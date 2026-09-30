/**
 * 引擎公共类型（蓝图七/八/九节 · 决策输出）
 * 决策输出统一为三种：做技能 / 跑回玩家身边 / 什么都不做。
 * 由 Lifestyle 每 tick 询问当前引擎 → 执行。
 */
import type { StatusData } from '../status';

export type EngineDecision =
  | { kind: 'skill'; skill: string; reason: string }
  | { kind: 'goto_player'; pos: [number, number, number]; reason: string }
  | { kind: 'none'; reason: string };

export interface StatusLike extends StatusData {}

/** 平面距离（忽略 Y） */
export function flatDist(
  a: { x: number; z: number } | [number, number, number],
  b: { x: number; z: number } | [number, number, number]
): number {
  const ax = Array.isArray(a) ? a[0] : a.x;
  const az = Array.isArray(a) ? a[2] : a.z;
  const bx = Array.isArray(b) ? b[0] : b.x;
  const bz = Array.isArray(b) ? b[2] : b.z;
  return Math.hypot(ax - bx, az - bz);
}

/** 取离自己最近的在线玩家（位置已知），无则 null */
export function nearestPlayer(s: StatusData):
  | { name: string; position: [number, number, number] }
  | null {
  const self = s.self.position;
  let best: { name: string; position: [number, number, number]; d: number } | null = null;
  for (const p of s.world.players) {
    if (!p.position) continue;
    const d = flatDist(self, p.position);
    if (!best || d < best.d) best = { name: p.name, position: p.position, d };
  }
  return best ? { name: best.name, position: best.position } : null;
}

/** 背包是否含某物品片段 */
export function hasItem(s: StatusData, fragment: string): boolean {
  return s.self.inventory.some((i) => i.name.includes(fragment));
}

/** 科技是否已解锁 */
export function hasTech(s: StatusData, tech: string): boolean {
  return s.progress.tech_unlocked.includes(tech);
}
