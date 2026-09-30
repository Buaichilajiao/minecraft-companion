/* 清理旧门框残留黑曜石 */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const client = new Client({ name: 'clean', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));

  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
    return res.content.map((c) => c.text).join(' ');
  };

  // 飞到柱子旁能看见/能挖的位置
  console.log(await call('move-to', { x: 52, y: 79, z: 52, mode: 'fly', tolerance: 0.8 }));

  // 残留黑曜石坐标（从上往下挖）
  const targets = [
    [52, 82, 49], [52, 81, 49], [52, 80, 49], [52, 79, 49], [53, 79, 49],
  ];
  for (const [x, y, z] of targets) {
    console.log(`挖 (${x},${y},${z}):`, await call('dig-block', { x, y, z }));
  }
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
