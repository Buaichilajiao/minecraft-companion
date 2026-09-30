import type mineflayer from 'mineflayer';
import type { MemoryManager } from './memory';
import type { StatusCollector } from './status';
import type { BrainBridge } from './brain';
import type { AppConfig } from './config';
import { log, dimOf } from './utils';
import { getGlobalLandmark } from './landmark';
import { chatSegmented } from './tools/helpers';
import type { CombatSayEvent } from './guardian';

type InjuryCfg = AppConfig['chat']['injuryChat'];
type EventCfg = AppConfig['chat']['eventChat'];
type StageKey = 'none' | 'light' | 'heavy' | 'critical';
/** 游戏事件类型（仿真聊天系统设计文档 §3） */
type EvtKind =
  | 'rain' | 'rainStop' | 'thunder'
  | 'night' | 'day'
  | 'enterNether' | 'enterEnd' | 'leaveNether' | 'leaveEnd'
  | 'hunger_low' | 'hunger_critical';

/** 怪物类型 → 中文（伤害来源描述用） */
const SRC_CN: Record<string, string> = {
  zombie: '僵尸', skeleton: '骷髅', creeper: '苦力怕', spider: '蜘蛛', cave_spider: '洞穴蜘蛛',
  enderman: '末影人', witch: '女巫', blaze: '烈焰人', phantom: '幻翼', drowned: '溺尸',
  husk: '尸壳', stray: '流浪者', pillager: '掠夺者', vindicator: '卫道士', ravager: '劫掠兽',
  slime: '史莱姆', magma_cube: '岩浆怪', piglin: '猪灵', zombified_piglin: '僵尸猪灵',
  hoglin: '疣猪兽', zoglin: '僵尸疣猪兽', iron_golem: '铁傀儡', wolf: '狼', goat: '山羊',
};
const STAGE_LABEL: Record<StageKey, string> = { none: '无感', light: '轻伤', heavy: '重伤', critical: '濒死' };
const STAGE_ORDER: StageKey[] = ['none', 'light', 'heavy', 'critical']; // 下标越大越严重
const DIM_CN: Record<string, string> = { overworld: '主世界', nether: '下界', end: '末地' };

/**
 * 战斗事件 → 语气种子（sayCombat 用）。只描述情境与情绪倾向，文案由大脑现组织；
 * 每次注入都自然口语短句，绝不整句预设输出（违反就违背文档 §1.1）。
 */
const COMBAT_PROMPT: Record<CombatSayEvent, string> = {
  combat_start_pve: '有怪物（{target}）贴脸了，我准备应战。以真人玩家口吻随口说一句开战前的话。',
  protect_start: '{target}那边有怪威胁到他了，我去护他。以真人玩家口吻、用1秒内就能喊出口的短句安抚一句让人安心（别写太长、别播报）。',
  killed_mob: '我刚打退了{target}。以真人玩家口吻随口说一句（松口气/得意都行，别嘲讽别播报）。',
  escaped: '我刚甩掉威胁脱战了。以真人玩家口吻松口气说一句（后怕/庆幸都行）。',
  hit_by_player_1: '{target}突然打了我一下，我完全没防备。以真人玩家口吻表达困惑，问他为什么打我（我不还手）。',
  hit_by_player_2: '{target}又打我了，第二次了，有点疼。以真人玩家口吻表达委屈，让他别打了（我不还手）。',
  hit_by_player_3plus: '{target}还在打我。我很难过，一边躲远一边说（我不还手，只想走开）。',
  player_declared_pvp: '我和{target}约好切磋一场。以真人玩家口吻兴奋地应战（点到为止、不放水都行）。',
  pvp_end: '我和{target}的切磋刚结束。按我现在的血量/心情自然收尾：赢了就谦逊一句，输了夸对方，别嘲讽。',
};

/**
 * 说话风格约束（仿真聊天系统设计文档 §1.3，写死不可省略）：
 * 每次向 brain 注入上下文都附带 → 自然口语短句、贴合 MC 世界观、禁预设/文艺/播报。
 * 不做字数硬截断（出口拆句完整发，见 sendShortMessages），用自然语言引导说话节奏。
 * 说话出口统一拼接，任何调用方都绕不开。
 */
const MC_TALK_RULE =
  '约束：你是一个正在玩 Minecraft 的真人玩家，性格热情开朗，说话带着自然的兴奋劲儿，像和朋友一起玩那样有温度。开口就自然地说 1~2 句简短口语，像真人发消息那样说完就停：不要把话憋成干巴巴的几个字，也别一口气说成一大段长文，更不要把句子掐在半截。必须贴合 MC 游戏内的真实体验，不要说任何脱离 MC 游戏世界的话（禁止文艺感慨、现实感受、播报式语言）。直接输出这句话，不要调用任何工具。';

/** 事件 kind → 中文标签（timeline / 日志用） */
const EVT_LABEL: Record<EvtKind, string> = {
  rain: '下雨', rainStop: '雨停', thunder: '打雷',
  night: '天黑', day: '天亮',
  enterNether: '进下界', enterEnd: '进末地', leaveNether: '回主世界', leaveEnd: '回主世界',
  hunger_low: '饿了', hunger_critical: '饿惨',
};

