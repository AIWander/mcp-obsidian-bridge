"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.McpBridge = void 0;
const child_process_1 = require("child_process");
const events_1 = require("events");
const crypto = __importStar(require("crypto"));
/**
 * Bridges MCP Streamable HTTP requests to a stdio MCP subprocess.
 * Manages subprocess lifecycle and JSON-RPC message routing.
 */
class McpBridge extends events_1.EventEmitter {
    process = null;
    buffer = '';
    pendingRequests = new Map();
    sessions = new Map();
    serverConfig;
    requestTimeout;
    constructor(serverConfig, requestTimeout = 60000) {
        super();
        this.serverConfig = serverConfig;
        this.requestTimeout = requestTimeout;
    }
    async start() {
        if (this.process) {
            throw new Error('Bridge subprocess already running');
        }
        const env = { ...process.env, ...this.serverConfig.env };
        // Use shell on Windows for npx/uvx commands that need cmd.exe resolution
        const needsShell = process.platform === 'win32' &&
            ['npx', 'uvx', 'cmd'].includes(this.serverConfig.command);
        this.process = (0, child_process_1.spawn)(this.serverConfig.command, this.serverConfig.args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env,
            shell: needsShell,
        });
        this.process.stdout.on('data', (chunk) => {
            this.handleStdout(chunk.toString());
        });
        this.process.stderr.on('data', (chunk) => {
            this.emit('stderr', chunk.toString());
        });
        this.process.on('exit', (code, signal) => {
            this.emit('exit', code, signal);
            this.rejectAllPending(new Error(`Subprocess exited with code ${code}`));
            this.process = null;
        });
        this.process.on('error', (err) => {
            this.emit('error', err);
            this.rejectAllPending(err);
            this.process = null;
        });
        // Wait briefly for process to be ready
        await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 500);
            this.process.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });
        });
    }
    async stop() {
        if (this.process) {
            this.process.kill('SIGTERM');
            await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    if (this.process)
                        this.process.kill('SIGKILL');
                    resolve();
                }, 5000);
                this.process.on('exit', () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
            this.process = null;
        }
    }
    isRunning() {
        return this.process !== null && this.process.exitCode === null;
    }
    getOrCreateSession(sessionId) {
        if (sessionId && this.sessions.has(sessionId)) {
            return this.sessions.get(sessionId);
        }
        const id = sessionId || crypto.randomUUID();
        const session = { id, initialized: false, createdAt: Date.now() };
        this.sessions.set(id, session);
        return session;
    }
    /**
     * Send a JSON-RPC request to the stdio subprocess and wait for the response.
     */
    async sendRequest(request) {
        if (!this.process || !this.process.stdin) {
            throw new Error('Subprocess not running');
        }
        const id = request.id ?? crypto.randomUUID();
        const message = { ...request, id };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Request timed out after ${this.requestTimeout}ms: ${request.method}`));
            }, this.requestTimeout);
            this.pendingRequests.set(id, { resolve, reject, timer });
            const line = JSON.stringify(message) + '\n';
            this.process.stdin.write(line, (err) => {
                if (err) {
                    clearTimeout(timer);
                    this.pendingRequests.delete(id);
                    reject(err);
                }
            });
        });
    }
    /**
     * Send a notification (no id, no response expected).
     */
    sendNotification(method, params) {
        if (!this.process || !this.process.stdin) {
            throw new Error('Subprocess not running');
        }
        const message = { jsonrpc: '2.0', method, params };
        this.process.stdin.write(JSON.stringify(message) + '\n');
    }
    /**
     * Handle an incoming HTTP MCP request and return the response.
     */
    async handleMcpRequest(body, sessionId) {
        const session = this.getOrCreateSession(sessionId);
        if (Array.isArray(body)) {
            const responses = await Promise.all(body.map((req) => this.handleSingleRequest(req, session)));
            return { response: responses, sessionId: session.id };
        }
        const response = await this.handleSingleRequest(body, session);
        return { response, sessionId: session.id };
    }
    async handleSingleRequest(request, session) {
        // Track initialization state
        if (request.method === 'initialize') {
            session.initialized = true;
        }
        // If it's a notification (no id), send and return empty
        if (request.id === undefined || request.id === null) {
            this.sendNotification(request.method, request.params);
            return { jsonrpc: '2.0', result: {} };
        }
        try {
            return await this.sendRequest(request);
        }
        catch (err) {
            return {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: -32603,
                    message: err instanceof Error ? err.message : 'Internal error',
                },
            };
        }
    }
    handleStdout(data) {
        this.buffer += data;
        const lines = this.buffer.split('\n');
        // Keep the last incomplete line in the buffer
        this.buffer = lines.pop() || '';
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const message = JSON.parse(trimmed);
                this.handleMessage(message);
            }
            catch {
                this.emit('stderr', `Non-JSON output from subprocess: ${trimmed}`);
            }
        }
    }
    handleMessage(message) {
        if (message.id !== undefined && message.id !== null) {
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
                clearTimeout(pending.timer);
                this.pendingRequests.delete(message.id);
                pending.resolve(message);
                return;
            }
        }
        // Notification from server or unmatched response
        this.emit('notification', message);
    }
    rejectAllPending(error) {
        for (const [id, pending] of this.pendingRequests) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pendingRequests.clear();
    }
}
exports.McpBridge = McpBridge;
//# sourceMappingURL=bridge.js.map