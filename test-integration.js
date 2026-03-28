/**
 * Integration test: Run the bridge against a REAL MCP server
 * Uses @modelcontextprotocol/server-filesystem to prove the bridge
 * handles production MCP protocol correctly.
 */
const path = require('path');
const fs = require('fs');
const { createDefaultConfig, hashPin, saveConfig } = require('./dist/config');
const { createBridgeServer } = require('./dist/server');

const TEST_DIR = path.join(__dirname, 'test-vault');

async function main() {
  // Create a test directory with some files to simulate a vault
  if (!fs.existsSync(TEST_DIR)) fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, 'note1.md'), '# Test Note\nThis is a test note in the vault.');
  fs.writeFileSync(path.join(TEST_DIR, 'note2.md'), '# Second Note\nAnother note with different content.');
  fs.mkdirSync(path.join(TEST_DIR, 'subfolder'), { recursive: true });
  fs.writeFileSync(path.join(TEST_DIR, 'subfolder', 'deep-note.md'), '# Deep Note\nNested inside a subfolder.');

  // Configure bridge to use the REAL filesystem MCP server
  const { hash, salt } = hashPin('testpin');
  const config = createDefaultConfig({
    servers: {
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', TEST_DIR],
        env: {}
      }
    },
    activeServer: 'filesystem',
    port: 3458,
    ngrokAuthtoken: ''
  });
  config.oauth.pinHash = hash;
  config.oauth.pinSalt = salt;
  saveConfig(config);

  console.log('=== Integration Test: Real MCP Server ===\n');
  console.log(`Test directory: ${TEST_DIR}`);
  console.log('MCP server: @modelcontextprotocol/server-filesystem\n');

  const server = createBridgeServer(config);
  let url;
  try {
    url = await server.start();
  } catch (err) {
    console.error('FATAL: Failed to start bridge:', err.message);
    process.exit(1);
  }
  console.log(`Bridge running at ${url}\n`);

  // Wait a moment for npx to download and start the server
  console.log('Waiting 5s for npx to download and start filesystem server...');
  await new Promise(r => setTimeout(r, 5000));

  let passed = 0;
  let failed = 0;

  function test(name, condition, detail) {
    if (condition) {
      console.log(`  ✅ ${name}${detail ? ': ' + detail : ''}`);
      passed++;
    } else {
      console.log(`  ❌ ${name}${detail ? ': ' + detail : ''}`);
      failed++;
    }
  }

  // Step 1: Get a token through full OAuth flow
  console.log('\n--- OAuth Flow ---');

  const client = await fetch(url + '/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' })
  }).then(r => r.json());
  test('DCR registration', client.client_id && client.client_secret);

  const authResp = await fetch(url + '/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      state: 'test',
      pin: 'testpin'
    }),
    redirect: 'manual'
  });
  const location = authResp.headers.get('location');
  const codeMatch = location && location.match(/code=([^&]+)/);
  test('PIN auth → code', !!codeMatch);

  let token;
  if (codeMatch) {
    const tokenResp = await fetch(url + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: codeMatch[1],
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        client_id: client.client_id,
        client_secret: client.client_secret
      })
    }).then(r => r.json());
    token = tokenResp.access_token;
    test('Code → token', !!token);
  }

  if (!token) {
    console.error('\nFATAL: Could not get token. Aborting MCP tests.');
    await server.stop();
    process.exit(1);
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + token
  };

  // Step 2: MCP Initialize
  console.log('\n--- MCP Protocol ---');

  const initResp = await fetch(url + '/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'integration-test', version: '1.0.0' }
      }
    })
  }).then(r => r.json());

  test('initialize', initResp.result && initResp.result.serverInfo,
    initResp.result ? `server=${initResp.result.serverInfo?.name} proto=${initResp.result.protocolVersion}` : JSON.stringify(initResp));

  // Send initialized notification
  await fetch(url + '/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  });

  // Step 3: List tools
  const toolsResp = await fetch(url + '/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  }).then(r => r.json());

  const tools = toolsResp.result?.tools || [];
  test('tools/list', tools.length > 0, `${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);

  // Step 4: List directory (read_directory or list_directory tool)
  const listTool = tools.find(t => t.name === 'list_directory' || t.name === 'list_directory_with_sizes');
  if (listTool) {
    const listResp = await fetch(url + '/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: listTool.name, arguments: { path: TEST_DIR } }
      })
    }).then(r => r.json());

    const content = listResp.result?.content?.[0]?.text || '';
    test(`${listTool.name}`, content.includes('note1') || content.includes('note2'),
      content.substring(0, 200));
  } else {
    console.log('  ⏭️  No list directory tool found, skipping');
  }

  // Step 5: Read a file
  const readTool = tools.find(t => t.name === 'read_file' || t.name === 'read_text_file');
  if (readTool) {
    const readResp = await fetch(url + '/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: readTool.name, arguments: { path: path.join(TEST_DIR, 'note1.md') } }
      })
    }).then(r => r.json());

    const content = readResp.result?.content?.[0]?.text || '';
    test(`${readTool.name}`, content.includes('Test Note'),
      content.substring(0, 100));
  } else {
    console.log('  ⏭️  No read file tool found, skipping');
  }

  // Step 6: Write a file (proves write path works)
  const writeTool = tools.find(t => t.name === 'write_file');
  if (writeTool) {
    const newContent = `# Written by Bridge\nCreated at ${new Date().toISOString()}\nThis proves the write path works.`;
    const writeResp = await fetch(url + '/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 5, method: 'tools/call',
        params: { name: writeTool.name, arguments: { path: path.join(TEST_DIR, 'bridge-created.md'), content: newContent } }
      })
    }).then(r => r.json());

    const writeOk = !writeResp.error && fs.existsSync(path.join(TEST_DIR, 'bridge-created.md'));
    const actualContent = writeOk ? fs.readFileSync(path.join(TEST_DIR, 'bridge-created.md'), 'utf8') : '';
    test(`${writeTool.name}`, writeOk && actualContent.includes('Written by Bridge'),
      writeOk ? 'file created on disk and content verified' : JSON.stringify(writeResp.error || writeResp));
  } else {
    console.log('  ⏭️  No write file tool found, skipping');
  }

  // Step 7: Search (if available)
  const searchTool = tools.find(t => t.name === 'search_files');
  if (searchTool) {
    const searchResp = await fetch(url + '/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 6, method: 'tools/call',
        params: { name: searchTool.name, arguments: { path: TEST_DIR, pattern: 'subfolder' } }
      })
    }).then(r => r.json());

    const content = searchResp.result?.content?.[0]?.text || '';
    test(`${searchTool.name}`, content.length > 0, content.substring(0, 150));
  }

  // Step 8: Session header
  console.log('\n--- Session Management ---');
  const sessionResp = await fetch(url + '/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} })
  });
  const sessionId = sessionResp.headers.get('mcp-session-id');
  test('Mcp-Session-Id header', !!sessionId, sessionId);

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);
  console.log('='.repeat(50));

  // Cleanup
  await server.stop();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  process.exit(1);
});
