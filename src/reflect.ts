/**
 * 本地反射旁路（陪伴层·真缺口 2）
 * ─────────────────────────────────────────────
 * 目的：玩家某些运动类指令（过来/停下/危险/跟ME）在本地毫秒级响应，
 *       不绕 LLM（不走 SSE 通道②），也不进 brain 队列 —— 由身体直通。
 *
 * 通道定位（见 DESIGN-陪伴第一批-A1.md §三）：
 *   · 本地反射 = 无通道：guardian/helpers 进程内直通，几百毫秒内
 *   · 主动决策 = ② brain.trigger（不在本文件）
 *   · 动作执行 = ① MCP callTool（不在本文件）
 *
 * 铁律：
 *   · 只做「让身体动 / 一句话确认」，不组织拟人叙事（拟人走 ②）
 *   · 抢身体用 body.acquire('player', ...)（玩家级，压过 auto 闲逛/自主任务）
 *   · 不写对话历史、不触发大脑（避免 LLM 再答一遍）
 *   · 命中返回 true，交由 main 短路跳过 engage()；未命中返回 false 放行进大脑
 */
import type mineflayer from 'mineflayer';
import { goals } from '@nxg-org/mineflayer-pathfinder';
import type { MemoryManager } from './memory';
import type { BodyController } from './body-controller';
import type { Guardian } from './guardian';
import type { AppConfig } from './config';
import type { ReflectAction } from './config';
import { log, sleep } from './utils';
import { gotoSmart } from './tools/helpers';

/** 附近敌对生物精简名单（危险反射用；与 guardian 内部名单隔离，不侵入底层） */
const HOSTILE: string[] = [
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch',
  'phantom', 'blaze', 'drowned', 'husk', 'stray', 'pillager', 'vindicator', 'ravager',
  'slime', 'magma_cube', 'hoglin', 'zoglin', 'piglin_brute', 'vex', 'guardian', 'wither_skeleton',
];

/** 反射动作 → 中文标签（回复确认用，短句） */
const ACTION_CN: Record<ReflectAction, string> = {
  avoid: '躲开',
  danger_heed: '警惕',
  stop: '停下',
  come: '过来',
  follow: '陪你',
};

export class PixieReflect {
  private bot: mineflayer.Bot;
  private memory: MemoryManager;
  private body: BodyController;
  private guardian: Guardian | null;
  private cfg: AppConfig['reflect'];

  /** 反射级动作的本地冷却（防玩家狂喊刷屏），按动作标签各自冷却 */
  private lastFire: Partial<Record<ReflectAction, number>> = {};
  private COOLDOWN_MS = 3000;

  constructor(bot: mineflayer.Bot, memory: MemoryManager, body: BodyController, guardian: Guardian | null, cfg: AppConfig['reflect']) {
    this.bot = bot;
    this.memory = memory;
    this.body = body;
    this.guardian = guardian;
    this.cfg = cfg;
  }

  /**
   * 玩家指令反射短路。命中则执行本地动作并返回 true（main 据此跳过 engage）。
   * @return true=已本地代答（不再进大脑）；false=未命中，放行进大脑
   */
  handle(username: string, rawMessage: string): boolean {
    if (!this.cfg.enabled) return false;
    const text = rawMessage.replace(/^\(私聊\)\s*/, '').trim();
    if (text.length < 2) return false;
    if (username === this.bot.username) return false;

    // 在各触发词中，只取「最具体/最长匹配」一次，避免多动作叠加冲突
    const match = this.matchAction(text);
    if (!match) return false;

    const [action, pattern] = match;
    // 本地冷却：同动作 3s 内不重复响应，防刷屏
    const now = Date.now();
    if (now - (this.lastFire[action] ?? 0) < this.COOLDOWN_MS) {
      log('INFO', `🪞 反射[${ACTION_CN[action]}] 冷却中，静默`);
      return true; // 命中但仍冷却 → 仍算「已处理」，不进大脑（避免大脑又答一遍）
    }
    this.lastFire[action] = now;

    log('INFO', `🪞 反射[${ACTION_CN[action]}] ${username}: "${pattern}" → 本地直通`);
    this.memory.pushTimeline(`玩家${username}说「${text.slice(0, 24)}」，我${ACTION_CN[action]}`);
    void this.dispatch(action, username, text);
    return true;
  }

