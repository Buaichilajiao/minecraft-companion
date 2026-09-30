const mineflayer = require('mineflayer');
const path = require('path');

function createBot(cfg) {
  const options = {
    host: cfg.host, port: cfg.port, username: cfg.username,
    version: false, auth: 'mojang',
    authServer: cfg.authServer,
    sessionServer: cfg.authServer.replace(/\/authserver\/?$/, '') + '/sessionserver',
    password: cfg.password,
  };
  return mineflayer.createBot(options);
}

(async () => {
  const cfg = require(path.join(__dirname, '..', 'config', 'config.json')).mc;
  const bot = createBot(cfg);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  bot.on('error', (e) => console.log('BOTERR', String(e).slice(0, 100)));
  bot.on('kicked', (r) => console.log('KICKED', String(r).slice(0, 100)));

  await new Promise((res, rej) => {
    bot.once('spawn', res);
    bot.once('end', () => rej(new Error('disconnected before spawn')));
  });
  console.log('已 spawn');

  // 监听所有槽位更新
  bot.inventory.on('updateSlot', (slot, oldItem, newItem) => {
    const n = newItem ? `${newItem.name} x${newItem.count}` : '空';
    console.log(`  [槽${slot}] -> ${n}`);
  });

  await sleep(2000);
  // 创造模式：直接给自己 8 木板到主手槽 36
  const Item = require('prismarine-item')(bot.registry);
  const plankId = bot.registry.itemsByName.oak_planks.id;
  const plankItem = new Item(plankId, 8);
  await bot.creative.setInventorySlot(36, plankItem);
  await sleep(1000);
  console.log('已创造给木板');
  const planks = bot.inventory.items().find(i => i.name.includes('planks'));
  console.log('木板:', planks ? `${planks.name} x${planks.count} slot${planks.slot}` : '无');

  // 找到 crafting_table 无台配方
  const id = bot.registry.itemsByName.crafting_table.id;
  const recipes = bot.recipesFor(id, null, null, null);
  const recipe = recipes.find(r => !r.requiresTable);
  console.log('工作台配方:', recipe ? `找到 inShape=${JSON.stringify(recipe.inShape?.map(row => row.map(c => c.id)))}` : '无');

  // 直接用 bot.craft，但加观察
  console.log('--- 开始 bot.craft(crafting_table) ---');
  const t0 = Date.now();
  try {
    await bot.craft(recipe, 1, null);
    console.log(`✅ craft 成功 用时 ${Date.now() - t0}ms`);
  } catch (e) {
    console.log(`❌ craft 失败 用时 ${Date.now() - t0}ms: ${String(e).slice(0, 120)}`);
  }

  // 打印合成网格/cursor 状态
  console.log('--- 失败后状态 ---');
  console.log('cursor:', bot.inventory.selectedItem ? `${bot.inventory.selectedItem.name} x${bot.inventory.selectedItem.count}` : '空');
  for (let s = 1; s <= 4; s++) {
    const it = bot.inventory.slots[s];
    console.log(`网格槽${s}:`, it ? `${it.name} x${it.count}` : '空');
  }
  console.log('木板剩余:', bot.inventory.count(planks.type));
  const tableItem = bot.inventory.items().find(i => i.name === 'crafting_table');
  console.log('背包工作台:', tableItem ? '有' : '无');

  bot.end();
  process.exit(0);
})().catch(e => { console.error('FATAL', String(e)); process.exit(1); });
