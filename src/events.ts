/**
 * 事件层（蓝图第五节 · 事件层）
 * ─────────────────────────────────────────────
 * 世界不靠 agent 轮询感知，而是主动推"事件"：
 * environment 环境 | danger 危险 | discovery 发现 | social 社交 | achievement 成就
 *
 * EventBus: 事件缓冲 + 未读读取（供大脑上下文 / MCP resource 消费）
 * EventWatcher: 周期扫描 bot 状态，把原始游戏现象翻译成事件（挂到 lifestyle tick 或独立 interval）
 *
 * 说明：真实"声音/动画"类事件 mineflayer 拿不到（协议限制），本层用
 * 实体/状态/方块变化做等价检测，描述保持"人类视角"。
 */
import type mineflayer from 'mineflayer';
import type { MemoryManager } from './memory';
import type { StatusCollector, StatusData } from './status';
import type { EmotionSystem } from './emotion';
import { log, v3 } from './utils';

export type EventCategory = 'environment' | 'danger' | 'discovery' | 'social' | 'achievement';
export type EventUrgency = 'low' | 'medium' | 'high' | 'critical';

export interface GameEvent {
  id: number;
  t: number;
  category: EventCategory;
  /** 事件类型名（与 EMOTION_TRIGGERS / 蓝图 EVENTS 对齐） */
  type: string;
  /** 人类视角描述（喂给大脑的原文） */
  description: string;
  urgency: EventUrgency;
}

const CATEGORY_DESC: Record<EventCategory, string> = {
  environment: '环境', danger: '危险', discovery: '发现', social: '社交', achievement: '成就',
};

/** 事件缓冲：未读事件供上下文消费 */
export class EventBus {
  private buffer: GameEvent[] = [];
  private seq = 0;

  push(category: EventCategory, type: string, description: string, urgency: EventUrgency): GameEvent {
    const ev: GameEvent = { id: ++this.seq, t: Date.now(), category, type, description, urgency };
    this.buffer.push(ev);
    if (this.buffer.length > 200) this.buffer = this.buffer.slice(-200);
    log('INFO', `📣 事件[${urgency}] ${CATEGORY_DESC[category]}: ${description}`);
    return ev;
  }

  /** 取走全部未读（消费后清空，避免重复注入） */
  getUnread(): GameEvent[] {
    const out = this.buffer;
    this.buffer = [];
    return out;
  }

  /** 最近 N 条（不消费） */
  recent(n: number): GameEvent[] {
    return this.buffer.slice(-n);
  }
}

/**
 * 场景检测器：挂在周期 tick 上（建议复用 Lifestyle 的 5s interval 或独立 5s）。
 * 把游戏原始状态 → 事件 + 情绪触发。
 * 内置去重：同一类型事件在 cooldownMs 内不重复上报，防止刷屏。
 */
export class EventWatcher {
  private bot: mineflayer.Bot;
  private memory: MemoryManager;
  private status: StatusCollector;
  private emotion: EmotionSystem;
  private bus: EventBus;
  private lastFire: Record<string, number> = {};
  private lastPlayers = new Set<string>();
  private cooldownMs = 60000;

  constructor(bot: mineflayer.Bot, memory: MemoryManager, status: StatusCollector, emotion: EmotionSystem, bus: EventBus) {
    this.bot = bot;
    this.memory = memory;
    this.status = status;
    this.emotion = emotion;
    this.bus = bus;
  }

  /**
   * 每 tick 调用一次（建议复用 Lifestyle 已取的状态快照，避免重复全量扫描）。
   * 不传则内部自取一次快照。
   */
  scan(s?: StatusData): void {
    try {
      const snap = s ?? this.status.getStatus();
      this.scanDanger(snap);
      this.scanEnvironment(snap);
      this.scanSocial(snap);
      this.scanAchievement(snap);
    } catch {
      /* 扫描失败不影响主流程 */
    }
  }

  private canFire(type: string): boolean {
    const now = Date.now();
    if (now - (this.lastFire[type] ?? 0) < this.cooldownMs) return false;
    this.lastFire[type] = now;
    return true;
  }

  // ── 危险类（P2-2 双轨制 · 事件轨）──
  // 危险改"边沿触发"：只在威胁首次进入警戒范围、或危险等级上升时喊一嗓子；
  // "周围持续有谁"由 ChatContextBuilder 的状态轨每次上下文注入（大脑始终知道），
  // 事件层不重复刷屏。威胁离开警戒范围后复位，允许下次新威胁再次提醒。
  // 等级：critical(≤4 格) > high(≤8 格) > medium(≤10 格)。
  private dangerLevel: 0 | 1 | 2 | 3 = 0;
  private warnedLowHealth = false;
  private warnedLowHunger = false;
  private warnedNight = false;

