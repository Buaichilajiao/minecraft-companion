import { z } from 'zod';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { ok, fail } from './helpers';

export function registerCrossMemoryTools(mcp: McpServerManager, ctx: ToolContext): void {
  const cm = () => ctx.crossMemory;

  // 写跨端记忆
  mcp.registerTool(
    'cross-memory-write',
    '写一条跨端记忆（QQ↔游戏共享）：在 QQ 里认识玩家、记住其称呼/偏好/约定，或游戏里发生值得记住的事时调用。写入后无论在 QQ 还是游戏都能想起，不会再失忆。',
    {
      person: z.string().describe('人物标识：玩家的 QQ 号优先；不知道就填玩家名'),
      content: z.string().describe('要记住的内容，一句话，如"玩家叫辣椒，喜欢在山顶盖石头房子"'),
      source: z.enum(['qq', 'game']).describe('写入来源：你在 QQ 侧就填 qq，在游戏里就填 game'),
      display_name: z.string().optional().describe('玩家的称呼（可选）'),
      mc_name: z.string().optional().describe('玩家的 Minecraft 角色名（可选，便于两端互认）'),
    },
    async (args) => {
      try {
        const person = String(args.person).trim();
        const content = String(args.content).trim();
        const source = args.source === 'game' ? 'game' : 'qq';
        if (!person || !content) return fail('person 和 content 不能为空');
        cm().write(person, content, source, {
          display_name: args.display_name ? String(args.display_name) : undefined,
          mc_name: args.mc_name ? String(args.mc_name) : undefined,
        });
        return ok(`已写入跨端记忆（${person}）：${content}`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 读跨端记忆
  mcp.registerTool(
    'cross-memory-read',
    '读取某人的跨端记忆（QQ↔游戏共享的共同经历）。进游戏或在 QQ 想不起玩家时先读，恢复你们在另一端的经历。',
    {
      person: z.string().describe('人物标识：玩家 QQ 号优先；不知道就填玩家名'),
    },
    async (args) => {
      try {
        const person = String(args.person).trim();
        const p = cm().read(person);
        if (!p) return ok(`没有关于 ${person} 的跨端记忆（可能是第一次接触，或还没在另一端记录过）`);
        const out = {
          person,
          display_name: p.display_name ?? null,
          mc_names: p.mc_names,
          facts: p.facts.map((f) => ({
            text: f.text,
            source: f.source,
            time: new Date(f.t).toLocaleString('zh-CN'),
          })),
        };
        return ok(JSON.stringify(out, null, 2));
      } catch (e) {
        return fail(String(e));
      }
    }
  );
}
