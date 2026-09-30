// far 情境测试：Tester 用 pathfinder 稳定走到 30+ 格外，观察 bot 是否在档位跨越时自然问一句
const mineflayer = require('mineflayer');
const { createPlugin, goals } = require('@nxg-org/mineflayer-pathfinder');

const HOST = '127.0.0.1', PORT = 25565, BOTNAME = 'XiaoBai_bot';
const t = mineflayer.createBot({ host: HOST, port: PORT, username: 'Tester', auth: 'offline', version: '1.21.1' });
if (t.world) t.loadPlugin(createPlugin({}));
else t.once('login', () => t.loadPlugin(createPlugin({})));

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const botPos = () => t.players[BOTNAME]?.entity?.position;

t.once('spawn', async () => {
  console.log(stamp(), 'Tester 进入');
  let tries = 0;
  while (!t.players[BOTNAME] && tries < 20) { await sleep(1000); tries++; }
  await sleep(4000);
  const b = botPos();
  if (!b) { console.log('bot 不在线'); process.exit(1); }
  // 目标：沿 +x 方向走到距 bot 约 35 格处
  const tx = Math.floor(b.x) + 38, tz = Math.floor(b.z);
  console.log(stamp(), `用 pathfinder 走到远处目标 (${tx}, ${tz})…`);
  try {
    await t.pathfinder.goto(new goals.GoalNear(tx, Math.floor(b.y), tz, 3));
  } catch (e) {
    console.log('goto 出错:', String(e));
  }
  const after = botPos();
  if (after) {
    const d = Math.hypot(after.x - t.entity.position.x, after.z - t.entity.position.z);
    console.log(stamp(), `已停下，距 bot 约 ${d.toFixed(1)} 格，等待 bot 反应（30s）`);
  }
  await sleep(30000);
  console.log(stamp(), '测试完成');
  t.quit();
  process.exit(0);
});

t.on('error', (e) => console.log('错误', e));
t.on('kicked', (r) => console.log('被踢', r));
