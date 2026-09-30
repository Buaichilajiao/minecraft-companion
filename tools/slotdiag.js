const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
(async () => {
  const client = new Client({ name: 'slot', version: '1.0' });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp?clientId=slot1')));
  // 直接通过 run-command 无法看内部。改用 get-state 全量
  const r = await client.callTool({ name: 'get-state', arguments: {} }, undefined, { timeout: 15000 });
  const t = r.content[0].text;
  // 提取 inventory 部分
  const invMatch = t.match(/"inventory"[\s\S]*?\](,|\s*\])/);
  console.log('INVENTION:');
  console.log(invMatch ? invMatch[0].slice(0, 1500) : '未找到');
  client.close();
})().catch(e => { console.error(String(e)); process.exit(1); });
