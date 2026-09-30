const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
(async () => {
  const client = new Client({ name: 'full', version: '1.0' });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp?clientId=full1')));
  const call = async (n, a, to = 90000) => {
    const r = await client.callTool({ name: n, arguments: a }, undefined, { timeout: to });
    return r.content[0].text;
  };
  // 查当前状态
  for (const it of ['oak_planks','stick','crafting_table']) {
    console.log(it, ':', await call('find-item', { item_name: it }, 15000));
  }
  // 没工作台就先合成（需要 4 板）
  let r = await call('find-item', { item_name: 'crafting_table' }, 15000);
  if (!r.includes('有')) {
    console.log('合成工作台:', await call('craft-item', { item_name: 'crafting_table', count: 1 }));
  }
  // 木镐、木斧
  console.log('木镐:', await call('craft-item', { item_name: 'wooden_pickaxe', count: 1 }));
  console.log('木斧:', await call('craft-item', { item_name: 'wooden_axe', count: 1 }));
  // 最终
  for (const it of ['wooden_pickaxe','wooden_axe']) {
    console.log(it, ':', await call('find-item', { item_name: it }, 15000));
  }
  client.close();
})().catch(e => { console.error(String(e)); process.exit(1); });
