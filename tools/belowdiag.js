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
  await sleep(3000);

  const me = bot.entity.position;
  const cx = Math.floor(me.x), cy = Math.floor(me.y), cz = Math.floor(me.z);
  console.log('bot @', me.floored().toString());

  // 脚下往下 12 格
  console.log('\n=== 脚下地层 ===');
  for (let y = cy; y >= cy-12; y--) {
    const b = bot.blockAt(new Vec3(cx, y, cz));
    console.log(`  y${y}: ${b ? b.name : '?'}`);
  }

  // 暴露石头（放宽 y 差 ±12）
  const found = [];
  for (let x = cx-24; x <= cx+24; x++) {
    for (let z = cz-24; z <= cz+24; z++) {
      for (let y = cy-6; y <= cy+12; y++) {
        const b = bot.blockAt(new Vec3(x,y,z));
        if (!b || b.name !== 'stone') continue;
        let exposed = false;
        for (const d of [[1,0],[-1,0],[0,1],[0,-1],[0,1],[0,-1]]) {
          const nb = bot.blockAt(new Vec3(x+d[0], y+(d[1]||0), z+d[2]));
          if (nb && nb.name === 'air') { exposed = true; break; }
        }
        if (exposed) {
          const dist = Math.hypot(x-cx, y-cy, z-cz);
          found.push({ x,y,z, dist, yd: y-cy });
        }
      }
    }
  }
  found.sort((a,b)=>a.dist-b.dist);
  console.log('\n=== 暴露石头（放宽范围，最近10个）===');
  for (const f of found.slice(0,10)) {
    console.log(`  stone @(${f.x},${f.y},${f.z}) 距${f.dist.toFixed(1)} 脚差${f.yd}`);
  }
  console.log('总数:', found.length);

  // iron_ore 位置
  const ores = [];
  for (let x = cx-48; x <= cx+48; x++) {
    for (let z = cz-48; z <= cz+48; z++) {
      for (let y = cy-10; y <= cy+10; y++) {
        const b = bot.blockAt(new Vec3(x,y,z));
        if (b && b.name === 'iron_ore') {
          ores.push({x,y,z, dist: Math.hypot(x-cx,y-cy,z-cz), yd: y-cy});
        }
      }
    }
  }
  ores.sort((a,b)=>a.dist-b.dist);
  console.log('\n=== 铁矿（最近5个）===');
  for (const f of ores.slice(0,5)) {
    console.log(`  iron_ore @(${f.x},${f.y},${f.z}) 距${f.dist.toFixed(1)} 脚差${f.yd}`);
  }
  console.log('铁矿总数:', ores.length);

  bot.end();
  process.exit(0);
})().catch(e => { console.error('FATAL', String(e)); process.exit(1); });
