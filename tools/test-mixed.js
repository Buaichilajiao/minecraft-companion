// 混合团战：同时 summon creeper + zombie 贴 Tester，看 bot 能否两边都顾（硬刚 zombie 同时引离 creeper，或优先 creeper）
const mineflayer = require('mineflayer');
const { createPlugin, goals } = require('@nxg-org/mineflayer-pathfinder');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOST = '127.0.0.1', PORT = 25565, BOTNAME = 'XiaoBai_bot';
const PROJECT = 'D:\\下载\\minecraft-companion';
const NODE = 'D:\\nodejs\\node-v22.10.0-win-x64\\node.exe';
const ALL = ['zombie','skeleton','spider','creeper','husk','drowned'];
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
  console.log(runCmd('difficulty peaceful').trim());
  await sleep(1500);
  const bp0 = botPos();
  if (bp0) { try { await t.pathfinder.goto(new goals.GoalNear(Math.floor(bp0.x), Math.floor(bp0.y), Math.floor(bp0.z), 3)); } catch {} }
  ['forward','back','sprint','jump'].forEach(k => t.setControlState(k, false));
  await sleep(1000);
  for (const item of ['iron_sword','iron_helmet','iron_chestplate','iron_leggings','iron_boots']) {
    try { runCmd(`give Tester ${item} 1`); } catch {}
    await sleep(350);
  }
  await sleep(800);
  for (const slot of ['head','torso','legs','feet']) {
    const it = t.inventory.items().find(i => i.name.includes(slot === 'torso' ? 'chestplate' : slot === 'legs' ? 'leggings' : slot === 'feet' ? 'boots' : 'helmet'));
    if (it) { try { await t.equip(it, slot); } catch {} }
  }
  console.log(runCmd('difficulty easy').trim());
  console.log(runCmd('time set night').trim());
  await sleep(2000);

  const bp = botPos();
  console.log(stamp(), `就位，Tester离bot ${bp?.distanceTo(t.entity.position).toFixed(1)} 格，同时 summon creeper + zombie`);
  const tp = t.entity.position;
  // creeper 在 Tester 一侧 +2，zombie 在另一侧 -2
  console.log(runCmd(`summon creeper ${Math.floor(tp.x)+2} ${Math.floor(tp.y)} ${Math.floor(tp.z)}`).trim());
  await sleep(300);
  console.log(runCmd(`summon zombie ${Math.floor(tp.x)-2} ${Math.floor(tp.y)} ${Math.floor(tp.z)}`).trim());
  console.log(stamp(), '观察 50 秒…');

  const start = Date.now();
  const obs = [];
  const timer = setInterval(() => {
    const b = botPos();
    const nearMob = Object.values(t.entities).filter(e => e && ALL.includes(e.name) && e.position && e.position.distanceTo(t.entity.position) < 12);
    const dBot = b ? b.distanceTo(t.entity.position).toFixed(1) : '?';
    const mobs = nearMob.map(m => `${m.name}(${m.position.distanceTo(t.entity.position).toFixed(1)})`).join(',');
    obs.push(`+${((Date.now()-start)/1000).toFixed(0)}s bot距${dBot} 怪[${mobs}] 我血${Math.round(t.health)}`);
  }, 3000);
  await sleep(50000);
  clearInterval(timer);
  console.log('\n=== 观察记录 ===');
  obs.forEach(o => console.log(o));
  console.log(stamp(), '完成');
  t.quit();
  process.exit(0);
});

t.on('error', (e) => console.log('错误', e));
t.on('kicked', (r) => console.log('被踢', r));
