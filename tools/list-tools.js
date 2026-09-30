/* 列出所有工具名  node tools/list-tools.js */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const client = new Client({ name: 'list', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  const tools = await client.listTools();
  console.log(tools.tools.map((t) => t.name).join('\n'));
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
