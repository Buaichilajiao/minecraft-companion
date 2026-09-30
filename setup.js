#!/usr/bin/env node
/**
 * setup.js — 智能配置引导（人和 AI agent 通用）
 *
 * 用法:
 *   node setup.js            # 交互式问答，Enter 用默认值
 *   node setup.js --auto     # 全自动生成最小可用配置（适合 agent 无人值守）
 *   node setup.js --auto --brain=llm --apiKey=sk-xxx   # 指定大脑模式
 *
 * 行为:
 *   - 检测 Node 版本 / config.json 是否已存在（存在则备份为 config.json.bak）
 *   - 自动探测 AstrBot (127.0.0.1:6185) → 大脑用 astrbot 桥模式（无需 apiKey）
 *   - 生成 config/config.json 并打印摘要 + 下一步命令
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

const ROOT = __dirname;
const CFG_DIR = path.join(ROOT, 'config');
const CFG_PATH = path.join(CFG_DIR, 'config.json');

const argv = process.argv.slice(2);
const auto = argv.includes('--auto');
const force = argv.includes('--force');
const getArg = (key) => {
  const hit = argv.find((a) => a.startsWith(`--${key}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};

const DEFAULT = {
  mcpPort: 3001,
  mc: {
    host: 'localhost',
    port: 25565,
    version: 'auto',
    username: 'AI_Companion',
    auth: 'offline',
    password: '',
    authServer: 'https://littleskin.cn/api/yggdrasil/authserver',
  },
  brain: {
    mode: 'astrbot',
    baseUrl: 'http://127.0.0.1:6185',
    apiKey: '',
    model: '',
    sessionId: 'mc-companion',
    timeoutMs: 120000,
  },
  lifestyle: { enabled: false, autoLearn: true },
  guardian: { enabled: true, retreatHp: 8, eatHp: 12, maxDist: 64, wanderRadius: 24 },
};

function log(...a) { console.log(...a); }
function warn(...a) { console.log('⚠️ ', ...a); }
function ok(...a) { console.log('✅', ...a); }

function detectAstrbot() {
  // AstrBot 默认 API 端口 6185，通了就当大脑宿主用
  try {
    const r = execSync('powershell -NoProfile -Command "(Test-NetConnection 127.0.0.1 -Port 6185 -WarningAction SilentlyContinue).TcpTestSucceeded"', { encoding: 'utf8', timeout: 8000 }).trim();
    return r === 'True';
  } catch { return false; }
}

function randomName() {
  const adj = ['Wandering', 'Curious', 'Sunny', 'Brave', 'Gentle'];
  const noun = ['Companion', 'Pal', 'Buddy', 'Sidekick', 'Mate'];
  return `${adj[Math.floor(Math.random() * adj.length)]}_${noun[Math.floor(Math.random() * noun.length)]}_${Math.floor(Math.random() * 900 + 100)}`;
}

// auto 模式下 ask 直接返回默认值，不需要 readline；交互模式惰性创建
let rl = null;
function getRl() {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}
async function ask(_rl, question, def) {
  if (auto) return def;
  return new Promise((resolve) => {
    rl.question(`  ${question}${def !== '' && def !== undefined ? ` [默认: ${def}]` : ''}: `, (ans) => {
      resolve(ans.trim() === '' ? def : ans.trim());
    });
  });
}

async function main() {
  log('==============================================');
  log('  minecraft-companion 智能配置引导');
  log('==============================================');

  // 0. Node 版本
  try {
    const v = process.versions.node.split('.')[0];
    if (Number(v) < 18) { warn(`Node 版本过低: ${process.versions.node}（需要 18+）`); }
    else ok(`Node ${process.versions.node}`);
  } catch {}

  // 1. 依赖检查
  const hasDeps = fs.existsSync(path.join(ROOT, 'node_modules'));
  if (!hasDeps) {
    log('\n① 依赖未安装，正在 npm install ...');
    try {
      execSync('npm install --no-audit --no-fund', { cwd: ROOT, stdio: 'inherit', timeout: 600000 });
      ok('依赖安装完成');
    } catch (e) {
      warn(`npm install 失败: ${e.message}`);
    }
  } else {
    ok('依赖已安装');
  }

  // 2. 已有配置保护
  if (fs.existsSync(CFG_PATH) && !force) {
    log('\n② 检测到已有 config/config.json，跳过生成（不覆盖现有配置）');
    if (auto) {
      log('   想重新生成？加 --force:  node setup.js --auto --force');
      return;
    } else {
      const overwrite = await ask(getRl(), '已存在配置，是否覆盖? (y/N)', 'N');
      if (String(overwrite).toLowerCase() !== 'y') {
        log('已保留现有配置，退出。');
        return;
      }
    }
  } else if (fs.existsSync(CFG_PATH)) {
    const bak = CFG_PATH + '.bak';
    fs.copyFileSync(CFG_PATH, bak);
    log(`\n② 已有 config.json，已备份到 ${path.basename(bak)}（--force 覆盖）`);
  }

  const cfg = JSON.parse(JSON.stringify(DEFAULT));

  // 3. 大脑模式
  const astrbotUp = detectAstrbot();
  log('\n③ 大脑配置（决定机器人听谁的）');
  if (auto) {
    const mode = getArg('brain') || (astrbotUp ? 'astrbot' : 'llm');
    cfg.brain.mode = mode;
    if (mode === 'llm') {
      cfg.brain.baseUrl = getArg('baseUrl') || 'https://api.deepseek.com/v1';
      cfg.brain.apiKey = getArg('apiKey') || '';
      cfg.brain.model = getArg('model') || '';
      if (!cfg.brain.apiKey) warn('llm 模式需要 apiKey（--apiKey=sk-xxx），缺了大脑不工作');
    }
  } else {
    if (astrbotUp) {
      ok(`检测到本机 AstrBot (127.0.0.1:6185)，大脑默认用 AstrBot 桥（无需 apiKey）`);
    } else {
      warn('未检测到 AstrBot，大脑需要直连 LLM API 或关闭');
    }
    const mode = await ask(getRl(), '大脑模式? (astrbot / llm / none)', astrbotUp ? 'astrbot' : 'llm');
    cfg.brain.mode = mode;
    if (mode === 'llm') {
      cfg.brain.baseUrl = await ask(getRl(), 'LLM API 地址', 'https://api.deepseek.com/v1');
      cfg.brain.apiKey = await ask(getRl(), 'LLM API Key', '');
      cfg.brain.model = await ask(getRl(), '模型名', '');
    }
  }
  if (cfg.brain.mode === 'astrbot') { cfg.brain.baseUrl = 'http://127.0.0.1:6185'; }

  // 4. MC 服务器
  log('\n④ Minecraft 服务器（机器人要进的世界）');
  cfg.mc.host = await ask(getRl(), '服务器地址', 'localhost');
  cfg.mc.port = Number(await ask(getRl(), '端口', '25565'));
  cfg.mc.version = await ask(getRl(), '游戏版本 (auto / 1.21.1 / ...)', 'auto');
  const auth = await ask(getRl(), '登录方式 (offline / yggdrasil / microsoft)', 'offline');
  cfg.mc.auth = auth;
  if (auth === 'offline') {
    cfg.mc.username = auto ? (getArg('username') || randomName()) : await ask(getRl(), '机器人名字（离线服随便起）', randomName());
    cfg.mc.password = '';
  } else {
    cfg.mc.username = await ask(getRl(), '账号', '');
    cfg.mc.password = await ask(getRl(), '密码', '');
    if (auth === 'yggdrasil') {
      cfg.mc.authServer = await ask(getRl(), '外置登录服务器', 'https://littleskin.cn/api/yggdrasil/authserver');
    }
  }

  // 5. 写文件
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  ok(`\n⑤ 已生成 ${path.relative(ROOT, CFG_PATH)}`);

  // 6. 摘要
  log('\n========== 配置摘要 ==========');
  log(`  MCP 端口   : ${cfg.mcpPort}`);
  log(`  服务器     : ${cfg.mc.host}:${cfg.mc.port} (${cfg.mc.version})`);
  log(`  机器人账号 : ${cfg.mc.username} (${cfg.mc.auth})`);
  log(`  大脑模式   : ${cfg.brain.mode}${cfg.brain.mode === 'llm' ? (cfg.brain.apiKey ? ' ✅ 有key' : ' ⚠️ 缺key') : ''}`);
  log('===============================');

  // 7. 校验提示
  const missing = [];
  if (!cfg.mc.username) missing.push('mc.username');
  if (cfg.brain.mode === 'llm' && !cfg.brain.apiKey) missing.push('brain.apiKey');
  if (missing.length) {
    warn(`还缺: ${missing.join(', ')} — 请补填 config/config.json 后重启`);
  } else {
    ok('配置完整，可以启动！');
    log('\n下一步:');
    log('  node dist/main.js');
    log('  或:  npm start');
    log('  MCP SSE 地址: http://127.0.0.1:3001/mcp');
  }
}

main().then(() => { if (rl) rl.close(); }).catch((e) => { console.error('setup 失败:', e); if (rl) rl.close(); process.exit(1); });
