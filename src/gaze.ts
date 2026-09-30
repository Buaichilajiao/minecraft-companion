import type mineflayer from 'mineflayer';
import type { BodyController } from './body-controller';
import { log } from './utils';
import { aimAt, aimDir, releaseHead } from './head-channel';

type GazePhase = 'idle' | 'gazing' | 'cooldown';

/** 归一到 [-π, π) */
function normAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * 常驻注视系统（村民式间歇注视）
 * ─────────────────────────────────────────────
 * 规则（玩家可预测的确定性行为）：
 *   - 玩家进入 5 格内 → gazing 盯住，实时转脸跟随
 *   - 玩家走动 = 有吸引力：一直盯（位移会重置计时）
 *   - 玩家站定不动连续满 5s → 移开视线（cooldown），不再看
 *   - cooldown 中玩家走开 5 格外 → idle；再次进入 → 重新盯、重新计时
 *
 * 转头：@9/12 改走 head-channel（统一转向通道）。原来这里"干脆直接设 entity.yaw"
 * 被玩家实测为"疯狂转头"：20Hz 无死区直写 + yawSpeed=200 即时发包 → 目标位置那点
 * 抖动被放大成甩头。现在物理朝向仍即时（站位不动，不影响移动），
 * 玩家看到的头部朝向走 __netStat.headYaw：300°/s 匀速 + 2° 死区 + 目标位置 EMA。
 *
 * 让位规则（任何一条成立即暂停转头，动作方自动接管视角）：
 *   1. body.owner !== null —— guardian(保命)/player(任务)/auto(自主)
 *   2. 控制键按下 —— move-direction/nxg 寻路/飞行跟随正在移动
 *   3. 主动暂停 —— 大脑 look-at / 特殊动作调 pause()，到点或 resume() 恢复
 */
export class GazeController {
  private bot: mineflayer.Bot;
  private body: BodyController;
  private tickHandler: (() => void) | null = null;
  private paused = false;
  private resumeAt = 0;

  // —— 注视状态机 ——
  private phase: GazePhase = 'idle';
  private phaseUntil = 0; // gazing 放弃计时截止
  private anchor: { x: number; z: number } | null = null; // gazing 中玩家位置基准（位移重置计时）
  private readonly RANGE = 5; // 注视范围（格）
  private readonly GAZE_TTL = 2500; // 站定不动满 2.5s 移开视线
  private readonly MOVE_RESET = 0.15; // 位移超过此(格)视为"在动"，重置计时（@9/12 0.05→0.15：玩家站着微抖就会无限续期，永远盯着人反而像抽风）
  private readonly maxDist = 16; // 视野内候选玩家上限（实际注视范围看 RANGE）

  constructor(bot: mineflayer.Bot, body: BodyController) {
    this.bot = bot;
    this.body = body;
  }

  attach(): void {
    this.tickHandler = () => this.onTick();
    this.bot.on('physicsTick' as never, this.tickHandler as never);
    log('INFO', '👀 常驻注视系统已启动（5格内盯人：动着一直看，站定2.5s移开，出5格再进重计时）');
  }

  detach(): void {
    if (this.tickHandler) {
      this.bot.removeListener('physicsTick' as never, this.tickHandler as never);
      this.tickHandler = null;
    }
    this.paused = false;
    this.resumeAt = 0;
    this.phase = 'idle';
    this.phaseUntil = 0;
    this.anchor = null;
  }

  /** 主动暂停注视（大脑 look-at 等需要看别处的场景）。pauseMs>0 = 到时自动恢复；0 = 一直暂停直到 resume() */
  pause(pauseMs: number, reason: string): void {
    this.paused = true;
    this.resumeAt = pauseMs > 0 ? Date.now() + pauseMs : 0;
    log('INFO', `👀 注视暂停（${reason}）${pauseMs > 0 ? `，${pauseMs}ms 后自动恢复` : '，需手动恢复'}`);
  }

  resume(): void {
    this.paused = false;
    this.resumeAt = 0;
    log('INFO', '👀 注视已恢复');
  }

