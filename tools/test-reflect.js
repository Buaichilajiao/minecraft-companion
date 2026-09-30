/* 本地反射自动化测试：模拟玩家登录 25565，发送运动指令，测量 bot 毫秒级反射响应。
   用法: node tools/test-reflect.js
   说明：本脚本只扮演"玩家"，被测的是 3001 上的 MCP/companion（XiaoBai_bot）。 */
const mineflayer = require('mineflayer');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = 25565;
const VERSION = '1.21.1';

const p = mineflayer.createBot({
  host: HOST, port: PORT,
  username: 'Tester',
  auth: 'offline',
  version: VERSION,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(...a) { console.log(new Date().toISOString().slice(11, 23), ...a); }

let waiters = [];
p.on('message', (msg) => {
  const text = msg.toString();
  for (const w of waiters) {
    if (w.keywords.some((k) => text.includes(k))) {
      w.hits.push({ text, dt: Date.now() - w.t0 });
    }
  }
});

function send(cmd, keywords, opts = {}) {
  return new Promise(async (resolve) => {
    const w = { cmd, keywords, t0: Date.now(), hits: [] };
    waiters.push(w);
    log(`▶ 发送「${cmd}」(期望含: ${keywords.join('/')})`);
    p.chat(cmd);
    const observeMs = opts.observeMs || 6000;
    await sleep(observeMs);
    waiters = waiters.filter((x) => x !== w);
    if (w.hits.length === 0) {
      log(`  ❌ ${observeMs}ms 内无匹配回复`);
    } else {
      w.hits.forEach((h) => log(`  ✅ ${h.dt}ms → ${h.text}`));
    }
    resolve(w.hits);
  });
}

// 让玩家往某个方向走一段（拉开距离）
async function walkAway(sec = 8) {
  log('玩家先走开拉距离...');
  p.setControlState('forward', true);
  p.setControlState('sprint', true);
  await sleep(sec * 1000);
  p.setControlState('forward', false);
  p.setControlState('sprint', false);
  await sleep(1000);
  const me = p.entity.position;
  log(`玩家现在位置 ~(${Math.round(me.x)},${Math.round(me.y)},${Math.round(me.z)})`);
}

p.once('spawn', async () => {
  log('Tester 已进入服务器');
  await sleep(4000);
  const botEnt = Object.values(p.entities).find((e) => e.username === 'XiaoBai_bot' || e.name === 'XiaoBai_bot');
  if (botEnt) log(`XiaoBai_bot 初始位置 ~(${Math.round(botEnt.position.x)},${Math.round(botEnt.position.y)},${Math.round(botEnt.position.z)})`);
  else log('未在实体列表找到 XiaoBai_bot（可能命名不同）');

  await walkAway(8);

  // 1. 过来
  await send('过来', ['来了', '过去', '这就'], { observeMs: 9000 });
  await sleep(2000);

  // 2. 停下（先让它可能在动）
  await send('停下', ['停下', '好'], { observeMs: 5000 });
  await sleep(2000);

  // 3. 跟着我
  await send('跟着我', ['跟着'], { observeMs: 7000 });
  await sleep(3000);

  // 4. 危险
  await send('危险', ['危险', '撤', '小心', '躲', '听'], { observeMs: 6000 });
  await sleep(2000);

  // 5. 躲开
  await send('躲开', ['躲开', '让', '躲'], { observeMs: 6000 });

  log('=== 反射测试完成，Tester 30s 后退出 ===');
  await sleep(30000);
  p.quit();
  process.exit(0);
});

p.on('error', (e) => log('连接错误:', e.message));
p.on('kicked', (r) => log('被踢:', r));
p.on('end', () => { log('Tester 连接结束'); process.exit(0); });
