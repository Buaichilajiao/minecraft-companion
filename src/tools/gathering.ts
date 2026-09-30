import { z } from 'zod';
import { goals } from '@nxg-org/mineflayer-pathfinder';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { getBot, ok, fail, withTimeout, gotoSmart, pickupItemSmart, digShaftDown, digStairDown } from './helpers';
import { v3, log } from '../utils';
import { MAX_STEPS } from '../constants';
import type { ActionExecutor } from '../actions/executor';

const LOG_BLOCKS = ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];
const ORE_BLOCKS = ['coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'diamond_ore', 'emerald_ore', 'redstone_ore', 'lapis_ore', 'deepslate_iron_ore', 'deepslate_coal_ore', 'deepslate_diamond_ore'];

async function walkTo(bot: ReturnType<typeof getBot>, pos: { x: number; y: number; z: number }): Promise<void> {
  // 已贴脸（≤4 格）就直接干活，别走寻路——新版 pathfinder 对近距离目标会空转误报"卡住"（同 smelt 的 workaround）
  const dist = bot.entity.position.distanceTo(v3(pos.x, pos.y, pos.z));
  if (dist <= 4) return;
  await gotoSmart(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 2), 30000, '走路');
}

export function registerGatheringTools(mcp: McpServerManager, ctx: ToolContext, executor: ActionExecutor): void {
  // 挖指定方块
  mcp.registerTool(
    'dig-block',
    '挖掘指定坐标的方块（自动走过去并挖掉）',
    { x: z.number(), y: z.number(), z: z.number() },
    async (args) => {
      const r = await executor.dig({ x: Number(args.x), y: Number(args.y), z: Number(args.z) });
      return r.ok ? ok(r.message) : fail(r.message);
    }
  );

  // 砍树
  mcp.registerTool(
    'collect-tree',
    '砍一棵完整的树：找到最近的树，把树干全部挖掉（最多 10 个原木，90 秒内完成）',
    {},
    async () => {
      try {
        const bot = getBot(ctx);
        const startBlock = bot.findBlock({ matching: (b) => LOG_BLOCKS.includes(b.name), maxDistance: 40 }) as unknown as { position?: { x: number; y: number; z: number } } | null;
        if (!startBlock || !startBlock.position) return fail('附近 40 格内没有树');
        const start = startBlock.position;

        // BFS 收集与起点相连的整棵树干原木坐标（去重，上限 treeLogs）
        const logs: Array<{ x: number; y: number; z: number }> = [];
        const seen = new Set<string>();
        const queue: Array<{ x: number; y: number; z: number }> = [{ x: start.x, y: start.y, z: start.z }];
        const deadline = Date.now() + MAX_STEPS.longTaskMs;
        while (queue.length > 0 && logs.length < MAX_STEPS.treeLogs) {
          if (Date.now() > deadline) break;
          const pos = queue.shift()!;
          const key = `${pos.x},${pos.y},${pos.z}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const block = bot.blockAt(v3(pos.x, pos.y, pos.z)) as unknown as { name?: string } | null;
          if (!block || !LOG_BLOCKS.includes(block.name ?? '')) continue;
          logs.push(pos);
          for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
            queue.push({ x: pos.x + dx, y: pos.y + dy, z: pos.z + dz });
          }
        }
        if (logs.length === 0) return fail('找到了树但没识别出可砍的原木（可能被树叶包住），换个角度再试');

        // 从树干最底部、离 bot 最近的原木开始砍：findBlock 的"最近"是 3D 距离，
        // 可能选中树干高处（半空）的原木，空手又没法垫脚会卡死。先砍底部（地面可达），
        // bot 到树底后抬头依次砍上方（视线 4.5 格内可直接挖，无需垫脚）。
        const bp0 = bot.entity.position;
        const horiz = (p: { x: number; y: number; z: number }) => Math.hypot(p.x - bp0.x, p.z - bp0.z);
        logs.sort((a, b) => (a.y - b.y) || (horiz(a) - horiz(b)));

        // 逐块走健壮挖掘流水线（ensureReachable + withAimLock，避免 head-follow 抢朝向导致 dig 瞬断）
        let cut = 0;
        const failed: string[] = [];
        const isItem = (e: unknown): boolean => {
          const t = (e as { type?: string; kind?: string }).type ?? (e as { kind?: string }).kind ?? '';
          return t === 'object' || (e as { name?: string }).name === 'item';
        };
        for (let i = 0; i < logs.length; i++) {
          const pos = logs[i];
          if (Date.now() > deadline) { failed.push('超时'); break; }
          // 底部第一根走完整就位（走到树底）；上方原木原地抬头垂直挖（都在视线内，走位反而被带偏）
          const r = i === 0 ? await executor.dig(pos) : await executor.digInPlace(pos);
          if (r.ok) {
            cut++;
            if (cut % MAX_STEPS.progressEvery === 0) log('INFO', `🪓 砍树进度: ${cut}/${logs.length} 个原木`);
            // 边砍边捡：刚掉的原木就在原地/脚边，立即用高物智能拾取（优先挖树叶让物品下落，不爬高）。
            // 避免它弹飞到树叶/建筑顶（之后难捡）。
            await new Promise((res) => setTimeout(res, 350));
            const near = bot.nearestEntity((e) => isItem(e)) as { position?: { x: number; y: number; z: number } } | null;
            if (near?.position) {
              const d = bot.entity.position.distanceTo(v3(near.position.x, near.position.y, near.position.z));
              if (d <= 8) await pickupItemSmart(bot, near.position, 15000).catch(() => undefined);
            }
          } else {
            failed.push(`(${pos.x},${pos.y},${pos.z}):${r.message.slice(0, 30)}`);
          }
        }
        // 砍完回地面：若砍树干时站到树干/树桩上而悬空，向下走到最近的地面，避免卡在树上
        try {
          const curFoot = Math.floor(bot.entity.position.y);
          const below = bot.blockAt(v3(Math.floor(bot.entity.position.x), curFoot - 1, Math.floor(bot.entity.position.z))) as unknown as { name?: string } | null;
          if (below && (below.name === 'air' || below.name === 'cave_air' || below.name?.endsWith('_leaves'))) {
            // 脚下是空气或树叶（悬空），向下找最近的可站立实体方块并落下去
            for (let y = curFoot - 1; y >= Math.max(0, curFoot - 12); y--) {
              const b = bot.blockAt(v3(Math.floor(bot.entity.position.x), y, Math.floor(bot.entity.position.z))) as unknown as { name?: string } | null;
              if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'water' && !b.name?.endsWith('_leaves')) {
                await gotoSmart(bot, new (require('@nxg-org/mineflayer-pathfinder') as { goals: any }).goals.GoalNear(
                  Math.floor(bot.entity.position.x) + 0.5, y + 1, Math.floor(bot.entity.position.z) + 0.5, 1), 10000, '回地面').catch(() => undefined);
                break;
              }
            }
          }
        } catch { /* 回地面失败不致命 */ }

        ctx.memory.pushTimeline(`砍了一棵树（${cut} 个原木）`);
        if (cut === 0) return fail(`一块原木都没砍成：${failed.slice(0, 2).join('；')}`);
        const tail = failed.length > 0 ? `，${failed.length} 块没砍成（${failed[0]}）` : '';
        return ok(`砍树完成，共 ${cut} 个原木${tail}`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 挖矿
  mcp.registerTool(
    'mine-ore',
    '找最近的矿石并挖掘（支持煤/铁/铜/金/钻石等）',
    {},
    async () => {
      try {
        const bot = getBot(ctx);
        const oreBlock = bot.findBlock({ matching: (b) => ORE_BLOCKS.includes(b.name), maxDistance: 48 }) as unknown as { name?: string; position?: { x: number; y: number; z: number } } | null;
        if (!oreBlock || !oreBlock.position) return fail('附近 48 格内没有矿石');
        const opos = oreBlock.position;
        // 统一走健壮挖掘流水线（ensureReachable + withAimLock），不再 walkTo + bot.dig
        const dr = await executor.dig({ x: opos.x, y: opos.y, z: opos.z });
        if (!dr.ok) return fail(dr.message);
        const oreName = oreBlock.name ?? '矿石';
        ctx.memory.pushTimeline(`挖到了 ${oreName}`, [opos.x, opos.y, opos.z]);
        // 挖到钻石：成就里程碑（情绪+事件+长期记忆）
        if (oreName.includes('diamond')) {
          ctx.emotion?.()?.react('found_diamond');
          ctx.eventBus?.()?.push('achievement', 'found_diamond', '我挖到钻石了！！这可是最稀有的矿石', 'high');
          ctx.memoryV2?.addAchievement('第一次挖到钻石');
          ctx.memoryV2?.rememberEvent('我挖到了一颗钻石', '兴奋', 9);
        }
        return ok(`挖到了 ${oreName}`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 竖井挖矿（原地向下挖穿泥土/岩石层，到目标层或矿层）
  mcp.registerTool(
    'mine-down',
    '向下挖到目标深度层或矿藏层。默认楼梯模式（staircase=true）：向前且向下挖一条 1 格宽、落差恒 1 格、可回走的台阶，能沿原路回来（工作台/熔炉放楼梯口即可反复上下）。用于矿藏/石头盖在泥土之下、地表不暴露的场景。可指定 target 矿，下挖过程中侧向命中该矿就停下挖穿。',
    {
      target: z.string().optional().describe('可选：目标方块名，如 stone / iron_ore / diamond_ore。命中即停下挖穿'),
      target_depth: z.number().optional().describe('可选：目标脚层 y，下挖到该层停止。默认 55（矿藏常见层）'),
      max_depth: z.number().optional().describe('最大下挖步数，默认 48'),
      staircase: z.boolean().optional().describe('是否楼梯模式（默认 true）；false 则原地竖井直下（回不来，仅适合只下一趟就走的场景）'),
      need_count: z.number().optional().describe('楼梯模式：挖够 N 块圆石就停（与 target 互斥，用于攒建材；不触发"命中即停"）'),
      avoid_x: z.number().optional().describe('竖井要避开的 x 坐标（仅竖井模式用）'),
      avoid_z: z.number().optional().describe('竖井要避开的 z 坐标'),
    },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const target = args.target ? String(args.target) : null;
        const targetDepth = Number(args.target_depth ?? 55);
        const maxDepth = Number(args.max_depth ?? 48);
        const needCount = args.need_count !== undefined ? Number(args.need_count) : 0;
        const useStair = args.staircase !== false;

        if (useStair) {
          // 楼梯模式：need_count 与 target 互斥。
          //  need_count>0 → 边下挖边攒圆石，挖够就停（不触发侧向命中）；
          //  target    → 侧向命中目标矿即停（模式 B 找铁）。
          const r = await digStairDown(bot, targetDepth, {
            targetBlock: needCount > 0 ? undefined : (target ?? undefined),
            needCount: needCount,
            needItemName: needCount > 0 ? 'cobblestone' : undefined,
            maxSteps: maxDepth,
          });
          if (r.hitOre) {
            return ok(`楼梯下挖命中 ${r.hitOre.name}@(${r.hitOre.x},${r.hitOre.y},${r.hitOre.z})，共挖 ${r.dug} 格 / ${r.steps} 步`);
          }
          if (r.got !== undefined) {
            return r.reached
              ? ok(`楼梯下挖完成：挖 ${r.dug} 格 / ${r.steps} 步，攒到 ${r.got} 块圆石`)
              : fail(`楼梯未挖够圆石（${r.stopped}，已得 ${r.got}），挖 ${r.dug} 格`);
          }
          return r.reached
            ? ok(`楼梯下挖完成：挖 ${r.dug} 格 / ${r.steps} 步，到达目标层${target ? `（找 ${target}）` : ''}`)
            : fail(`楼梯未达标（${r.stopped}），已挖 ${r.dug} 格`);
        }

        // 竖井模式（保留）
        const avoidX = args.avoid_x !== undefined ? Number(args.avoid_x) : undefined;
        const avoidZ = args.avoid_z !== undefined ? Number(args.avoid_z) : undefined;
        const r = await digShaftDown(bot, targetDepth, { maxDepth, avoidX, avoidZ });
        return r.reached
          ? ok(`竖井挖完：下挖 ${r.dug} 格，到达目标层${target ? `（找 ${target}）` : ''}`)
          : fail(`竖井未达标（${r.stopped}），已挖 ${r.dug} 格`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 拾取掉落物
  mcp.registerTool(
    'pickup-item',
    '拾取附近掉落的物品（精确走过去碰到并捡）',
    { max_distance: z.number().optional().describe('最大距离，默认 48(3 区块)') },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const maxDist = Number(args.max_distance ?? 48);
        const isItem = (e: unknown): boolean => {
          const t = (e as { type?: string; kind?: string }).type ?? (e as { kind?: string }).kind ?? '';
          return t === 'object' || (e as { name?: string }).name === 'item';
        };
        const item = bot.nearestEntity((e) => isItem(e)) as { position?: { x: number; y: number; z: number }; id: number } | null;
        if (!item) return fail('附近没有掉落物');
        const myPos = bot.entity.position;
        const dist = Math.hypot(item.position!.x - myPos.x, item.position!.y - myPos.y, item.position!.z - myPos.z);
        if (dist > maxDist) return fail(`最近的掉落物在 ${Math.round(dist)} 格外，太远了`);

        // 智能拾取：自动走过去碰、高处垫脚、坑底绕行，通过物品是否消失判断是否真捡到。
        const tgt = item.position!;
        const picked = await pickupItemSmart(bot, tgt, 25000);
        if (!picked) return fail(`没能走到掉落物 (${tgt.x},${tgt.y},${tgt.z}) 捡起（可能卡在方块/坑底）`);
        return ok('已拾取掉落物');
      } catch (e) {
        return fail(String(e));
      }
    }
  );
}
