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

  console.log('start @', bot.entity.position.floored().toString());

  const targets = [
    { name: '物品精确 GoalNear(4,125,3,0)', goal: new goals.GoalNear(4,125,3,0), ms: 25000 },
    { name: '台阶点 GoalNear(3,124,3,1)', goal: new goals.GoalNear(3,124,3,1), ms: 20000 },
    { name: '另一侧 GoalNear(4,125,2,1)', goal: new goals.GoalNear(4,125,2,1), ms: 20000 },
  ];
  for (const t of targets) {
    console.log(`\n>>> ${t.name}`);
    try {
      await bot.pathfinder.goto(t.goal);
      console.log(`  ✅ 到了 @ ${bot.entity.position.floored().toString()}`);
      const item = Object.values(bot.entities).find(e => (e.displayName==='item'||e.name==='item') && Math.abs(e.position.x-4.3)<0.6 && Math.abs(e.position.z-3.3)<0.6);
      console.log(`  物品还在: ${!!item}`);
    } catch (e) {
      console.log(`  ❌ ${String(e.message).slice(0,90)} @ ${bot.entity.position.floored().toString()}`);
    }
  }

  bot.end();
  process.exit(0);
})().catch(e => { console.error('FATAL', String(e)); process.exit(1); });
