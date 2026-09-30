const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
(async () => {
  const client = new Client({ name: 'pick', version: '1.0' });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp?clientId=pick1')));
  for (let i = 0; i < 6; i++) {
    const r = await client.callTool({ name: 'pickup-item', arguments: { max_distance: 24 } }, undefined, { timeout: 60000 });
    console.log(`[${i}]`, r.content[0].text);
    if (r.content[0].text.includes('❌')) break;
  }
  // 查背包关键物品
  for (const it of ['oak_log','spruce_log','birch_log','oak_planks','spruce_planks']) {
    const r = await client.callTool({ name: 'find-item', arguments: { item_name: it } }, undefined, { timeout: 15000 });
    console.log(it, '=>', r.content[0].text);
  }
  client.close();
})().catch(e => { console.error(String(e)); process.exit(1); });
