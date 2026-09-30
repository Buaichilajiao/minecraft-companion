import type mineflayer from 'mineflayer';
import type { MemoryManager } from './memory';
import type { StatusCollector, StatusData } from './status';
import type { AppConfig } from './config';
import type { BrainBridge } from './brain';
import type { BodyController } from './body-controller';
import { skills, type SkillContext } from './skills';
import { TaskScheduler, defaultTasks } from './task-scheduler';
import { v3, log, sleep } from './utils';
import { gotoSmart, chatSegmented, walkStraightTo } from './tools/helpers';
import { matchesBlockName } from './blocknames';
import { goals } from '@nxg-org/mineflayer-pathfinder';
import type { EventWatcher } from './events';
import type { EmotionSystem } from './emotion';
import type { ModeController } from './engine/mode-controller';
import type { EngineDecision } from './engine/engine-types';
import { listTasks, autoAdvanceRunningTask } from './tasklist';

export type LifeState = 'auto' | 'working' | 'waiting';

/**
 * 生活循环状态机（定稿）：
 * 进游戏 → auto（自主玩耍）
 * 玩家命令 → working（执行）
 * 命令完成 → waiting（2分钟窗口）→ 无新命令 → auto
 */
export class Lifestyle {
  private bot: mineflayer.Bot;
  private memory: MemoryManager;
  private status: StatusCollector;
  private cfg: AppConfig['lifestyle'];
  private brain?: BrainBridge;
  private body: BodyController;
  /** 闲逛配置（陪伴层；可选，不传则关闭闲逛） */
  private hangCfg?: AppConfig['companion'];

  private state: LifeState = 'auto';
  private commandEndTime = 0;
  private tickTimer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastAutoActivity = 0;
  private autoCooldownMs = 15000;
  private scheduler: TaskScheduler;
  private currentTask: { id: string; skill: string } | null = null;
  /** 事件层（可选）：tick 复用状态快照做世界事件检测 */
  private watcher?: EventWatcher;
  /** 情绪系统（可选）：tick 里自然衰减 */
  private emotion?: EmotionSystem;
  /** 模式控制器（可选，P1）：solo/coop 引擎决策。不传则回退到内置任务表 */
  private mode?: ModeController;

  constructor(
    bot: mineflayer.Bot,
    memory: MemoryManager,
    status: StatusCollector,
    cfg: AppConfig['lifestyle'],
    brain: BrainBridge | undefined,
    body: BodyController,
    watcher?: EventWatcher,
    emotion?: EmotionSystem,
    mode?: ModeController,
    hangCfg?: AppConfig['companion']
  ) {
    this.bot = bot;
    this.memory = memory;
    this.status = status;
    this.cfg = cfg;
    this.brain = brain;
    this.body = body;
    this.watcher = watcher;
    this.emotion = emotion;
    this.mode = mode;
    this.hangCfg = hangCfg;
    this.scheduler = new TaskScheduler(defaultTasks());
  }

  getState(): LifeState {
    return this.state;
  }

  /** 玩家下命令：切到执行状态（大脑在处理） */
  onPlayerCommand(): void {
    this.state = 'working';
    log('INFO', '▶ 玩家命令 → working');
  }

  /** 命令处理完成：进入 2 分钟等待窗口 */
  onCommandDone(): void {
    this.commandEndTime = Date.now();
    this.state = 'waiting';
    log('INFO', `⏳ 命令完成 → waiting（${Math.round(this.cfg.commandWaitMs / 1000)}s 窗口）`);
  }

  attach(): void {
    if (!this.cfg.enabled) {
      log('INFO', '🌱 生活循环已禁用 (lifestyle.enabled=false)');
      return;
    }
    this.tickTimer = setInterval(() => void this.tick(), 5000);
    log('INFO', '🌱 生活循环已启动 (state=auto)');
  }

  detach(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.state = 'auto';
    this.busy = false;
    this.currentTask = null;
    log('INFO', '🌱 生活循环已停止');
  }

