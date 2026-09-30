const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
(async () => {
  const client = new Client({ name: 'inv', version: '1.0' });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp?clientId=inv1')));
  const r = await client.callTool({ name: 'get-state', arguments: {} }, undefined, { timeout: 15000 });
  const t = r.content[0].text;
  const inv = t.match(/"inventory":\s*\[([\s\S]*?)\]/);
  if (inv) {
    const items = [...inv[1].matchAll(/"name":\s*"([^"]+)",\s*"count":\s*(\d+),\s*"slot":\s*(\d+)/g)];
    for (const m of items) console.log(`${m[1]} x${m[2]} (slot ${m[3]})`);
  }
  client.close();
})().catch(e => { console.error(String(e)); process.exit(1); });
