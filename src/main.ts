import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from './config';
import { dimOf, log } from './utils';
import { MemoryManager } from './memory';
import { MemoryV2 } from './memory-v2';
import { CrossMemory } from './cross-memory';
import { BotConnection } from './bot-connection';
import { StatusCollector } from './status';
import { McpServerManager } from './mcp-server';
import { BrainBridge } from './brain';
import { ChatContextBuilder } from './chat-context';
import { BodyController } from './body-controller';
import { Guardian } from './guardian';
import { Lifestyle } from './lifestyle';
import { Companion } from './companion';
import { PixieReflect } from './reflect';
import { registerAllTools } from './tools';
import { chatSegmented } from './tools/helpers';
import { registerSkillTools } from './skills';
import { SelfCheck, registerSelfCheckTool } from './selfcheck';
import { EmotionSystem } from './emotion';
import { EventBus, EventWatcher } from './events';
import type { ToolContext } from './tools/context';
import { LandmarkStore, setGlobalLandmark, getGlobalLandmark, type LandmarkType } from './landmark';
import { GazeController } from './gaze';
import { HeadFollowController } from './head-follow';
// 知识库离线整理（玩家下线且待整理非空 → 自动归纳进板块；由大脑参与语义分流）
import { runOfflineSummary } from './tools/knowledge-tools';
import { pendingCount } from './knowledge';
import { SoloEngine } from './engine/solo-engine';
import { CoopEngine } from './engine/coop-engine';
import { ModeController } from './engine/mode-controller';

