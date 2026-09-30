/* 批量给 bot 发放 L1 测试物品（一次性运维脚本，走 run-command MCP 工具） */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const COMMANDS = [
  'give XiaoBai_bot wooden_hoe',
  'give XiaoBai_bot wheat_seeds 32',
  'give XiaoBai_bot bone_meal 32',
  'give XiaoBai_bot fishing_rod',
  'give XiaoBai_bot stone_sword',
  'give XiaoBai_bot stone_pickaxe',
  'give XiaoBai_bot stone_axe',
  'give XiaoBai_bot wheat 32',
  'gamemode creative Buaichilaijiao',
];

(async () => {
  const client = new Client({ name: 'setup', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  for (const command of COMMANDS) {
    const res = await client.callTool({ name: 'run-command', arguments: { command } });
    const text = res.content.map((c) => c.text).join(' ');
    console.log((res.isError ? '✗' : '✓'), text);
    await new Promise((r) => setTimeout(r, 500));
  }
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
