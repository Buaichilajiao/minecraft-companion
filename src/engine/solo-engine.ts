/**
 * SoloEngine（蓝图八节 · 单人自主引擎）
 *
 * 职责：玩家不在身边时决定「该干什么」。
 * 阶段：survival(交给 Guardian) → goal_driven(技术目标链) → leisure(无聊释放)。
 * 机制：无聊值 bored —— 反复做同一件事 / 活动失败会累积；
 *       达到阈值后进入探索/休闲，释放无聊。
 *
 * 纯决策引擎：不持有 bot/定时器/监听器，只吃 StatusData + 写 MemoryManager 可选。
 */
import type { MemoryManager } from '../memory';
import type { StatusData } from '../status';
import { log } from '../utils';
import { EngineDecision, hasItem, hasTech } from './engine-types';
import { NETHER_COOLDOWN, decideNether, netherRecord } from './nether-chain';

export interface SoloEngineOptions {
  /** 无聊阈值：达到后不再硬推任务，转探索/休闲 */
  boredThreshold?: number;
}

/** 每个技能执行后的冷却，防止 5s tick 反复干同一件事 */
const COOLDOWN_MS: Record<string, number> = {
  chop_tree: 60_000,
  mine_stone: 60_000,
  mine_iron: 90_000,
  plant_farm: 120_000,
  fish: 90_000,
  explore: 75_000,
  death_recover: 60_000,
  // A1 下界链冷却（nether-chain.ts §5）
  ...NETHER_COOLDOWN,
};

const BORED_PER_REPEAT = 12;   // 重复做同一件任务累积
const BORED_ON_FAIL = 8;       // 失败挫败感
const BORED_RELEASE_SWITCH = 40; // 成功换新任务释放
const BORED_RELEASE_EXPLORE = 60; // 成功探索大幅释放

export class SoloEngine {
  private memory?: MemoryManager;
  private boredThreshold: number;
  private bored = 0;
  private lastPickSkill: string | null = null;
  /** 上一次实际执行任务的成败（决定换新任务时是否发放成就感） */
  private prevStatus: 'completed' | 'failed' | null = null;
  private lastRunAt: Record<string, number> = {};
  private lastFallbackAt = 0;

  constructor(memory?: MemoryManager, opts: SoloEngineOptions = {}) {
    this.memory = memory;
    this.boredThreshold = opts.boredThreshold ?? 60;
  }

  getBored(): number {
    return this.bored;
  }

  /** 阶段描述（供状态显示/记忆，不落盘） */
  phaseDesc(s: StatusData): string {
    if (s.self.health < 10 || s.self.food < 8) return 'survival';
    if (this.bored >= this.boredThreshold) return 'leisure';
    if (!hasItem(s, '_log') && !hasItem(s, 'planks')) return 'goal_driven:wood';
    if (!hasItem(s, 'cobblestone')) return 'goal_driven:stone';
    if (!hasIron(s)) return 'goal_driven:iron';
    if (canFarm(s)) return 'goal_driven:farm';
    return 'goal_driven:settled';
  }

  /**
   * 每次技能结束回调：更新无聊值与冷却。
   *
   * 换新任务 -40 只在「上一个任务成功收尾」后才发放（完成目标的成就感）；
   * 上一个任务失败时被迫切换 → 不给成就感（挫败继续累积，避免
   * 「失败→换→无聊降→又失败→又换」的浅层横跳死循环）。
   */
  onActivityDone(skill: string, success: boolean): void {
    const now = Date.now();
    this.lastRunAt[skill] = now;
    // A1 下界链失败计数（独立模块内部状态，≥3 挂起由 decideNether 消费）
    netherRecord(skill, success);
    const isSwitch = skill !== this.lastPickSkill;
    if (success) {
      if (!isSwitch) {
        // 同一件事连续成功 → 重复劳动累积无聊
        this.bored = Math.min(100, this.bored + BORED_PER_REPEAT);
      } else if (this.prevStatus === 'failed') {
        // 上一个任务失败后硬换 → 不给成就感，挫败延续
        this.bored = Math.min(100, this.bored + BORED_ON_FAIL);
      } else {
        // 正常完成旧目标 → 换新任务：成就感释放无聊
        this.bored = Math.max(0, this.bored - BORED_RELEASE_SWITCH);
      }
      if (skill === 'explore') this.bored = Math.max(0, this.bored - BORED_RELEASE_EXPLORE);
    } else {
      this.bored = Math.min(100, this.bored + BORED_ON_FAIL);
    }
    if (this.bored >= this.boredThreshold && this.memory) {
      log('INFO', `😑 有点无聊了（bored=${this.bored}），想出去逛逛`);
    }
    this.prevStatus = success ? 'completed' : 'failed';
    this.lastPickSkill = skill;
  }

