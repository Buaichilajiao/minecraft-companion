const mineflayer = require('mineflayer');
const path = require('path');
const { createPlugin, goals } = require('@nxg-org/mineflayer-pathfinder');

(async () => {
  const cfg = require(path.join(__dirname, '..', 'config', 'config.json')).mc;
  const bot = mineflayer.createBot({
    host: cfg.host, port: cfg.port, username: cfg.username,
    version: false, auth: 'mojang',
    authServer: cfg.authServer,
    sessionServer: cfg.authServer.replace(/\/authserver\/?$/, '') + '/sessionserver',
    password: cfg.password,
  });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const setup = () => bot.loadPlugin(createPlugin({
    moveSettings: {
      allowDiagonalBridging: false, allowJumpSprint: false, allow1by1towers: false,
      canOpenDoors: true, canDig: false, canPlace: false,
      maxDropDown: 2, allowSprinting: false, movementTimeoutMs: 8000,
    },
  }));
  if (bot.world) setup(); else bot.once('login', setup);
  bot.on('error', (e) => console.log('BOTERR', String(e).slice(0, 80)));
  bot.on('kicked', (r) => console.log('KICKED', String(r).slice(0, 80)));
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('end', () => rej(new Error('end'))); });
  await sleep(3000);

  const timedGoto = (goal, ms, label) => Promise.race([
    bot.pathfinder.goto(goal).then(() => 'ok'),
    new Promise((res) => setTimeout(() => res('timeout'), ms)),
  ]).then((r) => {
    console.log(`[${label}] ${r} @ ${bot.entity.position.floored().toString()}`);
    return r;
  }).catch((e) => {
    console.log(`[${label}] fail: ${String(e.message).slice(0, 70)} @ ${bot.entity.position.floored().toString()}`);
    return 'fail';
  });

  console.log('start @', bot.entity.position.floored().toString());

  // 台阶点 (3,124,3)
  await timedGoto(new goals.GoalNear(3,124,3,1), 30000, '台阶点(3,124)');
  // 从台阶点跳上物品层 (4,125,3)
  await timedGoto(new goals.GoalNear(4,125,3,0), 30000, '物品层(4,125)');
  // 物品是否消失
  const item = Object.values(bot.entities).find(e => (e.displayName==='item'||e.name==='item') && Math.abs(e.position.x-4.3)<0.6 && Math.abs(e.position.z-3.3)<0.6);
  console.log('物品还在:', !!item);

  bot.end();
  process.exit(0);
})().catch(e => { console.error('FATAL', String(e)); process.exit(1); });
