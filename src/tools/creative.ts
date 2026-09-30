import { z } from 'zod';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { getBot, ok, fail, withTimeout } from './helpers';
import { sleep } from '../utils';

/** prismarine-item 类（延迟加载，配合 bot.registry） */
function getItemClass(bot: { registry: unknown }): new (id: number, count: number, metadata?: number) => unknown {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Item = require('prismarine-item')(bot.registry);
  return Item;
}

/**
 * 创造模式工具：不依赖 /give 权限，通过 set_creative_slot 协议包
 * 直接把任意物品放入背包槽位（mineflayer 自带 bot.creative.setInventorySlot）。
 */
export function registerCreativeTools(mcp: McpServerManager, ctx: ToolContext): void {
  mcp.registerTool(
    'creative-give',
    '【创造模式】给自己发放指定物品到背包（如 oak_planks/diamond/cobblestone/iron_ingot），自动找空槽，无需 /give 权限',
    { item_name: z.string().describe('物品名，如 oak_planks / diamond / cobblestone'), count: z.number().optional().describe('数量，默认 64，最大 640') },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const mode = ctx.status().world.game_mode;
        if (mode !== 'creative') return fail(`当前是 ${mode} 模式，需要创造模式才能用此工具`);
        const name = String(args.item_name);
        const count = Math.min(Number(args.count ?? 64), 640);
        const registry = (bot as unknown as { registry?: { itemsByName?: Record<string, { id: number; stackSize?: number }> } }).registry;
        const itemDef = registry?.itemsByName?.[name];
        if (!itemDef) return fail(`未知物品: ${name}`);
        const Item = getItemClass(bot as unknown as { registry: unknown });
        const perStack = itemDef.stackSize ?? 64;
        let remaining = count;
        let placedSlots = 0;
        // 从主背包起始槽 9 开始发放（快捷栏 0-8 部分服务器/插件会保护/占用，覆盖会被拒）
        const START_SLOT = 9;
        for (let slot = START_SLOT; slot < 45 && remaining > 0; slot++) {
          if (bot.inventory.slots[slot]) continue; // 跳过非空槽（简化：不合并已有堆）
          const n = Math.min(remaining, perStack);
          await withTimeout(
            bot.creative.setInventorySlot(slot, new Item(itemDef.id, n) as never),
            8000,
            '发放物品'
          );
          // 逐槽复查：服务器若拒绝该槽（延迟清空），回退数量并继续试下一个槽
          await sleep(400);
          const cur = bot.inventory.slots[slot] as { name?: string } | null | undefined;
          if (!cur || cur.name !== name) {
            continue; // 该槽被服务器拒，计数未扣，下一槽重试
          }
          remaining -= n;
          placedSlots++;
        }
        if (placedSlots === 0) return fail(`发放失败：服务器拒绝了所有尝试的槽位（快捷栏受保护？）`);
        ctx.memory.pushTimeline(`创造模式发放 ${name} x${count}`);
        // 复查：1.21+ 服务器若拒绝会静默覆盖槽位，等待后核对实际背包
        await sleep(800);
        const after = bot.inventory.items().map((i) => `${i.name}x${i.count}`).join(', ');
        const okFlag = bot.inventory.items().some((i) => i.name === name);
        return ok(`已在创造模式发放 ${name} x${count}（占 ${placedSlots} 格）${okFlag ? `，已确认在背包: ${after}` : `，⚠️ 但复查背包为空（${after || '无物品'}）——服务器可能拒绝`}`);
      } catch (e) {
        return fail(`发放失败（服务器可能拒绝）: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );

  // ── 管理员命令工具（bot 为 OP）：测试搭建 / 运维自动化用。描述明确限定，大脑不主动滥用 ──
  mcp.registerTool(
    'run-command',
    '【管理员工具】以 OP 身份执行一条原版服务器命令（不要带开头斜杠），如「give XiaoBai_bot wheat_seeds 16」「time set day」「summon cow ~ ~ ~」「setblock ~ ~-1 ~ water」。仅在明确需要管理/搭建操作时使用，不要用于普通聊天或动作',
    { command: z.string().describe('一条服务器命令，不含 /') },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const cmd = String(args.command).replace(/^\s*\/+/, '').trim();
        if (!cmd) return fail('空命令');
        bot.chat('/' + cmd);
        await sleep(700);
        return ok(`已执行: /${cmd}`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );
}
