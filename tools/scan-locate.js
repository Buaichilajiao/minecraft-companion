/* 扫描定位新门框：输出 obsidian/portal 矩阵  node tools/scan-locate.js */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const client = new Client({ name: 'scan', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
    return res.content.map((c) => c.text).join(' ');
  };

  for (let y = 85; y >= 77; y--) {
    let row = `y${y} `;
    for (let x = 42; x <= 52; x++) {
      let cell = '·';
      for (let z = 40; z <= 47; z++) {
        const t = await call('get-block-info', { x, y, z });
        const m = t.match(/=\s*(\S+)/);
        if (m?.[1] === 'obsidian') { cell = 'O'; }
        else if (m?.[1] === 'nether_portal') { cell = 'P'; }
        else if (m?.[1] === 'fire') { cell = 'F'; }
      }
      row += cell;
    }
    console.log(row);
  }
  // 精确列出 O/P/F 的 z 坐标
  console.log('\n=== 精确位置 ===');
  for (let x = 42; x <= 52; x++) {
    for (let y = 77; y <= 85; y++) {
      for (let z = 40; z <= 47; z++) {
        const t = await call('get-block-info', { x, y, z });
        const m = t.match(/=\s*(\S+)/);
        if (m?.[1] === 'obsidian' || m?.[1] === 'nether_portal' || m?.[1] === 'fire') {
          console.log(`${m[1]} (${x},${y},${z})`);
        }
      }
    }
  }
  // bot 位置
  const pos = await call('get-position', {});
  console.log('\nbot 位置:', pos.slice(0, 120));
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
