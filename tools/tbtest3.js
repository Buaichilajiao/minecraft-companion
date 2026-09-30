const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
(async () => {
  const client = new Client({ name: 'tb3', version: '1.0' });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp?clientId=tb3')));
  // 合成木镐
  let r = await client.callTool({ name: 'craft-item', arguments: { item_name: 'wooden_pickaxe', count: 1 } }, undefined, { timeout: 60000 });
  console.log('木镐结果:', r.content[0].text);
  await new Promise(res => setTimeout(res, 800));
  // 追踪
  r = await client.callTool({ name: 'find-item', arguments: { item_name: 'crafting_table' } }, undefined, { timeout: 15000 });
  console.log('背包工作台:', r.content[0].text);
  r = await client.callTool({ name: 'find-item', arguments: { item_name: 'wooden_pickaxe' } }, undefined, { timeout: 15000 });
  console.log('背包木镐:', r.content[0].text);
  r = await client.callTool({ name: 'find-blocks', arguments: { block_type: 'crafting_table', max_distance: 32 } }, undefined, { timeout: 15000 });
  console.log('地面工作台:', r.content[0].text.split('\n')[0]);
  r = await client.callTool({ name: 'get-state', arguments: {} }, undefined, { timeout: 15000 });
  const p = r.content[0].text.match(/"position":\s*\[\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)/);
  console.log('bot 位置:', p ? p[1]+','+p[2]+','+p[3] : '?');
  client.close();
})().catch(e => { console.error(String(e)); process.exit(1); });
