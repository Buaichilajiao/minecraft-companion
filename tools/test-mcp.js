/* L0 冒烟测试：连接 companion MCP，列出工具，调用只读工具 */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const url = process.argv[2] || 'http://127.0.0.1:3001/mcp';
  const client = new Client({ name: 'test-mcp', version: '1.0' }, { capabilities: {} });
  const transport = new SSEClientTransport(new URL(url));

  console.log('连接', url, '...');
  await client.connect(transport);
  console.log('✅ MCP 握手成功');

  const res = await client.listTools();
  const tools = res.tools;
  console.log(`✅ 工具数量: ${tools.length}`);
  console.log('工具清单:');
  for (const t of tools) console.log('  -', t.name);

  // 调用只读工具 get-state
  try {
    const state = await client.callTool({ name: 'get-state', arguments: {} });
    const text = state.content.map((c) => c.text).join('\n');
    console.log('\n=== get-state 返回 ===');
    console.log(text.slice(0, 800));
  } catch (e) {
    console.log('❌ get-state 失败:', e.message);
  }

  await client.close();
})().catch((e) => { console.error('❌', e); process.exit(1); });
