const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
(async () => {
  const client = new Client({ name: 'tree', version: '1.0' });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp?clientId=tree1')));
  for (const t of ['oak_log','spruce_log','birch_log','jungle_log','acacia_log','cherry_log']) {
    const r = await client.callTool({ name: 'find-blocks', arguments: { block_type: t, max_distance: 60 } }, undefined, { timeout: 15000 });
    console.log(t, '=>', r.content[0].text.split('\n')[0]);
  }
  client.close();
})().catch(e => { console.error(String(e)); process.exit(1); });
