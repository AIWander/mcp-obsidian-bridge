import { Command } from 'commander';
import inquirer from 'inquirer';
import {
  loadConfig,
  saveConfig,
  configExists,
  createDefaultConfig,
  hashPin,
  getConfigPath,
  BridgeConfig,
} from './config';
import { createBridgeServer } from './server';

const program = new Command();

program
  .name('mcp-bridge')
  .description('Bridge local stdio MCP servers to Claude.ai via Streamable HTTP + OAuth + ngrok')
  .version('1.0.0');

// --- setup command ---
program
  .command('setup')
  .description('Interactive first-run configuration')
  .action(async () => {
    console.log('\n🔧 MCP Bridge Setup\n');

    const existing = configExists() ? loadConfig() : null;

    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'ngrokAuthtoken',
        message: 'ngrok authtoken (get one free at https://dashboard.ngrok.com/signup):',
        default: existing?.ngrokAuthtoken || '',
        validate: (val: string) => val.trim().length > 0 || 'ngrok authtoken is required for remote access',
      },
      {
        type: 'confirm',
        name: 'setupObsidian',
        message: 'Set up Obsidian MCP server as the default?',
        default: true,
      },
    ]);

    let servers: BridgeConfig['servers'] = existing?.servers || {};
    let activeServer = existing?.activeServer || 'obsidian';

    if (answers.setupObsidian) {
      const obsidianAnswers = await inquirer.prompt([
        {
          type: 'input',
          name: 'apiKey',
          message: 'Obsidian Local REST API key (from the plugin settings):',
          default: existing?.servers?.obsidian?.env?.OBSIDIAN_API_KEY || '',
          validate: (val: string) => val.trim().length > 0 || 'API key is required',
        },
        {
          type: 'input',
          name: 'host',
          message: 'Obsidian host:',
          default: existing?.servers?.obsidian?.env?.OBSIDIAN_HOST || '127.0.0.1',
        },
        {
          type: 'input',
          name: 'port',
          message: 'Obsidian port:',
          default: existing?.servers?.obsidian?.env?.OBSIDIAN_PORT || '27123',
        },
      ]);

      servers['obsidian'] = {
        command: 'npx',
        args: ['-y', 'mcp-obsidian'],
        env: {
          OBSIDIAN_API_KEY: obsidianAnswers.apiKey,
          OBSIDIAN_HOST: obsidianAnswers.host,
          OBSIDIAN_PORT: obsidianAnswers.port,
        },
      };
      activeServer = 'obsidian';
    }

    const pinAnswers = await inquirer.prompt([
      {
        type: 'password',
        name: 'pin',
        message: 'Set a PIN for OAuth authorization (used when Claude.ai connects):',
        mask: '*',
        validate: (val: string) => val.length >= 4 || 'PIN must be at least 4 characters',
      },
      {
        type: 'password',
        name: 'pinConfirm',
        message: 'Confirm PIN:',
        mask: '*',
        validate: (val: string, answers: Record<string, string>) =>
          val === answers!.pin || 'PINs do not match',
      },
    ]);

    const portAnswer = await inquirer.prompt([
      {
        type: 'number',
        name: 'port',
        message: 'Local server port:',
        default: existing?.port || 3456,
      },
    ]);

    const { hash, salt } = hashPin(pinAnswers.pin);

    const config = createDefaultConfig({
      servers,
      ngrokAuthtoken: answers.ngrokAuthtoken,
      activeServer,
      port: portAnswer.port,
    });
    config.oauth.pinHash = hash;
    config.oauth.pinSalt = salt;

    // Preserve existing clients if re-running setup
    if (existing?.oauth?.clients) {
      config.oauth.clients = existing.oauth.clients;
    }

    saveConfig(config);

    console.log(`\n✅ Configuration saved to ${getConfigPath()}`);
    console.log('\nRun `mcp-bridge start` to launch the bridge.\n');
  });

// --- start command ---
program
  .command('start')
  .description('Start the MCP bridge server')
  .option('-s, --server <name>', 'Server to bridge (from config)')
  .action(async (opts) => {
    if (!configExists()) {
      console.error('No configuration found. Run `mcp-bridge setup` first.');
      process.exit(1);
    }

    const config = loadConfig();
    if (opts.server) {
      config.activeServer = opts.server;
    }

    const server = createBridgeServer(config);

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\nShutting down...');
      await server.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
      const url = await server.start();

      console.log('\n' + '='.repeat(60));
      console.log('  MCP Bridge is running!');
      console.log('='.repeat(60));
      console.log(`\n  Public URL:  ${url}`);
      console.log(`  MCP endpoint: ${url}/mcp`);
      console.log(`  Health:       ${url}/health`);
      console.log('\n  To connect from Claude.ai:');
      console.log('  1. Go to Claude.ai Settings → Integrations → Add custom connector');
      console.log(`  2. Enter URL: ${url}`);
      console.log('  3. Authorize with your PIN when prompted');
      console.log('\n  Press Ctrl+C to stop.\n');
    } catch (err) {
      console.error('Failed to start:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// --- status command ---
program
  .command('status')
  .description('Show current configuration')
  .action(() => {
    if (!configExists()) {
      console.log('Not configured. Run `mcp-bridge setup` first.');
      return;
    }

    const config = loadConfig();
    console.log('\nMCP Bridge Configuration');
    console.log('========================');
    console.log(`Config file:    ${getConfigPath()}`);
    console.log(`Port:           ${config.port}`);
    console.log(`Active server:  ${config.activeServer}`);
    console.log(`ngrok:          ${config.ngrokAuthtoken ? 'configured' : 'not configured'}`);
    console.log(`OAuth PIN:      ${config.oauth.pinHash ? 'set' : 'not set'}`);
    console.log(`Registered clients: ${Object.keys(config.oauth.clients).length}`);
    console.log('\nConfigured servers:');
    for (const [name, srv] of Object.entries(config.servers)) {
      const marker = name === config.activeServer ? ' (active)' : '';
      console.log(`  ${name}${marker}: ${srv.command} ${srv.args.join(' ')}`);
    }
    console.log();
  });

// --- add-server command ---
program
  .command('add-server')
  .description('Add a custom MCP server configuration')
  .argument('<name>', 'Server name')
  .requiredOption('-c, --command <cmd>', 'Command to run')
  .option('-a, --args <args...>', 'Command arguments')
  .option('-e, --env <pairs...>', 'Environment variables (KEY=VALUE)')
  .action((name, opts) => {
    if (!configExists()) {
      console.error('No configuration found. Run `mcp-bridge setup` first.');
      process.exit(1);
    }

    const config = loadConfig();
    const env: Record<string, string> = {};
    if (opts.env) {
      for (const pair of opts.env) {
        const [key, ...rest] = pair.split('=');
        env[key] = rest.join('=');
      }
    }

    config.servers[name] = {
      command: opts.command,
      args: opts.args || [],
      env: Object.keys(env).length > 0 ? env : undefined,
    };
    saveConfig(config);
    console.log(`Server "${name}" added.`);
  });

program.parse();
