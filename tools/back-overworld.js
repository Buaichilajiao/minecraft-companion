/* 读 bot 精确位置 + 把 bot 传回主世界  node tools/back-overworld.js */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const client = new Client({ name: 'back', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
    return res.content.map((c) => c.text).join(' ');
  };

  const state = JSON.parse(await call('get-state', {}));
  console.log('维度:', state.world.dimension, '模式:', state.world.game_mode);
  console.log('位置:', JSON.stringify(state.self.position));
  const home = state.self?.home;
  console.log('home:', JSON.stringify(home));

  // 传回主世界高空（先到安全位置 y100）
  const cmd = async (command) => {
    const res = await client.callTool({ name: 'run-command', arguments: { command } }, undefined, { timeout: 30000 });
    return res.content.map((c) => c.text).join(' ');
  };
  console.log('传送:', (await cmd('execute as XiaoBai_bot in minecraft:overworld run tp @s 48 100 44')).slice(0, 90));
  await new Promise((r) => setTimeout(r, 2500));
  const s2 = JSON.parse(await call('get-state', {}));
  console.log('现在维度:', s2.world.dimension, '位置:', JSON.stringify(s2.self.position));
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
