const mineflayer = require('mineflayer');
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
  await sleep(2500);

  const me = bot.entity.position;
  console.log('bot @', me.floored().toString(), 'y=', me.y.toFixed(2));

  // 所有 item 实体：metadata[8] 是 {itemId, itemCount}（1.21）
  console.log('\n=== 所有 item 实体（40 格内）===');
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (e.displayName !== 'item' && e.name !== 'item') continue;
    const d = me.distanceTo(e.position);
    if (d > 40) continue;
    const md = e.metadata[8];
    let desc = '?';
    if (md && md.itemId != null) {
      const it = bot.registry.items[md.itemId];
      desc = `${it ? it.name : md.itemId} x${md.itemCount}`;
    }
    console.log(`${desc} @(${e.position.floored().x},${e.position.floored().y},${e.position.floored().z}) 距离${d.toFixed(1)} 高度差${(e.position.y - me.y).toFixed(1)}`);
  }

  // 树/原木位置
  console.log('\n=== 残留原木方块（站着的树）===');
  const logs = bot.findBlocks({ matching: (b) => b.name.includes('oak_log'), maxDistance: 24, count: 30 });
  for (const p of logs) console.log(`oak_log @(${p.x},${p.y},${p.z})`);

  // 物品下方是什么方块（判断卡在哪）
  console.log('\n=== 每个 item 脚下的方块 ===');
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (e.displayName !== 'item' && e.name !== 'item') continue;
    if (me.distanceTo(e.position) > 40) continue;
    const fp = e.position.floored();
    const below = bot.blockAt({ x: fp.x, y: fp.y - 1, z: fp.z, equals: () => false, toString: () => `${fp.x},${fp.y - 1},${fp.z }` });
    console.log(`item @(${fp.x},${fp.y},${fp.z}) 脚下=${below ? below.name : '?'}`);
  }

  bot.end();
  process.exit(0);
})().catch(e => { console.error('FATAL', String(e)); process.exit(1); });
