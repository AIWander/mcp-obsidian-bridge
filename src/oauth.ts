import { Router, Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { BridgeConfig, saveConfig, verifyPin } from './config';

interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: number;
}

interface Token {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  expiresAt: number;
}

/**
 * Creates the OAuth2 router with authorization code grant flow,
 * Dynamic Client Registration (DCR), and PKCE support.
 */
export function createOAuthRouter(config: BridgeConfig, getPublicUrl: () => string): Router {
  const router = Router();
  const authCodes = new Map<string, AuthCode>();
  const tokens = new Map<string, Token>();
  const TOKEN_LIFETIME = 30 * 24 * 60 * 60 * 1000; // 30 days
  const CODE_LIFETIME = 10 * 60 * 1000; // 10 minutes

  // --- OAuth Authorization Server Metadata (RFC 8414) ---
  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    const issuer = getPublicUrl();
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      code_challenge_methods_supported: ['S256'],
    });
  });

  // --- Dynamic Client Registration (RFC 7591) ---
  router.post('/register', (req, res) => {
    const { redirect_uris, client_name } = req.body || {};

    if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris required' });
      return;
    }

    const clientId = crypto.randomUUID();
    const clientSecret = crypto.randomBytes(32).toString('hex');

    config.oauth.clients[clientId] = {
      clientSecret,
      redirectUris: redirect_uris,
    };
    saveConfig(config);

    res.status(201).json({
      client_id: clientId,
      client_secret: clientSecret,
      client_name: client_name || 'MCP Client',
      redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    });
  });

  // --- Authorization endpoint ---
  router.get('/authorize', (req, res) => {
    const { client_id, redirect_uri, state, response_type, code_challenge, code_challenge_method } = req.query as Record<string, string>;

    if (response_type !== 'code') {
      res.status(400).send('Unsupported response_type. Must be "code".');
      return;
    }

    if (!client_id || !config.oauth.clients[client_id]) {
      res.status(400).send('Unknown client_id. Register first via /register.');
      return;
    }

    const client = config.oauth.clients[client_id];
    if (!client.redirectUris.includes(redirect_uri)) {
      res.status(400).send('Invalid redirect_uri.');
      return;
    }

    // Render a simple HTML consent page
    res.type('html').send(`<!DOCTYPE html>
<html><head><title>MCP Bridge Authorization</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 400px; margin: 80px auto; padding: 20px; }
  h1 { font-size: 1.4em; }
  input[type=password] { width: 100%; padding: 10px; font-size: 16px; margin: 10px 0; box-sizing: border-box; }
  button { background: #5436DA; color: white; border: none; padding: 12px 24px; font-size: 16px; border-radius: 6px; cursor: pointer; width: 100%; }
  button:hover { background: #4329B5; }
  .error { color: #d32f2f; margin-top: 10px; }
</style></head>
<body>
  <h1>Authorize MCP Bridge</h1>
  <p>A Claude.ai connector is requesting access to your local MCP server.</p>
  <form method="POST" action="/authorize">
    <input type="hidden" name="client_id" value="${escapeHtml(client_id)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(redirect_uri)}">
    <input type="hidden" name="state" value="${escapeHtml(state || '')}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(code_challenge || '')}">
    <input type="hidden" name="code_challenge_method" value="${escapeHtml(code_challenge_method || '')}">
    <label for="pin">Enter your PIN:</label>
    <input type="password" id="pin" name="pin" placeholder="PIN" required autofocus>
    <button type="submit">Authorize</button>
  </form>
</body></html>`);
  });

  router.post('/authorize', (req, res) => {
    const { client_id, redirect_uri, state, pin, code_challenge, code_challenge_method } = req.body;

    if (!verifyPin(pin, config.oauth.pinHash, config.oauth.pinSalt)) {
      res.type('html').send(`<!DOCTYPE html>
<html><head><title>Authorization Failed</title>
<style>body { font-family: sans-serif; max-width: 400px; margin: 80px auto; padding: 20px; } .error { color: #d32f2f; }</style>
</head><body><h1>Authorization Failed</h1><p class="error">Incorrect PIN. Please go back and try again.</p>
<a href="javascript:history.back()">Try again</a></body></html>`);
      return;
    }

    const code = crypto.randomBytes(32).toString('hex');
    authCodes.set(code, {
      code,
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge || undefined,
      codeChallengeMethod: code_challenge_method || undefined,
      expiresAt: Date.now() + CODE_LIFETIME,
    });

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);

    res.redirect(302, redirectUrl.toString());
  });

  // --- Token endpoint ---
  router.post('/token', (req, res) => {
    const { grant_type, code, redirect_uri, client_id, client_secret, refresh_token, code_verifier } = req.body;

    if (grant_type === 'authorization_code') {
      const authCode = authCodes.get(code);
      if (!authCode) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
        return;
      }

      if (authCode.expiresAt < Date.now()) {
        authCodes.delete(code);
        res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code expired' });
        return;
      }

      if (authCode.clientId !== client_id || authCode.redirectUri !== redirect_uri) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Client ID or redirect URI mismatch' });
        return;
      }

      // Verify PKCE if code_challenge was provided
      if (authCode.codeChallenge) {
        if (!code_verifier) {
          res.status(400).json({ error: 'invalid_grant', error_description: 'code_verifier required' });
          return;
        }
        const expected = crypto.createHash('sha256').update(code_verifier).digest('base64url');
        if (expected !== authCode.codeChallenge) {
          res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
          return;
        }
      }

      // Verify client credentials
      const client = config.oauth.clients[client_id];
      if (!client || client.clientSecret !== client_secret) {
        res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
        return;
      }

      authCodes.delete(code);

      const accessToken = crypto.randomBytes(32).toString('hex');
      const refreshTok = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + TOKEN_LIFETIME;

      tokens.set(accessToken, { accessToken, refreshToken: refreshTok, clientId: client_id, expiresAt });

      res.json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: Math.floor(TOKEN_LIFETIME / 1000),
        refresh_token: refreshTok,
      });
    } else if (grant_type === 'refresh_token') {
      // Find the token by refresh_token
      let foundToken: Token | undefined;
      for (const t of tokens.values()) {
        if (t.refreshToken === refresh_token && t.clientId === client_id) {
          foundToken = t;
          break;
        }
      }

      if (!foundToken) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid refresh token' });
        return;
      }

      // Rotate tokens
      tokens.delete(foundToken.accessToken);
      const newAccessToken = crypto.randomBytes(32).toString('hex');
      const newRefreshToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = Date.now() + TOKEN_LIFETIME;

      tokens.set(newAccessToken, { accessToken: newAccessToken, refreshToken: newRefreshToken, clientId: client_id, expiresAt });

      res.json({
        access_token: newAccessToken,
        token_type: 'Bearer',
        expires_in: Math.floor(TOKEN_LIFETIME / 1000),
        refresh_token: newRefreshToken,
      });
    } else {
      res.status(400).json({ error: 'unsupported_grant_type' });
    }
  });

  // Middleware to validate Bearer tokens
  function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'unauthorized', error_description: 'Bearer token required' });
      return;
    }

    const token = authHeader.slice(7);
    const tokenData = tokens.get(token);
    if (!tokenData) {
      res.status(401).json({ error: 'invalid_token', error_description: 'Token not found or revoked' });
      return;
    }

    if (tokenData.expiresAt < Date.now()) {
      tokens.delete(token);
      res.status(401).json({ error: 'invalid_token', error_description: 'Token expired' });
      return;
    }

    next();
  }

  return Object.assign(router, { authMiddleware });
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