  /** 决定下一个动作 */
  decide(s: StatusData): EngineDecision {
    // 0) 死亡回捡最高优先：刚复活且有未捡的死亡点 → 先捡装备（掉装备比任何事都痛）
    const dp = this.memory?.data.death_point;
    if (dp && dimShort(s.world.dimension) === dp.dim && this.cooled('death_recover')) {
      return this.tryTask(s, 'death_recover', `刚在${dp.dim}死了（${dp.pos.join(',')}），先把装备捡回来`);
    }
    // 1) 休闲：无聊值到位 → 探索 / 钓鱼
    if (this.bored >= this.boredThreshold) {
      return this.pickLeisure(s);
    }
    // 2) 目标链：石器 → 铁器 → 农场
    if (!hasItem(s, '_log') && !hasItem(s, 'planks')) {
      return this.tryTask(s, 'chop_tree', '需要木头，先砍树');
    }
    if (!hasItem(s, 'cobblestone') && !hasTech(s, 'stone')) {
      return this.tryTask(s, 'mine_stone', '需要圆石，挖石头');
    }
    if (!hasIron(s)) {
      return this.tryTask(s, 'mine_iron', '目标：挖铁，升级装备');
    }
    if (canFarm(s)) {
      const farm = this.tryTask(s, 'plant_farm', '有种子有耕地，种田');
      if (farm.kind !== 'none') return farm;
    }
    // 链尾里程碑：温饱解决、还没安家 → 用攒下的材料盖个家
    if (!hasTech(s, 'home') && hasEnoughBuildingMat(s) && this.cooled('build_home')) {
      return { kind: 'skill', skill: 'build_home', reason: '铁器齐了，用攒的材料盖个自己的家' };
    }
    // A1 下界链扩展（独立模块 nether-chain.ts）：死亡回捡演练过（death_recovery）才介入，
    // 把链尾从 settled 往纵深推：钻石镐 → 黑曜石 → 传送门 → 下界
    const nether = decideNether(s, this.memory);
    if (nether) return nether;
    if (hasItem(s, 'fishing_rod') && this.cooled('fish')) {
      const hasWater = s.surroundings.nearby_blocks.some((b) => b.includes('water'));
      if (hasWater) return { kind: 'skill', skill: 'fish', reason: '钓会儿鱼休息一下' };
    }
    // 3) 兜底：交替 探索 / 砍树，避免只在原地打转
    const now = Date.now();
    if (now - this.lastFallbackAt > 90_000 && this.cooled('explore')) {
      this.lastFallbackAt = now;
      return { kind: 'skill', skill: 'explore', reason: '四下转转，看看有没有新地方' };
    }
    if (this.cooled('chop_tree')) {
      return { kind: 'skill', skill: 'chop_tree', reason: '备点木头' };
    }
    return { kind: 'none', reason: '暂无合适自主活动' };
  }

  /** 休闲选择：探索优先，其次钓鱼 */
  private pickLeisure(s: StatusData): EngineDecision {
    if (hasItem(s, 'fishing_rod') && this.cooled('fish')) {
      const hasWater = s.surroundings.nearby_blocks.some((b) => b.includes('water'));
      if (hasWater && Math.random() < 0.4) {
        return { kind: 'skill', skill: 'fish', reason: '无聊，去钓鱼' };
      }
    }
    if (this.cooled('explore')) {
      return { kind: 'skill', skill: 'explore', reason: '无聊了，出去逛逛' };
    }
    return { kind: 'none', reason: '想出去玩但刚逛过，歇会儿' };
  }

  /** 任务冷却闸：冷却期内返回 none（避免反复横跳） */
  private cooled(skill: string): boolean {
    const cd = COOLDOWN_MS[skill] ?? 60_000;
    return Date.now() - (this.lastRunAt[skill] ?? 0) >= cd;
  }

  private tryTask(s: StatusData, skill: string, reason: string): EngineDecision {
    if (!this.cooled(skill)) return { kind: 'none', reason: `${skill} 刚干过，歇口气` };
    return { kind: 'skill', skill, reason };
  }
}

function hasIron(s: StatusData): boolean {
  return hasTech(s, 'iron') || hasItem(s, 'iron_ingot') || hasItem(s, 'raw_iron');
}

/** world.dimension 原始串 → 短名（minecraft:the_nether → nether） */
function dimShort(raw: string): 'overworld' | 'nether' | 'end' {
  if (raw.includes('nether')) return 'nether';
  if (raw.includes('the_end')) return 'end';
  return 'overworld';
}

function canFarm(s: StatusData): boolean {
  const hasSeed =
    s.self.inventory.some((i) => i.name === 'wheat_seeds' || i.name === 'carrot' || i.name === 'potato');
  if (!hasSeed) return false;
  return s.surroundings.nearby_blocks.includes('farmland');
}

/** 建材是否攒够（build_home 门槛：任一建材 ≥128，与技能内 BUILD_NEED 对齐，避免反复失败挫败） */
function hasEnoughBuildingMat(s: StatusData): boolean {
  const candidates = [
    'cobblestone', 'oak_planks', 'spruce_planks', 'birch_planks',
    'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'oak_log',
  ];
  for (const frag of candidates) {
    const n = s.self.inventory.filter((i) => i.name === frag).reduce((a, i) => a + i.count, 0);
    if (n >= 128) return true;
  }
  return false;
}
