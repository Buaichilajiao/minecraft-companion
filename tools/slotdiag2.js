const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
(async () => {
  const client = new Client({ name: 'slot', version: '1.0' });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp?clientId=slot2')));
  const r = await client.callTool({ name: 'get-state', arguments: {} }, undefined, { timeout: 15000 });
  const t = r.content[0].text;
  // JSON 可能是 markdown 代码块包裹。提取 self 整段
  const selfStart = t.indexOf('"self"');
  const selfEnd = t.indexOf('"world"');
  console.log(t.slice(selfStart, selfEnd > selfStart ? selfEnd : selfStart + 3000));
  client.close();
})().catch(e => { console.error(String(e)); process.exit(1); });
