const mineflayer = require('mineflayer');
const path = require('path');
const Vec3 = require('vec3').Vec3;

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
  bot.on('error', (e) => console.log('BOTERR', String(e).slice(0, 80)));
  await new Promise((res) => bot.once('spawn', res));
  await sleep(4000);

  const me = bot.entity.position;
  const cx = Math.floor(me.x), cy = Math.floor(me.y), cz = Math.floor(me.z);
  console.log('出生点 @', me.floored().toString());

  const R = 48;
  const counts = {};
  const villageMarks = { oak_door: [], glass_pane: [], bell: [], mossy_cobblestone: [], oak_planks: 0, cobblestone: 0 };
  const logs = [];
  for (let x = cx - R; x <= cx + R; x++) {
    for (let z = cz - R; z <= cz + R; z++) {
      for (let y = cy - 6; y <= cy + 20; y++) {
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b) continue;
        const n = b.name;
        if (n === 'oak_door') villageMarks.oak_door.push([x,y,z]);
        else if (n === 'glass_pane') villageMarks.glass_pane.push([x,y,z]);
        else if (n === 'bell') villageMarks.bell.push([x,y,z]);
        else if (n === 'mossy_cobblestone') villageMarks.mossy_cobblestone.push([x,y,z]);
        else if (n === 'oak_planks') villageMarks.oak_planks++;
        else if (n === 'cobblestone') villageMarks.cobblestone++;
        else if (n.includes('oak_log')) logs.push([x,y,z]);
      }
    }
  }
  console.log('\n=== 村庄标志（半径', R, '）===');
  console.log('门:', villageMarks.oak_door.length, villageMarks.oak_door.slice(0,3));
  console.log('玻璃板:', villageMarks.glass_pane.length, villageMarks.glass_pane.slice(0,3));
  console.log('钟:', villageMarks.bell.length);
  console.log('苔石:', villageMarks.mossy_cobblestone.length);
  console.log('橡木板(散落):', villageMarks.oak_planks, '圆石(散落):', villageMarks.cobblestone);
  console.log('\n=== 树 ===');
  console.log('oak_log 方块数:', logs.length);
  console.log('最近5个:', logs.slice(0,5).map(p => `(${p[0]},${p[1]},${p[2]})`).join(' '));

  const isVillage = villageMarks.oak_door.length > 0 || villageMarks.bell.length > 0 ||
    (villageMarks.glass_pane.length > 2 && villageMarks.oak_planks > 10);
  console.log('\n判定有村庄:', isVillage);
  console.log('判定有足够树(>=5):', logs.length >= 5);

  bot.end();
  process.exit(0);
})().catch(e => { console.error('FATAL', String(e)); process.exit(1); });
