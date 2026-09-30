/* L1 第二批：移动 / 建造 / 合成 / 熔炼，含 PASS/FAIL 汇总 */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function record(group, name, ok, detail) {
  results.push({ group, name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} [${group}] ${name}${detail ? ' — ' + detail : ''}`);
}
async function call(client, group, name, args, expectOk = true) {
  const t0 = Date.now();
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content.map((x) => x.text).join(' ');
    const isErr = res.isError || text.trimStart().startsWith('❌');
    const ok = expectOk ? !isErr : isErr;
    record(group, name, ok, `${Date.now() - t0}ms ${text.slice(0, 80)}`);
  } catch (e) {
    record(group, name, false, `异常 ${e.message.slice(0, 60)}`);
  }
}

(async () => {
  const client = new Client({ name: 'l1run2', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  const cmd = async (c) => { await client.callTool({ name: 'run-command', arguments: { command: c } }); await sleep(350); };
  const give = async (item_name, count = 1) => { await client.callTool({ name: 'creative-give', arguments: { item_name, count } }); await sleep(250); };

  // 重置场地
  await cmd('fill 60 78 60 80 84 80 air');
  await cmd('fill 60 78 60 80 78 80 stone');
  await cmd('setblock 74 79 70 furnace');
  await cmd('tp XiaoBai_bot 70 79 70');
  await sleep(500);

  // ── 移动（真实，不用 /tp）──
  await call(client, '移动', 'move-to', { x: 70, y: 79, z: 72, mode: 'walk' });
  await call(client, '移动', 'look-at', { x: 72, y: 79, z: 70 });
  await call(client, '移动', 'move-to', { x: 70, y: 81, z: 70, mode: 'fly' });
  await cmd('tp XiaoBai_bot 70 79 70');

  // ── 建造 ──
  await cmd('clear XiaoBai_bot');
  await give('cobblestone', 24);
  await call(client, '建造', 'place-block', { block_type: 'cobblestone', x: 76, y: 79, z: 70 });
  await call(client, '建造', 'fill-region', { regions: [{ x1: 77, y1: 79, z1: 70, x2: 78, y2: 79, z2: 70, block: 'cobblestone' }] });
  await cmd('setblock 76 80 70 stone_button');
  await call(client, '建造', 'press-block', { x: 76, y: 80, z: 70 });
  await call(client, '建造', 'crosshair', { max_distance: 6 });
  await call(client, '建造', 'check-reach', { x: 76, y: 79, z: 70 });
  await call(client, '建造', 'check-harvest', { x: 76, y: 79, z: 70 });

  // ── 合成 ──
  await cmd('clear XiaoBai_bot');
  await give('oak_log', 4);
  await call(client, '合成', 'craft-item', { item_name: 'oak_planks', count: 4 });
  await call(client, '合成', 'craft-item', { item_name: 'stick', count: 4 });

  // ── 熔炼 ──
  await cmd('clear XiaoBai_bot');
  await give('raw_iron', 2);
  await give('coal', 4);
  await cmd('tp XiaoBai_bot 72 79 70');
  await call(client, '熔炼', 'smelt-batch', { item_name: 'raw_iron', result_name: 'iron_ingot', count: 2, fuel: 'coal' });

  // 汇总
  const by = {};
  let tp = 0, tf = 0;
  for (const r of results) {
    by[r.group] = by[r.group] || { p: 0, f: 0 };
    r.ok ? by[r.group].p++ : by[r.group].f++;
    r.ok ? tp++ : tf++;
  }
  console.log('\n════════ L1 第二批汇总 ════════');
  for (const g of Object.keys(by)) console.log(`${g}: ${by[g].p} 通过 / ${by[g].f} 失败`);
  console.log(`\n合计：${tp} 通过 / ${tf} 失败 / ${tp + tf} 项`);
  await client.close();
})().catch((e) => { console.error('❌ 脚本错误', e.message); process.exit(1); });
