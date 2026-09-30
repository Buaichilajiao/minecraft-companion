/* 场景二：召唤2头牛（繁殖）+ 放箱子 + 安置 */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const COMMANDS = [
  'summon cow 45 79 44',
  'summon cow 47 79 44',
  'setblock 45 78 50 chest',
  'gamemode creative Buaichilaijiao',
  'tp XiaoBai_bot 46 79 48',
  'tp Buaichilaijiao 46 84 48',
];

(async () => {
  const client = new Client({ name: 'scene2', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  for (const command of COMMANDS) {
    const res = await client.callTool({ name: 'run-command', arguments: { command } });
    console.log((res.isError ? '✗' : '✓'), res.content.map((c) => c.text).join(' '));
    await new Promise((r) => setTimeout(r, 700));
  }
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
