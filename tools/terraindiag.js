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

  // 地形高度图（每个 x,z 找最顶层固体）
  const R = 24;
  const height = {};
  const key = (x,z) => `${x},${z}`;
  for (let x = cx-R; x <= cx+R; x++) {
    for (let z = cz-R; z <= cz+R; z++) {
      let top = -1;
      for (let y = cy+30; y > cy-30; y--) {
        const b = bot.blockAt(new Vec3(x,y,z));
        if (b && b.boundingBox === 'block') { top = y; break; }
      }
      height[key(x,z)] = top;
    }
  }
  // 打印高度差（相对 bot 脚）
  console.log('\n=== 地形高度（数字=顶层固体 y - bot脚 y；.同层 / 高=+ / 低=-）===');
  for (let z = cz-12; z <= cz+12; z++) {
    let row = `z${String(z-cz).padStart(3)}: `;
    for (let x = cx-12; x <= cx+12; x++) {
      const h = height[key(x,z)];
      const d = h === -1 ? 99 : h - cy;
      let s;
      if (Math.abs(d) > 9) s = '~~';
      else if (d === 0) s = ' .';
      else if (d > 0) s = '+' + d;
      else s = String(d).padStart(2,' ');
      if (x === cx && z === cz) s = '##';
      row += s + ' ';
    }
    console.log(row);
  }

  // 暴露的、可直接水平到达的石头（在 bot 脚同层附近）
  console.log('\n=== 可直接挖的石头（y 与 bot 脚差 ±3，且相邻有空气）===');
  const found = [];
  for (let x = cx-R; x <= cx+R; x++) {
    for (let z = cz-R; z <= cz+R; z++) {
      for (let y = cy-3; y <= cy+3; y++) {
        const b = bot.blockAt(new Vec3(x,y,z));
        if (!b || b.name !== 'stone') continue;
        // 相邻有空气
        const dirs = [[1,0],[-1,0],[0,1],[0,-1],[0,1,0]];
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
  for (const f of found.slice(0,10)) {
    console.log(`  stone @(${f.x},${f.y},${f.z}) 距${f.dist.toFixed(1)} 脚差${f.yd}`);
  }
  console.log('总数:', found.length);

  bot.end();
  process.exit(0);
})().catch(e => { console.error('FATAL', String(e)); process.exit(1); });
