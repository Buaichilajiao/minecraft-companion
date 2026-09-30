// 【验证·头身同步 9/12】量化"转头慢半拍"：从下指令到下位机【实际发包朝向】(sentYaw=别人看到的头部朝向) 到位要多久。
// 背景：mineflayer physics.js 原本按 physics.yawSpeed=3rad/s 把发包朝向"小碎步"逼近 entity.yaw，
//       90° 要爬 10.5 tick ≈ 520ms → 身子(本地移动方向)早拐了、模型头还在原位，观感"傻子冲墙再甩头"。
// 用法: node tools/verify_head_latency.mjs [turns]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const TURNS = Number(process.argv[2] || 4);
const client = new Client({ name: 'head-latency-check', version: '1.0.0' }, { capabilities: {} });
await client.connect(new SSEClientTransport(new URL('http://127.0.0.1:3001/mcp')));

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
};
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const deg2rad = (d) => (d * Math.PI) / 180;
// mineflayer lib/conversions.js:17 → toNotchianYaw = toDegrees(PI - yaw)，故反向：yaw = PI - deg2rad(notchian)
const notchianToYaw = (d) => Math.PI - deg2rad(d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let samples = [];
let busy = false;
const sampler = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const j = JSON.parse(await call('pos-raw'));
    if (typeof j.sentYaw === 'number') {
      samples.push({ t: Date.now(), yaw: j.yaw, sent: notchianToYaw(j.sentYaw), yawSpeed: j.yawSpeed });
    }
  } catch {
    /* bot 忙 / 掉线 */
  }
  busy = false;
}, 20);

await sleep(500);
console.log(`yawSpeed = ${samples.at(-1)?.yawSpeed}  （修复前=3 rad/s → 90° 要爬 ~520ms）`);
console.log('回合 | 目标yaw(°) | 发包到位延迟(ms) | 头身最大夹角(°)');
const lat = [];
for (let i = 0; i < TURNS; i++) {
  const here = JSON.parse(await call('pos-raw'));
  const targetYaw = wrap(here.yaw + Math.PI / 2); // 每回合右转 90°（最坏情况：直角拐弯）
  const tx = here.x - Math.sin(targetYaw) * 8; // 本工程 yaw = atan2(-dx,-dz) → dx = -sin(yaw)*d
  const tz = here.z - Math.cos(targetYaw) * 8;
  samples = [];
  const mark = Date.now();
  await call('look-at', { x: tx, y: here.y, z: tz });
  await sleep(1500);
  let arrived = null;
  let maxGap = 0;
  for (const s of samples) {
    if (arrived === null && Math.abs(wrap(s.sent - targetYaw)) < 0.087) arrived = s.t - mark;
    maxGap = Math.max(maxGap, Math.abs(wrap(s.yaw - s.sent))); // 移动方向 vs 别人看到的头部朝向
  }
  lat.push(arrived);
  console.log(
    `${i + 1}     | ${((targetYaw * 180) / Math.PI).toFixed(0)}      | ${arrived ?? '未到位'}              | ${((maxGap * 180) / Math.PI).toFixed(1)}`
  );
}
clearInterval(sampler);
const ok = lat.filter((x) => x !== null);
console.log(`\n平均发包延迟 = ${ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : 'n/a'} ms / 90°（修复前 ≈520ms）`);
await client.close();
process.exit(0);