  private onTick(): void {
    const now = Date.now();
    try {
      if (this.paused) {
        if (this.resumeAt > 0 && now >= this.resumeAt) {
          this.paused = false;
          this.resumeAt = 0;
        } else {
          this.yieldHead(); // 让位时把头部覆盖还回去，否则粘住不动（大脑 look-at 会被它压掉）
          return;
        }
      }
      // 让位 1：身体被任务占用（guardian 保命 / player 任务 / auto 自主）
      if (this.body.current().owner !== null) {
        this.yieldHead();
        return;
      }

      // 让位 2：控制键按下 = bot 实际在移动（move-direction/autoJumpMove、nxg 寻路、飞行跟随）
      const b = this.bot as unknown as { getControlState?: (k: string) => boolean };
      if (b.getControlState) {
        for (const k of ['forward', 'back', 'left', 'right']) {
          try {
            if (b.getControlState(k)) {
              this.yieldHead();
              return;
            }
          } catch { /* ignore */ }
        }
      }

      const me = this.bot.entity?.position;
      if (!me) return;
      // 视野内找最近玩家（上限 16 格）
      let best: { x: number; y: number; z: number } | null = null;
      let bestD = this.maxDist * this.maxDist;
      for (const name of Object.keys(this.bot.players)) {
        if (name === this.bot.username) continue;
        const p = this.bot.players[name]?.entity;
        if (!p) continue;
        const dx = p.position.x - me.x;
        const dz = p.position.z - me.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD) {
          bestD = d2;
          best = p.position;
        }
      }
      // 玩家消失/超视野 → idle
      if (!best) {
        this.toIdle(now);
        return;
      }

      const dx = best.x - me.x;
      const dy = best.y + 1.6 - (me.y + 1.62); // 眼睛对眼睛（目标在上 dy>0）
      const dz = best.z - me.z;
      const horiz = Math.sqrt(dx * dx + dz * dz);

      switch (this.phase) {
        case 'idle':
          // 玩家走进 5 格内 → 开始盯
          if (horiz <= this.RANGE) this.toGazing(best);
          break;

        case 'gazing': {
          // 玩家走出范围（1 格容差防边界抖）→ 放弃
          if (horiz > this.RANGE + 1) {
            this.toIdle(now);
            break;
          }
          // 走动 = 有吸引力：位移超过阈值就重置 5s 计时
          if (this.anchor && Math.hypot(best.x - this.anchor.x, best.z - this.anchor.z) > this.MOVE_RESET) {
            this.anchor = { x: best.x, z: best.z };
            this.phaseUntil = now + this.GAZE_TTL;
          }
          // 站定不动满 5s → 腻了，移开视线
          if (now >= this.phaseUntil) {
            this.toCooldown();
          } else {
            this.faceAt(best);
          }
          break;
        }

        case 'cooldown':
          // 已失去兴趣：不看。玩家走开 5 格外 → 回 idle，下次进来重新计时
          if (horiz > this.RANGE + 1) {
            this.toIdle(now);
          }
          // 冷却期间视线停在别处（进入时已转开），不碰 yaw
          break;
      }
    } catch {
      /* physicsTick 高频触发，静默防崩 */
    }
  }

  /** 视线对准目标（走统一转向通道：物理即时 + 观感 300°/s、2°死区、目标位置低通） */
  private faceAt(best: { x: number; y: number; z: number }): void {
    aimAt(this.bot, 'gaze', best.x, best.y + 1.6, best.z); // 眼睛对眼睛
  }

  /** 让位：把头部覆盖还回身体朝向（不还的话覆盖会粘在头上，压掉别人的转向） */
  private yieldHead(): void {
    releaseHead(this.bot, 'gaze');
  }

  private toGazing(best: { x: number; z: number }): void {
    this.phase = 'gazing';
    this.phaseUntil = Date.now() + this.GAZE_TTL;
    this.anchor = { x: best.x, z: best.z };
  }

  private toCooldown(): void {
    this.phase = 'cooldown';
    this.phaseUntil = 0;
    this.anchor = null;
    this.lookAway();
  }

  private toIdle(now: number): void {
    this.phase = 'idle';
    this.phaseUntil = now;
    this.anchor = null;
  }

  /** 腻了：视线从当前朝向往旁边偏一截，像村民移开目光发呆（走统一通道匀速转，别瞬甩） */
  private lookAway(): void {
    const e = this.bot.entity;
    if (!e) return;
    const dir = Math.random() < 0.5 ? -1 : 1;
    const away = e.yaw + dir * (0.6 + Math.random() * 0.9); // 偏 34°~86°
    e.yaw = away; // 物理也转过去（站定状态下不影响移动），观感慢慢跟
    aimDir(this.bot, 'gaze', away, 0);
    // 转到位后交还覆盖（~0.5s），避免长期占着共享通道
    setTimeout(() => releaseHead(this.bot, 'gaze'), 900);
  }
}