  /** 命中触发词 → 返回 [动作, 原触发词]。取匹配值最长的那条（最具体优先） */
  private matchAction(text: string): [ReflectAction, string] | null {
    let best: [ReflectAction, string] | null = null;
    let bestLen = -1;
    for (const [pattern, action] of Object.entries(this.cfg.approach)) {
      const re = new RegExp(pattern);
      if (re.test(text) && pattern.length > bestLen) {
        best = [action, pattern];
        bestLen = pattern.length;
      }
    }
    return best;
  }

  /** 反射动作分派（全部本地、毫秒级、不碰 ① ②） */
  private async dispatch(action: ReflectAction, username: string, text: string): Promise<void> {
    switch (action) {
      case 'avoid': return this.actAvoid(username);
      case 'danger_heed': return this.actDangerHeed(username);
      case 'stop': return this.actStop(username);
      case 'come': return this.actCome(username);
      case 'follow': return this.actFollow(username);
      default: return;
    }
  }

  private say(msg: string): void {
    try { this.bot.chat(msg); } catch { /* 断线忽略 */ }
  }

  // ── S0 紧急躲避：附近有威胁 → 朝反方向短退，口头确认 ──
  private async actAvoid(username: string): Promise<void> {
    const threat = this.nearestHostile(16);
    if (!threat) {
      this.say(`好，我注意着点${username}`);
      return;
    }
    const me = this.bot.entity?.position;
    if (!me) return;
    const release = await this.body.acquire('player', `反射:玩家喊躲开(${username})`);
    try {
      const dx = me.x - threat.x, dz = me.z - threat.z;
      const len = Math.hypot(dx, dz) || 1;
      const away = { x: me.x + (dx / len) * 10, y: me.y, z: me.z + (dz / len) * 10 };
      await gotoSmart(this.bot, new goals.GoalNear(away.x, away.y, away.z, 2), 6000, '反射躲避', { rescue: true });
      this.say('嗯，我躲开点');
    } catch {
      this.say('我往边上让让，你小心');
    } finally {
      release();
    }
  }

  // ── S1 危险求助：玩家提醒有危险 → 停下 PVP、退到玩家身边安全处 ──
  private async actDangerHeed(username: string): Promise<void> {
    if (this.guardian?.inAgreedPvp()) {
      this.guardian.stopAgreedPvp();
      this.say('好，不打了，先撤');
      return;
    }
    const me = this.bot.entity?.position;
    const player = this.bot.players[username]?.entity?.position;
    if (!me || !player) {
      this.say('危险在哪？你说我听着');
      return;
    }
    const release = await this.body.acquire('player', `反射:危险求助(${username})`);
    try {
      // 就近的威胁：若有 → 侧移；否则先贴近玩家更安全
      const threat = this.nearestHostile(12);
      let target = { x: player.x, y: player.y, z: player.z };
      if (threat) {
        const dx = me.x - threat.x, dz = me.z - threat.z;
        const len = Math.hypot(dx, dz) || 1;
        target = { x: me.x + (dx / len) * 8, y: me.y, z: me.z + (dz / len) * 8 };
      }
      await gotoSmart(this.bot, new goals.GoalNear(target.x, target.y, target.z, 2), 8000, '反射危险躲避', { rescue: true });
      this.say('收到，我躲远了');
    } catch {
      this.say('我尽量不往那边凑');
    } finally {
      release();
    }
  }

