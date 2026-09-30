/* 扫描主世界 z=43-46 区域  node tools/scan-over.js */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const client = new Client({ name: 'scano', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
    return res.content.map((c) => c.text).join(' ');
  };
  for (let z = 40; z <= 50; z++) {
    for (let y = 86; y >= 78; y--) {
      let row = `z${z} y${y} `;
      for (let x = 44; x <= 52; x++) {
        const t = await call('get-block-info', { x, y, z });
        const m = t.match(/=\s*(\S+)/);
        const n = m?.[1];
        row += n === 'obsidian' ? 'O' : n === 'nether_portal' ? 'P' : n === 'fire' ? 'F' : n === 'air' ? '·' : 's';
      }
      console.log(row);
    }
  }
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
