import fs from 'fs';
import path from 'path';
import { atomicWriteJson, log } from './utils';

/**
 * 记忆层 v2（蓝图第六节 · Memory：短期/长期/对话 三层）
 * ─────────────────────────────────────────────
 * 设计原则：与 v1 memory.ts 完全隔离（另起炉灶，不踩旧结构）。
 *  - v1（memory.json）继续管：timeline 流水 / goals / tech / prefs / identity —— 不动
 *  - v2（memory2.json）新增：短期记忆 / 地点 / 带情感事件 / 人物 / 失败 / 对话画像 + 话题冷却
 * 依赖：仅 fs/path/utils，不依赖 bot（main.ts 顶层可 new，跨重连存活）。
 */

// ─────────── 类型定义 ───────────

export interface ShortTermItem {
  content: string;
  t: number;
  importance: number; // 1~10，越低越先被遗忘
}

export interface PlaceMemory {
  name: string;
  description: string;
  direction?: string; // "从家往西走…"
  feeling?: string;   // "有安全感"
  pos?: [number, number, number]; // 精确坐标（内部用），描述仍人话
  last_visited: number;
}

export interface EventMemory {
  event: string;
  emotion?: string;  // 情感标签（来自 EmotionSystem）
  importance: number;
  t: number;
}

export interface PersonMemory {
  name: string;
  traits: string[];
  interactions: string[];
  last_interaction: number;
}

export interface FailureMemory {
  event: string;
  cause?: string;
  lesson?: string;
  t: number;
}

export interface ChatMemoryData {
  /** 旧消息浓缩行（滚动，最多 12 行，每行截断） */
  summary_lines: string[];
  /** 最近几条对话短记（保留细节，最多 6 条） */
  recent: Array<{ speaker: string; text: string; t: number }>;
  /** 话题冷却表：topic → 上次聊的时间戳 */
  topic_cooldown: Record<string, number>;
  /** 玩家画像：对玩家的观察记录 */
  player_profile: { observations: Array<{ content: string; t: number }> };
}

export interface MemoryV2Data {
  version: 1;
  long: {
    places: PlaceMemory[];
    events: EventMemory[];
    people: PersonMemory[];
    achievements: string[];
    failures: FailureMemory[];
  };
  chat: ChatMemoryData;
}

// ─────────── 默认值 / 归一化（防御损坏 json，逐层深补默认） ───────────

function defaultData(): MemoryV2Data {
  return {
    version: 1,
    long: { places: [], events: [], people: [], achievements: [], failures: [] },
    chat: {
      summary_lines: [],
      recent: [],
      topic_cooldown: {},
      player_profile: { observations: [] },
    },
  };
}

function normalize(raw: unknown): MemoryV2Data {
  const d = defaultData();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<MemoryV2Data>;
  const long = (r.long ?? {}) as Partial<MemoryV2Data['long']>;
  const chat = (r.chat ?? {}) as Partial<ChatMemoryData>;
  d.long.places = Array.isArray(long.places) ? long.places.filter(isPlace) : [];
  d.long.events = Array.isArray(long.events) ? long.events.filter(isEvent) : [];
  d.long.people = Array.isArray(long.people) ? long.people.filter(isPerson) : [];
  d.long.achievements = Array.isArray(long.achievements) ? long.achievements.filter((x): x is string => typeof x === 'string') : [];
  d.long.failures = Array.isArray(long.failures) ? long.failures.filter(isFailure) : [];
  const pp = (chat.player_profile ?? {}) as Partial<ChatMemoryData['player_profile']>;
  d.chat.player_profile.observations = Array.isArray(pp.observations)
    ? pp.observations.filter((x): x is { content: string; t: number } => !!x && typeof x.content === 'string')
    : [];
  d.chat.summary_lines = Array.isArray(chat.summary_lines) ? chat.summary_lines.filter((x): x is string => typeof x === 'string') : [];
  d.chat.recent = Array.isArray(chat.recent) ? chat.recent.filter((x) => !!x && typeof x.speaker === 'string' && typeof x.text === 'string') : [];
  if (chat.topic_cooldown && typeof chat.topic_cooldown === 'object') {
    d.chat.topic_cooldown = chat.topic_cooldown as Record<string, number>;
  }
  // 容量兜底（防旧文件超大）
  d.long.places = d.long.places.slice(-30);
  d.long.events = d.long.events.slice(-100);
  d.long.people = d.long.people.slice(-20);
  d.long.achievements = d.long.achievements.slice(-50);
  d.long.failures = d.long.failures.slice(-30);
  d.chat.summary_lines = d.chat.summary_lines.slice(-12);
  d.chat.recent = d.chat.recent.slice(-6);
  d.chat.player_profile.observations = d.chat.player_profile.observations.slice(-20);
  return d;
}

