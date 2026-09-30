/* 验证：给无底框门加黑曜底框后点火  node tools/test-frame.js */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const client = new Client({ name: 'frame', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  const cmd = async (command) => {
    const res = await client.callTool({ name: 'run-command', arguments: { command } }, undefined, { timeout: 30000 });
    return res.content.map((c) => c.text).join(' ');
  };
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
    return res.content.map((c) => c.text).join(' ');
  };

  // 1. 清掉当前 fire
  console.log('清 fire:', (await cmd('setblock 48 79 44 air')).slice(0, 60));
  await new Promise((r) => setTimeout(r, 600));

  // 2. 把内孔底面（47/48,78,44）换成黑曜石
  console.log('底47:', (await cmd('setblock 47 78 44 obsidian')).slice(0, 60));
  console.log('底48:', (await cmd('setblock 48 78 44 obsidian')).slice(0, 60));
  await new Promise((r) => setTimeout(r, 800));

  // 3. bot 站到洞内 (47,79,44)，装备打火石
  console.log('move:', (await call('move-to', { x: 47, y: 79, z: 44, mode: 'fly', tolerance: 0.5 })).slice(0, 70));
  console.log('equip:', (await call('equip-item', { item_name: 'flint_and_steel' })).slice(0, 70));

  // 4. 对底面黑曜石 (47,78,44) 内侧顶面打火（press 看下）
  console.log('press 底面:', (await call('press-block', { x: 47, y: 78, z: 44 })).slice(0, 130));
  await new Promise((r) => setTimeout(r, 1800));

  // 5. 检查 portal
  for (const [x, y, z] of [[47, 79, 44], [48, 79, 44], [47, 81, 44], [48, 81, 44]]) {
    const t = await call('get-block-info', { x, y, z });
    console.log(`(${x},${y},${z})`, t.match(/=\s*\S+/)?.[0]);
  }
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
