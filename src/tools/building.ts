import { z } from 'zod';
import type mineflayer from 'mineflayer';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { getBot, ok, fail, findItemInInventory, smartPlace } from './helpers';
import { v3, sleep } from '../utils';
import type { ActionExecutor } from '../actions/executor';


export interface BuildShelterSpec {
  blockType: string;
  sx: number; sy: number; sz: number;
  width?: number; depth?: number; height?: number;
}

/**
 * 纯 bot 级小屋建造核心（无 MCP 依赖，供 MCP 工具与 build_home 技能共用）。
 * 地板 → 四面墙 → 天花板，南面(z=sz+d-1)中间留 1x2 门洞。
 * 返回实际放置方块数；材料不足/参数非法 throw。
 */
export async function buildShelterCore(bot: mineflayer.Bot, spec: BuildShelterSpec): Promise<number> {
  const blockType = spec.blockType;
  const w = Math.min(spec.width ?? 5, 10);
  const d = Math.min(spec.depth ?? 5, 10);
  const h = Math.min(spec.height ?? 4, 7);
  if (h < 3) throw new Error('高度至少 3 格（地板 + 2 格墙 + 天花板）');
  if (!findItemInInventory(bot, blockType)) throw new Error(`背包里没有 ${blockType}，先备好材料`);

  const sx = Math.floor(spec.sx), sy = Math.floor(spec.sy), sz = Math.floor(spec.sz);
  const positions: Array<{ x: number; y: number; z: number }> = [];
  for (let dx = 0; dx < w; dx++) for (let dz = 0; dz < d; dz++) positions.push({ x: sx + dx, y: sy, z: sz + dz });
  for (let dy = 1; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      positions.push({ x: sx + dx, y: sy + dy, z: sz + d - 1 });
      positions.push({ x: sx + dx, y: sy + dy, z: sz });
    }
    for (let dz = 0; dz < d; dz++) {
      positions.push({ x: sx, y: sy + dy, z: sz + dz });
      positions.push({ x: sx + w - 1, y: sy + dy, z: sz + dz });
    }
  }
  for (let dx = 0; dx < w; dx++) for (let dz = 0; dz < d; dz++) positions.push({ x: sx + dx, y: sy + h, z: sz + dz });
  const doorX = sx + Math.floor(w / 2);
  const plan = positions.filter((p) => !(p.z === sz + d - 1 && p.y >= sy + 1 && p.y <= sy + 2 && p.x === doorX));

  // 逐块智能放置：每块自动就位到"看得到参考面 + 在 reach 内"，失败重试
  let placed = 0;
  for (const pos of plan) {
    const existing = bot.blockAt(v3(pos.x, pos.y, pos.z)) as unknown as { name?: string } | null;
    if (existing && existing.name !== 'air') continue;
    let done = false;
    for (let t = 0; t < 3 && !done; t++) {
      done = await smartPlace(bot, pos, blockType);
      if (done) { placed++; await sleep(50); } else await sleep(150);
    }
    if (placed >= 150) break;
  }
  return placed;
}

