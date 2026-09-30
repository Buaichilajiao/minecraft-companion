const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
(async () => {
  const client = new Client({ name: 'sp2', version: '1.0' });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp?clientId=sp2')));
  const r = await client.callTool({ name: 'get-block-info', arguments: { x: -9, y: 124, z: -3 } }, undefined, { timeout: 15000 });
  console.log('=== 格 (-9,124,-3) ===');
  console.log(r.content[0].text);
  const r2 = await client.callTool({ name: 'get-block-info', arguments: { x: -9, y: 123, z: -3 } }, undefined, { timeout: 15000 });
  console.log('=== 下方 (-9,123,-3) ===');
  console.log(r2.content[0].text);
  client.close();
})().catch(e => { console.error(String(e)); process.exit(1); });
