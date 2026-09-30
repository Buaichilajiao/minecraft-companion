/* 跑 skill-build-portal 端到端验证  node tools/run-skill.js */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const client = new Client({ name: 'skillrun', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  const t0 = Date.now();
  const res = await client.callTool({ name: 'skill-build-portal', arguments: {} }, undefined, { timeout: 180000 });
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(res.content.map((c) => c.text).join('\n'));
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