export function registerBuildingTools(mcp: McpServerManager, ctx: ToolContext, executor: ActionExecutor): void {
  // 放置方块（自动拿方块，自动就位到能看到目标面的位置；已收敛到 L3 ActionExecutor.place）
  mcp.registerTool(
    'place-block',
    '在指定坐标放置方块（自动从背包拿取；若看不到目标面或超出放置距离，自动移动就位后再放置）',
    { block_type: z.string().describe('要放置的方块类型名，如 oak_planks / cobblestone / dirt'), x: z.number(), y: z.number(), z: z.number() },
    async (args) => {
      const r = await executor.place({ block_type: String(args.block_type), x: Number(args.x), y: Number(args.y), z: Number(args.z) });
      return r.ok ? ok(r.message) : fail(r.message);
    }
  );

  // 简易庇护所（v2：创造模式飞行俯视放置 + 南面留门洞）
  mcp.registerTool(
    'build-shelter',
    '建造一个小屋（地板+四面墙+天花板，南面留 1x2 门洞）。创造模式自动飞到每个方块上方俯视放置（视线永远通畅、不会卡自己），生存模式只能放 reach 内的方块',
    {
      block_type: z.string().describe('建造用方块，如 oak_planks / cobblestone'),
      x: z.number().describe('起点 X'),
      y: z.number().describe('起点 Y（地板高度）'),
      z: z.number().describe('起点 Z'),
      width: z.number().optional().describe('宽，默认 5'),
      depth: z.number().optional().describe('深，默认 5'),
      height: z.number().optional().describe('高，默认 4'),
    },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const blockType = String(args.block_type);
        const sx = Number(args.x), sy = Number(args.y), sz = Number(args.z);
        const w = Math.min(Number(args.width ?? 5), 10);
        const d = Math.min(Number(args.depth ?? 5), 10);
        const h = Math.min(Number(args.height ?? 4), 7);
        const placed = await buildShelterCore(bot, { blockType, sx, sy, sz, width: w, depth: d, height: h });
        ctx.memory.pushTimeline(`建了一个 ${w}x${d}x${h} 的 ${blockType} 小屋（含门洞）`);
        ctx.emotion?.()?.react('built_house');
        ctx.memoryV2?.rememberEvent('我亲手盖了一间小屋', '满足', 6);
return ok(`庇护所搭建完成，放置 ${placed} 个 ${blockType}（南面留了 1x2 门洞）`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // ── 【通用·OP】/fill 批量填充 ──
  // 逐块 smartPlace 造大工程太慢（每块要飞行就位 + 视线校验，577 块的迷宫要几分钟）：
  // 有 OP 时直接用服务器 /fill，一条命令填一整块长方体，整座迷宫 40 条命令就完事。
  // 也可用于：快速铺地板、清场地、填水池。
  mcp.registerTool(
    'fill-region',
    '【需 OP】用服务器 /fill 批量填充方块区域：一次可传多块长方体，逐条发给服务器。适合快速造迷宫/铺地板/清场地（比逐块放置快百倍）',
    {
      regions: z.array(z.object({
        x1: z.number(), y1: z.number(), z1: z.number(),
        x2: z.number(), y2: z.number(), z2: z.number(),
        block: z.string(),
      })).describe('区域列表：[{x1,y1,z1,x2,y2,z2,block}]，最多 400 条；坐标可用任意对角'),
      gap_ms: z.number().optional().describe('两条命令间隔毫秒（默认 120，服务器卡可加大）'),
    },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const regions = (args.regions ?? []) as Array<{ x1: number; y1: number; z1: number; x2: number; y2: number; z2: number; block: string }>;
        if (!regions.length) return fail('regions 为空');
        if (regions.length > 400) return fail(`区域太多（${regions.length} 条），最多 400 条`);
        const gap = Math.min(1000, Math.max(60, Number(args.gap_ms ?? 120)));
        let sent = 0;
        for (const r of regions) {
          const x1 = Math.floor(r.x1), y1 = Math.floor(r.y1), z1 = Math.floor(r.z1);
          const x2 = Math.floor(r.x2), y2 = Math.floor(r.y2), z2 = Math.floor(r.z2);
          const vol = (Math.abs(x2 - x1) + 1) * (Math.abs(y2 - y1) + 1) * (Math.abs(z2 - z1) + 1);
          if (vol > 32768) {
            return fail(`区域 (${x1},${y1},${z1})→(${x2},${y2},${z2}) 体积 ${vol} 超过 /fill 上限 32768`);
          }
          const blk = String(r.block);
          if (!/^[a-z0-9_:\[\]=,.]+$/i.test(blk)) return fail(`方块名非法：${blk}`);
          bot.chat(`/fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${blk}`);
          sent += 1;
          await sleep(gap);
        }
        await sleep(500); // 等最后一条在服务器结算
        ctx.memory.pushTimeline(`/fill 批量填充 ${sent} 块区域`, [Math.floor(regions[0].x1), Math.floor(regions[0].y1), Math.floor(regions[0].z1)]);
        return ok(`已发送 ${sent} 条 /fill 命令（间隔 ${gap}ms）。若方块没变化，多半是 bot 没有 OP 或服务器禁用了 /fill`);
      } catch (e) {
        return fail(`批量填充失败：${String(e)}`);
      }
    }
  );
}
