import { z } from 'zod';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { getBot, ok, fail, withTimeout } from './helpers';
import { v3 } from '../utils';
import { matchesBlockName, humanBlockName } from '../blocknames';

export function registerPerceptionTools(mcp: McpServerManager, ctx: ToolContext): void {
  // 完整状态
  mcp.registerTool(
    'get-state',
    '获取 bot 当前完整状态：世界类型(超平坦/普通)、模式、时间、天气、在线玩家、自身血量/饱食/背包/装备/buff、周围方块与实体（实体含实际坐标 x/y/z）、发展进度。玩家让你看向他/去找他时：直接读 nearby_entities 里该玩家名字对应的 x,y,z，再调 look-at 或 move-to 即可。查背包明细看 self.inventory，找单个物品用 find-item',
    {},
    async () => {
      try {
        return ok(JSON.stringify(ctx.status(), null, 2));
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 找方块
  mcp.registerTool(
    'find-blocks',
    '查找附近指定类型的方块（如 oak_log、iron_ore、crafting_table、chest、furnace、bed、wool——bed/wool 等颜色系会通配任意颜色，返回带实际方块名及坐标）',
    { block_type: z.string().describe('方块类型名，如 oak_log / iron_ore / chest / bed（bed 自动匹配红床/白床等任意颜色）'), max_distance: z.number().optional().describe('最大搜索距离，默认 48(3 区块)') },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const query = String(args.block_type);
        const maxDist = Number(args.max_distance ?? 48);
        const hits = bot.findBlocks({
          matching: (block) => matchesBlockName(String((block as unknown as { name?: string }).name ?? ''), query),
          maxDistance: Math.max(1, Math.floor(maxDist)),
          count: 8,
        }) as unknown as Array<{ x: number; y: number; z: number }> | null;
        if (!hits || hits.length === 0) return ok(`在 ${maxDist} 格内没有找到 ${query}`);
        const out = hits.slice(0, 5).map((pt) => {
          const b = bot.blockAt(v3(pt.x, pt.y, pt.z)) as unknown as { name?: string } | null;
          const nm = b?.name ?? query;
          const h = humanBlockName(nm);
          return `${nm}${h !== nm ? `(${h})` : ''}@(${pt.x}, ${pt.y}, ${pt.z})`;
        });
        return ok(`找到 ${hits.length} 个 ${query}: ${out.join('; ')}`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 找实体
  mcp.registerTool(
    'find-entity',
    '查找最近的指定类型实体（如 zombie、cow、sheep、villager、player），返回名字、距离、实际坐标、是否敌对。要看向玩家/实体时，用返回的坐标调 look-at（看向 y+1 表示其头部/躯干）',
    { entity_type: z.string().optional().describe('实体类型名，如 zombie / cow / player，留空找最近的敌对生物') },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const name = String(args.entity_type ?? '').toLowerCase();
        const entity = bot.nearestEntity((e) => {
          const en = ((e as unknown as { name?: string }).name ?? '').toLowerCase();
          if (name === 'player') return ((e as unknown as { type?: string }).type ?? '') === 'player';
          if (name) return en === name;
          const hostile = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch'].includes(en);
          return hostile;
        }) as unknown as { name?: string; type?: string; position?: { x: number; y: number; z: number } } | null;
        if (!entity) return ok('附近没有找到目标实体');
        const pos = ctx.status().self.position;
        const ep = entity.position as unknown as { x: number; y: number; z: number };
        const dist = Math.round(Math.hypot(ep.x - pos[0], ep.y - pos[1], ep.z - pos[2]));
        return ok(`找到 ${entity.name ?? entity.type}，距离 ${dist} 格，位置 @(${Math.round(ep.x)}, ${Math.round(ep.y)}, ${Math.round(ep.z)})`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 方块信息
  mcp.registerTool(
    'get-block-info',
    '获取指定坐标方块的信息（类型名、可站立、是否空气）',
    { x: z.number(), y: z.number(), z: z.number() },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const b = bot.blockAt(v3(Number(args.x), Number(args.y), Number(args.z))) as unknown as {
          name?: string; bounding?: string; boundingBox?: string;
          getProperties?: () => Record<string, unknown>;
        } | null;
        if (!b) return ok(`(${args.x}, ${args.y}, ${args.z}) 无法读取`);
        const nm = b.name ?? 'unknown';
        const h = humanBlockName(nm);
        let extra = '';
        if (b.boundingBox) extra += ` boundingBox=${b.boundingBox}`;
        try {
          const props = b.getProperties?.();
          if (props && Object.keys(props).length) extra += ` props=${JSON.stringify(props)}`;
        } catch { /* ignore */ }
        return ok(`(${args.x}, ${args.y}, ${args.z}) = ${nm}${h !== nm ? ` (${h})` : ''}${b.bounding === 'solid' ? ' (实体方块)' : ''}${extra}`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );
}
