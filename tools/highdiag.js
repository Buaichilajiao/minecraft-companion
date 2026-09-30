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
  bot.on('kicked', (r) => console.log('KICKED', String(r).slice(0, 80)));
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('end', () => rej(new Error('end'))); });
  await sleep(3000);

  const me = bot.entity.position;
  console.log('bot 脚:', me.floored().toString(), 'y=', me.y.toFixed(2));

  const items = [];
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (e.displayName !== 'item' && e.name !== 'item') continue;
    if (me.distanceTo(e.position) > 40) continue;
    items.push(e);
  }

  console.log('\n=== 掉落物 ===');
  for (const e of items) {
    const p = e.position;
    const md = e.metadata[8];
    let name = '?';
    if (md && md.itemId != null) {
      const it = bot.registry.items[md.itemId];
      name = it ? it.name : md.itemId;
    }
    const dy = Math.round(p.y) - Math.floor(me.y);
    const horiz = Math.hypot(p.x - me.x, p.z - me.z);
    console.log(`#${e.id} ${name} x${md ? md.itemCount : 1} @(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}) 水平${horiz.toFixed(1)} 高度差${dy}`);
  }

  console.log('\n=== 原木高物可达性 ===');
  for (const e of items) {
    const md = e.metadata[8];
    const it = md && md.itemId != null ? bot.registry.items[md.itemId] : null;
    if (!it || !it.name.includes('log')) continue;
    const p = e.position;
    const tx = Math.round(p.x), ty = Math.round(p.y), tz = Math.round(p.z);
    console.log(`\n原木 @(${tx},${ty},${tz}):`);
    console.log(`  物品格=${bot.blockAt(new Vec3(tx,ty,tz))?.name} 下方=${bot.blockAt(new Vec3(tx,ty-1,tz))?.name}`);
    for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const ax=tx+dx, az=tz+dz;
      const cols = [121,122,123,124,125].map(y => `y${y}=${bot.blockAt(new Vec3(ax,y,az))?.name}`).join(' ');
      console.log(`  相邻(${ax},${az}): ${cols}`);
    }
  }

  console.log('\n=== 背包 ===');
  for (const it of bot.inventory.items()) console.log(`  ${it.name} x${it.count}`);

  bot.end();
  process.exit(0);
})().catch(e => { console.error('FATAL', String(e)); process.exit(1); });
