"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBridgeServer = createBridgeServer;
const express_1 = __importDefault(require("express"));
const bridge_1 = require("./bridge");
const oauth_1 = require("./oauth");
const tunnel_1 = require("./tunnel");
function createBridgeServer(config) {
    const app = (0, express_1.default)();
    let tunnel = null;
    let bridge = null;
    let httpServer = null;
    let publicUrl = `http://localhost:${config.port}`;
    // --- Middleware ---
    app.use(express_1.default.json());
    app.use(express_1.default.urlencoded({ extended: true }));
    // CORS for claude.ai
    app.use((_req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
        res.header('Access-Control-Expose-Headers', 'Mcp-Session-Id');
        if (_req.method === 'OPTIONS') {
            res.sendStatus(204);
            return;
        }
        next();
    });
    // --- OAuth routes ---
    const oauthRouter = (0, oauth_1.createOAuthRouter)(config, () => publicUrl);
    app.use(oauthRouter);
    // --- MCP endpoint ---
    const authMiddleware = oauthRouter.authMiddleware;
    app.post('/mcp', authMiddleware, async (req, res) => {
        if (!bridge || !bridge.isRunning()) {
            res.status(503).json({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'MCP subprocess not running' },
            });
            return;
        }
        try {
            const sessionId = req.headers['mcp-session-id'];
            const { response, sessionId: newSessionId } = await bridge.handleMcpRequest(req.body, sessionId);
            res.header('Mcp-Session-Id', newSessionId);
            res.json(response);
        }
        catch (err) {
            console.error('[MCP] Error handling request:', err);
            res.status(500).json({
                jsonrpc: '2.0',
                error: {
                    code: -32603,
                    message: err instanceof Error ? err.message : 'Internal error',
                },
            });
        }
    });
    // DELETE /mcp — session termination
    app.delete('/mcp', authMiddleware, (req, res) => {
        res.sendStatus(200);
    });
    // GET /mcp — SSE endpoint (basic support)
    app.get('/mcp', authMiddleware, (req, res) => {
        res.header('Content-Type', 'text/event-stream');
        res.header('Cache-Control', 'no-cache');
        res.header('Connection', 'keep-alive');
        const sessionId = req.headers['mcp-session-id'];
        if (bridge && sessionId) {
            bridge.getOrCreateSession(sessionId);
        }
        // Keep alive
        const keepAlive = setInterval(() => {
            res.write(': keepalive\n\n');
        }, 30000);
        req.on('close', () => {
            clearInterval(keepAlive);
        });
    });
    // Health check
    app.get('/health', (_req, res) => {
        res.json({
            status: 'ok',
            bridge: bridge?.isRunning() ? 'running' : 'stopped',
            tunnel: tunnel ? tunnel.url : null,
        });
    });
    return {
        async start() {
            // 1. Start the MCP subprocess
            const serverName = config.activeServer;
            const serverConfig = config.servers[serverName];
            if (!serverConfig) {
                throw new Error(`Server "${serverName}" not found in config. Available: ${Object.keys(config.servers).join(', ')}`);
            }
            bridge = new bridge_1.McpBridge(serverConfig);
            bridge.on('stderr', (data) => {
                // Only show non-empty lines
                const lines = data.split('\n').filter((l) => l.trim());
                for (const line of lines) {
                    console.error(`[subprocess] ${line}`);
                }
            });
            bridge.on('exit', (code) => {
                console.error(`[subprocess] Exited with code ${code}`);
            });
            bridge.on('error', (err) => {
                console.error(`[subprocess] Error: ${err.message}`);
            });
            console.log(`Starting MCP subprocess: ${serverConfig.command} ${serverConfig.args.join(' ')}`);
            await bridge.start();
            console.log('MCP subprocess started.');
            // 2. Start HTTP server
            await new Promise((resolve) => {
                httpServer = app.listen(config.port, () => resolve());
            });
            console.log(`HTTP server listening on port ${config.port}`);
            // 3. Start ngrok tunnel
            if (config.ngrokAuthtoken) {
                try {
                    tunnel = await (0, tunnel_1.createTunnel)(config.port, config.ngrokAuthtoken);
                    publicUrl = tunnel.url;
                    console.log(`ngrok tunnel established: ${publicUrl}`);
                }
                catch (err) {
                    console.error(`Failed to create ngrok tunnel: ${err instanceof Error ? err.message : err}`);
                    console.error('Continuing without tunnel — only local access will work.');
                    publicUrl = `http://localhost:${config.port}`;
                }
            }
            else {
                console.log('No ngrok authtoken configured — running locally only.');
            }
            return publicUrl;
        },
        async stop() {
            if (tunnel) {
                await (0, tunnel_1.closeTunnel)(tunnel.listener);
                tunnel = null;
            }
            if (bridge) {
                await bridge.stop();
                bridge = null;
            }
            if (httpServer) {
                await new Promise((resolve) => httpServer.close(() => resolve()));
                httpServer = null;
            }
        },
    };
}
//# sourceMappingURL=server.js.map