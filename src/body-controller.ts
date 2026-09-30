import { log } from './utils';

/**
 * 身体控制权（BodyController）
 * ─────────────────────────────────────────────
 * 解决"谁在动 bot 身体"的互斥问题（v1.2.0 批次 1 新增）。
 *
 * 此前：lifestyle 自主技能直接 bot.xxx、AstrBot 多 agent 调 MCP 工具、
 *       guardian 保命 —— 三方可同时操作身体，无人管理。
 *
 * 本控制器统一管理身体使用权，优先级：
 *   guardian(保命) > player(玩家任务) > auto(作息/自主玩耍)
 *
 * 规则：
 * - acquire(kind)：高优先级可抢占低优先级（guardian 抢 player/auto，player 抢 auto）
 * - 低优先级申请时若被更高优先级占用 → 进入等待队列，释放后按优先级唤醒
 * - 抢占时记录 displaced，释放后自动恢复被抢占者（guardian 用完把身体还给 player）
 * - 观察类工具（get-state / find-blocks / look 等）不占用身体，不受锁影响
 */

export type BodyOwner = 'guardian' | 'player' | 'auto';

/** 排队等锁超时（ms）：超过则放弃并报错，避免调用方永久 hang */
const ACQUIRE_TIMEOUT_MS = 20000;

const PRIORITY: Record<BodyOwner, number> = { guardian: 3, player: 2, auto: 1 };

interface Waiter {
  kind: BodyOwner;
  label: string;
  resolve: () => void;
}

export class BodyController {
  private owner: BodyOwner | null = null;
  private ownerLabel = '';
  private displaced: BodyOwner | null = null;
  private waiters: Waiter[] = [];

  /** 当前占用者（观察用，供上下文注入） */
  current(): { owner: BodyOwner | null; label: string } {
    return { owner: this.owner, label: this.ownerLabel };
  }

  isOwner(kind: BodyOwner): boolean {
    return this.owner === kind;
  }

  /**
   * 能否获取控制权（v1.3.0 多方控制修复）：
   * - 无人占用 → 可以
   * - 同优先级（同 kind）→ 仅同一客户端(label)可重入；不同客户端互斥，需排队
   * - 高优先级可抢占低优先级（guardian 抢 player/auto，player 抢 auto）
   */
  private canAcquire(kind: BodyOwner, label: string): boolean {
    if (this.owner === null) return true;
    if (this.owner === kind) return this.ownerLabel === label; // 同客户端重入 OK，不同客户端互斥
    return PRIORITY[kind] > PRIORITY[this.owner];
  }

  /**
   * 申请身体控制权。
   * 高优先级直接抢占；低优先级被占用时等待（Promise 队列）。
   * @returns release 函数（释放后自动恢复被抢占者）
   */
  async acquire(kind: BodyOwner, label: string, timeoutMs = ACQUIRE_TIMEOUT_MS): Promise<() => void> {
    if (this.canAcquire(kind, label)) {
      return this.take(kind, label);
    }
    // 等待直到轮到我们。超时兜底（v17）：长任务（follow-player 等）持锁时，
    // 后来的调用方原来会永久 hang（MCP 请求/大脑调用永不返回）；现在超时直接报错让调用方收尾。
    const cur = this.current();
    await new Promise<void>((resolve, reject) => {
      const w: Waiter = { kind, label, resolve };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`身体被 ${cur.owner ?? '未知'}（${cur.label || '任务'}）占用超 ${Math.round(timeoutMs / 1000)}s，本次动作放弃`));
      }, timeoutMs);
      w.resolve = () => { clearTimeout(timer); resolve(); };
      this.waiters.push(w);
    });
    return this.take(kind, label);
  }

  /** 非阻塞申请：拿到返回 release，拿不到返回 null（auto 用，失败就跳过本轮） */
  tryAcquire(kind: BodyOwner, label: string): (() => void) | null {
    if (!this.canAcquire(kind, label)) return null;
    return this.take(kind, label);
  }

  private take(kind: BodyOwner, label: string): () => void {
    // 抢占时记住被抢占者（仅一层：guardian→player→auto）
    if (this.owner !== null && this.owner !== kind) {
      this.displaced = this.owner;
    } else if (this.owner === null) {
      this.displaced = null;
    }
    this.owner = kind;
    this.ownerLabel = label;
    log('INFO', `🔒 身体控制权 → ${kind}（${label}）`);
    return () => this.release(kind);
  }

  private release(kind: BodyOwner): void {
    if (this.owner !== kind) return;
    this.owner = this.displaced;
    this.displaced = null;
    this.ownerLabel = '';
    log('INFO', `🔓 身体控制权释放（${kind}）`);
    this.pumpWaiters();
  }

  private pumpWaiters(): void {
    // 唤醒等待者中优先级最高且能获取的第一个
    const sorted = [...this.waiters].sort((a, b) => PRIORITY[b.kind] - PRIORITY[a.kind]);
    const idx = this.waiters.indexOf(sorted[0]);
    if (idx >= 0 && this.canAcquire(sorted[0].kind, sorted[0].label)) {
      const [w] = this.waiters.splice(idx, 1);
      w.resolve();
    }
  }

  /** 等待队列长度（调试用） */
  waiterCount(): number {
    return this.waiters.length;
  }

  /** 是否有人在排队等身体（长任务据此主动让位，如跟随遇到玩家指令时先放手） */
  hasWaiter(kind?: BodyOwner): boolean {
    return kind ? this.waiters.some((w) => w.kind === kind) : this.waiters.length > 0;
  }
}
