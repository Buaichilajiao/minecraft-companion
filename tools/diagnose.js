/* 分步诊断：connect → listTools → callTool，定位 v3Schema.safeParse 错误环节 */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const client = new Client({ name: 'diag', version: '1' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
  console.log('--- listTools ---');
  try {
    const tools = await client.listTools();
    console.log('工具数:', tools.tools.length);
  } catch (e) { console.log('listTools 错误:', e.message); }

  console.log('--- callTool get-state ---');
  try {
    const r = await client.callTool({ name: 'get-state', arguments: {} });
    console.log('成功:', String(r.content[0].text).slice(0, 80));
  } catch (e) { console.log('callTool 错误:', e.message, e.data ? JSON.stringify(e.data) : ''); }
  await client.close();
})().catch((e) => { console.error('顶层错误:', e); process.exit(1); });
