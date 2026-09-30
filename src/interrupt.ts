import { log } from './utils';

/**
 * 全局动作中断信号（InterruptSignal）
 * ─────────────────────────────────────────────
 * 解决「bot 正在执行长动作（移动/寻路/跟随）时，玩家插话必须立刻停下、原地不动、优先回应」的需求。
 *
 * 机制：
 * - 玩家新消息入队时（brain.enqueuePlayerMessage）调用 requestInterrupt() 置一个中断窗口；
 * - 长动作的循环/寻路检查点（gotoSmart 卡顿 interval、follow 循环、walk-path 循环等）
 *   每次 tick 调用 isInterrupted()，命中就 cancel pathfinder + 清控制键 + 原地停住；
 * - 动作层对"被中断"给出明确结果（中断 ≠ 失败/超时），大脑据此知道"该先回应玩家了"。
 *
 * 设计要点：
 * - 中断是**一次性短窗口**（默认 1500ms），过期自动失效 —— 只打断"此刻正在跑"的动作，
 *   不影响之后玩家下一条指令正常发起的新动作。
 * - clearInterrupt() 供动作层或大脑主动清除（如大脑已决定"继续旧任务"时）。
 */

const INTERRUPT_WINDOW_MS = 1500;

let interruptUntil = 0;
let interruptReason = '';

/** 玩家插话/需要打断当前动作时调用（brain.enqueuePlayerMessage 处） */
export function requestInterrupt(reason = '玩家插话'): void {
  interruptUntil = Date.now() + INTERRUPT_WINDOW_MS;
  interruptReason = reason;
  log('INFO', `⛔ 请求中断当前动作：${reason}（窗口 ${INTERRUPT_WINDOW_MS}ms）`);
}

/** 查询当前是否处于中断窗口内 */
export function isInterrupted(): boolean {
  return Date.now() < interruptUntil;
}

/** 当前中断原因（供动作层带进"被中断"结果） */
export function interruptReasonText(): string {
  return interruptReason;
}

/** 主动清除中断（大脑决定继续动作时可调） */
export function clearInterrupt(): void {
  interruptUntil = 0;
  interruptReason = '';
}

/**
 * 动作执行前的标准守卫：若正处于中断窗口，立即抛出一个"被中断"错误，
 * 让长动作在刚启动时就能及早停下（不等跑到第一个检查点）。
 */
export function throwIfInterrupted(): void {
  if (isInterrupted()) {
    const r = interruptReasonText() || '玩家插话';
    throw new Error(`已中断（${r}），本次动作取消`);
  }
}