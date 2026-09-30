// 【运维·MCP 直连】绕过 AstrBot 的工具缓存，直接调 bot 进程暴露的任意 MCP 工具。
// 用途：新加的工具当前对话调不到（AstrBot 侧列表是会话启动时缓存的），但它已经在本进程注册好了。
// 用法: node tools/mcp_call.mjs <tool> <args.json>     # args.json 为对象；若为数组则自动包成 {regions:[...]}
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import fs from 'fs';

const [, , toolName, argsFile] = process.argv;
if (!toolName || !argsFile) {
  console.error('用法: node tools/mcp_call.mjs <tool> <args.json>');
  process.exit(2);
}
let args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
if (Array.isArray(args)) args = { regions: args };

const client = new Client({ name: 'ops-cli', version: '1.0.0' }, { capabilities: {} });
const transport = new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp'));
const t0 = Date.now();
try {
  await client.connect(transport);
  const res = await client.callTool({ name: toolName, arguments: args });
  const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${toolName}${res.isError ? ' ✗' : ' ✓'}: ${text}`);
  await client.close();
  process.exit(res.isError ? 1 : 0);
} catch (e) {
  console.error('调用失败:', e?.message ?? e);
  process.exit(3);
}
