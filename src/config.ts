import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export interface ServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface OAuthConfig {
  pinHash: string;
  pinSalt: string;
  signingSecret: string;
  clients: Record<string, { clientSecret: string; redirectUris: string[] }>;
}

export interface BridgeConfig {
  servers: Record<string, ServerConfig>;
  ngrokAuthtoken?: string;
  oauth: OAuthConfig;
  activeServer: string;
  port: number;
}

const CONFIG_DIR = path.join(os.homedir(), '.mcp-bridge');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_FILE);
}

export function hashPin(pin: string, salt?: string): { hash: string; salt: string } {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(pin, s, 100000, 64, 'sha512').toString('hex');
  return { hash, salt: s };
}

export function verifyPin(pin: string, hash: string, salt: string): boolean {
  const result = hashPin(pin, salt);
  return result.hash === hash;
}

export function loadConfig(): BridgeConfig {
  if (!configExists()) {
    throw new Error(
      'No configuration found. Run `mcp-bridge setup` first.'
    );
  }
  const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
  return JSON.parse(raw) as BridgeConfig;
}

export function saveConfig(config: BridgeConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

export function createDefaultConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    servers: {},
    oauth: {
      pinHash: '',
      pinSalt: '',
      signingSecret: crypto.randomBytes(32).toString('hex'),
      clients: {},
    },
    activeServer: 'obsidian',
    port: 3456,
    ...overrides,
  };
}
