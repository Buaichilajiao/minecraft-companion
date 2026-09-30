/* 点火测试 v2：站洞内对左柱/底面打火  node tools/test-ignite.js */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const client = new Client({ name: 'ignite', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
    return res.content.map((c) => c.text).join(' ');
  };
  const hasPortal = async () => {
    for (const [x, y, z] of [[47, 79, 44], [48, 79, 44], [47, 81, 44], [48, 81, 44]]) {
      if ((await call('get-block-info', { x, y, z })).includes('portal')) return true;
    }
    return false;
  };

  // 方案1：站洞内左 (47,78,44)，装备打火石，对左柱内侧 (46,79,44) 右键 → fire (47,79,44)
  console.log('move:', (await call('move-to', { x: 47, y: 78, z: 44, mode: 'fly', tolerance: 0.5 })).slice(0, 70));
  console.log('equip:', (await call('equip-item', { item_name: 'flint_and_steel' })).slice(0, 70));
  console.log('press 左柱:', (await call('press-block', { x: 46, y: 79, z: 44 })).slice(0, 130));
  await new Promise((r) => setTimeout(r, 1600));
  if (await hasPortal()) { console.log('✅ 方案1 点亮！'); await client.close(); return; }

  // 方案2：站洞内右 (48,78,44)，对右柱内侧 (49,79,44) 右键 → fire (48,79,44)
  console.log('move:', (await call('move-to', { x: 48, y: 78, z: 44, mode: 'fly', tolerance: 0.5 })).slice(0, 70));
  console.log('equip:', (await call('equip-item', { item_name: 'flint_and_steel' })).slice(0, 70));
  console.log('press 右柱:', (await call('press-block', { x: 49, y: 79, z: 44 })).slice(0, 130));
  await new Promise((r) => setTimeout(r, 1600));
  if (await hasPortal()) { console.log('✅ 方案2 点亮！'); await client.close(); return; }

  // 方案3：站洞内左，对相邻底面 (48,78,44) 右键
  console.log('move:', (await call('move-to', { x: 47, y: 78, z: 44, mode: 'fly', tolerance: 0.5 })).slice(0, 70));
  console.log('equip:', (await call('equip-item', { item_name: 'flint_and_steel' })).slice(0, 70));
  console.log('press 底面:', (await call('press-block', { x: 48, y: 78, z: 44 })).slice(0, 130));
  await new Promise((r) => setTimeout(r, 1600));
  if (await hasPortal()) { console.log('✅ 方案3 点亮！'); await client.close(); return; }

  console.log('❌ 三方案都没点亮，打印洞内 fire 状态：');
  for (const [x, y, z] of [[47, 79, 44], [48, 79, 44], [47, 78, 45], [48, 78, 45]]) {
    console.log(`(${x},${y},${z})`, (await call('get-block-info', { x, y, z })).match(/=\s*\S+/)?.[0]);
  }
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