function isPlace(x: unknown): x is PlaceMemory {
  const o = x as PlaceMemory;
  return !!o && typeof o.name === 'string' && typeof o.last_visited === 'number';
}
function isEvent(x: unknown): x is EventMemory {
  const o = x as EventMemory;
  return !!o && typeof o.event === 'string' && typeof o.importance === 'number' && typeof o.t === 'number';
}
function isPerson(x: unknown): x is PersonMemory {
  const o = x as PersonMemory;
  return !!o && typeof o.name === 'string';
}
function isFailure(x: unknown): x is FailureMemory {
  const o = x as FailureMemory;
  return !!o && typeof o.event === 'string' && typeof o.t === 'number';
}

// ─────────── 话题关键词表（轻量提取；将来可升级 LLM 辅助） ───────────

const TOPIC_RULES: Array<[string, RegExp]> = [
  ['挖矿/矿物', /挖矿|矿洞|铁矿|铁|钻石|煤矿|矿石|下矿/i],
  ['建造/装修', /建造|建房子|盖|城堡|装修|小屋|房子|石头房|改造/i],
  ['战斗/怪物', /打怪|僵尸|骷髅|苦力怕|怪物|打架|史莱姆|蜘蛛/i],
  ['食物/饥饿', /吃|饿|食物|面包|苹果|烤肉|饥饿/i],
  ['种田/农场', /种田|种|农田|小麦|胡萝卜|土豆|收获|农场/i],
  ['探索/冒险', /探索|洞穴|探险|那边|去看看|冒险|山顶/i],
  ['钓鱼', /钓鱼|钓竿|河|海边/i],
  ['下界/末地', /下界|地狱|末地|末影龙|传送门|龙/i],
  ['天气/时间', /天黑了|晚上|睡觉|天亮|下雨|晴天|日出|日落/i],
];

function extractTopic(text: string): string | null {
  for (const [topic, re] of TOPIC_RULES) {
    if (re.test(text)) return topic;
  }
  return null;
}

// ─────────── MemoryV2 ───────────

export class MemoryV2 {
  data: MemoryV2Data;
  /** 短期记忆：session 内（蓝图 6.1），重启清空、不落盘 */
  private short: ShortTermItem[] = [];
  private file: string;

  constructor(file?: string) {
    this.file = file ?? path.join(__dirname, '..', 'data', 'memory2.json');
    this.data = this.load();
  }