  private async tick(): Promise<void> {
    if (!this.bot.entity || this.bot.isSleeping) return;
    const s = this.status.getStatus();
    // 事件层：复用同一份状态快照扫描（不重复 getStatus）；情绪每 tick 自然衰减
    this.watcher?.scan(s);
    this.emotion?.decay();
    // P1：模式控制器每 tick 判定 solo/coop（迟滞切换）
    this.mode?.update(s);

    // 任务步自动完成检测（借鉴 Maicraft TaskTracker）：running 任务当前步若满足
    // completion 条件则自动推进，无需大脑手动调 tasklist-step。
    for (const t of listTasks().filter((x) => x.status === 'running')) {
      autoAdvanceRunningTask(t, s);
    }

    // 夜晚 → 优先尝试睡觉；但若睡不了（没床/床被占/身体被更优先占用），
    // 必须 fall through 到下方状态机继续跑 doAutoActivity——
    // 否则 coop-engine 的 defend_player（玩家身边 12 格有怪就帮打）在夜晚会被整个短路掉。
    if (s.world.time.phase === 'night' && !this.bot.isSleeping && !this.busy) {
      const slept = await this.trySleep(s);
      if (slept) return; // 真睡下了，本轮让位
      // 没睡成 → 不 return，落到状态机正常干活/响应威胁
    }

    switch (this.state) {
      case 'auto':
        await this.doAutoActivity(s);
        break;
      case 'waiting':
        if (Date.now() - this.commandEndTime >= this.cfg.commandWaitMs) {
          this.state = 'auto';
          log('INFO', '🔄 2 分钟无新命令 → 自主玩耍');
        }
        break;
      case 'working':
        // 大脑处理中，Guardian 兜底保护
        break;
    }
  }

  /** 夜晚尝试睡觉。返回 true=真睡下了（本轮让位）；false=没睡成（调用方需继续干活/响应威胁）。 */
  private async trySleep(s: StatusData): Promise<boolean> {
    if (this.busy) return false;
    const release = this.body.tryAcquire('auto', '夜晚睡觉');
    if (!release) return false; // 玩家/守护占用身体时让路，继续干活
    this.busy = true;
    try {
      const bed = this.bot.findBlock({ matching: (b) => matchesBlockName(String((b as unknown as { name?: string }).name ?? ''), 'bed'), maxDistance: 40 }) as unknown as { x: number; y: number; z: number } | null;
      if (bed) {
        const bedBlock = this.bot.blockAt(v3(bed.x, bed.y, bed.z)) as unknown as { name?: string };
        try {
          await this.bot.sleep(bedBlock as never);
          log('INFO', '🌙 天黑了，睡觉');
          this.memory.pushTimeline('天黑睡觉');
          return this.bot.isSleeping; // 睡下了 → true
        } catch {
          log('INFO', '🌙 床睡不进去，继续干活');
        }
      } else {
        log('INFO', '🌙 夜晚，但没床，继续干活');
      }
    } finally {
      this.busy = false;
      release();
    }
    return false;
  }

