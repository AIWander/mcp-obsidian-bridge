import { Router } from 'express';
import { BridgeConfig } from './config';
/**
 * Creates the OAuth2 router with authorization code grant flow,
 * Dynamic Client Registration (DCR), and PKCE support.
 */
export declare function createOAuthRouter(config: BridgeConfig, getPublicUrl: () => string): Router;
//# sourceMappingURL=oauth.d.ts.map