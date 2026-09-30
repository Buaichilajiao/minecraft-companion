const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
(async () => {
  const client = new Client({ name: 'diag', version: '1.0' });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp?clientId=diag')));
  for (const it of ['cobblestone','stick','stone']) {
    const r = await client.callTool({ name: 'find-item', arguments: { item_name: it } }, undefined, { timeout: 20000 });
    console.log(it, '=>', r.content[0].text);
  }
  // 找附近石头
  const fb = await client.callTool({ name: 'find-blocks', arguments: { block_type: 'stone', max_distance: 32 } }, undefined, { timeout: 20000 });
  console.log('STONE:', fb.content[0].text);
  client.close();
})().catch(e => { console.error(String(e)); process.exit(1); });
