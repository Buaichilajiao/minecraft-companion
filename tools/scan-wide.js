/* 扩大扫描：node tools/scan-wide.js */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const client = new Client({ name: 'scan', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));

  const q = async (x, y, z) => {
    const res = await client.callTool({ name: 'get-block-info', arguments: { x, y, z } }, undefined, { timeout: 15000 });
    const t = res.content.map((c) => c.text).join(' ');
    const m = t.match(/=\s*(\S+)/);
    let nm = m ? m[1] : '?';
    nm = nm.replace(/\(.*$/, '');
    return nm === 'air' ? '.' :
      nm === 'obsidian' ? 'O' :
      nm === 'stone' ? 's' :
      nm === 'fire' ? 'F' :
      nm.includes('portal') ? 'P' : nm[0];
  };

  for (let z = 44; z <= 48; z++) {
    console.log(`──── z=${z} ────`);
    for (let y = 84; y >= 78; y--) {
      let row = '';
      for (let x = 46; x <= 54; x++) {
        row += (await q(x, y, z)).padEnd(3);
      }
      console.log(`y${y}: ${row}`);
    }
  }
  console.log('x: 46  47  48  49  50  51  52  53  54');
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
