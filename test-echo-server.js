// Simple echo MCP server for testing
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', d => {
  buf += d;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'echo-test',version:'1.0'}}}) + '\n');
      } else if (msg.method === 'tools/list') {
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{tools:[{name:'echo',description:'Echo back input',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}}) + '\n');
      } else if (msg.method === 'tools/call') {
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{content:[{type:'text',text:'Echo: ' + JSON.stringify(msg.params)}]}}) + '\n');
      } else if (msg.id) {
        process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{}}) + '\n');
      }
    } catch(e) {}
  }
});
