/* 诊断侧柱 stand 可见性：setblock 底框 → 逐候选站位 look-at + crosshair
   node tools/diag-stand.js */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const c = new Client({ name: 'diag', version: '1' }, { capabilities: {} });
  await c.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  const call = async (name, args) => {
    const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
    return r.content.map((x) => x.text).join(' ');
  };
  const cmd = async (command) => call('run-command', { command });

  // 1. setblock 底框 4 块（y79 x47-50 z43）
  for (let x = 47; x <= 50; x++) {
    await cmd(`setblock ${x} 79 43 minecraft:obsidian`);
  }
  console.log('底框已建');

  // 目标：放 (47,80,43)，refPos=(47,79,43)
  const ref = { x: 47, y: 79, z: 43 };
  const targetCenter = { x: 47.5, y: 79.5, z: 43.5 };
  // 候选 stand（门后 z=44 侧 + 门两侧）
  const stands = [
    { x: 47, y: 80, z: 44, tag: '正后' },
    { x: 48, y: 80, z: 43, tag: '右内' },
    { x: 46, y: 80, z: 43, tag: '左外' },
    { x: 47, y: 80, z: 42, tag: '正前' },
    { x: 46, y: 79, z: 43, tag: '左外y79' },
    { x: 47, y: 79, z: 44, tag: '正后y79' },
  ];
  for (const s of stands) {
    // tp 到 stand（眼位 y = s.y+1.8）
    await cmd(`tp XiaoBai_bot ${s.x + 0.5} ${s.y} ${s.z + 0.5}`);
    await new Promise((r) => setTimeout(r, 600));
    // lookAt refPos center
    await call('look-at', { x: targetCenter.x, y: targetCenter.y, z: targetCenter.z });
    await new Promise((r) => setTimeout(r, 300));
    const ch = await call('crosshair', {});
    console.log(`[${s.tag}] stand(${s.x},${s.y},${s.z}) → ${ch.replace(/\s+/g, ' ').slice(0, 90)}`);
  }
  await c.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
