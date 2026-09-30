const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
(async () => {
  const client = new Client({ name: 'inv', version: '1.0' });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp?clientId=inv2')));
  const items = ['spruce_log','spruce_planks','oak_planks','stick','crafting_table','wooden_pickaxe','wooden_axe','wooden_hoe'];
  for (const it of items) {
    const r = await client.callTool({ name: 'find-item', arguments: { item_name: it } }, undefined, { timeout: 20000 });
    console.log(it, '=>', r.content[0].text);
  }
  client.close();
})().catch(e => { console.error(String(e)); process.exit(1); });
