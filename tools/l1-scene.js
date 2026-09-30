/* L1 测试场景准备：建平台、放设施、给 bot 准备测试物品 */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const client = new Client({ name: 'l1scene', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));

  const cmd = async (command) => {
    const res = await client.callTool({ name: 'run-command', arguments: { command } });
    const t = res.content.map((c) => c.text).join(' ');
    console.log(`[cmd] ${command} -> ${t.slice(0, 50)}`);
    await sleep(400);
  };
  const give = async (item_name, count) => {
    const res = await client.callTool({ name: 'creative-give', arguments: { item_name, count } });
    console.log(`[give] ${item_name} x${count} -> ${res.content.map((c) => c.text).join(' ').slice(0, 60)}`);
    await sleep(300);
  };

  // 场地中心：x=70 z=70
  await cmd('tp XiaoBai_bot 70 80 70');
  await cmd('fill 60 78 60 80 78 80 stone');
  await cmd('fill 60 79 60 80 84 80 air');
  // 设施：箱子、工作台、熔炉、床（在 bot 旁边）
  await cmd('setblock 72 79 70 chest');
  await cmd('setblock 73 79 70 crafting_table');
  await cmd('setblock 74 79 70 furnace');
  await cmd('setblock 70 79 72 red_bed');

  // 给 bot 准备测试物品
  await give('wheat', 32);
  await give('wheat_seeds', 16);
  await give('stone_sword', 1);
  await give('stone_hoe', 1);
  await give('bone_meal', 32);
  await give('cobblestone', 32);
  await give('oak_log', 16);
  await give('oak_planks', 32);
  await give('stick', 16);
  await give('diamond', 8);
  await give('iron_ingot', 16);

  console.log('\n场景准备完成，bot 位于 (70,80,70)，设施在 72-74,79,70，床在 70,79,72');
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
