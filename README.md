# mcp-obsidian-bridge

Bridge local stdio MCP servers to Claude.ai and Claude mobile via Streamable HTTP + OAuth + ngrok.

## What it does

Claude.ai supports remote MCP servers ("custom connectors") over Streamable HTTP with OAuth. Most local MCP servers — like [Obsidian MCP](https://www.npmjs.com/package/mcp-obsidian) — use stdio. This package bridges the gap:

```
Claude.ai / Claude mobile
    ↓ (HTTPS)
ngrok tunnel
    ↓ (localhost)
mcp-obsidian-bridge (OAuth + HTTP → stdio translation)
    ↓ (stdin/stdout)
Local MCP server (e.g. mcp-obsidian)
```

## Prerequisites

- **Node.js 18+**
- **ngrok account** (free): [Sign up here](https://dashboard.ngrok.com/signup)
- **Obsidian** with the [Local REST API plugin](https://github.com/coddingtonbear/obsidian-local-rest-api) enabled

## Quick Start

### 1. Run the setup wizard

```bash
npx mcp-obsidian-bridge setup
```

This will ask for:
- Your **ngrok authtoken** (from [ngrok dashboard](https://dashboard.ngrok.com/get-started/your-authtoken))
- Your **Obsidian API key** (from the Local REST API plugin settings in Obsidian)
- A **PIN** you'll use to authorize Claude.ai

### 2. Start the bridge

```bash
npx mcp-obsidian-bridge start
```

The bridge will:
1. Spawn the Obsidian MCP server as a subprocess
2. Start an HTTP server with OAuth and MCP endpoints
3. Open an ngrok tunnel
4. Print the public URL

### 3. Connect from Claude.ai

1. Go to **Claude.ai → Settings → Integrations → Add custom connector**
2. Enter the ngrok URL shown by the bridge
3. When the authorization page opens, enter your PIN
4. Done — Claude.ai can now access your Obsidian vault

## CLI Commands

| Command | Description |
|---------|-------------|
| `mcp-bridge setup` | Interactive first-run configuration |
| `mcp-bridge start` | Start the bridge server |
| `mcp-bridge start -s <name>` | Start with a specific server config |
| `mcp-bridge status` | Show current configuration |
| `mcp-bridge add-server <name> -c <cmd> -a <args...> -e KEY=VAL` | Add a custom MCP server |

## Using with other MCP servers

The bridge is generic — it works with any stdio MCP server. Add a custom server:

```bash
# Example: bridge a filesystem MCP server
mcp-bridge add-server filesystem -c npx -a -y @anthropic/mcp-server-filesystem /path/to/dir
```

Or edit `~/.mcp-bridge/config.json` directly:

```json
{
  "servers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "mcp-obsidian"],
      "env": {
        "OBSIDIAN_API_KEY": "your-key",
        "OBSIDIAN_HOST": "127.0.0.1",
        "OBSIDIAN_PORT": "27123"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-filesystem", "/home/user/documents"]
    }
  },
  "activeServer": "obsidian",
  "port": 3456
}
```

Then start with: `mcp-bridge start -s filesystem`

## How it works

### OAuth2 Flow
Claude.ai requires OAuth for custom connectors. The bridge implements a minimal OAuth2 authorization code grant with PKCE and Dynamic Client Registration (DCR):

1. Claude.ai discovers endpoints via `/.well-known/oauth-authorization-server`
2. Claude.ai registers itself via `/register` (DCR)
3. User is redirected to `/authorize` and enters their PIN
4. An authorization code is exchanged for tokens at `/token`
5. Tokens are valid for 30 days with refresh support

### MCP Translation
The bridge translates between HTTP and stdio:
- Incoming: `POST /mcp` with JSON-RPC → write to subprocess stdin
- Outgoing: Read subprocess stdout → JSON-RPC HTTP response
- Sessions are tracked via the `Mcp-Session-Id` header

## Configuration

Config is stored at `~/.mcp-bridge/config.json`. Sensitive values (PIN hash, OAuth signing secret) are never stored in plaintext.

## Security Notes

- The PIN is stored as a salted PBKDF2 hash, not in plaintext
- OAuth tokens are 256-bit random values
- The ngrok tunnel URL changes on restart (unless you have a paid ngrok plan with reserved domains)
- Only you should know the PIN — it's what prevents unauthorized access to your vault

## Troubleshooting

**"Subprocess exited with code 1"**: The MCP server failed to start. Check that:
- Obsidian is running with the Local REST API plugin enabled
- The API key is correct
- The host/port match your plugin settings

**"Failed to create ngrok tunnel"**: Check that:
- Your ngrok authtoken is correct
- You're not running another ngrok tunnel (free accounts allow 1)

**OAuth authorization fails**: Re-run `mcp-bridge setup` to reset your PIN.

## License

MIT