  private scanDanger(s: StatusData): void {
    // ── 敌对生物：首次出现 / 升级才报 ──
    const hostile = s.surroundings.nearby_entities
      .filter((e) => e.hostile && e.distance <= 10)
      .sort((a, b) => a.distance - b.distance);
    if (hostile.length > 0) {
      const minD = hostile[0].distance;
      const lvl: 1 | 2 | 3 = minD <= 4 ? 3 : minD <= 8 ? 2 : 1;
      if (lvl > this.dangerLevel) {
        const names = hostile.slice(0, 3).map((e) => e.name).join('、');
        const urgency: EventUrgency = lvl === 3 ? 'critical' : lvl === 2 ? 'high' : 'medium';
        this.bus.push('danger', 'mob_nearby', `有${names}在附近（约${Math.round(minD)}格）${lvl === 3 ? '，很危险！' : ''}`, urgency);
        this.emotion.react('mob_nearby');
      }
      this.dangerLevel = lvl;
    } else {
      // 离开警戒范围 → 复位，下次新威胁可再提醒
      this.dangerLevel = 0;
    }

    // ── 低血量 / 低饥饿 / 夜晚无庇护：恢复后才允许再次提醒 ──
    if (s.self.health <= 6 && !this.warnedLowHealth) {
      this.warnedLowHealth = true;
      this.bus.push('danger', 'low_health', `我伤得很重，只剩 ${s.self.health}/${s.self.max_health} 颗心了，必须马上治疗或撤离！`, 'critical');
      this.emotion.react('almost_died');
    } else if (s.self.health > 10) {
      this.warnedLowHealth = false;
    }
    if (s.self.food <= 6 && !this.warnedLowHunger) {
      this.warnedLowHunger = true;
      this.bus.push('danger', 'low_hunger', `我饿得不行了（饱食度 ${s.self.food}/20），得赶紧找吃的`, 'high');
    } else if (s.self.food > 10) {
      this.warnedLowHunger = false;
    }
    if (s.world.time.phase === 'night' && !this.warnedNight) {
      this.warnedNight = true;
      this.bus.push('danger', 'night_no_shelter', '天全黑了，我还在外面，得找个安全的地方过夜', 'high');
    } else if (s.world.time.phase !== 'night') {
      this.warnedNight = false;
    }
  }

  // ── 环境类 ──
  private scanEnvironment(s: StatusData): void {
    const phase = s.world.time.phase;
    if (phase === 'dusk' && this.canFire('time_dusk')) {
      this.bus.push('environment', 'time_change', '太阳开始落山了，天色渐暗', 'low');
      this.emotion.react('sunset');
    }
    if (phase === 'day' && this.canFire('time_day') && this.lastPhase === 'dawn') {
      this.bus.push('environment', 'time_change', '天亮了，新的一天开始了', 'low');
    }
    this.lastPhase = phase;
  }
  private lastPhase = '';

  // ── 社交类 ──
  private scanSocial(s: StatusData): void {
    const names = new Set(s.world.players.map((p) => p.name));
    for (const name of names) {
      if (!this.lastPlayers.has(name) && this.canFire(`player_join:${name}`)) {
        this.bus.push('social', 'player_join', `${name} 来到了这个世界`, 'low');
      }
    }
    for (const name of this.lastPlayers) {
      if (!names.has(name) && this.canFire(`player_leave:${name}`)) {
        this.bus.push('social', 'player_leave', `${name} 离开了`, 'low');
      }
    }
    this.lastPlayers = names;
  }

  // ── 成就类（轻量：基于统计与科技） ──
  private scanAchievement(s: StatusData): void {
    // 首次获得铁 → 里程碑
    const hasIron = this.memory.getStat('iron_mined') > 0 || this.memory.data.tech_unlocked.includes('iron');
    if (hasIron && this.canFire('first_iron') && !this.memory.data.stats.iron_celebrated) {
      this.memory.setStat('iron_celebrated', 1);
      this.bus.push('achievement', 'iron_milestone', '我挖到铁了！终于能用上铁装备了', 'medium');
      this.emotion.react('found_diamond'); // 近似兴奋
    }
    void s;
  }
}
