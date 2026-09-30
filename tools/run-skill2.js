/* 通用 skill 调用  node tools/run-skill2.js <skill-name> [timeout秒] */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const skill = process.argv[2] || 'skill-build-portal';
const tmo = (Number(process.argv[3]) || 120) * 1000;

(async () => {
  const client = new Client({ name: 'skillrun', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  const t0 = Date.now();
  const res = await client.callTool({ name: skill, arguments: {} }, undefined, { timeout: tmo });
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(res.content.map((c) => c.text).join('\n'));
  await client.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