  private load(): MemoryV2Data {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as unknown;
        return normalize(raw);
      }
    } catch (e) {
      log('WARN', `memory2 读取失败，重建: ${e}`);
    }
    return defaultData();
  }

  save(): void {
    try {
      atomicWriteJson(this.file, this.data);
    } catch (e) {
      log('ERROR', `memory2 保存失败: ${e}`);
    }
  }

  // ── 6.1 短期记忆（session 内，importance 淘汰） ──

  rememberShort(content: string, importance = 5): void {
    this.short.push({ content, t: Date.now(), importance });
    if (this.short.length > 20) {
      // 淘汰 importance 最低的（同分淘汰最旧）
      this.short.sort((a, b) => a.importance - b.importance || a.t - b.t);
      this.short = this.short.slice(-20);
    }
  }

  getShortRecent(n = 5): ShortTermItem[] {
    return this.short.slice(-n);
  }

  // ── 6.2 长期记忆：地点 ──

  rememberPlace(name: string, description: string, opts?: { direction?: string; feeling?: string; pos?: [number, number, number] }): void {
    const now = Date.now();
    const existing = this.data.long.places.find((p) => p.name === name);
    if (existing) {
      existing.description = description;
      if (opts?.direction) existing.direction = opts.direction;
      if (opts?.feeling) existing.feeling = opts.feeling;
      if (opts?.pos) existing.pos = opts.pos;
      existing.last_visited = now;
    } else {
      this.data.long.places.push({
        name,
        description,
        direction: opts?.direction,
        feeling: opts?.feeling,
        pos: opts?.pos,
        last_visited: now,
      });
      this.data.long.places = this.data.long.places.slice(-30);
    }
    this.save();
  }

  visitPlace(name: string): void {
    const p = this.data.long.places.find((x) => x.name === name);
    if (p) {
      p.last_visited = Date.now();
      this.save();
    }
  }

  findPlace(name: string): PlaceMemory | undefined {
    return this.data.long.places.find((p) => p.name === name);
  }

  // ── 6.2 长期记忆：事件（带情感标签） ──

  rememberEvent(event: string, emotion?: string, importance = 5): void {
    this.data.long.events.push({ event, emotion, importance, t: Date.now() });
    this.data.long.events = this.data.long.events.slice(-100);
    this.save();
  }

  // ── 6.2 长期记忆：人物 ──

  rememberPerson(name: string, trait?: string, interaction?: string): void {
    const now = Date.now();
    const p = this.data.long.people.find((x) => x.name === name);
    if (p) {
      if (trait && !p.traits.includes(trait)) p.traits.push(trait);
      if (interaction && !p.interactions.includes(interaction)) p.interactions.push(interaction);
      p.traits = p.traits.slice(-10);
      p.interactions = p.interactions.slice(-15);
      p.last_interaction = now;
    } else {
      this.data.long.people.push({
        name,
        traits: trait ? [trait] : [],
        interactions: interaction ? [interaction] : [],
        last_interaction: now,
      });
      this.data.long.people = this.data.long.people.slice(-20);
    }
    this.save();
  }

  // ── 6.2 长期记忆：成就 / 失败 ──

  addAchievement(text: string): void {
    if (!this.data.long.achievements.includes(text)) {
      this.data.long.achievements.push(text);
      this.data.long.achievements = this.data.long.achievements.slice(-50);
      this.save();
    }
  }

  rememberFailure(event: string, opts?: { cause?: string; lesson?: string }): void {
    this.data.long.failures.push({ event, cause: opts?.cause, lesson: opts?.lesson, t: Date.now() });
    this.data.long.failures = this.data.long.failures.slice(-30);
    this.save();
  }

  // ── 6.3 对话记忆：消息 / 摘要 / 冷却 / 画像 ──

  addChatMessage(speaker: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const now = Date.now();
    // 记录话题冷却（从玩家/AI 消息提取）
    const topic = extractTopic(trimmed);
    if (topic) this.data.chat.topic_cooldown[topic] = now;
    // 滚动摘要：recent 满 6 条 → 最老一条浓缩进 summary_lines
    this.data.chat.recent.push({ speaker, text: trimmed.slice(0, 120), t: now });
    if (this.data.chat.recent.length > 6) {
      const old = this.data.chat.recent.shift()!;
      const line = `${old.speaker}: ${old.text.slice(0, 40)}`;
      this.data.chat.summary_lines.push(line);
      if (this.data.chat.summary_lines.length > 12) this.data.chat.summary_lines.shift();
    }
    this.save();
  }

  /**
   * 最近对话（持久化，重连不丢），供 ChatContextBuilder 的【对话记录】。
   * 含玩家与 bot 双向发言；比 BrainBridge 内存 history（仅玩家单向、重连清空）更全。
   * 同时带上 summary_lines（被滚出 recent 的更早对话，已压缩），避免长对话后大脑彻底失忆。
   */
  getRecentChat(): Array<{ username: string; message: string; t: number }> {
    const out: Array<{ username: string; message: string; t: number }> = [];
    for (const line of this.data.chat.summary_lines) {
      const idx = line.indexOf(': ');
      if (idx > 0) out.push({ username: line.slice(0, idx), message: line.slice(idx + 2), t: 0 });
    }
    for (const r of this.data.chat.recent) {
      out.push({ username: r.speaker, message: r.text, t: r.t });
    }
    return out;
  }

  isTopicCooled(topic: string, cooldownSeconds = 300): boolean {
    const last = this.data.chat.topic_cooldown[topic];
    if (!last) return true;
    return Date.now() - last > cooldownSeconds * 1000;
  }

  /** 刚聊过、暂时别重复提的话题（供大脑上下文） */
  getAvoidTopics(cooldownSeconds = 300): string[] {
    const cutoff = Date.now() - cooldownSeconds * 1000;
    return Object.entries(this.data.chat.topic_cooldown)
      .filter(([, t]) => t > cutoff)
      .map(([topic]) => topic);
  }

  /** 手动记录某话题已聊（addChatMessage 已自动提取，此方法供显式调用） */
  recordTopic(topic: string): void {
    this.data.chat.topic_cooldown[topic] = Date.now();
    this.save();
  }

  observePlayer(observation: string): void {
    const list = this.data.chat.player_profile.observations;
    // 去重：同样的观察不重复记
    if (list.some((o) => o.content === observation)) return;
    list.push({ content: observation.slice(0, 100), t: Date.now() });
    if (list.length > 20) list.shift();
    this.save();
  }

  getObservations(): Array<{ content: string; t: number }> {
    return this.data.chat.player_profile.observations;
  }

  // ── 供大脑的上下文（人话，控制 token） ──

  /** 记忆层上下文：短期印象 + 熟悉地点 + 难忘事件 + 玩家画像 + 话题提醒 */
  getContext(playerName?: string): string {
    const parts: string[] = [];
    const short = this.getShortRecent(3).filter((s) => s.importance >= 5);
    if (short.length > 0) {
      parts.push(`我记得最近：${short.map((s) => s.content).join('；')}`);
    }
    const place = this.data.long.places
      .slice()
      .sort((a, b) => b.last_visited - a.last_visited)
      .slice(0, 2);
    if (place.length > 0) {
      parts.push(`熟悉的地方：${place.map((p) => `${p.name}（${p.description}${p.direction ? '，' + p.direction : ''}）`).join('；')}`);
    }
    const evts = this.data.long.events.slice(-2);
    if (evts.length > 0) {
      parts.push(`难忘的往事：${evts.map((e) => `${e.event}${e.emotion ? `（当时${e.emotion}）` : ''}`).join('；')}`);
    }
    const target = playerName ?? this.data.long.people[this.data.long.people.length - 1]?.name;
    if (target) {
      const obs = this.getObservations().slice(-2);
      if (obs.length > 0) {
        parts.push(`关于 ${target} 我注意到：${obs.map((o) => o.content).join('；')}`);
      }
    }
    const recent = this.data.chat.recent.slice(-2);
    if (recent.length > 0) {
      parts.push(`刚才聊到：${recent.map((r) => `${r.speaker}说"${r.text.slice(0, 30)}"`).join('；')}`);
    }
    const avoid = this.getAvoidTopics();
    if (avoid.length > 0) {
      parts.push(`这些话题刚聊过（尽量别重复）：${avoid.join('、')}`);
    }
    return parts.join('\n');
  }
}
