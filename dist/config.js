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
exports.getConfigDir = getConfigDir;
exports.getConfigPath = getConfigPath;
exports.configExists = configExists;
exports.hashPin = hashPin;
exports.verifyPin = verifyPin;
exports.loadConfig = loadConfig;
exports.saveConfig = saveConfig;
exports.createDefaultConfig = createDefaultConfig;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const crypto = __importStar(require("crypto"));
const CONFIG_DIR = path.join(os.homedir(), '.mcp-bridge');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
function getConfigDir() {
    return CONFIG_DIR;
}
function getConfigPath() {
    return CONFIG_FILE;
}
function configExists() {
    return fs.existsSync(CONFIG_FILE);
}
function hashPin(pin, salt) {
    const s = salt || crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(pin, s, 100000, 64, 'sha512').toString('hex');
    return { hash, salt: s };
}
function verifyPin(pin, hash, salt) {
    const result = hashPin(pin, salt);
    return result.hash === hash;
}
function loadConfig() {
    if (!configExists()) {
        throw new Error('No configuration found. Run `mcp-bridge setup` first.');
    }
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw);
}
function saveConfig(config) {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}
function createDefaultConfig(overrides = {}) {
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
//# sourceMappingURL=config.js.map