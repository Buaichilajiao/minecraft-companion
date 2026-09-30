// 闲逛测试：Tester 登录后走到 bot 身边，原地停留，观察 bot 是否在身边自然游走
const mineflayer = require('mineflayer');
const { createPlugin, goals } = require('@nxg-org/mineflayer-pathfinder');

const HOST = '127.0.0.1', PORT = 25565, BOTNAME = 'XiaoBai_bot';

const tester = mineflayer.createBot({
  host: HOST, port: PORT, username: 'Tester', auth: 'offline', version: '1.21.1',
});
// pathfinder 延迟注入（需等 world 就绪，否则 referenceWorld 未定义）
if (tester.world) tester.loadPlugin(createPlugin({}));
else tester.once('login', () => tester.loadPlugin(createPlugin({})));

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
let botPosHistory = [];
let startWatch = 0;

tester.once('spawn', async () => {
  console.log(stamp(), 'Tester 已进入');
  // 等 bot 在线
  let tries = 0;
  while (!tester.players[BOTNAME] && tries < 20) { await new Promise(r => setTimeout(r, 1000)); tries++; }
  await new Promise(r => setTimeout(r, 3000));

  // 走到 bot 身边 4 格
  const goNear = () => {
    const e = tester.players[BOTNAME]?.entity;
    if (!e) return false;
    tester.pathfinder.goto(new goals.GoalNear(Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z), 3)).catch(() => {});
    return true;
  };
  goNear();
  await new Promise(r => setTimeout(r, 12000));

  // 开始观察：每 3 秒记录 bot 位置，持续 75 秒
  startWatch = Date.now();
  console.log(stamp(), '开始观察 bot 闲逛（75s）');
  const timer = setInterval(() => {
    const e = tester.players[BOTNAME]?.entity?.position;
    const t = tester.players[BOTNAME]?.entity;
    if (e) {
      botPosHistory.push({ t: ((Date.now() - startWatch) / 1000).toFixed(0), x: e.x.toFixed(1), y: e.y.toFixed(1), z: e.z.toFixed(1) });
      // 每隔约 15 秒靠近一次，避免 bot 走远后脱离闲逛半径
    }
    // 每 20 秒重新贴近 bot
    if (Math.round((Date.now() - startWatch) / 1000) % 20 === 0 && t) {
      tester.pathfinder.goto(new goals.GoalNear(Math.floor(t.position.x), Math.floor(t.position.y), Math.floor(t.position.z), 4)).catch(() => {});
    }
  }, 3000);

  setTimeout(() => {
    clearInterval(timer);
    console.log('\n=== bot 位置轨迹（相对观察开始秒数）===');
    botPosHistory.forEach(p => console.log(`  +${p.t}s  (${p.x}, ${p.y}, ${p.z})`));
    // 统计位置是否变化
    const xs = new Set(botPosHistory.map(p => p.x + ',' + p.z));
    console.log(`不同水平位置数: ${xs.size}（>1 说明 bot 在身边游走）`);
    tester.quit();
    process.exit(0);
  }, 78000);
});

tester.on('error', (e) => console.log('错误', e));
tester.on('kicked', (r) => console.log('被踢', r));
