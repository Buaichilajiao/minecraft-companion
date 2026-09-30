/* 通用 MCP 工具调用：node tools/call.js <工具名> [JSON参数] */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');

(async () => {
  const name = process.argv[2];
  let args = {};
  const a3 = process.argv[3];
  if (a3) {
    if (a3.startsWith('@')) {
      let s = require('fs').readFileSync(a3.slice(1), 'utf8');
      if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1); // strip BOM
      args = JSON.parse(s);
    } else args = JSON.parse(a3);
  }
  if (!name) { console.error('用法: node tools/call.js <工具名> [JSON参数 或 @参数文件]'); process.exit(1); }

  const client = new Client({ name: 'call', version: '1.0' }, { capabilities: {} });
  await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));

  console.log(`调用 ${name} ${JSON.stringify(args)} ...`);
  const t0 = Date.now();
  // callTool 签名：(params, resultSchema=CallToolResultSchema, options)。超时放第三参数，别误传给第二参数！
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  console.log(`⏱ ${Date.now() - t0}ms`);
  const text = res.content.map((c) => c.text).join('\n');
  console.log(text);
  if (res.isError) console.log('(工具返回 isError=true)');
  await client.close();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
