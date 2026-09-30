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
  const cx = Math.round(me.x), cy = Math.floor(me.y), cz = Math.round(me.z);
  console.log('bot @', me.floored().toString());
  console.log('onGround:', bot.entity.onGround);

  // 打印脚下与周围
  console.log('\n=== 周边方块（x 横，z 竖）===');
  for (let y = cy + 2; y >= cy - 2; y--) {
    console.log(`\n--- y=${y} ---`);
    for (let z = cz - 4; z <= cz + 4; z++) {
      let row = `z${z >= 0 ? '+' : ''}${z}: `;
      for (let x = cx - 4; x <= cx + 4; x++) {
        const b = bot.blockAt(new Vec3(x, y, z));
        let s = b ? b.name.slice(0, 6) : '?';
        s = s.padEnd(7);
        if (x === cx && z === cz) s = '[' + s.trim().slice(0,5) + ']';
        row += s;
      }
      console.log(row);
    }
  }

  // 最近的树
  const logs = bot.findBlocks({ matching: (b) => b.name.includes('oak_log'), maxDistance: 30, count: 10 });
  console.log('\n=== 最近原木 ===');
  for (const p of logs) console.log(`  oak_log @(${p.x},${p.y},${p.z}) 距${Math.hypot(p.x-me.x,p.y-me.y,p.z-me.z).toFixed(1)}`);

  // 掉落物
  console.log('\n=== 掉落物 ===');
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (e.displayName !== 'item' && e.name !== 'item') continue;
    console.log(`  item @(${e.position.x.toFixed(1)},${e.position.y.toFixed(1)},${e.position.z.toFixed(1)})`);
  }

  bot.end();
  process.exit(0);
})().catch(e => { console.error('FATAL', String(e)); process.exit(1); });
