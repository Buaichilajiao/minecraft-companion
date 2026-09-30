import { z } from 'zod';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { ok, fail } from './helpers';

export function registerGoalsTools(mcp: McpServerManager, ctx: ToolContext): void {
  // 看目标（set-goal 已移除：与 memory-write(type='goal') 同源重复，统一走 memory-write）
  mcp.registerTool(
    'get-goals',
    '查看当前目标、目标列表和发展进度（科技树）',
    {},
    async () => {
      try {
        const m = ctx.memory.data;
        return ok(JSON.stringify({
          current_goal: m.current_goal,
          goal_list: m.goals,
          tech_unlocked: m.tech_unlocked,
          last_activity: m.last_activity,
        }, null, 2));
      } catch (e) {
        return fail(String(e));
      }
    }
  );
}
