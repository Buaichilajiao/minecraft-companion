import { z } from 'zod';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { getBot, ok, fail } from './helpers';
import { crosshairCast, checkReach } from '../crosshair';

/**
 * 仿客户端准星工具组
 * ────────────────────────────────────────────────────
 * crosshair  ：查「现在准星指到哪」——沿视线方向第一个碰到的方块/实体 + 距离 + 能否交互。
 * check-reach ：给定方块坐标（或实体），判断从当前位置能否够得着、视线通不通，
 *               动作（放置/挖掘/交互/攻击）前先问它，别盲目走位。
 */
export function registerCrosshairTools(mcp: McpServerManager, ctx: ToolContext): void {
  mcp.registerTool(
    'crosshair',
    '仿客户端准星：检测当前视线方向准星指向的方块/实体，并判断是否在交互/攻击距离内（生存：方块4.5格/攻击3格；创造：5格）。做放置/破坏/交互/攻击前先调它，确认面前是什么、够不够得着、视线是否被挡',
    {
      max_distance: z.number().optional().describe('准星检测最大距离，默认 6 格'),
    },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const maxDist = Number(args.max_distance ?? 6);
        const r = await crosshairCast(bot, maxDist);
        const lines: string[] = [
          `准星检测（${r.gameMode} 模式｜方块交互 ${r.reach.block} 格 / 攻击 ${r.reach.entity} 格）：`,
        ];
        if (!r.hit) {
          lines.push(`  ${r.note}`);
          return ok(lines.join('\n'));
        }
        if (r.hit.kind === 'block') {
          const b = r.hit.block;
          lines.push(`  🧱 命中方块 ${b.name} @ (${b.x}, ${b.y}, ${b.z})，距离 ${r.hit.distance.toFixed(2)} 格`);
        } else {
          const e = r.hit.entity;
          lines.push(`  👾 命中实体 ${e.name}(${e.type}) @ (${e.x.toFixed(1)}, ${e.y.toFixed(1)}, ${e.z.toFixed(1)})，距离 ${r.hit.distance.toFixed(2)} 格`);
        }
        lines.push(`  ${r.reachable ? '✅ 可交互' : '❌ ' + r.note}`);
        return ok(lines.join('\n'));
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  mcp.registerTool(
    'check-reach',
    '判断给定目标从当前位置能否合理交互（距离是否在交互/攻击范围内 + 视线是否被挡）。放方块/挖方块/交互/攻击前用它预检，不可达会给出还差多少格、被什么挡',
    {
      x: z.number().describe('目标方块 X（整数格）'),
      y: z.number().describe('目标方块 Y（整数格）'),
      z: z.number().describe('目标方块 Z（整数格）'),
      kind: z.enum(['block', 'entity']).optional().describe('目标类型：block=方块(默认) / entity=实体'),
    },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const kind = (args.kind as 'block' | 'entity') ?? 'block';
        const r = await checkReach(bot, { x: Number(args.x), y: Number(args.y), z: Number(args.z) }, kind);
        const lines: string[] = [
          `${kind === 'block' ? '方块' : '实体'}目标 @ (${r.target.x}, ${r.target.y}, ${r.target.z})：`,
          `  距离 ${r.distance.toFixed(1)} 格（${kind === 'block' ? '方块交互' : '攻击'}上限 ${r.reach} 格）`,
          `  视线：${r.lineOfSight ? '通畅' : '被 ' + (r.blockedBy ?? '?') + ' 挡住'}`,
          `  ${r.reachable ? '✅ 可交互' : '❌ ' + r.note}`,
        ];
        return ok(lines.join('\n'));
      } catch (e) {
        return fail(String(e));
      }
    }
  );
}
