export interface ServerConfig {
    command: string;
    args: string[];
    env?: Record<string, string>;
}
export interface OAuthConfig {
    pinHash: string;
    pinSalt: string;
    signingSecret: string;
    clients: Record<string, {
        clientSecret: string;
        redirectUris: string[];
    }>;
}
export interface BridgeConfig {
    servers: Record<string, ServerConfig>;
    ngrokAuthtoken?: string;
    oauth: OAuthConfig;
    activeServer: string;
    port: number;
}
export declare function getConfigDir(): string;
export declare function getConfigPath(): string;
export declare function configExists(): boolean;
export declare function hashPin(pin: string, salt?: string): {
    hash: string;
    salt: string;
};
export declare function verifyPin(pin: string, hash: string, salt: string): boolean;
export declare function loadConfig(): BridgeConfig;
export declare function saveConfig(config: BridgeConfig): void;
export declare function createDefaultConfig(overrides?: Partial<BridgeConfig>): BridgeConfig;
//# sourceMappingURL=config.d.ts.map