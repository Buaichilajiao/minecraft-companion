import { z } from 'zod';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { ok, fail } from './helpers';

export function registerMemoryTools(mcp: McpServerManager, ctx: ToolContext): void {
  // 读记忆
  mcp.registerTool(
    'memory-read',
    '读取记忆：身份、玩家偏好、发展进度、科技树、最近事件、共同回忆',
    {},
    async () => {
      try {
        const m = ctx.memory.data;
        const summary = {
          identity: m.identity,
          player_prefs: m.player_prefs,
          current_goal: m.current_goal,
          goals: m.goals,
          tech_unlocked: m.tech_unlocked,
          stats: m.stats,
          last_activity: m.last_activity,
          recent_events: m.timeline.slice(-10).map((e) => ({ t: new Date(e.t).toLocaleString('zh-CN'), event: e.event })),
          shared_memories: m.relationship.shared_memories.slice(-10),
        };
        return ok(JSON.stringify(summary, null, 2));
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 写记忆
  mcp.registerTool(
    'memory-write',
    '写一条记忆：记录事件（加入时间线）或记住玩家偏好（如 "Steve 喜欢石头房子"）',
    {
      type: z.enum(['event', 'pref', 'goal']).describe('event=记事件 / pref=记玩家偏好 / goal=设当前目标'),
      content: z.string().describe('内容'),
      key: z.string().optional().describe('pref 类型时的键，如 玩家名'),
    },
    async (args) => {
      try {
        const type = String(args.type);
        const content = String(args.content);
        if (type === 'event') {
          ctx.memory.pushTimeline(content);
        } else if (type === 'pref') {
          const key = String(args.key ?? '玩家');
          ctx.memory.setPref(key, content);
          ctx.memory.addSharedMemory(content);
        } else if (type === 'goal') {
          ctx.memory.setGoal(content);
        }
        ctx.memory.save();
        return ok(`已记录: ${content}`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );
}