  // ── S2 停下：取消当前寻路 + 身体复位（玩家级获取后立即释放，打断 auto/任务）──
  private async actStop(_username: string): Promise<void> {
    const pf = (this.bot as unknown as { pathfinder?: { cancel?: () => Promise<unknown> } }).pathfinder;
    // 先清控制键 + 静默取消 pathfinder；玩家级 acquire 会打断 auto 并把 body 让回 player 语义
    try {
      (this.bot as unknown as { clearControlStates?: () => void }).clearControlStates?.();
      (this.bot as unknown as { setControlState?: (k: string, v: boolean) => void }).setControlState?.('sprint', false);
    } catch { /* ignore */ }
    const cancelReq = pf?.cancel?.();
    if (cancelReq) await cancelReq.catch(() => undefined);
    // 玩家级锁：压过 auto（闲逛/自主任务）。拿锁即释放，纯粹用优先级让身体停役
    const release = this.body.tryAcquire('player', '反射:玩家叫停');
    if (release) release();
    this.say('好，我停下');
  }

  // ── S3 过来：先应声 → 再走到玩家身边（≤2 格贴住）。先回话再动身，玩家不干等 ──
  private async actCome(username: string): Promise<void> {
    const player = this.bot.players[username]?.entity?.position;
    if (!player) {
      this.say(`${username}，你在哪？我看不到你`);
      return;
    }
    // 先应一声再动身（人喊"过来"是先说"来了"再走）
    this.say('来了！');
    const release = await this.body.acquire('player', `反射:玩家呼叫(${username})`);
    try {
      await gotoSmart(this.bot, new goals.GoalNear(player.x, player.y, player.z, 2), 20000, '反射过来', { rescue: true });
      // 走到了补一句，让玩家知道到位（远距离时会晚到）
      this.say(`来了，到你了${username}`);
    } catch (e) {
      log('WARN', `反射过来失败: ${e}`);
      this.say('我这就过去，路有点绕');
    } finally {
      release();
    }
  }

  // ── S4 跟着我：先应声 → 走到玩家身边并持续跟随锚点（复用 coop goto_player 的锚点跟随语义）──
  private async actFollow(username: string): Promise<void> {
    const player = this.bot.players[username]?.entity?.position;
    if (!player) {
      this.say(`${username}，你在哪？我跟上你`);
      return;
    }
    // 先应一声再动身（人喊"跟着我"是先回话再跟）
    this.say('好，我跟着你');
    const release = await this.body.acquire('player', `反射:跟随(${username})`);
    try {
      // 先贴到玩家身边
      await gotoSmart(this.bot, new goals.GoalNear(player.x, player.y, player.z, 2), 20000, '反射跟进', { rescue: true });
      // 持续跟随：玩家移动时贴近（简化：跟随一个可重复的 GoalFollow，若 API 可用；否则退化为贴一次）
      const pf = (this.bot as unknown as { pathfinder?: { goto?: (g: unknown) => Promise<unknown> } }).pathfinder;
      const targetEnt = this.bot.players[username]?.entity;
      // GoalFollow 与 GoalNear 同源（@nxg-org/mineflayer-pathfinder goals）；直接构造
      const followGoal = (goals as unknown as { GoalFollow?: unknown }).GoalFollow;
      if (typeof followGoal === 'function' && pf?.goto && targetEnt) {
        const g = new (followGoal as new (e: unknown, r: number) => unknown)(targetEnt, 3);
        const go = pf.goto.bind(pf);
        await go(g).catch(() => undefined);
        await sleep(4000); // 短暂跟一段（长跟随仍交给大脑/coop 引擎），避免本地锁长期占身
      }
    } catch (e) {
      log('WARN', `反射跟随失败: ${e}`);
    } finally {
      release();
    }
  }

  /** 最近敌对生物坐标（≤range 格内）；无则 null。不挑衅，只用于躲避方向。 */
  private nearestHostile(range: number): { x: number; y: number; z: number } | null {
    const me = this.bot.entity?.position;
    if (!me) return null;
    let nearest: { x: number; y: number; z: number } | null = null;
    let best = range;
    for (const ent of Object.values(this.bot.entities)) {
      const e = ent as unknown as { name?: string; position?: { x: number; y: number; z: number } };
      const en = (e.name ?? '').toLowerCase();
      if (!HOSTILE.includes(en) || !e.position) continue;
      const d = Math.hypot(e.position.x - me.x, e.position.y - me.y, e.position.z - me.z);
      if (d < best) { best = d; nearest = e.position; }
    }
    return nearest;
  }
}