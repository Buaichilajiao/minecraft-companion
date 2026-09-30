/* 诊断 smartPlace 放第一块底框的就位点计算  node tools/diag-place.js */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const c = new Client({ name: 'diag', version: '1' }, { capabilities: {} });
  await c.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  const call = async (name, args) => {
    const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
    return r.content.map((x) => x.text).join(' ');
  };

  // 先 get-state 确认 bot 在线 + 位置
  const st = JSON.parse(await call('get-state', {}));
  console.log('维度:', st.world.dimension, '模式:', st.world.game_mode, '位置:', JSON.stringify(st.self.position));

  // 假设选址 anchor = (47,78,43)，放第一块底框 (47,79,43)，refPos = below = (47,78,43)
  const ref = { x: 47, y: 78, z: 43 };
  const target = { x: 47, y: 79, z: 43 };
  // 复现 standCandidates
  const blockName = async (x, y, z) => {
    const t = await call('get-block-info', { x, y, z });
    const m = t.match(/=\s*(\S+)/);
    return m?.[1] ?? '?';
  };
  console.log('\n=== standCandidates around', JSON.stringify(ref), '===');
  const cands = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 3) continue;
        const p = { x: ref.x + dx, y: ref.y + dy, z: ref.z + dz };
        const b = await blockName(p.x, p.y, p.z);
        const below = await blockName(p.x, p.y - 1, p.z);
        const isAir = b === 'air';
        const supported = below !== 'air' && below !== 'water' && !below.includes('lava');
        if (isAir && supported) cands.push(p);
      }
    }
  }
  // 排除目标格
  const filtered = cands.filter((p) => !(p.x === target.x && p.y === target.y && p.z === target.z));
  console.log('候选就位点（空气+支撑，排除目标）:');
  filtered.forEach((p) => console.log('  ', JSON.stringify(p)));
  await c.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
