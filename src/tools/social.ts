import { z } from 'zod';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { getBot, ok, fail, chatSegmented } from './helpers';

export function registerSocialTools(mcp: McpServerManager, ctx: ToolContext): void {
  // 发聊天
  mcp.registerTool(
    'send-chat',
    '在游戏聊天框发送消息（对玩家说话）',
    { message: z.string().describe('要发送的消息内容') },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const msg = String(args.message);
        await chatSegmented(bot, msg);
        return ok(`已发送: ${msg.slice(0, 200)}${msg.length > 200 ? '…' : ''}`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 读聊天
  mcp.registerTool(
    'read-chat',
    '读取最近的游戏聊天记录（其他玩家说了什么）',
    { limit: z.number().optional().describe('读取条数，默认 10') },
    async (args) => {
      try {
        const limit = Math.min(Number(args.limit ?? 10), 20);
        const history = ctx.chatHistory();
        if (history.length === 0) return ok('最近没有聊天记录');
        const lines = history.slice(-limit).map((h) => {
          const t = new Date(h.t);
          return `[${t.getHours().toString().padStart(2, '0')}:${t.getMinutes().toString().padStart(2, '0')}] ${h.username}: ${h.message}`;
        });
        return ok(`最近聊天:\n${lines.join('\n')}`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );
}
