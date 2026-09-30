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
  bot.on('error', (e) => console.log('BOTERR', String(e).slice(0, 100)));
  bot.on('kicked', (r) => console.log('KICKED', String(r).slice(0, 100)));
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('end', () => rej(new Error('end before spawn'))); });
  console.log('已 spawn，模式', bot.game.gameMode);
  await sleep(2500);

  // 1. 所有 item 实体 + 从 metadata 解析物品
  console.log('\n=== 掉落物实体 ===');
  for (const id of Object.keys(bot.entities)) {
    const e = bot.entities[id];
    if (e.name !== 'item' && e.objectType !== 'item') continue;
    let itemDesc = '?';
    // 掉落物的 Item 在 metadata 中（不同版本索引不同），遍历找带 name 的对象
    for (const k of Object.keys(e.metadata || {})) {
      const v = e.metadata[k];
      if (v && typeof v === 'object' && 'name' in v && 'count' in v) itemDesc = `${v.name} x${v.count}`;
    }
    if (itemDesc === '?') {
      // 退而求其次：直接读 NBT/原始数据
      itemDesc = JSON.stringify(e.metadata).slice(0, 120);
    }
    const d = bot.entity.position.distanceTo(e.position);
    console.log(`@(${e.position.floored().x},${e.position.floored().y},${e.position.floored().z}) 距离${d.toFixed(1)} = ${itemDesc}`);
  }

  // 2. 附近 48 格内所有 crafting_table 方块
  console.log('\n=== 工作台方块 ===');
  const tbs = bot.findBlocks({ matching: (b) => b.name === 'crafting_table', maxDistance: 48, count: 20 });
  if (tbs.length === 0) console.log('48 格内无工作台方块');
  for (const p of tbs) console.log(`工作台 @(${p.x},${p.y},${p.z})`);

  // 3. 背包明细
  console.log('\n=== 背包 ===');
  for (const it of bot.inventory.items()) console.log(`${it.name} x${it.count} (slot${it.slot})`);

  bot.end();
  process.exit(0);
})().catch(e => { console.error('FATAL', String(e)); process.exit(1); });
