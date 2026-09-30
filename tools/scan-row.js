/* 扫描门框区域，打印所有非空气方块：node tools/scan-row.js */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const client = new Client({ name: 'scan', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));

  const q = async (x, y, z) => {
    const res = await client.callTool({ name: 'get-block-info', arguments: { x, y, z } }, undefined, { timeout: 15000 });
    return res.content.map((c) => c.text).join(' ');
  };

  for (let z = 48; z <= 50; z++) {
    console.log(`──── z=${z} ────`);
    for (let y = 83; y >= 78; y--) {
      let row = '';
      for (let x = 50; x <= 57; x++) {
        const t = await q(x, y, z);
        const m = t.match(/=\s*(\S+)/);
        let nm = m ? m[1] : '?';
        nm = nm.replace(/\(.*$/, '');
        // 压缩成简短符号
        const sym = nm === 'air' ? '.' :
          nm === 'obsidian' ? 'O' :
          nm === 'stone' ? 's' :
          nm === 'fire' ? 'F' :
          nm.includes('portal') ? 'P' : nm[0];
        row += sym.padEnd(4);
      }
      console.log(`y${y}: ${row}`);
    }
  }
  console.log('图例: . 空气, O 黑曜石, s 石头, F 火, P 传送门');
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
