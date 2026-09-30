// 【运维·轨迹采样 v2】用 pos-raw 采【原始浮点坐标】（不取整），才看得清拐角是不是真的斜切顶墙。
// 用法: node tools/trace_poll.mjs <out.csv> <durationSec> [periodMs]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import fs from 'fs';

const out = process.argv[2] || 'logs/trace.csv';
const durSec = Number(process.argv[3] || 900);
const periodMs = Number(process.argv[4] || 25);

const client = new Client({ name: 'trace-poller', version: '2.0.0' }, { capabilities: {} });
await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
fs.writeFileSync(out, 't,x,y,z,yaw,onGround\n');

const t0 = Date.now();
let n = 0;
let errs = 0;
while (Date.now() - t0 < durSec * 1000) {
  try {
    const res = await client.callTool({ name: 'pos-raw', arguments: {} });
    const txt = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const j = JSON.parse(txt);
    fs.appendFileSync(
      out,
      `${((Date.now() - t0) / 1000).toFixed(2)},${j.x.toFixed(3)},${j.y.toFixed(3)},${j.z.toFixed(3)},${j.yaw.toFixed(3)},${j.onGround ? 1 : 0}\n`
    );
    n++;
  } catch (e) {
    errs++;
    if (errs < 5) fs.appendFileSync(out, `#err ${String(e?.message ?? e)}\n`);
  }
  if (periodMs > 0) await new Promise((r) => setTimeout(r, periodMs));
}
console.log(`poller done: samples=${n} errs=${errs} elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`);
await client.close();
process.exit(0);