/** 陪伴层：仿真聊天系统（受伤分阶段 + 游戏事件 + 统一触发出口）——让 bot 像朋友而不是工具/复读机 */
export class Companion {
  private bot: mineflayer.Bot;
  private memory: MemoryManager;
  private status: StatusCollector;
  private brain?: BrainBridge;
  private injuryCfg: InjuryCfg;
  private eventCfg: EventCfg;
  private greeted = new Set<string>();
  // ── 仿真聊天统一状态 ──
  private tickTimer: NodeJS.Timeout | null = null;
  /** 全局语音冷却（受伤+事件+关心共用同一时间戳：文档 §4.2 全局 30s 出口） */
  private lastEventSpeakAt = 0;
  private eventCooled: Partial<Record<EvtKind, number>> = {}; // 事件专属冷却（按 kind）
  // ── 受伤系统状态（v1.8：边沿触发 + 阶段冷却）──
  private lastStage: StageKey | null = null;
  private stageSpeakAt: Partial<Record<StageKey, number>> = {};
  private deathMuteUntil = 0;                // 死亡专属冷却：重生后 N 秒内不发声
  // ── 事件系统边沿基准（状态变化 → 触发一次）──
  private env = {
    rainKnown: false, raining: false,
    thunderKnown: false, thundering: false,
    nightKnown: false, night: false,
    dimKnown: false, dim: '',
    hungerBand: 0, // 0=饱(≥12) 1=轻度饥饿(<12) 2=严重饥饿(<4)
  };
  // 跟随掉队喊话专属冷却（身体侧触发 → 大脑说话；防刷屏）
  private lastGapSpeakAt = 0;
  private lastCombatSayAt = 0;             // 战斗说话专属冷却（guardian 战斗密集时别连续两句）
  private protectActive = false;            // 护玩家战斗进行中（guardian 置位）：抑制心跳说话，防叠话
  // ── 玩家活动感知（heartbeat：走远 / 附近挖放方块；边沿触发 + 专属冷却）──
  private hbCfg?: AppConfig['heartbeat'];
  private hbLastSpeakAt: Record<string, number> = {};   // 情境专属冷却
  private hbPlayerPos = new Map<string, { x: number; z: number; since: number; lastMoveAt: number }>(); // 位置轨迹+停留起点+最近动过的时刻
  private hbNearbyDigAt = 0;                            // 附近方块变化最近时间戳
  private hbNearbyDigLast = 0;                          // 上次上报过的冷却时间戳
  // 事件监听器引用（重连泄漏修复：匿名箭头无法 removeListener）
  private handlers: Array<[string, (...args: never[]) => void]> = [];
  private respawnHandler: (() => void) | null = null;

  constructor(
    bot: mineflayer.Bot,
    memory: MemoryManager,
    status: StatusCollector,
    brain: BrainBridge | undefined,
    injuryCfg?: InjuryCfg,
    eventCfg?: EventCfg,
    private autoSpeak = true,
    hbCfg?: AppConfig['heartbeat']
  ) {
    this.bot = bot;
    this.memory = memory;
    this.status = status;
    this.brain = brain;
    this.hbCfg = hbCfg;
    this.injuryCfg = injuryCfg ?? {
      enabled: true,
      stages: {
        none: { above: 80, chance: 0.03 },
        light: { above: 50, chance: 0.25 },
        heavy: { above: 20, chance: 0.6 },
        critical: { above: 0, chance: 0.85 },
      },
      cooldowns: { globalSec: 90, stageSec: 20, deathSec: 60 },
      contextTemplate: '{subject}受伤了，当前阶段：{stage}（血量剩 {hp}%），伤害来源：{cause}。{teammates}，现在是{time}，在{dim}。',
    };
    this.eventCfg = eventCfg ?? {
      enabled: true,
      weather: {
        rain: { probability: 0.12, cooldownSec: 600 },
        thunder: { probability: 0.18, cooldownSec: 600 },
        rainStop: { probability: 0.08, cooldownSec: 600 },
      },
      dayNight: {
        night: { probability: 0.25, cooldownSec: 900 },
        day: { probability: 0.2, cooldownSec: 900 },
      },
      dimension: {
        enterNether: { probability: 0.8, cooldownSec: 600 },
        enterEnd: { probability: 0.8, cooldownSec: 600 },
        leaveNether: { probability: 0.6, cooldownSec: 600 },
        leaveEnd: { probability: 0.6, cooldownSec: 600 },
      },
      hunger: {
        low: { probability: 0.12, cooldownSec: 900 },
        critical: { probability: 0.6, cooldownSec: 300 },
      },
      globalCooldownSec: 180,
      maxReplyLength: 15,
    };
  }

  attach(): void {
    const h1 = (player: { username?: string }): void => this.onPlayerJoined(player);
    const h2 = (entity: { type?: string; name?: string; uuid?: string; position?: { x: number; y: number; z: number } }, source?: unknown): void => {
      void this.onEntityHurt(entity, source);
    };
    this.respawnHandler = () => this.onRespawn();
    this.handlers = [
      ['playerJoined', h1 as never],
      ['entityHurt', h2 as never],
    ];
    this.bot.on('playerJoined' as never, h1 as never);
    this.bot.on('entityHurt' as never, h2 as never);
    this.bot.on('respawn' as never, this.respawnHandler as never);
    // 事件轮询：轻读 bot 属性，天气/昼夜/维度/饥饿变化 → 边沿触发
    this.tickTimer = setInterval(() => {
      try {
        this.scanEvents();
      } catch { /* 扫描失败不影响 */ }
    }, 3000);
    log('INFO', '💞 陪伴层已启动（仿真聊天系统：受伤分阶段 + 游戏事件 + 统一出口）');
  }

