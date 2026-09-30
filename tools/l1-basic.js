/* L1 基础动作测试：依次调用若干只读/瞬时工具，打印返回 */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const CALLS = [
  ['pos-raw', {}],
  ['observe', {}],
  ['jump', {}],
];

(async () => {
  const client = new Client({ name: 'l1', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  for (const [name, args] of CALLS) {
    const t0 = Date.now();
    try {
      const res = await client.callTool({ name, arguments: args });
      const text = res.content.map((c) => c.text).join('\n');
      console.log(`\n===== ${name} (${Date.now() - t0}ms) =====`);
      console.log(text.slice(0, 600));
      if (res.isError) console.log('  [isError]');
    } catch (e) {
      console.log(`\n===== ${name} ❌ ${e.message}`);
    }
  }
  await client.close();
})().catch((e) => { console.error('❌', e); process.exit(1); });
