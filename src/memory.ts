import fs from 'fs';
import path from 'path';
import { atomicWriteJson, log } from './utils';

export interface MemoryData {
  identity: {
    name: string;
    home?: [number, number, number];
    /** 主世界下界传送门坐标（A1 M3 建好后写） */
    portal?: [number, number, number];
    /** 下界侧传送门坐标（A1 M5 每次进入时更新） */
    nether_portal?: [number, number, number];
  };
  /** 最近一次死亡点（死亡回捡用）。捡回/确认消失后清空 */
  death_point?: { dim: 'overworld' | 'nether' | 'end'; pos: [number, number, number]; at: number } | null;
  goals: string[];
  player_prefs: Record<string, string>;
  timeline: Array<{ t: number; event: string; pos?: [number, number, number] }>;
  stats: Record<string, number>;
  tech_unlocked: string[];
  current_goal: string;
  last_activity: string;
  relationship: {
    last_seen: number;
    shared_memories: string[];
    player_name?: string;
  };
}

function defaultMemory(): MemoryData {
  return {
    identity: { name: '白白' },
    death_point: null,
    goals: [],
    player_prefs: {},
    timeline: [],
    stats: {},
    tech_unlocked: [],
    current_goal: '',
    last_activity: '',
    relationship: { last_seen: 0, shared_memories: [] },
  };
}

/** 统一记忆管理：唯一 data/memory.json，原子写入 */
export class MemoryManager {
  private file: string;
  data: MemoryData;

  constructor(file?: string) {
    this.file = file ?? path.join(__dirname, '..', 'data', 'memory.json');
    this.data = this.load();
  }

  private load(): MemoryData {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<MemoryData>;
        const base = defaultMemory();
        return {
          ...base,
          ...parsed,
          // 老文件 identity 可能缺新字段 → 浅合并兜底（home/portal/nether_portal）
          identity: { ...base.identity, ...(parsed.identity ?? {}) },
          death_point: parsed.death_point ?? null,
        } as MemoryData;
      }
    } catch (e) {
      log('WARN', `记忆文件读取失败，重建: ${e}`);
    }
    return defaultMemory();
  }

  save(): void {
    try {
      atomicWriteJson(this.file, this.data);
    } catch (e) {
      log('ERROR', `记忆保存失败: ${e}`);
    }
  }

  pushTimeline(event: string, pos?: [number, number, number]): void {
    this.data.timeline.push({ t: Date.now(), event, pos });
    if (this.data.timeline.length > 200) this.data.timeline = this.data.timeline.slice(-200);
    this.save();
  }

  setStat(key: string, value: number): void {
    this.data.stats[key] = value;
    this.save();
  }

  addStat(key: string, delta: number): void {
    this.data.stats[key] = (this.data.stats[key] ?? 0) + delta;
    this.save();
  }

  getStat(key: string): number {
    return this.data.stats[key] ?? 0;
  }

  /** 记录死亡点（Guardian death 事件调用，死亡回捡技能消费） */
  setDeathPoint(dim: 'overworld' | 'nether' | 'end', pos: [number, number, number]): void {
    this.data.death_point = { dim, pos, at: Date.now() };
    this.save();
  }

  /** 清空死亡点（捡回/确认消失后） */
  clearDeathPoint(): void {
    if (this.data.death_point) {
      this.data.death_point = null;
      this.save();
    }
  }

  addTech(tech: string): void {
    if (!this.data.tech_unlocked.includes(tech)) {
      this.data.tech_unlocked.push(tech);
      this.save();
    }
  }

  setGoal(goal: string): void {
    this.data.current_goal = goal;
    if (!this.data.goals.includes(goal)) this.data.goals.push(goal);
    this.save();
  }

  clearGoal(): void {
    this.data.current_goal = '';
    this.save();
  }

  setActivity(activity: string): void {
    this.data.last_activity = activity;
  }

  setPref(key: string, value: string): void {
    this.data.player_prefs[key] = value;
    this.save();
  }

  getPref(key: string): string | undefined {
    return this.data.player_prefs[key];
  }

  addSharedMemory(text: string): void {
    this.data.relationship.shared_memories.push(text);
    if (this.data.relationship.shared_memories.length > 50) {
      this.data.relationship.shared_memories = this.data.relationship.shared_memories.slice(-50);
    }
    this.save();
  }

  setPlayerName(name: string): void {
    this.data.relationship.player_name = name;
    this.save();
  }

  touchSeen(): void {
    this.data.relationship.last_seen = Date.now();
    this.save();
  }
}
