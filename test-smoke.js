const { createDefaultConfig, hashPin, saveConfig } = require('./dist/config');
const { createBridgeServer } = require('./dist/server');

async function main() {
  // Create a test config with a simple echo MCP server
  const { hash, salt } = hashPin('1234');
  const config = createDefaultConfig({
    servers: {
      echo: {
        command: 'node',
        args: [require('path').join(__dirname, 'test-echo-server.js')],
        env: {}
      }
    },
    activeServer: 'echo',
    port: 3457,
    ngrokAuthtoken: ''
  });
  config.oauth.pinHash = hash;
  config.oauth.pinSalt = salt;
  saveConfig(config);

  const server = createBridgeServer(config);
  const url = await server.start();
  console.log('Server started at ' + url);

  let passed = 0;
  let failed = 0;

  // Test 1: OAuth discovery
  const meta = await fetch(url + '/.well-known/oauth-authorization-server').then(r => r.json());
  if (meta.issuer && meta.authorization_endpoint && meta.token_endpoint && meta.registration_endpoint) {
    console.log('Test 1 - OAuth Discovery: PASS');
    passed++;
  } else {
    console.log('Test 1 - OAuth Discovery: FAIL', meta);
    failed++;
  }

  // Test 2: DCR
  const client = await fetch(url + '/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], client_name: 'Claude' })
  }).then(r => r.json());
  if (client.client_id && client.client_secret) {
    console.log('Test 2 - Dynamic Client Registration: PASS');
    passed++;
  } else {
    console.log('Test 2 - DCR: FAIL', client);
    failed++;
  }

  // Test 3: Authorize page renders
  const authPage = await fetch(url + '/authorize?client_id=' + client.client_id + '&redirect_uri=https://claude.ai/api/mcp/auth_callback&response_type=code&state=test').then(r => r.text());
  if (authPage.includes('Enter your PIN')) {
    console.log('Test 3 - Authorize Page: PASS');
    passed++;
  } else {
    console.log('Test 3 - Authorize Page: FAIL');
    failed++;
  }

  // Test 4: MCP endpoint rejects unauthenticated requests
  const unauth = await fetch(url + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  });
  if (unauth.status === 401) {
    console.log('Test 4 - MCP Rejects Unauthenticated: PASS');
    passed++;
  } else {
    console.log('Test 4 - MCP Auth: FAIL (got ' + unauth.status + ')');
    failed++;
  }

  // Test 5: Full OAuth flow → get token → call MCP
  // POST to /authorize with correct PIN
  const authResp = await fetch(url + '/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      state: 'test',
      pin: '1234'
    }),
    redirect: 'manual'
  });
  const location = authResp.headers.get('location');
  if (location && location.includes('code=')) {
    console.log('Test 5a - PIN Auth → Code: PASS');
    passed++;
  } else {
    console.log('Test 5a - PIN Auth: FAIL (status=' + authResp.status + ', location=' + location + ')');
    failed++;
  }

  // Extract code from redirect
  const codeMatch = location && location.match(/code=([^&]+)/);
  if (codeMatch) {
    const code = codeMatch[1];
    
    // Exchange code for token
    const tokenResp = await fetch(url + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        client_id: client.client_id,
        client_secret: client.client_secret
      })
    }).then(r => r.json());

    if (tokenResp.access_token && tokenResp.refresh_token) {
      console.log('Test 5b - Code → Token: PASS');
      passed++;

      // Test 6: Authenticated MCP call
      const mcpResp = await fetch(url + '/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + tokenResp.access_token
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } })
      }).then(r => r.json());

      if (mcpResp.result && mcpResp.result.serverInfo) {
        console.log('Test 6 - MCP Initialize: PASS (server=' + mcpResp.result.serverInfo.name + ')');
        passed++;
      } else {
        console.log('Test 6 - MCP Initialize: FAIL', JSON.stringify(mcpResp));
        failed++;
      }

      // Test 7: tools/list
      const toolsResp = await fetch(url + '/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + tokenResp.access_token
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      }).then(r => r.json());

      if (toolsResp.result && toolsResp.result.tools && toolsResp.result.tools.length > 0) {
        console.log('Test 7 - tools/list: PASS (tools=' + toolsResp.result.tools.map(t => t.name).join(', ') + ')');
        passed++;
      } else {
        console.log('Test 7 - tools/list: FAIL', JSON.stringify(toolsResp));
        failed++;
      }

      // Test 8: tools/call
      const callResp = await fetch(url + '/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + tokenResp.access_token
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hello from test' } } })
      }).then(r => r.json());

      if (callResp.result && callResp.result.content) {
        console.log('Test 8 - tools/call: PASS (' + callResp.result.content[0].text + ')');
        passed++;
      } else {
        console.log('Test 8 - tools/call: FAIL', JSON.stringify(callResp));
        failed++;
      }

      // Test 9: Token refresh
      const refreshResp = await fetch(url + '/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokenResp.refresh_token,
          client_id: client.client_id,
          client_secret: client.client_secret
        })
      }).then(r => r.json());

      if (refreshResp.access_token && refreshResp.access_token !== tokenResp.access_token) {
        console.log('Test 9 - Token Refresh: PASS (new token issued)');
        passed++;
      } else {
        console.log('Test 9 - Token Refresh: FAIL', JSON.stringify(refreshResp));
        failed++;
      }
    } else {
      console.log('Test 5b - Code → Token: FAIL', tokenResp);
      failed++;
    }
  }

  // Test 10: Health check
  const health = await fetch(url + '/health').then(r => r.json());
  if (health.status === 'ok' && health.bridge === 'running') {
    console.log('Test 10 - Health Check: PASS');
    passed++;
  } else {
    console.log('Test 10 - Health: FAIL', health);
    failed++;
  }

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);
  console.log('='.repeat(50));

  await server.stop();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
