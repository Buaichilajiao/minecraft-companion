/* 清理 z=44 残留门，恢复石头地面  node tools/clean-portal.js */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const client = new Client({ name: 'clean', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  const cmd = async (command) => {
    const res = await client.callTool({ name: 'run-command', arguments: { command } }, undefined, { timeout: 30000 });
    return res.content.map((c) => c.text).join(' ');
  };

  // 1. 清 portal（内孔 y79-81）
  console.log('清 portal:', (await cmd('fill 46 79 44 49 81 44 air replace nether_portal')).slice(0, 70));
  await new Promise((r) => setTimeout(r, 600));
  // 2. 清上部黑曜石（y79-82）
  console.log('清上部 obsidian:', (await cmd('fill 46 79 44 49 82 44 air replace obsidian')).slice(0, 70));
  await new Promise((r) => setTimeout(r, 600));
  // 3. 底框 y78 黑曜石恢复成石头
  console.log('底框恢复 stone:', (await cmd('fill 46 78 44 49 78 44 stone replace obsidian')).slice(0, 70));
  await new Promise((r) => setTimeout(r, 700));

  // 验证区域
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
    return res.content.map((c) => c.text).join(' ');
  };
  let dirty = 0;
  for (let x = 46; x <= 49; x++) {
    for (let y = 78; y <= 82; y++) {
      const t = await call('get-block-info', { x, y, z: 44 });
      const m = t.match(/=\s*(\S+)/);
      const name = m?.[1];
      if (name === 'obsidian' || name === 'nether_portal') dirty++;
    }
  }
  console.log(dirty === 0 ? '✅ 区域干净（无 obsidian/portal）' : `⚠️ 还剩 ${dirty} 块`);
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
