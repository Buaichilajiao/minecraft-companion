/* get-state + 小范围扫描定位  node tools/where.js */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const client = new Client({ name: 'where', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
    return res.content.map((c) => c.text).join(' ');
  };

  const state = await call('get-state', {});
  console.log('=== STATE ===');
  console.log(state.slice(0, 600));

  // 小范围扫描 x43-49, z40-44, y78-84
  console.log('\n=== 扫描（x43-49 / z40-44）===');
  for (let y = 84; y >= 78; y--) {
    for (let z = 40; z <= 44; z++) {
      let row = `y${y} z${z} `;
      for (let x = 43; x <= 49; x++) {
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
