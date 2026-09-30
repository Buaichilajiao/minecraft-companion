import { goals } from '@nxg-org/mineflayer-pathfinder';
import type mineflayer from 'mineflayer';
import type { ToolContext } from '../tools/context';
import {
  getBot,
  withAimLock,
  faceToward,
  gotoSmart,
  walkStraightTo,
  withTimeout,
  smartPlace,
  findItemInInventory,
} from '../tools/helpers';
import { checkReach } from '../crosshair';
import { v3, sleep, log } from '../utils';

/**
 * ActionExecutor —— L3 动作层（统一原子动作流水线）
 * ─────────────────────────────────────────────────────────────
 * 把「放 / 挖 / 按 / 攻击」等原子动作收敛到同一条流水线：
 *
 *   resolve → precheck(checkReach) → approach(走位) → aim(withAimLock) → execute → verify
 *
 * 工具层 / 技能层只调这里的方法，不直接碰 L1 原语（走位 / 朝向 / 背包）。
 * 每个动作返回 ActionResult（{ ok, message }），由工具层包装成 MCP 的 ok()/fail()。
 *
 * 设计约定（见 ARCHITECTURE.md 铁律）：
 *  - reach 统一走 getReach()（生存方块 4.5 / 实体 3.0；创造 5.0）
 *  - 动作期间的视线独占统一走 withAimLock
 *  - 预检统一走 checkReach（距离 + 视线）
 */

export interface ActionResult {
  ok: boolean;
  message: string;
}

export interface Pos {
  x: number;
  y: number;
  z: number;
}

const HOSTILE = [
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch', 'phantom',
  'blaze', 'slime', 'magma_cube', 'drowned', 'husk', 'stray', 'wither_skeleton',
  'zombified_piglin', 'pillager', 'vindicator', 'ravager', 'guardian', 'elder_guardian',
  'hoglin', 'zoglin', 'piglin_brute', 'vex',
];

export class ActionExecutor {
  constructor(private ctx: ToolContext) {}

  private bot(): mineflayer.Bot {
    return getBot(this.ctx);
  }