async function main(): Promise<void> {
  const cfg = loadConfig();
  log('INFO', '══════════════════════════════════════');
  log('INFO', '  🎮 minecraft-companion 启动');
  log('INFO', '══════════════════════════════════════');

  const memory = new MemoryManager();
  // 记忆层 v2（蓝图六节）：独立落盘 memory2.json，不碰 v1 结构。顶层 new → 跨重连存活
  const memoryV2 = new MemoryV2();
  // 跨端记忆桥：独立落盘 cross-memory.json，QQ 与游戏两端共享（解决进游戏失忆）
  const crossMemory = new CrossMemory();
  // 游戏记忆点系统（执行设计文档）：独立 landmarks.json，只存重要地点坐标；registry 供 guardian/companion/skills 解耦取用
  const landmarkStore = new LandmarkStore(cfg.landmarks);
  setGlobalLandmark(landmarkStore);
  // P1 模式控制器（蓝图七/八/九节）：双引擎顶层建，只吃 StatusData → 跨重连存活，无 listener/timer
  const soloEngine = new SoloEngine(memory, { boredThreshold: cfg.mode.soloBoredomThreshold });
  const coopEngine = new CoopEngine(memory, {
    returnRadius: cfg.mode.coopReturnRadius,
    followRadius: cfg.mode.coopFollowRadius,
  });
  const modeCtrl = new ModeController(soloEngine, coopEngine, {
    coopRadius: cfg.mode.coopRadius,
    hysteresisTicks: cfg.mode.modeHysteresisTicks,
  });
  // 模式切换上下文衔接：写 v1 时间线 + v2 情绪记忆 → 大脑下次回复自然带出当前模式
  modeCtrl.onSwitch = (from, to) => {
    const pn = memory.data.relationship.player_name || '玩家';
    if (to === 'coop') {
      memoryV2.rememberEvent(`${pn} 来到我身边，我切换到陪伴模式`, '开心', 6);
      memory.pushTimeline(`${pn} 在身边，切换到陪伴模式`);
    } else {
      memoryV2.rememberEvent(`${pn} 不在身边，我回到独自生活模式`, '平静', 5);
      memory.pushTimeline(`${pn} 不在身边，回到独自生活模式`);
    }
  };
  // 每轮 onSpawn 重建的情绪/事件引用（工具 getter 用，重连时指向最新实例）
  let emotionRef: EmotionSystem | null = null;
  let eventBusRef: EventBus | null = null;
  const conn = new BotConnection(cfg.mc);

  // 延迟初始化的子系统引用（工具闭包使用）
  let statusRef: StatusCollector | null = null;
  let brainRef: BrainBridge | null = null;
  let lifestyleRef: Lifestyle | null = null;
  let selfCheckRef: SelfCheck | null = null;
  // 生命周期子系统（重连泄漏修复：提升到 onSpawn 外，断线/重连时统一 detach）
  let guardianRef: Guardian | null = null;
  let companionRef: Companion | null = null;
  let reflectRef: PixieReflect | null = null;
  let gazeRef: GazeController | null = null;
  let headFollowRef: HeadFollowController | null = null;

  // 身体控制权（v1.2.0：统一互斥，guardian > player > auto）
  const body = new BodyController();

  // MCP 服务器（v1.2.0：传入 BodyController，动作类工具统一走身体锁）
  const mcp = new McpServerManager('minecraft-companion', '1.6.0', cfg.mcpPort, body, cfg.clientWhitelist ?? []);

  // 工具上下文
  const ctx: ToolContext = {
    bot: () => conn.bot,
    reconnect: async () => {
      log('INFO', '工具触发重连（恢复窗口状态）...');
      await conn.start();
    },
    memory,
    status: () => {
      if (!statusRef || !conn.bot) throw new Error('游戏尚未就绪');
      return statusRef.getStatus();
    },
    brain: undefined,
    lifestyle: undefined,
    body: () => body,
    chatHistory: () => brainRef?.getHistory() ?? [],
    emotion: () => emotionRef,
    eventBus: () => eventBusRef,
    memoryV2,
    crossMemory,
    gaze: () => gazeRef,
    guardian: () => guardianRef,
    companion: () => companionRef,
  };
  ctx.brain = brainRef ?? undefined;
  ctx.lifestyle = lifestyleRef ?? undefined;

  // 注册全部工具（15 模块）
  const moduleCount = registerAllTools(mcp, ctx);
  log('INFO', `已注册 ${moduleCount} 个工具模块`);
  // 注册技能库（12 个复合流程技能）
  const skillCount = registerSkillTools(mcp, ctx);
  log('INFO', `已注册 ${skillCount} 个技能`);
  // 注册自检工具（游戏内/QQ 均可触发）
  registerSelfCheckTool(mcp, () => selfCheckRef);

  // bot 进入游戏后初始化子系统
  conn.onSpawn = (bot) => {
    log('INFO', 'bot 已进入游戏，初始化子系统...');
    // ⚠️ 重连泄漏修复：先清上一轮子系统（清 interval/listener/状态），再挂新实例
    guardianRef?.detach(); guardianRef = null;
    lifestyleRef?.detach(); lifestyleRef = null;
    companionRef?.detach(); companionRef = null;
    reflectRef = null; // 反射旁路无 listener/timer，随子系统中止重建
    gazeRef?.detach(); gazeRef = null;
    headFollowRef?.detach(); headFollowRef = null;
    statusRef = new StatusCollector(bot, () => ({
      tech_unlocked: memory.data.tech_unlocked,
      current_goal: memory.data.current_goal,
      last_activity: memory.data.last_activity,
    }));
    // 情绪 + 事件层（蓝图接线 v1：注入不干预。每 5s lifestyle tick 里扫描+衰减，断线随三件套一起重建）
    const emotion = new EmotionSystem(3);
    const eventBus = new EventBus();
    emotionRef = emotion;
    eventBusRef = eventBus;
    const eventWatcher = new EventWatcher(bot, memory, statusRef, emotion, eventBus);

    // P2-3 聊天上下文组装器：统一喂 brain 的 8 字段（world/self/player/事件/记忆…）。
    // 闭包全部延迟解析：消息到达时各 ref 都已指向本轮实例。事件轨危险升级由 eventWatcher 负责，
    // 持续威胁由本组装器的"【周围威胁】"状态轨每次注入（P2-2 双轨制）。
    const chatCtx = new ChatContextBuilder({
      status: () => statusRef?.getStatus() ?? null,
      memoryV2,
      landmark: () => getGlobalLandmark(),
      chatHistory: () => brainRef?.getHistory() ?? [],
      recentEvents: () => eventBus.recent(8),
      emotion: () => emotion,
    });
    brainRef = new BrainBridge(cfg.brain, () => conn.bot, 3000, chatCtx, cfg.identity?.identityMapping, crossMemory);
    // 记忆层 v2 注入大脑（短期印象/熟悉地点/玩家画像/话题避免）
    brainRef.onMemoryContext = () => {
      const pn = memory.data.relationship.player_name;
      const text = memoryV2.getContext(pn);
      // 最近经历（时间线尾部，倒序取非聊天碎语）：回答"刚才干嘛去了/你死了吗"时有据可依，
      // 不会把"被重启重连"脑补成"挂了一次复活"
      const recent: string[] = [];
      const tl = memory.data.timeline;
      for (let i = tl.length - 1; i >= 0 && recent.length < 3; i--) {
        const e = tl[i];
        if (e.event.startsWith('我对玩家说') || e.event.startsWith('进入了游戏')) continue;
        const d = new Date(e.t);
        const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        recent.push(`${hm} ${e.event}`);
      }
      const parts: string[] = [];
      if (text) parts.push(`记忆（我对这里和玩家的了解）：
${text}`);
      if (recent.length > 0) parts.push(`最近经历（刚才发生了什么）：${recent.reverse().join('；')}`);
      return parts.join('\n');
    };
    // 情绪/事件注入大脑上下文（语气参考 + 刚发生的世界动态）
    brainRef.onEmotionContext = () => emotion.summarize();
    brainRef.onEventsContext = () => {
      const unread = eventBus.getUnread();
      if (unread.length === 0) return '';
      const recent = unread.slice(-3).map((e) => e.description).join('；');
      return `刚发生的事（我是亲历者视角）：${recent}`;
    };

    // 大脑回复 → 游戏聊天 + 生活循环状态推进（长回复自动分段完整发，不截断话尾）
    brainRef.onReply = (reply) => {
      void chatSegmented(bot, reply);
      lifestyleRef?.onCommandDone();
      memory.pushTimeline(`我对玩家说: ${reply.slice(0, 60)}`);
      memoryV2.addChatMessage(bot.username, reply);
    };
    brainRef.onThinking = () => {
      // 大脑处理期间保持 working（onPlayerCommand 已切）
    };

    // 游戏聊天监听（v1.7.1 触发策略 + 对话上下文窗口）
    // 命中判断：私聊永远命中（whisper 单独监听）；公共频道按模式 + 点名（bot.username/triggerNames/@）过滤；
    // 点名命中/窗口内延续 → 自动续聊（多人模式喊一次可聊 contextWindowSec 秒）
    const me = bot.username || '';
    const chatMode = cfg.chat.triggerMode;
    const triggerNames: string[] = [me, ...(cfg.chat.triggerNames || [])];
    const windowSec = cfg.chat.contextWindowSec ?? 60;
    // 按玩家维护对话窗口（懒清理：每次判断时检查过期即可，无需定时器）
    const chatWindows = new Map<string, number>();
    const touchWindow = (u: string): void => {
      if (windowSec > 0) chatWindows.set(u, Date.now() + windowSec * 1000);
    };
    const windowAlive = (u: string): boolean => {
      const exp = chatWindows.get(u);
      return exp != null && exp >= Date.now();
    };
    const isNamed = (msg: string): boolean => {
      const lower = msg.toLowerCase();
      return msg.startsWith('@') || triggerNames.some((n) => n && lower.includes(n.toLowerCase()));
    };
    // 主动结束语 → 回复后关闭该玩家窗口（轻量关键词；后续可换 brain 意图信号）
    const FAREWELLS = ['拜拜', '再见', '没事了', '结束对话', '不聊了', '回头见', '先走啦'];
    const isFarewell = (msg: string): boolean => FAREWELLS.some((w) => msg.includes(w));
    const publicShouldEngage = (username: string, msg: string): boolean => {
      // 测试开关：minecraft-companion/.no_auto_reply 存在时暂停大脑自动回复（工具回归临时关，删文件即恢复）
      if (fs.existsSync(path.join(__dirname, '..', '.no_auto_reply'))) return false;
      if (chatMode === 'always') return true;
      if (chatMode === 'name_only') return isNamed(msg) || windowAlive(username);
      // auto：服务器里除自己外只有 ≤1 名玩家 → 公共消息都视为对我说；≥2 人 → 需点名或该玩家窗口未过期
      const others = Object.keys(bot.players).filter((p) => p !== me).length;
      if (others <= 1) return true;
      return isNamed(msg) || windowAlive(username);
    };
    // ── 记忆点玩家指令（游戏记忆点系统·执行设计文档 §4.2/§11）──
    // 返回 true = 已代答且不再进大脑（删除类）；记录类执行完 return false → 照常进大脑自然回应。
    const handleLandmarkCommand = (username: string, message: string): boolean => {
      const store = getGlobalLandmark();
      const posE = bot.entity?.position;
      if (!store || !posE) return false;
      const msg = message.replace(/^\(私聊\)\s*/, '').trim();
      if (msg.length < 2) return false;
      const pos = { x: Math.floor(posE.x), y: Math.floor(posE.y), z: Math.floor(posE.z) };
      const dim = dimOf(bot) === 'unknown' ? 'overworld' : dimOf(bot);
      // —— 删除类：系统代答（大脑没有删除能力，交它会穿帮）——
      if (/(?:删掉|删除|删了|忘了|忘掉|忘记).{0,6}(?:记忆|标记|地点|它|这个|那个)/.test(msg)) {
        const kw = (/(?:删掉|删除|删了|忘了|忘掉|忘记)([^，。！？!?\s]{0,6})/.exec(msg) ?? [])[1] ?? '';
        const typeMap: Record<string, LandmarkType> = {
          家: 'home', 基地: 'base', 死亡: 'death_spot', 矿洞: 'mine', 村庄: 'village',
          农场: 'farm', 末地传送门: 'end_portal', 传送门: 'nether_portal', 下界: 'nether_portal', 末地: 'end_portal',
        };
        let type: LandmarkType | null = null;
        for (const [k, t] of Object.entries(typeMap)) { if (kw.includes(k)) { type = t; break; } }
        const id = type ? store.getNearest(type, pos)?.id ?? null : null;
        if (!id) { bot.chat('嗯？我好像没记过这个'); return true; }
        const nm = store.getById(id)?.name ?? '那个地方';
        store.deactivate(id);
        memory.pushTimeline(`按${username}的话把「${nm}」的记忆点标记清掉了`);
        bot.chat(`嗯，${nm}的标记我收起来了，当没这回事`);
        return true;
      }
      // —— 记录类 · 家（搬家：旧 home 自动废弃，且同步旧系统防走丢锚点）——
      const isHome =
        msg.includes('这是家') || msg.includes('新家') || msg.includes('安家') ||
        msg.includes('这是我的家') || msg.includes('把这里当家') ||
        (/家/.test(msg) && /(这|那)/.test(msg) && /(是|当|记|放)/.test(msg));
      if (isHome) {
        store.setHome(dim, pos);
        memory.data.identity.home = [pos.x, pos.y, pos.z];
        memory.addTech('home');
        memory.pushTimeline(`在（${pos.x},${pos.y},${pos.z}）安了家（玩家${username}确认）`, [pos.x, pos.y, pos.z]);
        return false;
      }
      // —— 记录类 · 具体类型：记住这个矿洞/传送门/村庄/农场/基地 ——
      const kwTypes: Array<[RegExp, LandmarkType, string]> = [
        [/记住(?:这个|那个|这里的)?(末地传送门)/, 'end_portal', '末地传送门'],
        [/记住(?:这个|那个|这里的)?(传送门|下界门)/, 'nether_portal', '传送门'],
        [/记住(?:这个|那个|这里的)?(矿洞|矿道|洞)/, 'mine', '矿洞'],
        [/记住(?:这个|那个|这里的)?村庄/, 'village', '村庄'],
        [/记住(?:这个|那个|这里的)?(农场|牧场)/, 'farm', '农场'],
        [/记住(?:这个|那个|这里的)?(基地|据点)/, 'base', '基地'],
      ];
      for (const [re, t, label] of kwTypes) {
        if (re.test(msg)) { store.addLandmark(t, label, pos, dim, ''); return false; }
      }
      if (msg.includes('基地') && /(是|当|记|就)/.test(msg)) { store.addLandmark('base', '基地', pos, dim, ''); return false; }
      // —— 记录类 · 兴趣点：记住这里 ——
      if (/记住这里|记下这里|标记这里|记住这个地方|记一下这里/.test(msg)) { store.addLandmark('poi', '兴趣点', pos, dim, ''); return false; }
      return false;
    };
    const engage = (username: string, message: string): void => {
      // 记忆点指令：删除类已代答且不进大脑（也不留对话记录，避免大脑当"没回应"补答）
      if (handleLandmarkCommand(username, message)) return;
      // 玩家对 bot 说话 → 记入 v2 对话记忆 + 命令模式 + 触发大脑
      memoryV2.addChatMessage(username, message);
      lifestyleRef?.onPlayerCommand();
      brainRef!.enqueuePlayerMessage(username, message);
    };
    // ── 系统/命令反馈过滤（2026-09-12 修）────────────────────────────
    // 现象：玩家每次给自己改游戏模式，bot 都会回一句话，而且回得驴唇不对马嘴。
    // 根因：服务器广播的 "Set own game mode to Spectator Mode" 这类命令反馈走到了
    //       bot.on('chat')，被当成"玩家对我说话" → 记进对话历史 → 触发大脑 → 大脑礼貌回一句。
    // 修法：① 命令反馈样式词表 ② 系统消息嗅探兜底（近 2.5s 以 system/game_info 身份出现过的同文本）
    //       两者命中都只写日志，既不进对话历史也不惊动大脑。
    const SYS_FEEDBACK: RegExp[] = [
      /^set own game mode to /i, /^set (?:the )?game mode (?:of|for) /i,
      /^changed (?:your|the|own) game mode/i, /^game mode (?:is|was|has been) (?:set|changed)/i,
      /^set the time to /i, /^time (?:is|was) set/i, /^set the weather/i, /^weather (?:set|cleared)/i,
      /^teleported /i, /^you (?:have been|were) teleported/i, /^gave /i, /^you (?:have been|were) given/i,
      /^unknown (?:command|or incomplete command)/i, /^you do not have permission/i, /^saved the game$/i,
      /^no (?:person|player|entity) was found/i, /^(?:that )?player (?:is not|does not) (?:online|exist)/i,
      /^(?:已|你已|成功)?(?:切换|设置|更改|设为|改为)(?:自己|你|游戏)?(?:为|成)?(?:创造|生存|冒险|旁观|和平|普通|困难)(?:模式)?/,
      /(?:游戏模式|难度|时间|天气).{0,8}(?:设为|改为|调整为|设置|已切换|已更改为|已设为)/,
      /^(?:你|您)?(?:已被|被|已)?传送(?:到|至)/,
      /^(?:未知的?(?:命令|指令)|指令错误|语法错误|权限不足|你没有权限|服务器[:：])/,
      /^\[(?:服务器|Server|系统|System)\]/i,
      // —— 英文原版服务器命令反馈（OP 调试高频；漏匹配会被当成玩家聊天、污染对话记忆）——
      /^applied effect /i, /^effect has been (?:applied|removed|cleared)/i,
      /^changed the block at /i, /^no blocks were changed/i,
      /^gamerule .{1,40} is now set to[: ]/i,
      /^filled \d+ block/i, /^no blocks were filled/i,
      /^summoned new /i, /^killed /i, /^nothing happened/i,
      /^the target block is outside/i, /^position is not loaded/i,
      /^could not (?:find|summon|set)/i, /^successfully /i,
    ];
    const isSystemFeedback = (m: string): boolean => SYS_FEEDBACK.some((re) => re.test(m.trim()));
    // 近 5 秒内以系统身份出现过的文本 → 兜住词表没覆盖的反馈（懒清理，不用定时器）
    const recentSystem = new Map<string, number>();
    bot.on('message', (jsonMsg, position) => {
      try {
        const text = String(jsonMsg).trim();
        if (!text) return;
        const pos = String(position ?? '');
        if (pos !== 'system' && pos !== 'game_info' && pos !== 'gameinfo') return;
        recentSystem.set(text, Date.now());
        for (const [k, t] of recentSystem) if (Date.now() - t > 5000) recentSystem.delete(k);
        const j = jsonMsg as unknown as { translate?: string; json?: { translate?: string } };
        const key = j.translate ?? j.json?.translate ?? '';
        log('INFO', `[系统消息${pos === 'system' ? '' : '/' + pos}${key ? ' ' + key : ''}] ${text.slice(0, 80)}`);
      } catch { /* ignore */ }
    });
    const wasSystemJustNow = (m: string): boolean => {
      const ts = recentSystem.get(m.trim());
      return ts != null && Date.now() - ts < 2500;
    };
    // 命令反馈 → 带玩家名前缀的人话（写进记忆也绝不裸放原文，防止大脑把"系统广播"当成"玩家在对我说话"）
    const GM_CN: Record<string, string> = { creative: '创造', survival: '生存', adventure: '冒险', spectator: '旁观' };
    const describeFeedback = (who: string, raw: string): string => {
      const t = raw.trim();
      let m = /^set own game mode to (\w+) mode/i.exec(t);
      if (m) {
        const g = m[1].toLowerCase();
        return `${who} 把自己的游戏模式改成了「${GM_CN[g] ?? g}」`;
      }
      m = /^set (?:the )?game mode (?:of|for) (\S+) to (\w+) mode/i.exec(t);
      if (m) return `${who} 把 ${m[1]} 的游戏模式改成了「${GM_CN[m[2].toLowerCase()] ?? m[2]}」`;
      if (/^changed (?:your|own) game mode/i.test(t)) return `${who} 换了自己的游戏模式`;
      if (/^set the time to /i.test(t)) return `${who} 改了时间（${t.replace(/^set the time to /i, '')}）`;
      if (/^set the weather/i.test(t) || /^weather (?:set|cleared)/i.test(t)) return `${who} 改了天气`;
      if (/^teleported /i.test(t)) return `${who} 用了传送：${t.replace(/^teleported /i, '到 ')}`;
      return `${who} 触发了服务器提示`;
    };

    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      // 本地反射旁路：come/stop/危险/躲避 等运动类短指令毫秒级本地响应。
      // 命中返回 true → 不进对话历史、不触发大脑、直接短路跳出（反射非拟人对话）。
      if (reflectRef?.handle(username, message)) return;
      // 系统/命令反馈：不惊动大脑（否则它把这句当真、回一句驴唇不对马嘴的话），
      // 但照写进对话历史 —— 必须带玩家名前缀 + 「不是玩家发言」标注，否则大脑会弄混是谁说的。
      if (isSystemFeedback(message) || wasSystemJustNow(message)) {
        const note = describeFeedback(username, message);
        brainRef!.addChat(username, `【系统提示·不是玩家发言】${note}（原文: ${message.slice(0, 60)}）`);
        if (/game mode|游戏模式/i.test(message)) memory.pushTimeline(note);
        log('INFO', `[chat] 系统/命令反馈 → 只记录不回应: ${message.slice(0, 80)}`);
        return;
      }
      brainRef!.addChat(username, message);
      // 自检命令：不经过大脑，直接跑自检
      if (message.includes('自检')) {
        void selfCheckRef?.reportToChat();
        return;
      }
      if (!publicShouldEngage(username, message)) return;
      // 窗口维护：结束语 → 关窗；其余（点名激活/窗口内延续/单人全自动）→ 续期
      if (isFarewell(message)) chatWindows.delete(username);
      else touchWindow(username);
      engage(username, message);
    });
    // 私聊（/msg 或点到 bot）：永远视为对我说，不受人数/模式限制
    bot.on('whisper', (username, message) => {
      if (username === bot.username) return;
      brainRef!.addChat(username, message);
      engage(username, `(私聊) ${message}`);
    });

    // 子系统
    // v17：把身体锁暴露到 bot 上（head-follow 等无 ctx 的后台模块据此让位，避免抢视线）
    (bot as unknown as { __bodyController?: unknown }).__bodyController = body;
    guardianRef = new Guardian(bot, memory, statusRef, cfg.guardian, body, emotion);
    guardianRef.attach();

    // 常驻注视系统：空闲自动盯附近玩家（独立于大脑，bot 一进游戏就挂）
    gazeRef = new GazeController(bot, body);
    gazeRef.attach();

    // 走哪看哪（全局移动转头兜底）：任意移动中头随前进方向；站定绝不碰头（让位主动视线）
    headFollowRef = new HeadFollowController(bot);
    headFollowRef.attach();

    // 自检器（引用 guardian，需在其后创建）
    const selfCheck = new SelfCheck(bot, memory, statusRef, cfg, brainRef, () => true);
    selfCheckRef = selfCheck;

    const lifestyle = new Lifestyle(bot, memory, statusRef, cfg.lifestyle, brainRef, body, eventWatcher, emotion, modeCtrl, cfg.companion);
    lifestyleRef = lifestyle;
    lifestyle.attach();
    const companion = new Companion(bot, memory, statusRef, brainRef, cfg.chat.injuryChat, cfg.chat.eventChat, cfg.chat.autoSpeak, cfg.heartbeat);
    companionRef = companion;
    companion.attach();
    // 本地反射旁路：玩家运动类短指令毫秒级响应，不走 LLM（创建于 guardian 之后以引用其 PVP 停战能力）
    const reflect = new PixieReflect(bot, memory, body, guardianRef, cfg.reflect);
    reflectRef = reflect;
    // 战斗事件说话 → companion（经大脑生成，禁预设）；两模块每轮 onSpawn 重建，须每轮重接
    guardianRef.combatSay = (ev, t) => {
      try { companion.sayCombat(ev, t); } catch { /* 说话失败不影响战斗 */ }
    };
    // 护人进行中 → 心跳静默（防叠话）：开护/护完实时通知 companion
    guardianRef.onProtectChange = (active) => {
      try { companion.setProtectActive(active); } catch { /* 广播失败不影响战斗 */ }
    };

    // 进游戏打招呼：不背预设口号，交给大脑按当前在线人数/自己想法现场组织一句
    // （有人 → 自然打招呼；没人/只有自己 → 发个感叹/观察环境之类）。3s 后等状态就绪再触发。
    setTimeout(() => {
      try {
        const me = bot.username || '';
        const others = Object.keys(bot.players ?? {}).filter((p) => p !== me);
        const prompt = others.length > 0
          ? `我刚上线进游戏，现在服务器里还有 ${others.join('、')} 在线。请按真实情况组织一句自然的进场招呼或感叹（不要用"大家好我是某某我来啦"这种固定模板，说你自己当场想说的话），直接输出这句话。`
          : `我刚上线进游戏，现在服务器里暂时没有其他人了。请随性说一句你自己想说的话（可以是对环境的感叹、接下来想干嘛之类），别背固定开场白，直接输出。`;
        void brainRef?.trigger(prompt).then((reply) => {
          if (reply && reply.trim()) chatSegmented(bot, reply.trim());
        }).catch(() => { /* 打招呼失败不影响游戏 */ });
      } catch {
        /* ignore */
      }
    }, 3000);
    // ── 知识库离线整理触发：玩家全部下线且有待整理知识点 → 大脑已分类，归档进板块 ──
    // 玩家离开 → 稍等 8s 让最后几条聊天/记忆落盘 → 若服务器已无其他玩家且待整理非空 → 整理
    bot.on('playerLeft', () => {
      setTimeout(() => {
        try {
          const me = bot.username || '';
          const others = Object.keys(bot.players ?? {}).filter((p) => p !== me);
          if (others.length > 0) return; // 还有别的人在，不抢着整理
          const n = pendingCount();
          if (n === 0) return;
          log('INFO', `🧠［知识库］检测到无玩家在线，开始离线整理 ${n} 条待归类知识点`);
          void runOfflineSummary().then((res) => {
            log('INFO', `🧠［知识库］${res}`);
          }).catch((e) => log('WARN', `知识库离线整理失败: ${e}`));
        } catch (e) {
          log('WARN', `知识库离线整理检查失败: ${e}`);
        }
      }, 8000);
    });
    // ── 经历同步：区分"死亡重生"与"退出重进/被重启" ──
    // 外部重启(工作测试)在启动前写 data/maintenance.json，bot 登录认领后把
    // "被重启(不是死亡)"写进记忆，避免把重连误述成"挂了一次复活/莫名其妙死了"。
    try {
      const mPath = path.join(__dirname, '..', 'data', 'maintenance.json');
      const gap = (() => {
        const last = memory.data.timeline[memory.data.timeline.length - 1];
        return last ? Date.now() - last.t : Infinity;
      })();
      let note = '';
      if (fs.existsSync(mPath)) {
        const raw = fs.readFileSync(mPath, 'utf-8').replace(/^\uFEFF/, '');
        const m = JSON.parse(raw) as { t?: number; note?: string };
        fs.rmSync(mPath, { force: true });
        if (m.t && Date.now() - m.t < 20 * 60 * 1000) note = (m.note || '系统维护').slice(0, 40);
      }
      if (note) {
        memoryV2.rememberEvent(`我刚才被${note}（掉线重启了一回，不是死亡），现在重新上线了`, '平静', 6);
        memory.pushTimeline(`被${note}，重新进入了游戏`);
        log('INFO', `📋 认领维护便签: ${note}`);
      } else if (gap < 3 * 60 * 1000) {
        // 无便签但刚进过游戏又进来：多半是掉线/被重启 → 如实记为"重连"，别让大脑脑补成"死了复活"
        memoryV2.rememberEvent('我刚才掉线重连了一回（不是死亡重生），现在重新上线了', '平静', 5);
        memory.pushTimeline('掉线后重连，重新进入了游戏');
        log('INFO', '📋 检测到短时间重连（无维护便签），记为掉线重连');
      }
    } catch (e) {
      log('WARN', `维护便签处理失败: ${e}`);
    }
    memory.pushTimeline('进入了游戏');
  };

  conn.onDisconnect = (reason) => {
    log('WARN', `游戏连接断开: ${reason}，清理子系统等待重连`);
    // 断线即清理，防止旧 interval 残留在后台空转/抢身体
    guardianRef?.detach(); guardianRef = null;
    lifestyleRef?.detach(); lifestyleRef = null;
    companionRef?.detach(); companionRef = null;
    reflectRef = null; // 反射旁路无 listener/timer，随子系统中止重建
    gazeRef?.detach(); gazeRef = null;
    headFollowRef?.detach(); headFollowRef = null;
  };

  // 启动
  mcp.start();
  await conn.start();

  // 优雅退出
  const shutdown = () => {
    log('INFO', '正在退出...');
    conn.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log('ERROR', `启动失败: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
