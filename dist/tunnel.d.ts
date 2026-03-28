import * as ngrok from '@ngrok/ngrok';
export interface TunnelInfo {
    url: string;
    listener: ngrok.Listener;
}
/**
 * Creates an ngrok tunnel to the local server.
 */
export declare function createTunnel(port: number, authtoken: string): Promise<TunnelInfo>;
/**
 * Closes the ngrok tunnel.
 */
export declare function closeTunnel(listener: ngrok.Listener): Promise<void>;
//# sourceMappingURL=tunnel.d.ts.map