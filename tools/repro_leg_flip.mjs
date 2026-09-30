// 【复现·腿间反向 9/12-v4】"回程任务刚开始时，脑袋突然一个 360 度大旋转，速度非常之快"
// 复现的几何：去程尾段（进迷宫）结束 → 停 1.5s（模拟大脑生成下一次工具调用的真实间隔）→ 回程起步（出迷宫）
//   ⇒ 航向正好反向 180°，这是"两侧等长"的平局点，最可疑。
// 观测口径：pos-raw 的 sentYaw = 真正发包的 notchian 度数（已含 headYaw 覆盖）= 别人看到的头部朝向。
// 两条判据必须分开算，别混：
//   ①rawDelta  = 相邻采样【不做角度环绕】的差 → 观察端朴素 lerp（Mth.lerp 不 wrap）看到的转动量
//                 |rawDelta| > 180° ⇒ 视觉上就是"猛地整圈/反向快旋"（哪怕 bot 其实只转了 2°）
//   ②wrapDelta = 取最短弧 → bot 真实转动量；限速 300°/s + 20~50ms 采样 ⇒ 应恒 ≤ ~15°
//   ③是否跨过 notchian 0/360 边界（0° = 朝南 +Z）：跨了就必然触发 ①
// 用法: node tools/repro_leg_flip.mjs [去程from] [去程count] [停顿ms] [回程from] [回程count]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import fs from 'fs';

const fwdFile = process.argv[7] || 'path_maze_rev.txt';
const backFile = process.argv[8] || 'path_maze_back.txt';
const fwdFrom = Number(process.argv[2] ?? 30);
const fwdCount = Number(process.argv[3] ?? 15);
const gapMs = Number(process.argv[4] ?? 1500);
const backFrom = Number(process.argv[5] ?? 1777);
const backCount = Number(process.argv[6] ?? 25);

const client = new Client({ name: 'repro-leg-flip', version: '1.0.0' }, { capabilities: {} });
await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const deg = (r) => (r * 180) / Math.PI;

let phase = 'fwd';
const samples = [];
let busy = false;
const sampler = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const j = JSON.parse(await call('pos-raw'));
    if (typeof j.sentYaw === 'number') {
      samples.push({ t: Date.now(), raw: j.sentYaw, move: deg(j.yaw), x: j.x, z: j.z, phase });
    }
  } catch {
    /* bot 忙/掉线，跳过 */
  }
  busy = false;
}, 20);

await sleep(500);
console.log(`去程(${fwdFile} from=${fwdFrom} count=${fwdCount}): ${await call('walk-path', { file: fwdFile, from: fwdFrom, count: fwdCount, timeLimitSec: 20 })}`);
phase = 'gap';
console.log(`模拟真实间隔 ${gapMs}ms（大脑生成下一次调用）...`);
await sleep(gapMs);
phase = 'back';
console.log(`回程(${backFile} from=${backFrom} count=${backCount}): ${await call('walk-path', { file: backFile, from: backFrom, count: backCount, timeLimitSec: 20 })}`);
await sleep(500);
clearInterval(sampler);
await sleep(200);

// ── 逐样本判定 ──
const rows = [];
for (let i = 1; i < samples.length; i++) {
  const a = samples[i - 1];
  const b = samples[i];
  const dt = (b.t - a.t) / 1000;
  const rawDelta = b.raw - a.raw; // 不做环绕：观察端朴素 lerp 看到的量
  const wrapDelta = deg(wrap(((b.raw - a.raw) * Math.PI) / 180)); // 真实转动量
  rows.push({ ...b, dt, rawDelta, wrapDelta, rate: wrapDelta / dt });
}
const iBack = samples.findIndex((s) => s.phase === 'back');
console.log(`\n采样 ${samples.length} 条；回程起点在第 ${iBack} 条`);

const bad = rows.filter((r) => Math.abs(r.rawDelta) > 180);
console.log(`\n【①观察端快旋】|rawDelta|>180° 的样本: ${bad.length} 个`);
bad.slice(0, 12).forEach((r) => console.log(`   t=+${r.t - samples[0].t}ms phase=${r.phase} raw=${r.raw.toFixed(1)}° rawDelta=${r.rawDelta.toFixed(1)}° (真实只转了 ${r.wrapDelta.toFixed(1)}°)`));

const wrapRates = rows.map((r) => Math.abs(r.rate)).filter((x) => x > 0 && Number.isFinite(x)).sort((a, b) => a - b);
const q = (p) => (wrapRates.length ? wrapRates[Math.min(wrapRates.length - 1, Math.floor(wrapRates.length * p))] : 0);
console.log(`\n【②bot 真实角速度】p50=${q(0.5).toFixed(0)}°/s p90=${q(0.9).toFixed(0)}°/s p99=${q(0.99).toFixed(0)}°/s 峰值=${(wrapRates.at(-1) ?? 0).toFixed(0)}°/s`);

// 回程起步后头到底净转了多少（真实弧长累加）
const win = rows.filter((r) => r.t >= samples[iBack].t - 100 && r.t <= samples[iBack].t + 2500);
let net = 0;
let arc = 0;
for (const r of win) {
  net += r.wrapDelta;
  arc += Math.abs(r.wrapDelta);
}
console.log(`\n【③回程起步窗口】净转角 ${net.toFixed(1)}°（真实方向），累计弧长 ${arc.toFixed(1)}°（≈360° 就说明真绕了一圈，≈180° 说明只是正常掉头）`);
// 边界跨越检测
let crossings = 0;
for (let i = 1; i < win.length; i++) {
  const a = win[i - 1].raw;
  const b = win[i].raw;
  if ((a > 270 && b < 90) || (a < 90 && b > 270)) crossings++;
}
console.log(`【③notchian 0/360 边界跨越】${crossings} 次（0° = 朝南 +Z）`);

// ④起步瞬间有没有"一个包就跳很大角度"= 玩家嘴里"快到看不清的甩头"
const maxStep = rows.reduce((m, r) => Math.max(m, Math.abs(r.wrapDelta)), 0);
console.log(`【④单次发包最大转角】${maxStep.toFixed(1)}°（限速 300°/s + 包 50ms ⇒ 正常应 ≤ ~15°；≥90° 即"瞬间甩头"）`);
console.log(String.fromCharCode(10) + '回程起步 ±1.2s 明细（raw=发包 notchian 度 / dRaw=不做环绕 / dWrap=真实转角 / move=身体朝向）:');
for (let i = Math.max(1, iBack - 20); i < Math.min(rows.length, iBack + 45); i++) {
  const r = rows[i];
  console.log(
    `  +${String(r.t - samples[0].t).padStart(6)}ms ${r.phase.padEnd(4)} raw=${r.raw.toFixed(1).padStart(6)}° dRaw=${r.rawDelta.toFixed(1).padStart(7)}° dWrap=${r.wrapDelta.toFixed(1).padStart(6)}° rate=${r.rate.toFixed(0).padStart(5)}°/s move=${r.move.toFixed(0).padStart(4)}°`
  );
}

fs.writeFileSync(
  'leg_flip_samples.csv',
  't,phase,x,z,moveYawDeg,sentYawRawDeg,rawDelta,wrapDelta\n' +
    rows.map((r) => `${r.t},${r.phase},${r.x.toFixed(2)},${r.z.toFixed(2)},${r.move.toFixed(1)},${r.raw.toFixed(1)},${r.rawDelta.toFixed(1)},${r.wrapDelta.toFixed(1)}`).join('\n')
);
console.log('\n明细已存 leg_flip_samples.csv');
await client.close();
process.exit(0);
