/* L1 综合单元测试：分模块验证原子工具，清空背包后逐组进行，最后汇总 PASS/FAIL */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(group, name, ok, detail) {
  results.push({ group, name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} [${group}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function runGroup(client, group, cases) {
  for (const c of cases) {
    const [name, args, expectOk = true] = c;
    const t0 = Date.now();
    try {
      const res = await client.callTool({ name, arguments: args });
      const text = res.content.map((x) => x.text).join(' ');
      // 权威判定：MCP isError，或项目自定义失败文本（以 ❌ 开头）
      const isErr = res.isError || text.trimStart().startsWith('❌');
      const ok = !expectOk ? isErr : !isErr;
      record(group, name, ok, `${Date.now() - t0}ms ${text.slice(0, 70)}`);
    } catch (e) {
      record(group, name, false, `异常 ${e.message.slice(0, 60)}`);
    }
    await sleep(350);
  }
}

(async () => {
  const client = new Client({ name: 'l1run', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));

  const cmd = async (command) => {
    await client.callTool({ name: 'run-command', arguments: { command } });
    await sleep(350);
  };
  const give = async (item_name, count = 1) => {
    await client.callTool({ name: 'creative-give', arguments: { item_name, count } });
    await sleep(250);
  };

  // ── 模块 0：重置场地与背包 ──
  await cmd('tp XiaoBai_bot 70 80 70');
  await cmd('clear XiaoBai_bot');
  await cmd('fill 60 78 60 80 78 80 stone');
  await cmd('fill 60 79 60 80 84 80 air');
  await cmd('setblock 72 79 70 chest');
  await cmd('setblock 73 79 70 crafting_table');
  await cmd('setblock 74 79 70 furnace');
  await sleep(500);

  // ── 模块 1：感知（只读）──
  await runGroup(client, '感知', [
    ['pos-raw', {}],
    ['get-state', {}],
    ['observe', {}],
    ['get-block-info', { x: 70, y: 78, z: 70 }],
    ['find-blocks', { block_type: 'stone', max_distance: 16 }],
    ['find-entity', { entity_type: 'player' }],
  ]);

  // ── 模块 2：物品（先清空再给）──
  await cmd('clear XiaoBai_bot');
  await give('wheat', 16);
  await runGroup(client, '物品', [
    ['find-item', { item_name: 'wheat' }],
    ['equip-item', { item_name: 'wheat' }],
    ['drop-item', { item_name: 'wheat', count: 4 }],
  ]);

  // ── 模块 3：箱子（给小麦，存，再清空腾空间，取）──
  await cmd('clear XiaoBai_bot');
  await give('wheat', 8);
  await runGroup(client, '箱子', [
    ['chest-deposit', { item_name: 'wheat', count: 8 }],
  ]);
  await cmd('clear XiaoBai_bot');
  await runGroup(client, '箱子', [
    ['chest-withdraw', { item_name: 'wheat', count: 4 }],
  ]);

  // ── 模块 4：农业（给锄头/种子/骨粉，在 bot 旁的草地上）──
  await cmd('clear XiaoBai_bot');
  await cmd('setblock 70 78 72 dirt');
  await give('stone_hoe', 1);
  await give('wheat_seeds', 8);
  await give('bone_meal', 16);
  await runGroup(client, '农业', [
    ['till-land', { x: 70, y: 78, z: 72 }],
    ['plant-seed', { x: 70, y: 78, z: 72, seed: 'wheat_seeds' }],
    ['use-bone-meal', { x: 70, y: 78, z: 72, times: 8 }],
    ['harvest', { x: 70, y: 78, z: 72 }],
  ]);

  // ── 模块 5：战斗（给剑，召唤僵尸，攻击）──
  await cmd('clear XiaoBai_bot');
  await give('stone_sword', 1);
  await cmd('difficulty easy');
  await cmd('summon zombie 70 79 66');
  await sleep(1500);
  await runGroup(client, '战斗', [
    ['equip-item', { item_name: 'stone_sword' }],
    ['attack-entity', { entity_type: 'zombie' }],
  ]);
  await cmd('kill @e[type=zombie]');

  // ── 模块 6：记忆/任务/知识（自包含，不依赖游戏物品）──
  await runGroup(client, '记忆', [
    ['memory-write', { type: 'event', content: 'L1综合测试写入的一条事件' }],
    ['memory-read', {}],
    ['cross-memory-write', { person: 'l1_person', content: 'L1跨端记忆测试', source: 'game' }],
    ['cross-memory-read', { person: 'l1_person' }],
    ['tasklist-create', { id: 'l1-test', title: 'L1测试任务', steps: [{ desc: '步骤一', tools: [] }] }],
    ['tasklist-list', {}],
    ['knowledge-add', { content: 'L1知识库测试条目' }],
  ]);

  // ── 汇总 ──
  const by = {};
  for (const r of results) {
    by[r.group] = by[r.group] || { pass: 0, fail: 0 };
    r.ok ? by[r.group].pass++ : by[r.group].fail++;
  }
  console.log('\n════════ L1 汇总 ════════');
  let totalP = 0, totalF = 0;
  for (const g of Object.keys(by)) {
    console.log(`${g}: ${by[g].pass} 通过 / ${by[g].fail} 失败`);
    totalP += by[g].pass; totalF += by[g].fail;
  }
  console.log(`\n合计：${totalP} 通过 / ${totalF} 失败 / ${totalP + totalF} 项`);
  await client.close();
})().catch((e) => { console.error('❌ 脚本错误', e.message); process.exit(1); });
