const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
(async () => {
  const client = new Client({ name: 'tb', version: '1.0' });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp?clientId=tb1')));
  // 1) 背包 crafting_table
  let r = await client.callTool({ name: 'find-item', arguments: { item_name: 'crafting_table' } }, undefined, { timeout: 15000 });
  console.log('背包工作台:', r.content[0].text);
  // 2) 地面 crafting_table
  r = await client.callTool({ name: 'find-blocks', arguments: { block_type: 'crafting_table', max_distance: 32 } }, undefined, { timeout: 15000 });
  console.log('地面工作台:', r.content[0].text);
  // 3) bot 位置 + 完整背包
  r = await client.callTool({ name: 'get-state', arguments: {} }, undefined, { timeout: 15000 });
  const t = r.content[0].text;
  const p = t.match(/"position":\s*\[\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)/);
  console.log('bot 位置:', p ? p[1]+','+p[2]+','+p[3] : '?');
  const inv = t.match(/"inventory":\s*\[([\s\S]*?)\]/);
  console.log('背包:', inv ? inv[1].match(/"name":\s*"[^"]+"/g)?.join(', ') : '空');
  client.close();
})().catch(e => { console.error(String(e)); process.exit(1); });
