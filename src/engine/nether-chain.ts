/**
 * A1 下界链 · 决策模块（DESIGN_A1_NETHER.md）
 *
 * 定位：目标链纵深 A 的引擎侧扩展。独立模块 → SoloEngine 只加一行调用，状态机零侵入。
 *
 * 规则（对齐设计 §0/§2/§3）：
 *  - M0 硬门槛：`death_recovery` 未解锁（没成功演练过死亡回捡）→ 本模块静默返回 null，
 *    不打断 settled 生活，绝不放行任何下界动作。
 *  - 解锁后按里程碑守卫逐级放行「技能已实现」的最近一步；缺前置回退补材料或交还原引擎。
 *  - 失败回退：同一里程碑连续失败 ≥3 → 该步挂起 10min（leisure/主链照常，冷却后重试）。
 *  - 技能实体按批次落地（IMPLEMENTED 点亮），未实现的里程碑不派单，防止引擎空转。
 *  - 仅在主世界做决策；下界内不自主乱走（由 Guardian 维度锚点撤退链接管）。
 */
import type { MemoryManager } from '../memory';
import type { StatusData } from '../status';
import type { EngineDecision } from './engine-types';
import { hasItem, hasTech } from './engine-types';
import { ensureNetherReady } from './nether-gate';
import { log } from '../utils';

/** §5 冷却表（与 solo-engine 的 COOLDOWN_MS 合并，由 SoloEngine 统一计时） */
export const NETHER_COOLDOWN: Record<string, number> = {
  mine_diamond: 120_000,
  mine_obsidian: 180_000,
  build_portal: 180_000,
  enter_nether: 60_000,
  find_fortress: 300_000,
  kill_blaze: 240_000,
  return_home: 60_000,
  gear_up: 60_000,
};

/** 技能实体落地标记：每批次实现后点亮。未实现 → 该里程碑不派单 */
const IMPLEMENTED: Record<string, boolean> = {
  mine_diamond: true,
  mine_obsidian: true,
  build_portal: true,
  // B3（附录 §9）：M5 进入 + M8 雏形回穿 + M4 补给闭环
  gear_up: true,
  enter_nether: true,
  return_home: true,
  // B4 预留（要塞/烈焰人，需下界实机基础）
  find_fortress: false,
  kill_blaze: false,
};

/** 失败挂起状态（进程内存即可；重启后冷却清零，可接受） */
interface ChainMem {
  fails: Record<string, number>;
  suspendUntil: Record<string, number>;
}
const chain: ChainMem = { fails: {}, suspendUntil: {} };
/** 里程碑提示节流：挂起/缺料信息 5 分钟最多 log 一次，避免刷屏 */
let lastNoticeAt = 0;
function notice(msg: string): void {
  if (Date.now() - lastNoticeAt > 5 * 60_000) {
    lastNoticeAt = Date.now();
    log('INFO', `A1 ${msg}`);
  }
}

/** SoloEngine.onActivityDone 转发：记录该里程碑成败，失败计数 ≥3 → 挂起 10min */
export function netherRecord(skill: string, success: boolean): void {
  if (success) {
    chain.fails[skill] = 0;
    return;
  }
  chain.fails[skill] = (chain.fails[skill] ?? 0) + 1;
  if (chain.fails[skill] >= 3) {
    chain.suspendUntil[skill] = Date.now() + 10 * 60_000;
    log('WARN', `😵 A1「${skill}」连续失败 ${chain.fails[skill]} 次，挂起 10 分钟再试`);
  }
}

function suspended(skill: string): boolean {
  return Date.now() < (chain.suspendUntil[skill] ?? 0);
}

/** world.dimension 原始串 → 短名 */
function dimShort(raw: string): 'overworld' | 'nether' | 'end' {
  if (raw.includes('nether')) return 'nether';
  if (raw.includes('the_end')) return 'end';
  return 'overworld';
}

/**
 * A1 决策入口：返回 null = 本链不插话（交还原引擎）。
 * 里程碑链：M0 death_recovery → M1 diamond_pickaxe → M2 obsidian → M3 portal
 *           → M4 nether_ready → M5 enter_nether → M6 find_fortress → M7 blaze_rod → M8 return
 */