  // ─────────────────────────────────────────────
  // 公共步骤：precheck + approach（不可达才走位）
  // ─────────────────────────────────────────────
  private async ensureReachable(pos: Pos, kind: 'block' | 'entity', label: string): Promise<void> {
    const bot = this.bot();
    const rc = await checkReach(bot, pos, kind);
    if (rc.reachable) return;

    const p = bot.entity.position;
    const dist = Math.hypot(pos.x - p.x, pos.y - p.y, pos.z - p.z);
    if (dist <= 12) {
      try {
        await walkStraightTo(bot, { x: pos.x, y: pos.y, z: pos.z }, { timeoutMs: 10000, tol: 1.6 });
        return;
      } catch (e) {
        log('INFO', `🔄 ${label} 直线接近失败（${String(e)}），降级寻路`);
      }
    }
    await gotoSmart(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 1.6), 20000, label, { rescue: true });
  }

  // ─────────────────────────────────────────────
  // 动作：dig / press / attack
  // ─────────────────────────────────────────────
  async dig(req: { x: number; y: number; z: number }): Promise<ActionResult> {
    try {
      const bot = this.bot();
      const pos: Pos = { x: Math.floor(req.x), y: Math.floor(req.y), z: Math.floor(req.z) };

      // resolve：目标方块
      const block = bot.blockAt(v3(pos.x, pos.y, pos.z)) as unknown as { name?: string } | null;
      if (!block || block.name === 'air') {
        return { ok: false, message: `(${pos.x}, ${pos.y}, ${pos.z}) 是空气，没什么可挖的` };
      }
      const name = block.name;

      // precheck + approach：够不着/视线不通先走近
      await this.ensureReachable(pos, 'block', '挖方块');

      // aim + execute：挖掘（bot.dig 内部会 lookAt；withAimLock 防止 head-follow 抢朝向）
      await withAimLock(bot, () => withTimeout(bot.dig(block as never), 30000, '挖掘'));

      this.ctx.memory.pushTimeline(`挖掉了 ${name}`, [pos.x, pos.y, pos.z]);
      return { ok: true, message: `已挖掉 ${name}` };
    } catch (e) {
      return { ok: false, message: String(e) };
    }
  }

  /**
   * 原地挖掘（不 approach）：用于砍树时挖头顶垂直向上的原木。
   * 砍完树干底部后 bot 已在树底，上方原木都在视线 4.5 格内，只需 lookAt 垂直向上挖，
   * 一旦走 ensureReachable 反而会被水平带偏、再也够不着。调用方需保证目标在 reach 内。
   */
  async digInPlace(req: { x: number; y: number; z: number }): Promise<ActionResult> {
    try {
      const bot = this.bot();
      const pos: Pos = { x: Math.floor(req.x), y: Math.floor(req.y), z: Math.floor(req.z) };
      const block = bot.blockAt(v3(pos.x, pos.y, pos.z)) as unknown as { name?: string } | null;
      if (!block || block.name === 'air') {
        return { ok: false, message: `(${pos.x}, ${pos.y}, ${pos.z}) 是空气` };
      }
      const name = block.name;
      await withAimLock(bot, () => withTimeout(bot.dig(block as never), 20000, '原地挖掘'));
      this.ctx.memory.pushTimeline(`挖掉了 ${name}`, [pos.x, pos.y, pos.z]);
      return { ok: true, message: `已挖掉 ${name}` };
    } catch (e) {
      return { ok: false, message: String(e) };
    }
  }

  async press(req: { x: number; y: number; z: number }): Promise<ActionResult> {
    try {
      const bot = this.bot();
      const pos: Pos = { x: Math.floor(req.x), y: Math.floor(req.y), z: Math.floor(req.z) };

      // resolve：目标方块
      const block = bot.blockAt(v3(pos.x, pos.y, pos.z)) as unknown as { name?: string } | null;
      if (!block || block.name === 'air') {
        return { ok: false, message: `(${pos.x}, ${pos.y}, ${pos.z}) 是空气，没有可交互的方块` };
      }
      const name = block.name;

      // precheck + approach
      await this.ensureReachable(pos, 'block', '按方块');

      // aim + execute：右键使用（连点 2 次兜底丢包）
      let pressed = 0;
      await withAimLock(bot, async () => {
        for (let i = 0; i < 2; i++) {
          const b2 = bot.blockAt(v3(pos.x, pos.y, pos.z)) as unknown as { name?: string } | null;
          if (!b2 || b2.name === 'air') break;
          await withTimeout(bot.lookAt(v3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5), true), 5000, '看向方块');
          await withTimeout(bot.activateBlock(b2 as never), 8000, '使用方块');
          pressed++;
          await sleep(350);
        }
      });

      this.ctx.memory.pushTimeline(`按了 ${name} (${pos.x}, ${pos.y}, ${pos.z})`);
      const after = bot.blockAt(v3(pos.x, pos.y, pos.z)) as unknown as { name?: string } | null;
      return {
        ok: true,
        message: `已按下/使用了 ${name} (${pos.x}, ${pos.y}, ${pos.z})，共 ${pressed} 次${after?.name === 'air' ? '（方块已消失）' : ''}`,
      };
    } catch (e) {
      return { ok: false, message: String(e) };
    }
  }

  async attack(req: { entity_type?: string; max_distance?: number }): Promise<ActionResult> {
    try {
      const bot = this.bot();
      const maxDist = Number(req.max_distance ?? 48);
      const want = req.entity_type ? String(req.entity_type).toLowerCase() : '';

      // resolve：目标实体
      const target = bot.nearestEntity((e) => {
        const en = ((e as unknown as { name?: string }).name ?? '').toLowerCase();
        const et = ((e as unknown as { type?: string }).type ?? '').toLowerCase();
        if (!want) return HOSTILE.includes(en);
        return en === want || et === want;
      }) as unknown as {
        name?: string;
        position?: { x: number; y: number; z: number };
        attack?: () => Promise<void>;
      } | null;
      if (!target) {
        return want
          ? { ok: false, message: `附近没有 ${req.entity_type}` }
          : { ok: true, message: '附近没有敌对生物' };
      }
      const pos = target.position;
      const dist = pos
        ? Math.hypot(pos.x - bot.entity.position.x, pos.y - bot.entity.position.y, pos.z - bot.entity.position.z)
        : 999;
      if (dist > maxDist) {
        return { ok: false, message: `${want || '最近的敌对生物'}在 ${Math.round(dist)} 格外（超过 ${maxDist} 格）` };
      }
      if (!bot.attack) return { ok: false, message: '无法攻击该目标' };

      // precheck + approach
      if (pos) await this.ensureReachable({ x: pos.x, y: pos.y, z: pos.z }, 'entity', '接近目标');

      // aim + execute：先转准星再出刀
      await withAimLock(bot, async () => {
        if (pos) {
          faceToward(bot, pos.x, pos.y + 0.8, pos.z);
          await sleep(120); // 等发包朝向收敛
        }
        bot.attack(target as never);
        await sleep(300);
      });

      const label = target.name ?? want ?? '敌对生物';
      if (!want) this.ctx.memory.pushTimeline(`击退了 ${label}`);
      return { ok: true, message: `已攻击 ${label}` };
    } catch (e) {
      return { ok: false, message: String(e) };
    }
  }

  // ─────────────────────────────────────────────
  // 动作：place（approach 策略 = smartPlace）
  // ─────────────────────────────────────────────
  async place(req: { block_type: string; x: number; y: number; z: number }): Promise<ActionResult> {
    try {
      const bot = this.bot();
      const blockType = String(req.block_type);
      const pos: Pos = { x: Math.floor(Number(req.x)), y: Math.floor(Number(req.y)), z: Math.floor(Number(req.z)) };

      // resolve：目标格必须是空气，否则无处可放
      const target = bot.blockAt(v3(pos.x, pos.y, pos.z)) as unknown as { name?: string } | null;
      if (target && target.name !== 'air') {
        return { ok: false, message: `(${pos.x}, ${pos.y}, ${pos.z}) 已被 ${target.name} 占据，无法放置` };
      }
      // resolve：材料预检（提前失败，别走位半天才发现没材料）
      if (!findItemInInventory(bot, blockType)) {
        return { ok: false, message: `背包里没有 ${blockType}，先备好材料` };
      }

      // approach + aim + execute：smartPlace 作为 place 策略（参考面/就位/垫脚/让位/重试全在内）
      // withAimLock 挂起 head-follow，防它在 smartPlace 内部 lookAt 后把朝向抢回去
      let placed = false;
      await withAimLock(bot, async () => {
        placed = await smartPlace(bot, pos, blockType);
      });

      if (!placed) {
        return { ok: false, message: '放置失败：目标位置附近没有可放置的参考面，或找不到能看得到该位置的就位点' };
      }
      this.ctx.memory.pushTimeline(`放置了 ${blockType}`, [pos.x, pos.y, pos.z]);
      return { ok: true, message: `已在 (${pos.x}, ${pos.y}, ${pos.z}) 放置 ${blockType}` };
    } catch (e) {
      return { ok: false, message: String(e) };
    }
  }
}
