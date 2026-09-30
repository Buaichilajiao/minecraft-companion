import { z } from 'zod';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { getBot, ok, fail, findItemInInventory, withTimeout } from './helpers';
import { v3, sleep } from '../utils';
import { matchesBlockName } from '../blocknames';

// 修复：补生鱼 cod/salmon（bot 钓鱼常钓到，旧列表只有 cooked_*）；rotten_flesh 垫底（有饥饿风险，最后才吃）
const FOODS = ['bread', 'apple', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_cod', 'cooked_salmon', 'cod', 'salmon', 'golden_apple', 'baked_potato', 'cookie', 'melon_slice', 'sweet_berries', 'rotten_flesh'];

export function registerSurvivalTools(mcp: McpServerManager, ctx: ToolContext): void {
  // 进食
  mcp.registerTool(
    'eat',
    '吃背包里的食物恢复饱食度（自动挑选可用食物）',
    {},
    async () => {
      try {
        const bot = getBot(ctx);
        let food = null;
        for (const name of FOODS) {
          food = findItemInInventory(bot, name);
          if (food) break;
        }
        if (!food) {
          const anyFood = (bot.inventory.items() as unknown as Array<{ name: string; count: number }>).find((it) => it.name.includes('beef') || it.name.includes('pork') || it.name.includes('chicken') || it.name.includes('bread') || it.name.includes('apple'));
          if (!anyFood) return fail('背包里没有食物');
          food = { item: anyFood as never, count: anyFood.count };
        }
        await bot.equip(food.item as never, 'hand');
        await bot.activateItem();
        await sleep(2000);
        return ok('已吃东西，正在恢复饱食度');
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 睡觉
  mcp.registerTool(
    'sleep',
    '找到附近的床睡觉（夜晚过夜，天亮自动醒）',
    {},
    async () => {
      try {
        const bot = getBot(ctx);
        // 修复：findBlock 返回 Block（坐标在 .position），旧代码误用 bed.x/.y/.z（undefined），
        // 多余的 blockAt(NaN) 又得到 null。直接把 Block 交给 bot.sleep 即可
        const bed = bot.findBlock({ matching: (b) => matchesBlockName(String((b as unknown as { name?: string }).name ?? ''), 'bed'), maxDistance: 32 }) as never;
        if (!bed) return fail('附近 32 格内没有床');
        if (bot.isSleeping) {
          return ok('已经在睡觉了');
        }
        await bot.sleep(bed);
        ctx.memory.pushTimeline('睡觉了');
        return ok('已躺下睡觉，天亮或有人叫我就会醒');
      } catch (e) {
        return fail(String(e));
      }
    }
  );
}
