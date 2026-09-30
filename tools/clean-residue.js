/* 清理当前残留黑曜石：node tools/clean-residue.js */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const client = new Client({ name: 'clean', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));

  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
    return res.content.map((c) => c.text).join(' ');
  };

  // 飞到残留旁（z=46 是门框前方）
  console.log(await call('move-to', { x: 48, y: 79, z: 46, mode: 'fly', tolerance: 0.8 }));

  // 残留坐标（从上往下挖）
  const targets = [
    [48, 80, 45], [48, 79, 45], [51, 79, 45], [50, 79, 47],
  ];
  for (const [x, y, z] of targets) {
    console.log(`挖 (${x},${y},${z}):`, (await call('dig-block', { x, y, z })).slice(0, 120));
  }
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
