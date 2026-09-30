const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
(async () => {
  const client = new Client({ name: 'axe', version: '1.0' });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp?clientId=axe1')));
  const find = async (it) => {
    const r = await client.callTool({ name: 'find-item', arguments: { item_name: it } }, undefined, { timeout: 15000 });
    return r.content[0].text;
  };
  console.log('--- 合成前 ---');
  console.log('工作台:', await find('crafting_table'));
  console.log('木板:', await find('cherry_planks'));
  console.log('木棍:', await find('stick'));

  let r = await client.callTool({ name: 'craft-item', arguments: { item_name: 'wooden_pickaxe', count: 1 } }, undefined, { timeout: 90000 });
  console.log('木镐:', r.content[0].text);
  r = await client.callTool({ name: 'craft-item', arguments: { item_name: 'wooden_axe', count: 1 } }, undefined, { timeout: 90000 });
  console.log('木斧:', r.content[0].text);

  console.log('--- 合成后 ---');
  console.log('木镐:', await find('wooden_pickaxe'));
  console.log('木斧:', await find('wooden_axe'));
  console.log('地面工作台:', (await client.callTool({ name: 'find-blocks', arguments: { block_type: 'crafting_table', max_distance: 32 } }, undefined, { timeout: 15000 })).content[0].text.split('\n')[0]);
  client.close();
})().catch(e => { console.error(String(e)); process.exit(1); });
