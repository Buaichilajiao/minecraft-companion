// 步骤4 全链路：Tester 引怪到 bot 身边，观察 bot 反射危险+主动帮打，盯叠话/身体锁
const mineflayer = require('mineflayer');
const { createPlugin, goals } = require('@nxg-org/mineflayer-pathfinder');

const HOST = '127.0.0.1', PORT = 25565, BOTNAME = 'XiaoBai_bot';
const HOSTILES = ['zombie', 'skeleton', 'spider', 'husk', 'cave_spider', 'drowned', 'pillager', 'witch'];
const t = mineflayer.createBot({ host: HOST, port: PORT, username: 'Tester', auth: 'offline', version: '1.21.1' });
if (t.world) t.loadPlugin(createPlugin({}));
else t.once('login', () => t.loadPlugin(createPlugin({})));

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const botPos = () => t.players[BOTNAME]?.entity?.position;
const findHostile = () => {
  const list = Object.values(t.entities).filter(e =>
    e && e.name && HOSTILES.includes(e.name) && e.position && e.position.distanceTo(t.entity.position) < 48);
  list.sort((a, b) => a.position.distanceTo(t.entity.position) - b.position.distanceTo(t.entity.position));
  return list[0] || null;
};

t.once('spawn', async () => {
  console.log(stamp(), 'Tester 进入');
  let tries = 0;
  while (!t.players[BOTNAME] && tries < 20) { await sleep(1000); tries++; }
  await sleep(4000);

  // 先到 bot 附近
  let bp = botPos();
  if (bp) { try { await t.pathfinder.goto(new goals.GoalNear(Math.floor(bp.x), Math.floor(bp.y), Math.floor(bp.z), 3)); } catch {} }
  await sleep(2000);
  console.log(stamp(), '在 bot 附近，找怪…');

  // 找怪（夜晚，最多等30秒）
  let mob = findHostile();
  let waited = 0;
  while (!mob && waited < 30) { await sleep(3000); waited += 3; mob = findHostile(); }
  if (!mob) { console.log(stamp(), '附近48格没找到怪，无法引怪'); t.quit(); process.exit(2); }
  console.log(stamp(), `找到 ${mob.name}，距 ${mob.position.distanceTo(t.entity.position).toFixed(1)} 格，去引它`);

  // 走到怪附近 4 格（让它盯上 Tester），稍等 1.5s
  try {
    await t.pathfinder.goto(new goals.GoalNear(Math.floor(mob.position.x), Math.floor(mob.position.y), Math.floor(mob.position.z), 4));
  } catch {}
  await sleep(1500);
  console.log(stamp(), '已引到怪，回 bot 身边（怪会追）');

  // 回 bot 身边，怪追过来
  bp = botPos();
  if (bp) { try { await t.pathfinder.goto(new goals.GoalNear(Math.floor(bp.x), Math.floor(bp.y), Math.floor(bp.z), 3)); } catch {} }
  ['forward','back','sprint','jump'].forEach(k => t.setControlState(k, false));
  console.log(stamp(), '已回到 bot 身边，观察 70 秒（Tester 边后撤保持距离保命）…');

  // 每 3 秒记录：离 bot 距离、附近怪、自己血量；同时简单后撤保命
  const start = Date.now();
  const obs = [];
  const timer = setInterval(() => {
    const b = botPos();
    const nearMob = Object.values(t.entities).filter(e => e && HOSTILES.includes(e.name) && e.position && e.position.distanceTo(t.entity.position) < 8);
    const dBot = b ? b.distanceTo(t.entity.position).toFixed(1) : '?';
    const mobs = nearMob.map(m => `${m.name}(${m.position.distanceTo(t.entity.position).toFixed(1)})`).join(',');
    obs.push(`+${((Date.now()-start)/1000).toFixed(0)}s bot距${dBot} 身边怪[${mobs}] 我血${Math.round(t.health)}`);
    // 怪贴脸(≤2)就后撤，给 bot 争取帮打时间
    if (nearMob.some(m => m.position.distanceTo(t.entity.position) <= 2.2)) {
      t.setControlState('back', true);
    }
  }, 3000);
  // 后撤与停顿交替，别一直后退
  const kite = setInterval(() => {
    if (t.getControlState('back')) { t.setControlState('back', false); }
  }, 1500);
  await sleep(70000);
  clearInterval(timer);
  clearInterval(kite);
  ['forward','back','sprint','jump'].forEach(k => t.setControlState(k, false));
  console.log('\n=== 观察记录 ===');
  obs.forEach(o => console.log(o));
  console.log(stamp(), '测试完成');
  t.quit();
  process.exit(0);
});

t.on('error', (e) => console.log('错误', e));
t.on('kicked', (r) => console.log('被踢', r));
