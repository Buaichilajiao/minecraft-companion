const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
(async () => {
  const client = new Client({ name: 'inv', version: '1.0' });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp?clientId=inv')));
  const r = await client.callTool({ name: 'observe', arguments: {} }, undefined, { timeout: 30000 });
  console.log(r.content[0].text);
  client.close();
})().catch(e => { console.error(String(e)); process.exit(1); });
