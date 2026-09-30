import { z } from 'zod';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { getBot, ok, fail } from './helpers';
import type { ActionExecutor } from '../actions/executor';

/**
 * 战斗类工具。
 * 原子动作「攻击实体」已收敛到 L3 ActionExecutor.attack（ARCHITECTURE.md Phase 1），
 * 本文件只做薄声明 + 保留约定 PVP 入口（需 guardian）。
 */
export function registerCombatTools(mcp: McpServerManager, ctx: ToolContext, executor: ActionExecutor): void {
  mcp.registerTool(
    'attack-entity',
    '攻击指定实体；不传 entity_type 时默认攻击最近的敌对生物（僵尸/骷髅/苦力怕等）。距离超过 3 格会自动先走过去再攻击',
    {
      entity_type: z.string().optional().describe('实体类型或玩家名，如 zombie / cow / 玩家名；留空 = 攻击最近的敌对生物'),
      max_distance: z.number().optional().describe('搜索最大距离，默认 48(3 区块)'),
    },
    async (args) => {
      const r = await executor.attack({
        entity_type: args.entity_type as string | undefined,
        max_distance: args.max_distance as number | undefined,
      });
      return r.ok ? ok(r.message) : fail(r.message);
    }
  );

  // ── 约定 PVP 入口（陪伴定位：大脑看到玩家明确想切磋才调；非约定绝不主动打玩家）──
  mcp.registerTool(
    'pvp-start',
    '玩家明确提出切磋/PVP（如"来PVP/打一架/切磋"）且你同意后调用：进入约定 PVP（点到为止，任一方血量≤4 自动停，60s 无攻击自动退）。调用后你会跟该玩家对打',
    {
      player: z.string().optional().describe('要切磋的玩家名，默认最近的在附近玩家'),
    },
    async (args) => {
      try {
        const g = ctx.guardian?.() ?? null;
        if (!g) return fail('守护层未就绪');
        const bot = getBot(ctx);
        const want = args.player ? String(args.player) : '';
        let name = want;
        if (!name) {
          const me = bot.username;
          const near = Object.values(bot.players).find((p) => p.username !== me && p.entity);
          name = near?.username ?? '';
        }
        if (!name) return fail('附近没有可切磋的玩家');
        const r = g.startAgreedPvp(name);
        return r.ok ? ok(`已和 ${name} 进入切磋（点到为止）`) : fail(r.msg ?? '无法开始');
      } catch (e) {
        return fail(String(e));
      }
    }
  );
  mcp.registerTool(
    'pvp-stop',
    '主动结束当前约定 PVP（玩家说"不打了/停/认输"，或你觉得该收手时调用）',
    {},
    async () => {
      try {
        const g = ctx.guardian?.() ?? null;
        if (!g) return fail('守护层未就绪');
        g.stopAgreedPvp();
        return ok('已结束切磋');
      } catch (e) {
        return fail(String(e));
      }
    }
  );
}
