const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
(async () => {
  const client = new Client({ name: 'blk', version: '1.0' });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp?clientId=blk1')));
  // 物品在 (-39,64,64) 附近。打印 x=-40..-38, y=62..65, z=62..64 的方块
  const r = await client.callTool({ name: 'observe', arguments: {} }, undefined, { timeout: 15000 });
  console.log(r.content[0].text);
  // 列出所有物品实体精确位置
  const st = await client.callTool({ name: 'get-state', arguments: {} }, undefined, { timeout: 15000 });
  const t = st.content[0].text;
  console.log(t.split('\n').filter(l => /实体|entity|item|附近|位置|position|y:|物品/i.test(l)).slice(0, 20).join('\n'));
  client.close();
})().catch(e => { console.error(String(e)); process.exit(1); });
