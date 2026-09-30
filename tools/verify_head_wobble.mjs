// 【验证·摆头 9/12-v3】量化"弯道密集的地方疯狂左右摆头，速度非常快"。
// 做法：一边让 walk-path 连续走迷宫（含多个直角拐弯），一边用 pos-raw 以 ~20ms 采样
// 【实际发包朝向】sentYaw（= 别人看到的头部朝向，已含 headYaw 覆盖），离线算：
//   ①头部角速度分位/峰值 —— "速度非常之快"的量化
//   ②左右反转段 —— 肉眼看到的"摆头"次数（相邻两段振幅都 ≥8° 才算一次来回）
//   ③头身夹角(位移方向 entity.yaw vs 发包头部朝向) —— 头身解耦后该值变大是【有意为之】(头先转)
// 用法: node tools/verify_head_wobble.mjs <路点文件> <from> <count> [批次数]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import fs from 'fs';

const file = process.argv[2] || 'path_maze_rev.txt';
const from0 = Number(process.argv[3] || 0);
const count = Number(process.argv[4] || 60);
const batches = Number(process.argv[5] || 2);

const client = new Client({ name: 'head-wobble-check', version: '1.0.0' }, { capabilities: {} });
await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
};
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const notchianToYaw = (d) => Math.PI - (d * Math.PI) / 180;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deg = (r) => (r * 180) / Math.PI;

const samples = [];
let busy = false;
const sampler = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const j = JSON.parse(await call('pos-raw'));
    if (typeof j.sentYaw === 'number') {
      samples.push({ t: Date.now(), x: j.x, z: j.z, move: j.yaw, head: notchianToYaw(j.sentYaw) });
    }
  } catch {
    /* bot 忙/掉线，跳过 */
  }
  busy = false;
}, 20);
await sleep(600);

let cur = from0;
for (let b = 0; b < batches; b++) {
  const t = await call('walk-path', { file, from: cur, count, timeLimitSec: Number(process.argv[6] || 30) });
  console.log(`batch${b + 1}: ${t}`);
  const m = t.match(/到第\s*(\d+)\s*\//);
  if (!m) break;
  cur = Number(m[1]);
}
await sleep(300);
clearInterval(sampler);

// ── 离线分析 ──
const pairs = [];
for (let i = 1; i < samples.length; i++) {
  const a = samples[i - 1];
  const b = samples[i];
  const dt = (b.t - a.t) / 1000;
  if (dt <= 0 || dt > 0.4) continue;
  pairs.push({
    t: b.t,
    rate: deg(wrap(b.head - a.head)) / dt,
    dHead: deg(wrap(b.head - a.head)),
    gap: Math.abs(deg(wrap(b.move - b.head)))
  });
}
const rates = pairs.map((p) => Math.abs(p.rate)).sort((x, y) => x - y);
const q = (p) => (rates.length ? rates[Math.min(rates.length - 1, Math.floor(rates.length * p))] : 0);
console.log(`\n采样 ${samples.length} 条 / 有效相邻对 ${pairs.length}`);
console.log(
  `头部角速度: p50=${q(0.5).toFixed(0)}°/s p90=${q(0.9).toFixed(0)}°/s p99=${q(0.99).toFixed(0)}°/s 峰值=${(rates.at(-1) ?? 0).toFixed(0)}°/s`
);
console.log(
  `快速摆头采样点: >400°/s 共 ${pairs.filter((p) => Math.abs(p.rate) > 400).length} 个；>800°/s 共 ${pairs.filter((p) => Math.abs(p.rate) > 800).length} 个`
);

// 左右反转：连续同号归一段，相邻两段振幅都 ≥8° 记一次"来回摆"
const segs = [];
let accSign = 0;
let accAmp = 0;
for (const p of pairs) {
  const s = Math.sign(p.dHead);
  if (s === 0) continue;
  if (s === accSign) accAmp += Math.abs(p.dHead);
  else {
    if (accSign !== 0) segs.push({ sign: accSign, amp: accAmp });
    accSign = s;
    accAmp = Math.abs(p.dHead);
  }
}
if (accSign !== 0) segs.push({ sign: accSign, amp: accAmp });
let reversals = 0;
let bigReversals = 0;
for (let i = 1; i < segs.length; i++) {
  if (segs[i - 1].amp >= 8 && segs[i].amp >= 8) {
    reversals++;
    if (segs[i - 1].amp >= 15 && segs[i].amp >= 15) bigReversals++;
  }
}
const span = (samples.at(-1).t - samples[0].t) / 1000;
console.log(
  `方向反转段 ${segs.length} 个 → "两边都 ≥8°"的来回摆 ${reversals} 次（≥15° 的 ${bigReversals} 次），全程 ${span.toFixed(1)}s`
);
console.log(
  `头身夹角(位移方向 vs 发包头部): 平均 ${(pairs.reduce((a, p) => a + p.gap, 0) / Math.max(pairs.length, 1)).toFixed(1)}° 峰值 ${pairs.reduce((m, p) => Math.max(m, p.gap), 0).toFixed(1)}°`
);
fs.writeFileSync(
  'head_wobble_samples.csv',
  't,x,z,moveYawDeg,headYawDeg\n' +
    samples.map((s) => `${s.t},${s.x.toFixed(2)},${s.z.toFixed(2)},${deg(s.move).toFixed(1)},${deg(s.head).toFixed(1)}`).join('\n')
);
console.log('采样明细已存 head_wobble_samples.csv');
await client.close();
process.exit(0);
