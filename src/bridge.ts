import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { ServerConfig } from './config';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface Session {
  id: string;
  initialized: boolean;
  createdAt: number;
}

/**
 * Bridges MCP Streamable HTTP requests to a stdio MCP subprocess.
 * Manages subprocess lifecycle and JSON-RPC message routing.
 */
export class McpBridge extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer = '';
  private pendingRequests = new Map<string | number, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private sessions = new Map<string, Session>();
  private serverConfig: ServerConfig;
  private requestTimeout: number;

  constructor(serverConfig: ServerConfig, requestTimeout = 60000) {
    super();
    this.serverConfig = serverConfig;
    this.requestTimeout = requestTimeout;
  }

  async start(): Promise<void> {
    if (this.process) {
      throw new Error('Bridge subprocess already running');
    }

    const env = { ...process.env, ...this.serverConfig.env };

    // Use shell on Windows for npx/uvx commands that need cmd.exe resolution
    const needsShell = process.platform === 'win32' &&
      ['npx', 'uvx', 'cmd'].includes(this.serverConfig.command);

    this.process = spawn(this.serverConfig.command, this.serverConfig.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: needsShell,
    });

    this.process.stdout!.on('data', (chunk: Buffer) => {
      this.handleStdout(chunk.toString());
    });

    this.process.stderr!.on('data', (chunk: Buffer) => {
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
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 500);
      this.process!.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (this.process) this.process.kill('SIGKILL');
          resolve();
        }, 5000);
        this.process!.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      this.process = null;
    }
  }

  isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  getOrCreateSession(sessionId?: string): Session {
    if (sessionId && this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }
    const id = sessionId || crypto.randomUUID();
    const session: Session = { id, initialized: false, createdAt: Date.now() };
    this.sessions.set(id, session);
    return session;
  }

  /**
   * Send a JSON-RPC request to the stdio subprocess and wait for the response.
   */
  async sendRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (!this.process || !this.process.stdin) {
      throw new Error('Subprocess not running');
    }

    const id = request.id ?? crypto.randomUUID();
    const message: JsonRpcRequest = { ...request, id };

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out after ${this.requestTimeout}ms: ${request.method}`));
      }, this.requestTimeout);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const line = JSON.stringify(message) + '\n';
      this.process!.stdin!.write(line, (err) => {
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
  sendNotification(method: string, params?: unknown): void {
    if (!this.process || !this.process.stdin) {
      throw new Error('Subprocess not running');
    }
    const message = { jsonrpc: '2.0' as const, method, params };
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }

  /**
   * Handle an incoming HTTP MCP request and return the response.
   */
  async handleMcpRequest(body: JsonRpcRequest | JsonRpcRequest[], sessionId?: string): Promise<{
    response: JsonRpcResponse | JsonRpcResponse[];
    sessionId: string;
  }> {
    const session = this.getOrCreateSession(sessionId);

    if (Array.isArray(body)) {
      const responses = await Promise.all(
        body.map((req) => this.handleSingleRequest(req, session))
      );
      return { response: responses, sessionId: session.id };
    }

    const response = await this.handleSingleRequest(body, session);
    return { response, sessionId: session.id };
  }

  private async handleSingleRequest(request: JsonRpcRequest, session: Session): Promise<JsonRpcResponse> {
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
    } catch (err) {
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

  private handleStdout(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const message = JSON.parse(trimmed) as JsonRpcResponse;
        this.handleMessage(message);
      } catch {
        this.emit('stderr', `Non-JSON output from subprocess: ${trimmed}`);
      }
    }
  }

  private handleMessage(message: JsonRpcResponse): void {
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

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}
