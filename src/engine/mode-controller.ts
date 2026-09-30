/**
 * ModeController（蓝图七节 · 模式控制器，项目语义：solo=独自 / coop=玩家陪伴）
 *
 * 规则（含迟滞防抖，蓝图「迟滞切换」）：
 *   - 有玩家在 coopRadius 内 → 攒 coopTick；连续 modeHysteresisTicks 次才切 coop（防边缘抖动）
 *   - 玩家全部不在半径内 → 1 tick 即切回 solo（人走了别端着）
 * 切换时回调 onSwitch，供装配层做上下文衔接（写记忆 → 大脑下次回复自然带出模式）。
 *
 * 纯状态机：不持有 bot/定时器，update(s) 由 Lifestyle tick 驱动。
 */
import type { StatusData } from '../status';
import { log } from '../utils';
import { EngineDecision, flatDist } from './engine-types';
import { SoloEngine } from './solo-engine';
import { CoopEngine } from './coop-engine';

export type CompanionMode = 'solo' | 'coop';

export interface ModeControllerOptions {
  /** 玩家在此半径内 → 进入陪伴模式 */
  coopRadius?: number;
  /** 玩家出现后需连续 N tick 才确认切 coop（迟滞防抖） */
  hysteresisTicks?: number;
}

export class ModeController {
  private mode: CompanionMode = 'solo';
  private coopTick = 0;
  private coopRadius: number;
  private hysteresisTicks: number;
  private solo: SoloEngine;
  private coop: CoopEngine;

  /** 模式切换通知（装配层接线：写记忆/衔接上下文） */
  onSwitch?: (from: CompanionMode, to: CompanionMode, s: StatusData) => void;

  constructor(solo: SoloEngine, coop: CoopEngine, opts: ModeControllerOptions = {}) {
    this.solo = solo;
    this.coop = coop;
    this.coopRadius = opts.coopRadius ?? 80;
    this.hysteresisTicks = Math.max(1, opts.hysteresisTicks ?? 2);
  }

  getMode(): CompanionMode {
    return this.mode;
  }

  /** 每 tick 由 Lifestyle 调用：更新模式判定 */
  update(s: StatusData): void {
    const self = s.self.position;
    const hasNear = s.world.players.some(
      (p) => p.position && flatDist(self, p.position) <= this.coopRadius
    );

    if (hasNear) {
      this.coopTick++;
      if (this.coopTick >= this.hysteresisTicks && this.mode !== 'coop') {
        this.switchTo('coop', s);
      }
    } else {
      this.coopTick = 0;
      this.coop.onPlayerGone();
      if (this.mode !== 'solo') {
        this.switchTo('solo', s);
      }
    }
  }

  /** 当前引擎决策 */
  decide(s: StatusData): EngineDecision {
    return this.mode === 'coop' ? this.coop.decide(s) : this.solo.decide(s);
  }

  /** 活动结束回调 → 交给当前引擎维护内部状态 */
  onActivityDone(skill: string, success: boolean): void {
    if (this.mode === 'coop') return; // coop 无无聊值
    this.solo.onActivityDone(skill, success);
  }

  private switchTo(to: CompanionMode, s: StatusData): void {
    const from = this.mode;
    this.mode = to;
    log('INFO', `🔀 模式切换: ${from} → ${to}`);
    this.onSwitch?.(from, to, s);
  }
}