export function decideNether(s: StatusData, memMgr?: MemoryManager): EngineDecision | null {
  // M0 硬门槛：死亡回捡没演练过 → 不进下界链（设计 §0 硬约束 1）
  if (!hasTech(s, 'death_recovery')) return null;
  const dim = dimShort(s.world.dimension);

  // ── 下界维度（B3 安全网）：不自主推进 M6/M7（B4 才开放）→ 回穿主世界 ──
  if (dim === 'nether') {
    if (hasTech(s, 'nether') && IMPLEMENTED.return_home && !suspended('return_home')) {
      return { kind: 'skill', skill: 'return_home', reason: 'A1：下界要塞/烈焰人（B4）还没开放，先回穿主世界保证安全' };
    }
    notice('下界内没有可执行的下界动作，等玩家指令或回穿');
    return null;
  }
  if (dim !== 'overworld') return null;

  // M1 钻石镐：为下界第一步做的硬装备（钻石挖不了 → 黑曜石无从谈起）
  if (!hasItem(s, 'diamond_pickaxe') && !hasTech(s, 'diamond_pickaxe')) {
    // 守卫：连铁镐都没有 → 还不是下界阶段，交还原引擎（主链先按自己节奏发育）
    if (!hasItem(s, 'iron_pickaxe') && !hasItem(s, 'diamond_pickaxe')) return null;
    if (!IMPLEMENTED.mine_diamond) return null;
    if (suspended('mine_diamond')) {
      notice('挖钻石连续失败挂起中，歇 10 分钟再试（回日常）');
      return null;
    }
    return { kind: 'skill', skill: 'mine_diamond', reason: 'A1：去下界的硬门槛是钻石镐（后面要挖黑曜石），去挖钻石做镐' };
  }

  // M2 黑曜石 ×14（传送门材料）：技能内水浇岩浆成石、单源失败重试 ≤3
  if (!hasTech(s, 'obsidian') && !hasItem(s, 'obsidian')) {
    if (!IMPLEMENTED.mine_obsidian) return null;
    if (suspended('mine_obsidian')) {
      notice('黑曜石连续失败挂起中，歇 10 分钟再试（回日常）');
      return null;
    }
    return { kind: 'skill', skill: 'mine_obsidian', reason: 'A1：钻石镐到手，去找岩浆源浇水做黑曜石，凑 14 块就能搭传送门' };
  }

  // M3 传送门：选址（平整/净空/无易燃）失败自动换位 → 搭框点火
  if (!hasTech(s, 'portal')) {
    if (!IMPLEMENTED.build_portal) return null;
    if (suspended('build_portal')) {
      notice('搭门连续失败挂起中，歇 10 分钟再试（回日常）');
      return null;
    }
    return { kind: 'skill', skill: 'build_portal', reason: 'A1：黑曜石够了，找片平地搭传送门（自动选址，挤/易燃就换地方）' };
  }

  // ── M4 gate（B2 口径：铁剑+铁甲全套+食物64+打火石+金锭4）──
  const gate = ensureNetherReady(s);
  if (!gate.ok) {
    // 补给闭环（B3）：缺铁器/打火石/金锭 → gear_up 技能；只缺食物 → 交主链日常兜底
    const needsGear = gate.missing.some((m) => /铁|剑|打火石|金锭/.test(m));
    if (needsGear && IMPLEMENTED.gear_up && !suspended('gear_up')) {
      return { kind: 'skill', skill: 'gear_up', reason: `A1：进下界前补给装备——缺 ${gate.missing.join('、')}` };
    }
    notice(`M4 装备检查未过：缺 ${gate.missing.join('、')}（补给挂起/只缺食物时交主链日常）`);
    return null;
  }

  // gate 通过 → 里程碑 M4 nether_ready（仅记录；M5 守卫用 gate 本身即可）
  if (!hasTech(s, 'nether_ready')) memMgr?.addTech('nether_ready');

  // M5 进入下界（B3）：进过一次（nether tech）不再自动二进，避免进出空转；B4 点亮后改为持续推进
  if (!hasTech(s, 'nether') && IMPLEMENTED.enter_nether && !suspended('enter_nether')) {
    return { kind: 'skill', skill: 'enter_nether', reason: 'A1：装备齐了，进传送门去下界（记录出口门坐标，安全第一）' };
  }
  return null;
}
