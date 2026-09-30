/**
 * A1 陪伴第一批 · 一站式压测套件
 * 顺序跑完反射 / 护人(苦力怕) / 护人(混合团战) / 护人(末影人) 四条边界。
 *
 * 用法:
 *   node tools/companion-suite.js            # 全跑
 *   node tools/companion-suite.js reflect creeper mixed ender   # 只跑指定的
 *
 * 前提:
 *   - 本地 1.21.1 服已开(25565)
 *   - XiaoBai_bot 已在 3001 运行(被测对象)
 *   - 各单测为独立 mineflayer 玩家脚本, 跑完自动退出
 *
 * 判定: 子进程 exit 0 且在 stdout 出现过 "完成" 即算通过; 否则失败。
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const NODE = 'D:\\nodejs\\node-v22.10.0-win-x64\\node.exe';
const TOOLS = __dirname;

// name -> 脚本文件 + 一句说明(输出会带上)
const CASES = [
  { name: 'reflect', file: 'test-reflect.js',  desc: '反射: 玩家指令毫秒级响应' },
  { name: 'creeper', file: 'test-creeper.js',  desc: '护人①: 单苦力怕引离' },
  { name: 'mixed',   file: 'test-mixed.js',    desc: '护人③: 混合团战(zombie+creeper)' },
  { name: 'ender',   file: 'test-ender.js',    desc: '护人④: 末影人引离' },
];

const requested = process.argv.slice(2);
const want = requested.length
  ? CASES.filter(c => requested.includes(c.name))
  : CASES;

if (!want.length) {
  console.error('没有可跑的用例。可选: ' + CASES.map(c => c.name).join(' / '));
  process.exit(1);
}

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

function runCase(c) {
  return new Promise((resolve) => {
    const script = path.join(TOOLS, c.file);
    if (!fs.existsSync(script)) {
      console.log(`[${c.name}] 缺脚本 ${c.file}, 跳过`);
      resolve({ name: c.name, pass: false, err: 'missing' });
      return;
    }
    console.log(`\n${'='.repeat(56)}\n[${stamp()}] ▶ 开始 ${c.name}: ${c.desc}\n${'='.repeat(56)}`);
    const child = spawn(NODE, [script], { cwd: path.join(TOOLS, '..'), stdio: 'inherit' });
    let sawDone = false; let out = '';
    child.stdout?.on('data', d => { out += d; if (out.includes('完成')) sawDone = true; });
    child.stderr?.on('data', d => out += d);
    child.on('close', (code) => {
      const pass = code === 0 && sawDone;
      console.log(`[${stamp()}] ${pass ? '✅ 通过' : '❌ 失败/中断'} ${c.name} (exit=${code}${sawDone ? ', 有"完成"' : ', 未出现"完成"'})`);
      resolve({ name: c.name, pass });
    });
  });
}

(async () => {
  const results = [];
  for (const c of want) results.push(await runCase(c));
  console.log(`\n${'='.repeat(56)}\n套件结果汇总 (${results.filter(r => r.pass).length}/${results.length} 通过)`);
  for (const r of results) console.log(`  ${r.pass ? '✅' : '❌'} ${r.name}${r.err ? ` (${r.err})` : ''}`);
  process.exit(results.every(r => r.pass) ? 0 : 1);
})();