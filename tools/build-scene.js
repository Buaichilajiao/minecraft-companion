/* 搭建 L1 人工测试平台（走 run-command）。分阶段，先建平台+传送，截图确认后再细化场景 */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const COMMANDS = [
  // 关键：先清空平台区域上方（否则 tp 可能落进原有的实心地形，重蹈窒息）
  'fill 38 79 38 62 96 62 air',
  // 25x25 平台（顶层草方块 y78，垫层泥土 y77）——幂等重填，补掉任何坑
  'fill 40 78 40 60 78 60 grass_block',
  'fill 40 77 40 60 77 60 dirt',
  // 玩家切创造（防止高空掉落摔伤/掉进坑），清掉散落掉落物
  'gamemode creative Buaichilaijiao',
  'kill @e[type=item]',
  // bot 与玩家传送到平台
  'tp XiaoBai_bot 50 79 50',
  'tp Buaichilaijiao 50 82 55',
];

(async () => {
  const client = new Client({ name: 'build', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  for (const command of COMMANDS) {
    const res = await client.callTool({ name: 'run-command', arguments: { command } });
    console.log((res.isError ? '✗' : '✓'), res.content.map((c) => c.text).join(' '));
    await new Promise((r) => setTimeout(r, 700));
  }
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