  private async doAutoActivity(s: StatusData): Promise<void> {
    if (this.busy) return;
    const now = Date.now();
    if (now - this.lastAutoActivity < this.autoCooldownMs) return;
    this.lastAutoActivity = now;
    this.busy = true;
    try {
      // 作息阶段：傍晚（dusk）且玩家在线 → 30% 概率社交闲聊，少干活
      if (s.world.time.phase === 'dusk' && s.world.players.length > 0 && Math.random() < 0.3) {
        await this.trySocialChat();
        return;
      }
      const decision = this.pickDecision(s);
      if (!decision || decision.kind === 'none') {
        // 陪伴层：无事可做且玩家在身边 → 闲逛（在玩家附近自然游走，像朋友在身边）
        // 决策为 none / 无正事干 才闲逛；有任务/玩家命令时不抢。纯本地行为，不触发大脑。
        const reason = decision ? decision.reason : '';
        const hung = await this.tryHang(s);
        if (!hung) log('INFO', decision ? `⏸ ${reason}` : '暂无合适自主活动');
        return;
      }
      // 身体控制权：玩家/守护占用时让路（不排队等，跳过本轮，下轮再试）
      const actName = decision.kind === 'goto_player' ? '跑回玩家身边' : decision.skill;
      const release = this.body.tryAcquire('auto', `自主玩耍:${actName}`);
      if (!release) {
        log('INFO', `⏸ 身体被占用，自主活动让路（${actName}）`);
        return;
      }
      try {
        // P1：coop 陪伴 —— 跑回玩家身边
        if (decision.kind === 'goto_player') {
          log('INFO', `🎮 陪伴行动: ${decision.reason}`);
          try {
            await gotoSmart(
              this.bot,
              new goals.GoalNear(decision.pos[0], decision.pos[1], decision.pos[2], 4),
              60000,
              '回玩家身边'
            );
            this.mode?.onActivityDone('goto_player', true);
          } catch (e) {
            log('INFO', `陪伴行动失败: ${String(e)}`);
          }
          return;
        }
        const skillName = decision.skill;
        const ctx: SkillContext = {
          bot: () => this.bot,
          memory: this.memory,
          status: () => this.status.getStatus(),
          emotion: () => this.emotion ?? null,
        };
        log('INFO', `🎮 自主玩耍: ${skillName}`);
        const result = await skills[skillName](ctx);
        // 旧任务表路径：记录冷却避免反复横跳
        if (this.currentTask) {
          this.scheduler.markDone(this.currentTask.id);
          this.currentTask = null;
        }
        // P1 引擎路径：维护无聊值/冷却
        this.mode?.onActivityDone(skillName, result.success);
        if (result.success) {
          this.memory.setActivity(`正在${skillName}`);
          // 简单自动课程推进
          this.advanceTech(skillName);
          // 阶段性让大脑汇报（节流，避免刷屏）
          if (this.brain && Math.random() < 0.2) {
            const reply = await this.brain.trigger(`我刚自主完成了「${skillName}」：${result.message}。玩家在线的话就自然跟他分享一句（口语短句、说完就停，别啰嗦成报告，别用播报腔）。`);
            if (reply && s.world.players.length > 0) {
              await chatSegmented(this.bot, reply);
            }
          }
        } else {
          log('INFO', `自主活动失败: ${result.message}`);
        }
      } finally {
        release();
      }
    } finally {
      this.busy = false;
    }
  }

