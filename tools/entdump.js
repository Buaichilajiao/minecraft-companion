// 读附近掉落物 + 背包明细（用 MCP SDK）
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const client = new Client({ name: 'ent', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
    return res.content.map((c) => c.text).join('\n');
  };
  console.log('=== find-entity item ===');
  console.log((await call('find-entity', { entity_type: 'item' })).slice(0, 1200));
  console.log('\n=== get-state ===');
  const gs = await call('get-state');
  console.log(gs.slice(0, 1200));
  await client.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
