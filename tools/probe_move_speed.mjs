// 【距离调速探针 9/12】给一次移动打速度曲线：每 40ms 采样 pos-raw，按相邻位移/时间算水平速度（格/秒）。
// 用途：验证"远 → 疾跑/跑跳、近目标 → 收成走"到底有没有生效（行走 4.3 / 疾跑 5.6 / 跑跳 ≈7.1 格每秒）。
// 用法:
//   node tools/probe_move_speed.mjs walk-path <路点文件> <from> <count>
//   node tools/probe_move_speed.mjs move-to <x> <y> <z>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const [mode, ...rest] = process.argv.slice(2);
const client = new Client({ name: 'probe-move-speed', version: '1.0.0' }, { capabilities: {} });
await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const samples = [];
let busy = false;
const t0 = Date.now();
const SAMPLE = process.env.SAMPLE !== '0';
const sampler = SAMPLE
  ? setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const j = JSON.parse(await call('pos-raw'));
        samples.push({ t: Date.now() - t0, x: j.x, y: j.y, z: j.z });
      } catch {
        /* bot 忙，跳过 */
      }
      busy = false;
    }, 40)
  : null;

await sleep(500);
let msg = '';
if (mode === 'walk-path') {
  msg = await call('walk-path', { file: rest[0], from: Number(rest[1] ?? 1), count: Number(rest[2] ?? 20), timeLimitSec: 20 });
} else {
  msg = await call('move-to', { x: Number(rest[0]), y: Number(rest[1]), z: Number(rest[2]), mode: 'walk' });
}
await sleep(400);
if (sampler) clearInterval(sampler);
console.log(`调用结果: ${msg}`);
console.log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)}s（含前后各 0.5/0.4s 固定开销）`);
if (!samples.length) process.exit(0);
console.log(`起点 (${samples[0]?.x.toFixed(1)}, ${samples[0]?.z.toFixed(1)}) → 终点 (${samples.at(-1)?.x.toFixed(1)}, ${samples.at(-1)?.z.toFixed(1)})，采样 ${samples.length} 条`);

const seg = [];
for (let i = 1; i < samples.length; i++) {
  const dt = (samples[i].t - samples[i - 1].t) / 1000;
  const d = Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z);
  if (dt > 0.005) seg.push({ t: samples[i].t, v: d / dt, d });
}
if (!seg.length) process.exit(0);
const B = 500;
const maxT = seg.at(-1).t;
console.log('时间片速度（格/秒）:');
for (let s = 0; s < maxT; s += B) {
  const a = seg.filter((x) => x.t >= s && x.t < s + B);
  if (!a.length) continue;
  const v = a.reduce((p, c) => p + c.v, 0) / a.length;
  console.log(`  ${(s / 1000).toFixed(1)}–${((s + B) / 1000).toFixed(1)}s   v≈${v.toFixed(2)}${v > 6.2 ? '  ← 跑跳' : v > 4.9 ? '  ← 疾跑' : v > 0.5 ? '  ← 走' : ''}`);
}
const vs = seg.map((x) => x.v).sort((a, b) => a - b);
const q = (p) => vs[Math.min(vs.length - 1, Math.floor(vs.length * p))];
console.log(`速度分布: p50=${q(0.5).toFixed(2)}  p90=${q(0.9).toFixed(2)}  max=${vs.at(-1).toFixed(2)} 格/秒`);
const last = seg.slice(-Math.ceil(seg.length * 0.2));
console.log(`末段(最后20%)平均: ${(last.reduce((p, c) => p + c.v, 0) / last.length).toFixed(2)} 格/秒`);
