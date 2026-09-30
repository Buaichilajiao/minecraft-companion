const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
(async () => {
  const client = new Client({ name: 'seq', version: '1.0' });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp?clientId=seq1')));
  const call = async (n, a, to = 90000) => {
    const r = await client.callTool({ name: n, arguments: a }, undefined, { timeout: to });
    return r.content[0].text;
  };
  const steps = [
    ['craft-item', { item_name: 'stick', count: 8 }],
    ['craft-item', { item_name: 'crafting_table', count: 1 }],
    ['craft-item', { item_name: 'wooden_pickaxe', count: 1 }],
    ['craft-item', { item_name: 'wooden_axe', count: 1 }],
  ];
  for (const [tool, args] of steps) {
    console.log(tool, args.item_name, '=>', await call(tool, args, 120000));
  }
  console.log('--- 最终 ---');
  for (const it of ['stick','wooden_pickaxe','wooden_axe']) {
    console.log(it, ':', await call('find-item', { item_name: it }, 15000));
  }
  console.log('地面工作台:', (await call('find-blocks', { block_type: 'crafting_table', max_distance: 32 }, 15000)).split('\n')[0]);
  client.close();
})().catch(e => { console.error(String(e)); process.exit(1); });
