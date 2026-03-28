import { EventEmitter } from 'events';
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
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
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
export declare class McpBridge extends EventEmitter {
    private process;
    private buffer;
    private pendingRequests;
    private sessions;
    private serverConfig;
    private requestTimeout;
    constructor(serverConfig: ServerConfig, requestTimeout?: number);
    start(): Promise<void>;
    stop(): Promise<void>;
    isRunning(): boolean;
    getOrCreateSession(sessionId?: string): Session;
    /**
     * Send a JSON-RPC request to the stdio subprocess and wait for the response.
     */
    sendRequest(request: JsonRpcRequest): Promise<JsonRpcResponse>;
    /**
     * Send a notification (no id, no response expected).
     */
    sendNotification(method: string, params?: unknown): void;
    /**
     * Handle an incoming HTTP MCP request and return the response.
     */
    handleMcpRequest(body: JsonRpcRequest | JsonRpcRequest[], sessionId?: string): Promise<{
        response: JsonRpcResponse | JsonRpcResponse[];
        sessionId: string;
    }>;
    private handleSingleRequest;
    private handleStdout;
    private handleMessage;
    private rejectAllPending;
}
export {};
//# sourceMappingURL=bridge.d.ts.map