  detach(): void {
    for (const [ev, handler] of this.handlers) {
      this.bot.removeListener(ev as never, handler as never);
    }
    if (this.respawnHandler) {
      this.bot.removeListener('respawn' as never, this.respawnHandler as never);
      this.respawnHandler = null;
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.handlers = [];
    this.greeted.clear();
    this.hbPlayerPos.clear();
    this.hbLastSpeakAt = {};
    log('INFO', '💞 陪伴层已停止');
  }

  /** 玩家上线 → 问候 */
  private onPlayerJoined(player: { username?: string }): void {
    const name = player.username ?? '玩家';
    if (name === this.bot.username || this.greeted.has(name)) return;
    this.greeted.add(name);
    this.memory.setPlayerName(name);
    this.memory.touchSeen();
    log('INFO', `👋 玩家 ${name} 上线了`);
    const home = this.memory.data.identity.home;
    const greet = home
      ? `你来啦 ${name}！我在家附近玩呢，今天想干点啥？`
      : `你来啦 ${name}！我刚到这个世界，正准备安家呢，一起吗？`;
    setTimeout(() => {
      try {
        this.bot.chat(greet);
      } catch {
        /* 断线后可能触发，忽略 */
      }
    }, 2000);
    this.memory.pushTimeline(`${name} 上线了`);
  }

  // ═══════════ 统一触发出口（文档 §4：所有事件聊天走同一出口）═══════════
  // 出口内统一：全局冷却检查由各入口做（见 tryEventChat/受伤路径），
  // speakViaBrain 负责统一拼硬约束 + 长度截断 + 大脑生成（禁止预设）。

  /** 事件通用触发管道：全局冷却 → 专属冷却 → 概率骰 → brain */
  private tryEventChat(kind: EvtKind, prompt: string): void {
    if (!this.eventCfg.enabled) return;
    const now = Date.now();
    if (now < this.deathMuteUntil) return; // 死亡冷却（刚复活不想说话）
    if (now - this.lastEventSpeakAt < this.eventCfg.globalCooldownSec * 1000) {
      log('INFO', `🎲 [${EVT_LABEL[kind]}] 全局冷却中，静默`);
      return;
    }
    const spec = this.eventSpec(kind);
    if (!spec) return;
    if (now - (this.eventCooled[kind] ?? 0) < spec.cooldownSec * 1000) {
      log('INFO', `🎲 [${EVT_LABEL[kind]}] 事件冷却(${spec.cooldownSec}s)中，静默`);
      return;
    }
    this.lastEventSpeakAt = now;
    this.eventCooled[kind] = now;
    if (Math.random() >= spec.probability) {
      log('INFO', `   🤐 [${EVT_LABEL[kind]}] 概率 ${spec.probability}，本次沉默`);
      return;
    }
    log('INFO', `   🎲 [${EVT_LABEL[kind]}] 概率 ${spec.probability} 命中 → 大脑组织语言`);
    void this.speakViaBrain(prompt, EVT_LABEL[kind]);
  }

  private eventSpec(kind: EvtKind): { probability: number; cooldownSec: number } | null {
    const ec = this.eventCfg;
    switch (kind) {
      case 'rain': return ec.weather.rain;
      case 'rainStop': return ec.weather.rainStop;
      case 'thunder': return ec.weather.thunder;
      case 'night': return ec.dayNight.night;
      case 'day': return ec.dayNight.day;
      case 'enterNether': return ec.dimension.enterNether;
      case 'enterEnd': return ec.dimension.enterEnd;
      case 'leaveNether': return ec.dimension.leaveNether;
      case 'leaveEnd': return ec.dimension.leaveEnd;
      case 'hunger_low': return ec.hunger.low;
      case 'hunger_critical': return ec.hunger.critical;
      default: return null;
    }
  }

  // ═══════════ 游戏事件轮询（文档 §3：天气/昼夜/维度/饥饿）═══════════
  private scanEvents(): void {
    const b = this.bot;
    if (!b || !b.entity) return;
    // 单 tick 内最多说一句：优先级 维度 > 昼夜 > 饥饿 > 天气 > 玩家活动（体验差大者先）
    if (this.scanDimension()) return;
    if (this.scanDayNight()) return;
    if (this.scanHunger()) return;
    this.scanWeather();
    if (this.scanPlayerActivity()) return;
  }

  /** 天气：晴↔雨 / 雷暴边沿 */
  private scanWeather(): boolean {
    const raining = !!this.bot.isRaining;
    const thundering = (this.bot.thunderState ?? 0) > 0;
    const e = this.env;
    if (!e.rainKnown) { e.rainKnown = true; e.raining = raining; }
    else if (raining !== e.raining) {
      e.raining = raining;
      if (raining) { this.tryEventChat('rain', this.eventPrompt('rain')); return true; }
      else { this.tryEventChat('rainStop', this.eventPrompt('rainStop')); return true; }
    }
    if (!e.thunderKnown) { e.thunderKnown = true; e.thundering = thundering; }
    else if (thundering !== e.thundering) {
      e.thundering = thundering;
      if (thundering) { this.tryEventChat('thunder', this.eventPrompt('thunder')); return true; }
    }
    return false;
  }

  /** 昼夜：timeOfDay 跨越 13000(天黑) / 0(天亮) */
  private scanDayNight(): boolean {
    const tod = (this.bot.time?.timeOfDay ?? 0) % 24000;
    const night = tod >= 13000;
    const e = this.env;
    if (!e.nightKnown) { e.nightKnown = true; e.night = night; return false; }
    if (night !== e.night) {
      e.night = night;
      this.tryEventChat(night ? 'night' : 'day', this.eventPrompt(night ? 'night' : 'day'));
      return true;
    }
    return false;
  }

  /** 维度：进入/离开 下界/末地 */
  private scanDimension(): boolean {
    const dim = dimOf(this.bot);
    const e = this.env;
    if (!e.dimKnown) { e.dimKnown = true; e.dim = dim; return false; }
    if (dim !== e.dim) {
      const prev = e.dim;
      e.dim = dim;
      const kind: EvtKind =
        prev === 'overworld' && dim === 'nether' ? 'enterNether'
        : prev === 'overworld' && dim === 'end' ? 'enterEnd'
        : prev === 'nether' && dim === 'overworld' ? 'leaveNether'
        : prev === 'end' && dim === 'overworld' ? 'leaveEnd'
        : (null as unknown as EvtKind);
      if (kind) {
        // 进入新维度 → 记录该维度第一个落脚点（base 据点）
        const p = this.bot.entity?.position;
        if (p) getGlobalLandmark()?.recordBaseIfFirst(dim, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
        this.tryEventChat(kind, this.eventPrompt(kind)); return true;
      }
    }
    return false;
  }

  /** 饥饿：食物<12 轻度 / <4 严重（边沿进档触发一次，吃饱复位） */
  private scanHunger(): boolean {
    const food = this.bot.food ?? 20;
    const band = food < 4 ? 2 : food < 12 ? 1 : 0;
    const e = this.env;
    if (band === e.hungerBand) return false;
    const prev = e.hungerBand;
    e.hungerBand = band;
    if (band > prev) {
      const kind: EvtKind = band === 2 ? 'hunger_critical' : 'hunger_low';
      this.tryEventChat(kind, this.eventPrompt(kind));
      return true;
    }
    return false;
  }

  // ═══════════ 玩家活动感知（heartbeat：走远 / 附近在忙活；信号驱动 + 专属冷却）═══════════
  /** 玩家离我远近档位：0=危险很近 1=在身边 2=稍远 3=很远(≥阈值)。档位跨越才值得开口。 */
  private hbRangeBand(dist: number): 0 | 1 | 2 | 3 {
    const thr = this.hbCfg?.playerMoveThreshold ?? 20;
    if (dist < 5) return 0;
    if (dist < thr * 0.4) return 1;
    if (dist < thr) return 2;
    return 3;
  }

  /**
   * 玩家活动边沿感知。只判「现在该不该开口、什么情境」→ 模糊触发给大脑组织，绝不报精确数字。
   * 信号源只用可靠项：玩家实体位置 + 玩家位置时间相关性（在哪带了一小阵）。
   * 「玩家没动静」→ 不开口（不刷存在感）。普通走动不动嘴。
   */
  private scanPlayerActivity(): boolean {
    if (!this.hbCfg?.enabled) return false;
    const b = this.bot;
    const my = b.entity?.position;
    if (!my) return false;
    const now = Date.now();
    // 护玩家战斗期间：心跳闭嘴，战斗的话归 guardian 的战斗出口一个声音（防叠话，语义互斥）
    if (this.protectActive) {
      log('INFO', '   🛡 护玩家战斗中，抑制心跳说话，静默');
      return false;
    }
    // 全局说话冷却（与战斗/受伤/事件共用）：近期刚说过话（含 combatSay）就不插一脚，对称防叠话
    if (now - this.lastEventSpeakAt < (this.eventCfg?.globalCooldownSec ?? 30) * 1000) {
      log('INFO', '   💬 全局说话冷却中，心跳静默（防叠话）');
      return false;
    }
    const act = this.heartbeatAction(); // 决定本次触发的动作情境（走远 / 附近持续忙活 / 无）
    if (!act) return false;
    const cd = (this.hbCfg.activitySpeakCooldownSec ?? 30) * 1000;
    // 情境专属冷却（同情境别连车）
    if (now - (this.hbLastSpeakAt[act.tag] ?? 0) < cd) return false;
    this.hbLastSpeakAt[act.tag] = now;
    this.lastEventSpeakAt = now; // 与全局说话冷却共用一个出口（8s 不叠话那类约束同样生效）
    log('INFO', `💓 [${act.tag}] 玩家活动情境命中 → 大脑组织语言（屏蔽精确距离）`);
    this.promptHeartbeat(act.tag, act.text);
    return true;
  }

  /** 判定一个值得开口的玩家活动情境（边沿/趋势信号 → 模糊情境描述）。无 → null。 */
  private heartbeatAction(): { tag: string; text: string } | null {
    const b = this.bot;
    const my = b.entity?.position;
    if (!my) return null;
    const now = Date.now();

    // 只关心「真实玩家」远程玩家（bot 自己 / 无实体的跳过；多玩家只取最近的一个）
    let target: { name: string; x: number; z: number } | null = null;
    let best = Infinity;
    for (const [nm, p] of Object.entries(b.players)) {
      if (nm === b.username) continue;
      const pe = p?.entity;
      if (!pe?.position) continue;
      const d = Math.hypot(pe.position.x - my.x, pe.position.z - my.z);
      if (d < best) { best = d; target = { name: nm, x: pe.position.x, z: pe.position.z }; }
    }
    if (!target) return null;

    // ── ① 走远：距离档位向上跨越（从「在身边/稍远」→「很远」），问一句（不催）──
    const prev = this.hbPlayerPos.get(target.name);
    const curBand = this.hbRangeBand(best);
    const prevBand = prev ? this.hbRangeBand(Math.hypot(prev.x - my.x, prev.z - my.z)) : curBand;
    // 位置轨迹：
    //  - 「换片」= 相对上 tick 走 >3 格（离开这片）→ 重置停留计时 since；
    //  - 「动过」= 位置相对上 tick 有变化（哪怕 <3 格）→ 记 lastMoveAt（区分真在忙 vs 纯站着）。
    const movedFar = prev ? Math.hypot(target.x - prev.x, target.z - prev.z) > 3 : true;
    const movedAny = prev ? Math.hypot(target.x - prev.x, target.z - prev.z) > 0.15 : true;
    const since = prev && !movedFar ? prev.since : now;
    const lastMoveAt = movedAny ? now : (prev?.lastMoveAt ?? now);
    this.hbPlayerPos.set(target.name, { x: target.x, z: target.z, since, lastMoveAt });
    const idleSec = (now - since) / 1000;
    const movedWithin = now - lastMoveAt < 20000; // 20s 内有过移动 = 在忙活（不是纯站着）
    if (curBand === 3 && prevBand <= 2 && curBand > prevBand) {
      // 走得很远 → 朋友式问一句，绝不催 / 不报格数
      return { tag: 'far', text: `玩家${target.name}离我有点远了（跑很远去了）。以真人朋友口吻随口问一句他要去哪/干嘛，好奇但别催促、别担心、别报具体距离数字。` };
    }

    // ── ② 附近持续忙活：近距 0/1 档且同一片停留 ≥ 6 秒、这段时间真动过（挖矿/盖房那种反复微动）──
    if ((curBand === 0 || curBand === 1) && idleSec >= 6 && movedWithin) {
      const name = target.name;
      return { tag: 'nearby', text: `玩家${name}一直在我附近忙活（挖矿/盖房子之类），待在同一片好一会儿了。以真人朋友口吻好奇地问他在弄什么（比如「这是在盖啥呢」「还在挖啊」），感兴趣但不邀功、不报具体距离。` };
    }
    return null;
  }

  /** 玩家动过之后不再动（写心跳走该情境出口）。trigger 统一走此处，补 timeline 记忆。 */
  private promptHeartbeat(tag: string, text: string): void {
    // 本地感知只送「模糊情境」，数字距离绝不进台词 → 直接触发大脑组织自然的话
    // speakViaBrain 内部：走 MC_TALK_RULE 统一约束 + 大脑组织 + pushTimeline 记忆收尾。
    void this.speakViaBrain(text, tag);
  }

  /** 组装事件上下文（贴合设计文档 §3.5 结构，口语化转述） */
  private eventPrompt(kind: EvtKind): string {
    const hp = Math.max(0, Math.round(this.bot.health ?? 20));
    const dim = DIM_CN[this.env.dim] ?? DIM_CN[dimOf(this.bot)] ?? '未知';
    const mates = this.nearbyTeammatesText();
    const threats = this.nearbyThreatText();
    switch (kind) {
      case 'rain': return `【天气事件】开始下雨了。${threats ? `附近有${threats}。` : '周围还算安静。'}在${dim}。`;
      case 'rainStop': return `【天气事件】雨停了。在${dim}。`;
      case 'thunder': return `【天气事件】打雷了，雷暴天气。${threats ? `附近还有${threats}。` : ''}在${dim}。`;
      case 'night': return `【昼夜事件】天黑了，夜晚开始了。${threats ? `附近有${threats}，不太安全。` : '周围暂时没看到怪。'}在${dim}。`;
      case 'day': return `【昼夜事件】天亮了，白天开始了。在${dim}。`;
      case 'enterNether': return `【维度事件】我刚穿过传送门进入了${dim}。当前血量 ${hp}%。${mates}`;
      case 'enterEnd': return `【维度事件】我刚穿过传送门进入了${dim}。当前血量 ${hp}%。${mates}`;
      case 'leaveNether': return `【维度事件】我从下界穿过传送门回来了，现在在${dim}。当前血量 ${hp}%。${mates}`;
      case 'leaveEnd': return `【维度事件】我从末地回来了，现在在${dim}。当前血量 ${hp}%。${mates}`;
      case 'hunger_low': return `【饥饿事件】我有点饿了（饥饿值 ${this.bot.food ?? 20}/20）。当前血量 ${hp}%。${mates}`;
      case 'hunger_critical': return `【饥饿事件】我要饿死了（饥饿值 ${this.bot.food ?? 20}/20，快空了）。当前血量 ${hp}%。${mates}`;
      default: return `【事件】发生了点事。在${dim}，血量 ${hp}%。`;
    }
  }

  /** 附近队友描述（复用受伤上下文口径） */
  private nearbyTeammatesText(): string {
    const my = this.bot.entity?.position;
    const mates: string[] = [];
    for (const [nm, p] of Object.entries(this.bot.players)) {
      if (nm === this.bot.username) continue;
      const pe = p?.entity;
      if (pe?.position && my) {
        const d = Math.round(Math.hypot(pe.position.x - my.x, pe.position.y - my.y, pe.position.z - my.z));
        mates.push(d <= 64 ? `${nm}（${d}格）` : `${nm}（较远）`);
      } else {
        mates.push(nm);
      }
    }
    return mates.length ? `附近队友：${mates.slice(0, 3).join('、')}。` : '独自一人（附近没有队友）。';
  }

  /** 附近威胁描述（≤16 格敌对生物） */
  private nearbyThreatText(): string {
    const my = this.bot.entity?.position;
    if (!my) return '';
    const names = new Set<string>();
    for (const ent of Object.values(this.bot.entities)) {
      if (ent.type === 'mob' && ent.position && ent.name && ent.name in SRC_CN) {
        const d = Math.hypot(ent.position.x - my.x, ent.position.y - my.y, ent.position.z - my.z);
        if (d <= 16) names.add(SRC_CN[ent.name]);
      }
    }
    return [...names].slice(0, 2).join('、');
  }

  // ═══════════ 受伤仿真聊天（设计文档 §2：分阶段 + 概率 + 边沿 + 冷却）═══════════

  /** 血量百分比 → 阶段（按配置 above 从高到低，pct≥above 即落入该档） */
  private stageOf(pct: number): StageKey {
    const st = this.injuryCfg.stages;
    if (pct >= st.none.above) return 'none';
    if (pct >= st.light.above) return 'light';
    if (pct >= st.heavy.above) return 'heavy';
    return 'critical';
  }

  private chanceOf(s: StageKey): number {
    return this.injuryCfg.stages[s].chance;
  }

  /** 实体受伤入口：自己挨打走分阶段模型，其他玩家受伤走关心模型 */
  private async onEntityHurt(
    entity: { type?: string; name?: string; uuid?: string; position?: { x: number; y: number; z: number } },
    source?: unknown
  ): Promise<void> {
    try {
      if (!entity || !this.injuryCfg.enabled) return;
      const self = this.bot.entity;
      const isSelf = !!self && (entity === self || entity.uuid === self.uuid);
      if (isSelf) {
        this.handleSelfHurt(source);
        return;
      }
      if (entity.type !== 'player') return;
      const name = entity.name ?? '玩家';
      if (name === this.bot.username) return;
      this.handlePlayerHurt(entity, name, source);
    } catch {
      /* ignore */
    }
  }

  /** 自己受伤：边沿触发（仅阶段变差时判定一次）+ 概率 + 冷却 */
  private handleSelfHurt(source?: unknown): void {
    const hp = Math.max(0, Math.round(this.bot.health));
    const pct = Math.min(100, Math.round((hp / 20) * 100));
    const s = this.stageOf(pct);
    // 边沿触发：阶段未变差（同档继续挨打 / 回血）→ 静默不判定
    if (this.lastStage !== null && STAGE_ORDER.indexOf(s) <= STAGE_ORDER.indexOf(this.lastStage)) {
      if (this.lastStage !== s) this.lastStage = s; // 回血了 → 更新基准档
      log('INFO', `❤️ 我受伤（剩 ${pct}%，${STAGE_LABEL[s]}）→ 同阶段内/回血，静默`);
      return;
    }
    this.lastStage = s;
    log('INFO', `❤️ 我受伤了（剩 ${pct}%）进入「${STAGE_LABEL[s]}」阶段`);
    // 冷却：死亡冷却 → 全局(所有聊天共用) → 阶段
    const cd = this.injuryCfg.cooldowns;
    const now = Date.now();
    if (now < this.deathMuteUntil) {
      log('INFO', `   💤 死亡冷却中（${Math.ceil((this.deathMuteUntil - now) / 1000)}s），静默`);
      return;
    }
    if (now - this.lastEventSpeakAt < cd.globalSec * 1000) {
      log('INFO', `   💤 全局冷却中，静默`);
      return;
    }
    if (now - (this.stageSpeakAt[s] ?? 0) < cd.stageSec * 1000) {
      log('INFO', `   💤 「${STAGE_LABEL[s]}」阶段冷却中，静默`);
      return;
    }
    this.lastEventSpeakAt = now;
    this.stageSpeakAt[s] = now;
    // 概率骰：没命中 = 真人沉默干活
    const chance = this.chanceOf(s);
    if (Math.random() >= chance) {
      log('INFO', `   🤐 「${STAGE_LABEL[s]}」触发概率 ${chance}，本次沉默`);
      return;
    }
    log('INFO', `   🎲 「${STAGE_LABEL[s]}」概率 ${chance} 命中 → 大脑组织语言`);
    void this.speakViaBrain(
      this.buildInjuryPrompt({ subject: '我', stage: STAGE_LABEL[s], hp: pct, cause: this.causeText(source) }),
      '受伤'
    );
  }

  /** 队友受伤：关心模型（全局冷却 + 概率；血量可见则按档位概率） */
  private handlePlayerHurt(
    entity: { position?: { x: number; y: number; z: number }; health?: number },
    name: string,
    source?: unknown
  ): void {
    const my = this.bot.entity?.position;
    const pos = entity?.position;
    const dist = pos && my
      ? Math.round(Math.hypot(pos.x - my.x, pos.y - my.y, pos.z - my.z))
      : 99;
    if (dist > 40) return;
    const cd = this.injuryCfg.cooldowns;
    const now = Date.now();
    if (now < this.deathMuteUntil) return; // 刚复活不想说话
    if (now - this.lastEventSpeakAt < cd.globalSec * 1000) return; // 全局冷却（所有聊天共用）
    this.lastEventSpeakAt = now;
    const hpRaw = entity?.health;
    let pct: number | null = null;
    if (typeof hpRaw === 'number' && hpRaw > 0) pct = Math.min(100, Math.round((hpRaw / 20) * 100));
    const chance = pct != null ? this.chanceOf(this.stageOf(pct)) : 0.45;
    if (Math.random() >= chance) {
      log('INFO', `❤️ 玩家 ${name} 受伤（距离 ${dist}${pct != null ? `，剩 ${pct}%` : ''}）→ 概率 ${chance}，本次沉默`);
      return;
    }
    log('INFO', `❤️ 玩家 ${name} 受伤了（距离 ${dist}${pct != null ? `，剩 ${pct}%` : ''}）→ 关心`);
    const stage = pct != null ? STAGE_LABEL[this.stageOf(pct)] : '未知';
    void this.speakViaBrain(
      this.buildInjuryPrompt({
        subject: `我旁边的玩家 ${name}`,
        stage,
        hp: pct != null ? String(pct) : '?',
        cause: this.causeText(source),
      }),
      '关心'
    );
  }

  /** 重生入口：区分"死亡重生"与"维度传送重进"（避免把传下界误喊成死了） */
  private onRespawn(): void {
    const dim = dimOf(this.bot);
    const e = this.env;
    // 维度变化 → 传送（respawn 包在穿传送门时也可能发）→ 交维度事件系统，别当死亡
    if (e.dimKnown && e.dim !== dim) {
      const prev = e.dim;
      e.dim = dim;
      const kind: EvtKind =
        prev === 'overworld' && dim === 'nether' ? 'enterNether'
        : prev === 'overworld' && dim === 'end' ? 'enterEnd'
        : prev === 'nether' && dim === 'overworld' ? 'leaveNether'
        : prev === 'end' && dim === 'overworld' ? 'leaveEnd'
        : (null as unknown as EvtKind);
      if (kind) {
        log('INFO', `🌐 检测到维度切换（${DIM_CN[prev] ?? prev} → ${DIM_CN[dim] ?? dim}）→ 维度事件`);
        const p = this.bot.entity?.position;
        if (p) getGlobalLandmark()?.recordBaseIfFirst(dim, { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
        this.tryEventChat(kind, this.eventPrompt(kind));
      }
      return;
    }
    // 真死亡重生：100% 发声 + 启动死亡专属冷却
    e.dimKnown = true; e.dim = dim;
    this.lastStage = null; // 满血重置边沿基准
    const cd = this.injuryCfg.cooldowns;
    this.deathMuteUntil = Date.now() + cd.deathSec * 1000;
    log('INFO', `💀 已重生 → 死亡语音 100%（死亡冷却 ${cd.deathSec}s 内不发声）`);
    const dimCn = DIM_CN[dim] ?? '主世界';
    setTimeout(() => {
      void this.speakViaBrain(
        `我刚死了一次又在${dimCn}复活了。按真人玩家表达一下情绪（愤怒/无奈/不服都行）。`,
        '死亡重生'
      );
    }, 1200);
  }

  /** 组装注入大脑的上下文：占位符替换配置模板 */
  private buildInjuryPrompt(ctx: { subject: string; stage: string; hp: string | number; cause: string }): string {
    const my = this.bot.entity?.position;
    const mates: string[] = [];
    for (const [nm, p] of Object.entries(this.bot.players)) {
      if (nm === this.bot.username) continue;
      const pe = p?.entity;
      if (pe?.position && my) {
        const d = Math.round(Math.hypot(pe.position.x - my.x, pe.position.y - my.y, pe.position.z - my.z));
        mates.push(d <= 64 ? `${nm}（${d}格）` : `${nm}（较远）`);
      } else {
        mates.push(nm);
      }
    }
    const teammates = mates.length ? '附近队友：' + mates.slice(0, 3).join('、') : '独自一人（附近没有队友）';
    const tod = this.bot.time?.timeOfDay ?? 0;
    const time = tod >= 0 && tod < 13000 ? '白天' : '夜晚';
    const dim = DIM_CN[dimOf(this.bot)] ?? '未知维度';
    return this.injuryCfg.contextTemplate
      .replace('{subject}', ctx.subject)
      .replace('{stage}', ctx.stage)
      .replace('{hp}', String(ctx.hp))
      .replace('{cause}', ctx.cause)
      .replace('{teammates}', teammates)
      .replace('{time}', time)
      .replace('{dim}', dim);
  }

  /** 伤害来源 → 中文描述 */
  private causeText(source: unknown): string {
    if (!source) return '环境伤害（来源不明，可能是摔落/火/岩浆/仙人掌等）';
    const t = source as { type?: string; name?: string; username?: string };
    if (t.type === 'player') return `玩家 ${t.name ?? t.username ?? '某人'}`;
    const key = typeof t.name === 'string' ? t.name : '';
    return SRC_CN[key] ?? key ?? '未知怪物';
  }

  /** 说话出口（统一收口，文档 §4.3）：拼硬约束 → brain 生成 → 截断 → 发送。
   *  大脑不可用时**静默**（遵守文档 §1.1 禁止预设对话），只留日志。 */
  /** 战斗说话出口（guardian 经 combatSay 钩子调用）：事件只给"语气种子"，文案由大脑现组织，禁预设 */
  /** 护玩家战斗开关（guardian 置位）→ 心跳说话整体静默，战斗说完归战斗一个声音（防叠话） */
  setProtectActive(active: boolean): void {
    this.protectActive = active;
  }

  sayCombat(event: CombatSayEvent, target?: string): void {
    if (!this.autoSpeak) return;
    const now = Date.now();
    if (now < this.deathMuteUntil) return;                    // 死亡静默期闭嘴
    if (now - this.lastCombatSayAt < 4000) {
      log('INFO', '⚔️ 战斗说话冷却(4s)中，静默');
      return;
    }
    if (now - this.lastEventSpeakAt < 8000) {
      log('INFO', '⚔️ 8s 内刚说过别的（战斗撞心跳/天气），不叠话，静默');
      return;
    }
    this.lastCombatSayAt = now;
    this.lastEventSpeakAt = now;
    const tpl = COMBAT_PROMPT[event];
    if (!tpl) return;
    const prompt = tpl.replace(/\{target\}/g, target ?? '对手');
    log('INFO', `⚔️ [战斗对话] ${event}${target ? ` → ${target}` : ''}`);
    void this.speakViaBrain(prompt, '战斗');
  }

  /** 跟随掉队说话出口：身体侧检测到玩家把我甩开太远 → 大脑现编台词喊他等等。
   *  只给"模糊情境"，文案 100% 大脑组织（禁预设）；专属冷却 25s 防刷屏，
   *  全局出口 8s 内刚说过话不叠（避免跟受伤/天气事件抢着说），死亡静默期内闭嘴。 */
  sayGap(prompt: string): void {
    if (!this.autoSpeak) return;
    const now = Date.now();
    if (now < this.deathMuteUntil) return; // 刚复活，不想说话
    if (now - this.lastGapSpeakAt < 25000) {
      log('INFO', '🗣️ 掉队喊话冷却(25s)中，静默');
      return;
    }
    if (now - this.lastEventSpeakAt < 8000) {
      log('INFO', '🗣️ 8s 内刚说过别的，不叠话，静默');
      return;
    }
    this.lastGapSpeakAt = now;
    log('INFO', '🗣️ 掉队喊话 → 大脑组织语言');
    void this.speakViaBrain(prompt, '掉队');
  }

  private async speakViaBrain(prompt: string, tag = '事件'): Promise<void> {
    if (!this.autoSpeak) {
      log('INFO', `💬 [${tag}] 自主说话总闸已关(autoSpeak=false) → 静默`);
      return;
    }
    if (!this.brain) {
      log('WARN', `💬 [${tag}] 大脑未接入 → 静默（禁止预设兜底）`);
      return;
    }
    try {
      const reply = await this.brain.trigger(`${MC_TALK_RULE}\n\n${prompt}`);
      if (reply) {
        const text = reply.trim();
        if (!text) return;
        // 真人式多条短消息：按标点拆句，逐条完整发出（不再硬切话尾）
        await this.sendShortMessages(text);
        log('INFO', `💬 [${tag}] ${text.slice(0, 120)}`);
        const tlTag = tag === '死亡重生' ? '复活后' : `${tag}时`;
        this.memory.pushTimeline(`${tlTag}我说: ${text.slice(0, 40)}`);
      }
    } catch (err) {
      // 大脑调用失败 → 静默（不吐预设文本）
      log('WARN', `💬 [${tag}] 大脑调用失败 → 静默: ${String(err).slice(0, 80)}`);
    }
  }

  /** 把一句话拆成多条短消息逐条发（像真人连续发消息），每条不掐断。
   *  超长单条（>64字）退回分段发送兜底，绝不丢话尾。 */
  private async sendShortMessages(text: string): Promise<void> {
    const chunks = text
      .split(/(?<=[。！？!?；;~～…])/u)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    for (const c of chunks) {
      if (c.length <= 64) {
        this.bot.chat(c);
      } else {
        await chatSegmented(this.bot, c); // 单句超长 → 完整分段兜底
      }
      await new Promise((r) => setTimeout(r, 120)); // 真人打字间隔
    }
  }
}
