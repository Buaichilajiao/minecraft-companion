// 步骤4 全链路（可控版）：Tester 到 bot 旁，用 summon 在身边刷 zombie，观察 bot 主动帮打
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
  fs.writeFileSync(path.join(PROJECT, 'tools', 'arg-summon.json'), JSON.stringify({ command }));
  return execFileSync(NODE, ['tools/call.js', 'run-command', '@tools/arg-summon.json'], { cwd: PROJECT, encoding: 'utf8' });
};

t.once('spawn', async () => {
  console.log(stamp(), 'Tester 进入');
  let tries = 0;
  while (!t.players[BOTNAME] && tries < 20) { await sleep(1000); tries++; }
  await sleep(3000);

  // 到 bot 旁边
  let bp = botPos();
  if (bp) { try { await t.pathfinder.goto(new goals.GoalNear(Math.floor(bp.x), Math.floor(bp.y), Math.floor(bp.z), 3)); } catch {} }
  ['forward','back','sprint','jump'].forEach(k => t.setControlState(k, false));
  await sleep(2000);
  bp = botPos();
  console.log(stamp(), `就位，Tester=${t.entity.position.floored().toString()} bot=${bp?.floored().toString()}`);

  // 确保是夜晚
  console.log(runCmd('time set night').trim());
  await sleep(1500);

  // 在 Tester 身边 2 格 summon zombie
  const tp = t.entity.position;
  const sx = Math.floor(tp.x) + 2, sy = Math.floor(tp.y), sz = Math.floor(tp.z);
  console.log(stamp(), `summon zombie @ (${sx},${sy},${sz})`);
  console.log(runCmd(`summon zombie ${sx} ${sy} ${sz}`).trim());
  console.log(stamp(), '怪已刷，观察 60 秒（Tester 贴脸就后撤保命）');

  const start = Date.now();
  const obs = [];
  const timer = setInterval(() => {
    const b = botPos();
    const nearMob = Object.values(t.entities).filter(e => e && HOSTILES.includes(e.name) && e.position && e.position.distanceTo(t.entity.position) < 10);
    const dBot = b ? b.distanceTo(t.entity.position).toFixed(1) : '?';
    const mobs = nearMob.map(m => `${m.name}(${m.position.distanceTo(t.entity.position).toFixed(1)})`).join(',');
    obs.push(`+${((Date.now()-start)/1000).toFixed(0)}s bot距${dBot} 怪[${mobs}] 我血${Math.round(t.health)}`);
    if (nearMob.some(m => m.position.distanceTo(t.entity.position) <= 2.2)) t.setControlState('back', true);
    else t.setControlState('back', false);
  }, 3000);
  await sleep(60000);
  clearInterval(timer);
  t.setControlState('back', false);
  console.log('\n=== 观察记录 ===');
  obs.forEach(o => console.log(o));
  console.log(stamp(), '测试完成');
  t.quit();
  process.exit(0);
});

t.on('error', (e) => console.log('错误', e));
t.on('kicked', (r) => console.log('被踢', r));
