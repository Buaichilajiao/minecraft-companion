// 打印 recipe 结构，研究如何精确计算材料能支持的合成次数
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const client = new Client({ name: 'rec', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  // 用 run-command 不行（无OP）。改用一个临时方式：直接在 node 里拿 bot 不可行（bot在另一个进程）。
  // 用 get-state 看不到 recipe。改测 recipesFor 行为：通过 craft-item 不同 count 观察。
  // 这里直接读 mineflayer 的 Recipe 类型定义。
  const fs = require('fs');
  const base = 'D:/下载/minecraft-companion/node_modules/mineflayer';
  const rf = fs.readFileSync(base + '/lib/plugins/craft.js', 'utf8');
  // 找 recipe 字段使用
  const m = rf.match(/recipe\.(delta|ingredients|result|requiresTable)[^\n]*/g);
  console.log('=== craft.js 中 recipe 字段使用 ===');
  console.log([...new Set(m)].slice(0, 30).join('\n'));
  await client.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
