const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
(async () => {
  const client = new Client({ name: 'tb2', version: '1.0' });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp?clientId=tb2')));
  const dump = async (label) => {
    let r = await client.callTool({ name: 'find-item', arguments: { item_name: 'crafting_table' } }, undefined, { timeout: 15000 });
    console.log(label, '背包:', r.content[0].text);
    r = await client.callTool({ name: 'find-blocks', arguments: { block_type: 'crafting_table', max_distance: 32 } }, undefined, { timeout: 15000 });
    console.log(label, '地面:', r.content[0].text.split('\n')[0]);
  };
  // 合成前
  let r = await client.callTool({ name: 'find-item', arguments: { item_name: 'cherry_planks' } }, undefined, { timeout: 15000 });
  console.log('当前 cherry_planks:', r.content[0].text);
  // 合成工作台
  r = await client.callTool({ name: 'craft-item', arguments: { item_name: 'crafting_table', count: 1 } }, undefined, { timeout: 40000 });
  console.log('合成结果:', r.content[0].text);
  await new Promise(res => setTimeout(res, 800));
  await dump('合成后');
  client.close();
})().catch(e => { console.error(String(e)); process.exit(1); });
