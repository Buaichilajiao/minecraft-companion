/* L1 战斗：切easy/白天 → tp → 装备石剑 → 召唤僵尸 → attack-entity */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const STEPS = [
  ['run-command', { command: 'difficulty easy' }],
  ['run-command', { command: 'time set day' }],
  ['run-command', { command: 'tp XiaoBai_bot 50 79 50' }],
  ['equip-item', { item_name: 'stone_sword' }],
  ['run-command', { command: 'summon zombie 50 79 46' }],
];

(async () => {
  const client = new Client({ name: 'l1combat', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  for (const [name, args] of STEPS) {
    const res = await client.callTool({ name, arguments: args });
    console.log((res.isError ? '✗' : '✓'), `[${name}]`, res.content.map((c) => c.text).join(' '));
    await new Promise((r) => setTimeout(r, 700));
  }
  console.log('--- 僵尸已召唤，等 2s 后攻击 ---');
  await new Promise((r) => setTimeout(r, 2000));
  const t0 = Date.now();
  const res = await client.callTool({ name: 'attack-entity', arguments: { entity_type: 'zombie' } });
  console.log(`[attack-entity] ${Date.now() - t0}ms`, (res.isError ? '✗ ' : '✓ ') + res.content.map((c) => c.text).join(' '));
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
