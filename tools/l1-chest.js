/* L1 箱子存取：chest-deposit wheat x5 → chest-withdraw wheat x3 */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const STEPS = [
  ['chest-deposit', { item_name: 'wheat', count: 5 }],
  ['chest-withdraw', { item_name: 'wheat', count: 3 }],
];

(async () => {
  const client = new Client({ name: 'l1chest', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  for (const [name, args] of STEPS) {
    const t0 = Date.now();
    const res = await client.callTool({ name, arguments: args });
    console.log(`[${name}] ${Date.now() - t0}ms`, (res.isError ? '✗ ' : '✓ ') + res.content.map((c) => c.text).join(' '));
    await new Promise((r) => setTimeout(r, 800));
  }
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
