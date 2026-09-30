// 全链路3：给 Tester 铁甲+剑（扛怪），summon zombie 打 Tester，看 bot 毫秒级护玩家
const mineflayer = require('mineflayer');
const { createPlugin, goals } = require('@nxg-org/mineflayer-pathfinder');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOST = '127.0.0.1', PORT = 25565, BOTNAME = 'XiaoBai_bot';
const PROJECT = 'D:\\下载\\minecraft-companion';
const NODE = 'D:\\nodejs\\node-v22.10.0-win-x64\\node.exe';
const HOSTILES = ['zombie', 'skeleton', 'spider', 'husk', 'drowned'];
const t = mineflayer.createBot({ host: HOST, port: PORT, username: 'Tester', auth: 'offline', version: '1.21.1' });
if (t.world) t.loadPlugin(createPlugin({}));
else t.once('login', () => t.loadPlugin(createPlugin({})));

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const botPos = () => t.players[BOTNAME]?.entity?.position;
const runCmd = (command) => {
  fs.writeFileSync(path.join(PROJECT, 'tools', 'arg-g.json'), JSON.stringify({ command }));
  return execFileSync(NODE, ['tools/call.js', 'run-command', '@tools/arg-g.json'], { cwd: PROJECT, encoding: 'utf8' });
};

t.once('spawn', async () => {
  console.log(stamp(), 'Tester 进入');
  let tries = 0;
  while (!t.players[BOTNAME] && tries < 20) { await sleep(1000); tries++; }
  await sleep(3000);
  // 到 bot 旁
  let bp = botPos();
  if (bp) { try { await t.pathfinder.goto(new goals.GoalNear(Math.floor(bp.x), Math.floor(bp.y), Math.floor(bp.z), 3)); } catch {} }
  ['forward','back','sprint','jump'].forEach(k => t.setControlState(k, false));
  await sleep(1500);
  runCmd('time set night');
  await sleep(1000);

  // 给 Tester 铁甲 + 剑，然后装备
  const kit = ['iron_sword', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
  for (const item of kit) {
    try { runCmd(`give Tester ${item} 1`); } catch (e) { console.log('give', item, 'fail', String(e)); }
    await sleep(400);
  }
  await sleep(1000);
  for (const slot of ['head', 'torso', 'legs', 'feet']) {
    const it = t.inventory.items().find(i => i.name.includes(slot === 'torso' ? 'chestplate' : slot === 'legs' ? 'leggings' : slot === 'feet' ? 'boots' : 'helmet'));
    if (it) { try { await t.equip(it, slot); } catch {} }
  }
  const sword = t.inventory.items().find(i => i.name.includes('sword'));
  if (sword) { try { await t.equip(sword, 'hand'); } catch {} }
  console.log(stamp(), 'Tester 已装备铁甲+剑');

  // 在 Tester 身边 3 格 summon zombie（怪打 Tester），bot 应该冲过来护
  const tp = t.entity.position;
  const sx = Math.floor(tp.x) + 3, sy = Math.floor(tp.y), sz = Math.floor(tp.z);
  console.log(stamp(), `summon zombie @ (${sx},${sy},${sz})，观察 bot 护人（60s）`);
  runCmd(`summon zombie ${sx} ${sy} ${sz}`);

  const start = Date.now();
  const obs = [];
  const timer = setInterval(() => {
    const b = botPos();
    const nearMob = Object.values(t.entities).filter(e => e && HOSTILES.includes(e.name) && e.position && e.position.distanceTo(t.entity.position) < 12);
    const dBot = b ? b.distanceTo(t.entity.position).toFixed(1) : '?';
    const mobs = nearMob.map(m => `${m.name}(${m.position.distanceTo(t.entity.position).toFixed(1)})`).join(',');
    obs.push(`+${((Date.now()-start)/1000).toFixed(0)}s bot距${dBot} 怪[${mobs}] 我血${Math.round(t.health)}`);
  }, 3000);
  await sleep(60000);
  clearInterval(timer);
  console.log('\n=== 观察记录 ===');
  obs.forEach(o => console.log(o));
  console.log(stamp(), '完成');
  t.quit();
  process.exit(0);
});

t.on('error', (e) => console.log('错误', e));
t.on('kicked', (r) => console.log('被踢', r));
