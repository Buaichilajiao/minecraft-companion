const mineflayer = require('mineflayer');
const Vec3 = require('vec3');
const path = require('path');

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
  await sleep(2000);

  // 检查掉落物 (3,124,4) 周围 3x3x3 的方块
  console.log('=== (3,124,4) 掉落物周围方块 ===');
  for (let y = 122; y <= 126; y++) {
    let row = `y=${y}: `;
    for (let x = 2; x <= 4; x++) {
      for (let z = 3; z <= 5; z++) {
        const b = bot.blockAt(new Vec3(x, y, z));
        const mark = (x === 3 && z === 4) ? '*' : '';
        row += `(${x},${z})${mark}=${b ? b.name : '?'}  `;
      }
    }
    console.log(row);
  }

  // 尝试垫脚路径：bot 在 (5,122,4)，要到 (3,124,4) 附近
  // 检查 (3,123,4) 是否可站立（垫脚上去）
  const stand = bot.blockAt(new Vec3(3, 124, 4));
  const standBelow = bot.blockAt(new Vec3(3, 123, 4));
  console.log('\n垫脚目标 (3,124,4)=', stand?.name, ' 脚下(3,123,4)=', standBelow?.name);

  bot.end();
  process.exit(0);
})().catch(e => { console.error('FATAL', String(e)); process.exit(1); });