  /**
   * 陪伴·在身边闲逛（陪伴层 PPC-HANG）：
   * 无事可做且玩家在附近时，在玩家身边自然游走——像朋友待在一起。纯本地行为、不触发大脑。
   * 铁律：只在「决策为 none（无正事干）」时调用；玩家/守护占用身体立即让路（tryAcquire 失败就跳过）。
   * @return true=执行了一次闲逛；false=条件不满足未闲逛
   */
  private async tryHang(s: StatusData): Promise<boolean> {
    if (!this.hangCfg?.hangEnabled) return false;
    if (s.world.players.length === 0) return false;
    const range = this.hangCfg.hangRadius;
    // 找身边最近的玩家（只闲逛于身边，不专门长途去找）
    const me = this.bot.entity?.position;
    if (!me) return false;
    let nearest: { x: number; y: number; z: number; name: string } | null = null;
    let best = range;
    for (const p of s.world.players) {
      if (p.name === this.bot.username) continue;
      if (!p.position) continue;
      const d = Math.hypot(p.position[0] - me.x, p.position[2] - me.z);
      if (d < best) { best = d; nearest = { x: p.position[0], y: p.position[1], z: p.position[2], name: p.name }; }
    }
    if (!nearest) return false; // 玩家不在身边，不闲逛（也不专门去找）

    // 身体控制权：auto 级闲逛，玩家/守护占用时让路（不排队，跳本轮）
    const release = this.body.tryAcquire('auto', '在身边闲逛');
    if (!release) return false;

    log('INFO', `🎈 玩家在附近(${Math.round(best)} 格)，在身边闲逛`);
    // 注意：外层 doAutoActivity 已 set busy=true，这里不重复管理，只持身体锁
    try {
      // 时长与分段：按配置区间随机取
      const [segMin, segMax] = this.hangCfg.hangSegmentSec;
      const [totMin, totMax] = this.hangCfg.hangTotalSec;
      const [pMin, pMax] = this.hangCfg.hangPauseSec;
      const wanderEnd = Date.now() + (totMin + Math.random() * (totMax - totMin)) * 1000;
      const segMs = (segMin + Math.random() * (segMax - segMin)) * 1000;
      const pauseMs = (pMin + Math.random() * (pMax - pMin)) * 1000;
      const segEnd = Date.now() + segMs;
      let paused = false;
      while (Date.now() < wanderEnd) {
        // 暂停段：停下来朝玩家看（拟人：偶尔看看同伴）
        if (paused) {
          const p = this.bot.players[nearest.name]?.entity?.position;
          if (p) this.bot.lookAt(v3(p.x, p.y + 1, p.z), true).catch(() => undefined);
          await sleep(Math.min(pauseMs, wanderEnd - Date.now()));
          paused = false;
          continue;
        }
        // 走到本段的随机点位（围绕玩家保持 2~5 格拟人距离）
        const ang = Math.random() * Math.PI * 2;
        const rad = 2 + Math.random() * 3;
        const target = { x: Math.round(nearest.x + Math.cos(ang) * rad), y: nearest.y, z: Math.round(nearest.z + Math.sin(ang) * rad) };
        try {
          // 短距（围绕玩家2~5格）优先直线走：@nxg pathfinder 对近距离目标会"空转误报卡住"，
          // 平地闲逛根本不需要寻路
          try {
            await walkStraightTo(this.bot, target, { timeoutMs: 9000, tol: 1.2 });
          } catch {
            // 被挡/有高差 → 降级 pathfinder 绕路（仍走不过则下面 catch 收尾）
            await gotoSmart(this.bot, new goals.GoalNear(target.x, target.y, target.z, 1), 9000, '在身边闲逛', { rescue: true });
          }
        } catch {
          break; // 走不过去就结束闲逛，不硬拗
        }
        // 本段走完进暂停；若已超总时长则收尾
        if (Date.now() >= segEnd || Date.now() >= wanderEnd) break;
        paused = true;
      }
      this.memory.setActivity('在玩家附近闲逛');
      log('INFO', '🎈 闲逛结束');
      return true;
    } finally {
      release();
    }
  }

  /** 傍晚社交：让大脑跟玩家闲聊两句（不占用身体锁） */
  private async trySocialChat(): Promise<void> {
    if (!this.brain) return;
    try {
      const reply = await this.brain.trigger('傍晚了，玩家在的话就自然开口聊两句（口语短句、像真人发消息一样说完就停，别一口气说一大段）。');
      if (reply) await chatSegmented(this.bot, reply);
      this.memory.pushTimeline('傍晚跟玩家闲聊');
    } catch {
      /* 聊不了就算了 */
    }
  }

  /**
   * 从引擎（P1：solo/coop）或旧任务表取下一个动作。
   * 低血量/低饱食交给 Guardian 处理（任何引擎都不该硬干）。
   */
  private pickDecision(s: StatusData): EngineDecision | null {
    if (s.self.health < 10 || s.self.food < 8) return null; // 交给 Guardian
    if (this.mode) return this.mode.decide(s);
    // 无模式控制器（旧装配）：回退内置任务表
    const task = this.scheduler.next(s);
    if (!task) return null;
    this.currentTask = { id: task.id, skill: task.skill };
    return { kind: 'skill', skill: task.skill, reason: '任务表' };
  }

  /** 科技树推进：完成关键技能时解锁阶段 */
  private advanceTech(skillName: string): void {
    if (skillName === 'chop_tree') this.memory.addTech('wood');
    if (skillName === 'mine_stone') this.memory.addTech('stone');
    if (skillName === 'mine_iron') this.memory.addTech('iron');
  }
}
