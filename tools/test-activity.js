// 玩家活动感知测试：Tester 先走远（测 far），再回附近反复微动（测 nearby）
const mineflayer = require('mineflayer');
const { createPlugin, goals } = require('@nxg-org/mineflayer-pathfinder');

const HOST = '127.0.0.1', PORT = 25565, BOTNAME = 'XiaoBai_bot';
const t = mineflayer.createBot({ host: HOST, port: PORT, username: 'Tester', auth: 'offline', version: '1.21.1' });
if (t.world) t.loadPlugin(createPlugin({}));
else t.once('login', () => t.loadPlugin(createPlugin({})));

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const setCtrl = (k, v) => t.setControlState(k, v);
const botPos = () => t.players[BOTNAME]?.entity?.position;
const distToBot = () => {
  const b = botPos();
  if (!b) return null;
  return Math.hypot(b.x - t.entity.position.x, b.z - t.entity.position.z);
};

t.once('spawn', async () => {
  console.log(stamp(), 'Tester 进入');
  let tries = 0;
  while (!t.players[BOTNAME] && tries < 20) { await sleep(1000); tries++; }
  await sleep(4000);

  // ① 走远：纯物理移动，朝"远离 bot"的方向持续疾走直到 >26 格（无 pathfinder 残留）
  ['forward','back','sprint','jump'].forEach(k => setCtrl(k, false));
  setCtrl('sprint', true);
  setCtrl('forward', true);
  let d = distToBot();
  let seconds = 0;
  while ((d === null || d < 26) && seconds < 30) {
    const b = botPos();
    if (b) {
      // 远离方向：从 bot 指向 Tester
      const dx = t.entity.position.x - b.x, dz = t.entity.position.z - b.z;
      t.entity.yaw = Math.atan2(-dx, -dz);
    }
    await sleep(1000);
    seconds++;
    d = distToBot();
  }
  setCtrl('sprint', false);
  setCtrl('forward', false);
  console.log(stamp(), `已停下，距 bot 约 ${d?.toFixed(1)} 格，等待 bot 反应（26s）`);
  await sleep(26000);

  // ② 回 bot 附近（await pathfinder GoalNear 完成，会自动停止）
  console.log(stamp(), '回到 bot 附近…');
  const b = botPos();
  if (b) {
    try {
      await t.pathfinder.goto(new goals.GoalNear(Math.floor(b.x), Math.floor(b.y), Math.floor(b.z), 3));
    } catch { /* 走不到也继续 */ }
  }
  ['forward','back','sprint','jump'].forEach(k => setCtrl(k, false));
  await sleep(2000);

  // ③ 附近反复微动（模拟挖矿/盖房），持续 24 秒
  console.log(stamp(), '开始在 bot 附近反复忙活（24s）…');
  const end = Date.now() + 24000;
  while (Date.now() < end) {
    setCtrl('forward', true); await sleep(800); setCtrl('forward', false);
    setCtrl('back', true); await sleep(800); setCtrl('back', false);
    setCtrl('jump', true); await sleep(200); setCtrl('jump', false);
    await sleep(300);
  }
  console.log(stamp(), '忙活结束，等待 bot 反应（22s）');
  await sleep(22000);
  console.log(stamp(), '测试完成');
  t.quit();
  process.exit(0);
});

t.on('error', (e) => console.log('错误', e));
t.on('kicked', (r) => console.log('被踢', r));
