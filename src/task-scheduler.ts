import type { StatusData } from './status';

export interface SchedTask {
  id: string;
  /** skills 表里的 key（lifestyle 调用） */
  skill: string;
  /** 优先级：越大越先执行 */
  priority: number;
  /** 可执行条件（满足才考虑） */
  min?: (s: StatusData) => boolean;
  /** 执行后冷却时间（毫秒），防止反复横跳 */
  cooldownMs: number;
}

/**
 * 生活任务调度器（批次 4）
 * 按优先级 + 条件从任务表里挑下一个该干的活，
 * 解决 pickSkill 反复横跳的问题（比如一直砍树）。
 */
export class TaskScheduler {
  private tasks: SchedTask[] = [];
  private lastRunAt: Record<string, number> = {};

  constructor(tasks: SchedTask[]) {
    this.tasks = tasks.slice().sort((a, b) => b.priority - a.priority);
  }

  /** 选出下一个可执行任务（无则 null） */
  next(s: StatusData): SchedTask | null {
    const now = Date.now();
    for (const t of this.tasks) {
      const last = this.lastRunAt[t.id] ?? 0;
      if (now - last < t.cooldownMs) continue;
      if (t.min && !t.min(s)) continue;
      return t;
    }
    return null;
  }

  /** 任务执行完成后调用，记录冷却 */
  markDone(id: string): void {
    this.lastRunAt[id] = Date.now();
  }
}

/** 默认生活任务表：科技树推进 + 生产循环（按优先级） */
export function defaultTasks(): SchedTask[] {
  const has = (s: StatusData, name: string): boolean =>
    s.self.inventory.some((i) => i.name.includes(name));
  return [
    {
      id: 'wood',
      skill: 'chop_tree',
      priority: 5,
      min: (s) => !has(s, '_log') && !has(s, 'planks'),
      cooldownMs: 60_000,
    },
    {
      id: 'stone',
      skill: 'mine_stone',
      priority: 4,
      min: (s) => !has(s, 'cobblestone'),
      cooldownMs: 60_000,
    },
    {
      id: 'iron',
      skill: 'mine_iron',
      priority: 3,
      min: (s) => !has(s, 'iron_ingot') && !has(s, 'raw_iron'),
      cooldownMs: 90_000,
    },
    {
      id: 'farm',
      skill: 'plant_farm',
      priority: 2,
      min: (s) =>
        s.self.inventory.some((i) => i.name === 'wheat_seeds' || i.name === 'carrot' || i.name === 'potato') &&
        s.surroundings.nearby_blocks.includes('farmland'),
      cooldownMs: 120_000,
    },
    {
      id: 'fish',
      skill: 'fish',
      priority: 1,
      min: (s) =>
        s.self.inventory.some((i) => i.name === 'fishing_rod') &&
        (s.surroundings.nearby_blocks.includes('water') || s.surroundings.nearby_blocks.includes('water_source')),
      cooldownMs: 120_000,
    },
    // 兜底：都不满足就砍树（备足木头）
    {
      id: 'fallback_wood',
      skill: 'chop_tree',
      priority: 0,
      min: () => true,
      cooldownMs: 30_000,
    },
  ];
}
