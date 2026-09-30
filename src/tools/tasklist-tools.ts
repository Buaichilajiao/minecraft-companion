import { z } from 'zod';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { ok, fail } from './helpers';
import { createTask, readTask, listTasks, updateTask, advanceTask } from '../tasklist';

/**
 * 长期任务表工具（mc-task-flow SKILL 落地，v26）
 * ─────────────────────────────────────────────────────────────
 * 之前的断裂点：SKILL 要求大脑「用文件读写工具」建 data/tasklist/*.json，
 * 但 AstrBot 侧 computer 工具（shell/fs/python）已关闭，大脑只能调 Minecraft MCP 工具，
 * 导致长期任务永远无法真正落盘。这里把任务表 CRUD 暴露成 4 个 MCP 工具，兑现 SKILL 承诺。
 */
export function registerTasklistTools(mcp: McpServerManager, _ctx: ToolContext): void {
  // 创建任务表
  mcp.registerTool(
    'tasklist-create',
    '【长期任务流】创建一张任务表（落盘到 data/tasklist/<id>.json）。用于玩家下达无法用单个工具立刻完成的长期任务（如"通关 MC 打败末影龙""建一座城堡"）。建表后按 current_step 逐个调用该步 tools 里的工具，配合 tasklist-step 标记进度。id 用英文小写+连字符。',
    {
      id: z.string().describe('任务唯一标识，英文小写+连字符，如 kill-ender-dragon'),
      title: z.string().describe('任务名（人类可读，中文即可）'),
      steps: z.array(
        z.object({
          desc: z.string().describe('这一步做什么'),
          tools: z.array(z.string()).optional().describe('这一步要调用的工具名（skill-* 或基础工具），按顺序调用'),
          completion: z.object({
            item: z.object({ item: z.string(), count: z.number() }).optional().describe('背包里至少 count 个名为 item 的物品即算完成'),
            any_item: z.object({ count: z.number() }).optional().describe('背包物品总数量达到 count 即算完成'),
            near_block: z.string().optional().describe('附近出现该方块即算完成'),
            no_hostile: z.boolean().optional().describe('周围无敌对生物即算完成'),
          }).optional().describe('可选：自动完成条件。填了系统会自动检测并推进该步，无需手动调 tasklist-step'),
        })
      ).describe('步骤列表（按执行顺序）'),
    },
    async (args) => {
      try {
        const steps = args.steps as Array<{ desc: string; tools?: string[]; completion?: any }>;
        if (!steps || steps.length === 0) return fail('steps 不能为空，至少一个步骤');
        const t = createTask({ id: String(args.id), title: String(args.title), steps });
        if (!t) return fail(`任务 ${args.id} 已存在，用 tasklist-get 查看或 tasklist-set 修改`);
        return ok(`已创建任务表 "${t.title}"（id=${t.id}，共 ${t.steps.length} 步，状态 pending）\n开始执行：把 status 置 running 后，从第 1 步逐个调 tools 里的工具，每步完成用 tasklist-step 标记。`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 查看任务表
  mcp.registerTool(
    'tasklist-get',
    '【长期任务流】查看某张任务表的完整内容（title/status/current_step 及各步骤 desc+done 状态）。执行长期任务前先读它，知道现在到第几步、下一步做什么。',
    { id: z.string().describe('任务 id') },
    async (args) => {
      try {
        const t = readTask(String(args.id));
        if (!t) return fail(`任务 ${args.id} 不存在`);
        return ok(JSON.stringify(t, null, 2));
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 列出全部任务表
  mcp.registerTool(
    'tasklist-list',
    '【长期任务流】列出全部任务表（含已暂停/已完成），按最近更新排序。概览当前有哪些长期任务在推进。',
    {},
    async () => {
      try {
        const list = listTasks();
        if (list.length === 0) return ok('当前没有任何任务表');
        const lines = list.map((t) => {
          const total = t.steps.length;
          const done = t.steps.filter((s) => s.done).length;
          return `- [${t.status}] ${t.title}（id=${t.id}，进度 ${done}/${total} 步）`;
        });
        return ok(lines.join('\n'));
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 更新任务表（状态/标题等）
  mcp.registerTool(
    'tasklist-set',
    '【长期任务流】修改任务表字段：切换状态（pending/running/paused/done）、改标题等。开始执行置 running，被打断置 paused，完成置 done。current_step 一般用 tasklist-step 推进，不要手动设。',
    {
      id: z.string().describe('任务 id'),
      status: z.enum(['pending', 'running', 'paused', 'done']).optional().describe('要改成的状态'),
      title: z.string().optional().describe('新标题'),
    },
    async (args) => {
      try {
        const patch: Record<string, unknown> = {};
        if (args.status) patch.status = args.status;
        if (args.title) patch.title = args.title;
        if (Object.keys(patch).length === 0) return fail('至少给一个要修改的字段（status 或 title）');
        const t = updateTask(String(args.id), patch as never);
        if (!t) return fail(`任务 ${args.id} 不存在`);
        return ok(`已更新 "${t.title}"：status=${t.status}`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 标记某步完成 + 推进
  mcp.registerTool(
    'tasklist-step',
    '【长期任务流】标记某一步完成并自动推进 current_step（到第一个未完成步；全部完成则状态自动置 done）。每次做完一个步骤就调它一次，任务流才能继续往前走。step_index 从 0 起。',
    { id: z.string().describe('任务 id'), step_index: z.number().describe('刚完成的步骤下标（0 起）') },
    async (args) => {
      try {
        const idx = Number(args.step_index);
        const t = advanceTask(String(args.id), idx);
        if (!t) return fail(`任务 ${args.id} 不存在`);
        const total = t.steps.length;
        if (t.status === 'done') {
          return ok(`任务 "${t.title}" 全部完成 ✅（${total}/${total} 步）`);
        }
        const next = t.steps[t.current_step];
        return ok(`步骤 ${idx + 1}/${total} 完成。下一步（第 ${t.current_step + 1} 步）：${next?.desc ?? '（无）'}${next?.tools?.length ? `，调用工具：${next.tools.join('、')}` : ''}`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );
}