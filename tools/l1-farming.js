/* L1 种田链：till-land → plant-seed → use-bone-meal（bot 在 50,79,50，脚下 50,78,50） */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

const STEPS = [
  ['till-land', {}],
  ['plant-seed', { seed: 'wheat_seeds' }],
  ['use-bone-meal', { x: 50, y: 79, z: 50, times: 10 }],
];

(async () => {
  const client = new Client({ name: 'l1farm', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  for (const [name, args] of STEPS) {
    const t0 = Date.now();
    const res = await client.callTool({ name, arguments: args });
    console.log(`[${name}] ${Date.now() - t0}ms`, (res.isError ? '✗ ' : '✓ ') + res.content.map((c) => c.text).join(' '));
    await new Promise((r) => setTimeout(r, 800));
  }
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
