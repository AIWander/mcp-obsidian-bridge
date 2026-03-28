import { BridgeConfig } from './config';
export interface BridgeServer {
    start(): Promise<string>;
    stop(): Promise<void>;
}
export declare function createBridgeServer(config: BridgeConfig): BridgeServer;
//# sourceMappingURL=server.d.ts.map