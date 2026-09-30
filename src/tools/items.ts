import { z } from 'zod';
import { goals } from '@nxg-org/mineflayer-pathfinder';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { getBot, ok, fail, findItemInInventory, withTimeout, gotoSmart, smeltBatch, equipByName, smartPlace } from './helpers';
import { v3, log, sleep } from '../utils';

type AnyWindow = {
  close: () => Promise<void>;
  putSlotItem: (slot: number, item: unknown, count?: number) => Promise<void>;
  deposit: (item: unknown, metadata: unknown, count: number) => Promise<void>;
  withdraw: (item: unknown, metadata: unknown, count: number) => Promise<void>;
  containerItems: () => unknown[];
};

async function walkTo(bot: ReturnType<typeof getBot>, pos: { x: number; y: number; z: number }): Promise<void> {
  await gotoSmart(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 2), 30000, '走路');
}

export function registerItemsTools(mcp: McpServerManager, ctx: ToolContext): void {
  // 注：背包全量查询已并入 get-state（self.inventory），不再单独注册 list-inventory，避免重复。
  // 找单个物品用 find-item（技能层也在用）。
  // 找物品
  mcp.registerTool(
    'find-item',
    '在背包里查找指定物品',
    { item_name: z.string() },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const found = findItemInInventory(bot, String(args.item_name));
        if (!found) return ok(`背包里没有 ${args.item_name}`);
        return ok(`背包里有 ${args.item_name} x${found.count}`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 装备物品（从 building.ts 迁入：归入物品组）
  mcp.registerTool(
    'equip-item',
    '把背包中的指定物品装备到主手',
    { item_name: z.string().describe('物品名，如 iron_pickaxe / oak_planks') },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const name = String(args.item_name);
        await equipByName(bot, name);
        return ok(`已装备 ${name} 到主手`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 合成
  mcp.registerTool(
    'craft-item',
    '合成物品（如 oak_planks、stick、crafting_table、torch、iron_ingot 的合成）',
    { item_name: z.string().describe('要合成的物品名'), count: z.number().optional().describe('数量，默认 1') },
    async (args) => {
      const doCraft = async () => {
      try {
        const bot = getBot(ctx);
        const name = String(args.item_name);
        const count = Math.min(Number(args.count ?? 1), 64);
        // 1.21+ registry.recipes 键是数字 id（非物品名），名字需先转 id 才能查到配方
        const reg = (bot as never as { registry?: { itemsByName?: Record<string, { id: number }> } }).registry;
        const itemId = reg?.itemsByName?.[name]?.id;
        if (itemId == null) return fail(`不认识物品名 ${name}（registry.itemsByName 无此项）`);
        // mineflayer 会过滤 requiresTable 且未传工作台的配方 → 无台查不到时,须带工作台重查
        const recipesNoTable = bot.recipesFor(itemId as never, null, null, null) as unknown as Array<{ requiresTable?: boolean }>;
        let recipe = recipesNoTable?.find((r) => !r.requiresTable) ?? null;
        let table: unknown = null;
        if (!recipe) {
          let tbBlock = bot.findBlock({ matching: (b: { name: string }) => b.name === 'crafting_table', maxDistance: 24 }) as unknown as { position?: { x: number; y: number; z: number } } | null;
          // 增强：附近没有工作台，但背包有 → 自动放置到脚边（修复 setup-base 合成木镐/木斧失败，
          // 以及任何技能链中"合成了工作台却没放置"的情形）
          if (!tbBlock || !tbBlock.position) {
            const tableItem = findItemInInventory(bot, 'crafting_table');
            if (tableItem) {
              // 用健壮的 smartPlace 放置工作台：自动找参考面、就位点、移动并放置，
              // 避开 dirt_path/farmland（不完整方块）与悬空位置（旧 placeBlock 会静默失败）。
              const my = bot.entity.position;
              const bx = Math.floor(my.x), by = Math.floor(my.y), bz = Math.floor(my.z);
              const offsets: Array<[number, number, number]> = [
                [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
                [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
                [2, 0, 0], [-2, 0, 0], [0, 0, 2], [0, 0, -2],
                [0, 1, 0],
              ];
              for (const [dx, dy, dz] of offsets) {
                const tp = { x: bx + dx, y: by + dy, z: bz + dz };
                const tgtBlk = bot.blockAt(v3(tp.x, tp.y, tp.z));
                if (!tgtBlk || tgtBlk.name !== 'air') continue;
                const placed = await smartPlace(bot, tp, 'crafting_table');
                if (placed) {
                  tbBlock = bot.findBlock({ matching: (b: { name: string }) => b.name === 'crafting_table', maxDistance: 16 }) as typeof tbBlock;
                  if (tbBlock) break;
                }
              }
            }
          }
          if (!tbBlock || !tbBlock.position) return fail(`${name} 需要工作台：附近 24 格没有 crafting_table，背包也没有，先合成/放置一个再试`);
          const tb = tbBlock.position;
          // 贴脸（≤4 格）就跳过寻路——新版 pathfinder 对近距离目标会空转误报"卡住"
          const distToTable = bot.entity.position.distanceTo(v3(tb.x, tb.y, tb.z));
          if (distToTable > 4) {
            await gotoSmart(bot, new goals.GoalNear(tb.x, tb.y, tb.z, 2), 20000, '走向工作台');
          }
          // findBlock 返回对象本身即 Block；1.21.1 下 blockAt 二次查询可能返回 null，别用
          const recipesT = bot.recipesFor(itemId as never, null, null, tbBlock as never) as unknown as Array<{ requiresTable?: boolean }>;
          if (!recipesT || recipesT.length === 0) return fail(`没有 ${name} 的可用配方（可能缺材料）`);
          recipe = recipesT[0];
          table = tbBlock;
        }
        // count 语义 = 最终想要的物品数量；bot.craft 第 2 参是"合成次数"。
        // 精确计算材料能支持的最大合成次数（recipe.delta 记录每种材料的净消耗），
        // 再用一次 craft(recipe, n) 批量合成：材料一定够（不会中途 missing ingredient），
        // 且比逐次 craft(recipe,1) 反复操作背包窗口稳定得多（连续无台 craft 时序极易错乱）。
        const recipeFull = recipe as never as { result?: { count?: number }; delta?: Array<{ id: number; count: number; metadata?: number | null }> };
        const perCraft = recipeFull.result?.count ?? 1;
        const wantTimes = Math.max(1, Math.ceil(count / perCraft));
        let maxCraft = Infinity;
        for (const d of (recipeFull.delta ?? [])) {
          if (d.count < 0) {
            const have = bot.inventory.count(d.id as never, (d.metadata ?? null) as never);
            maxCraft = Math.min(maxCraft, Math.floor(have / -d.count));
          }
        }
        if (!isFinite(maxCraft)) maxCraft = 1;
        const craftTimes = Math.min(wantTimes, maxCraft);
        const craftFn = (bot as never as { craft: (r: unknown, c: number, t: unknown) => Promise<void> }).craft;
        if (craftTimes <= 0) {
          const need = (recipeFull.delta ?? []).filter(d => d.count < 0).map(d => `${(bot.registry as never as { items?: Array<{ name: string }> }).items?.[d.id]?.name ?? d.id} x${-d.count}`).join('、');
          return fail(`没有 ${name} 的材料（需要：${need}）`);
        }
        log('INFO', `合成 ${name}：想要 ${wantTimes} 次，材料支持 ${maxCraft} 次 → 执行 ${craftTimes} 次`);
        await craftFn.call(bot, recipe as never, craftTimes, table);
        const made = craftTimes * perCraft;
        const note = made < count ? `（要求 ${count}，材料不足只做了 ${made}）` : `（要求 ${count}）`;
        ctx.memory.pushTimeline(`合成了 ${name} x${made}`);
        return ok(`合成了 ${name} x${made}${note}`);
      } catch (e) {
        const emsg = String(e instanceof Error ? e.message : e);
        // 窗口状态类抛给外层重连；其余（缺料/找不到物品）转成失败结果
        if (/did not fire|timeout|Event updateSlot|Event window|Server didn't respond/i.test(emsg)) throw e;
        return fail(emsg);
      }
      };
      let lastErr = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await doCraft();
        } catch (e) {
          const emsg = String(e instanceof Error ? e.message : e);
          lastErr = emsg;
          if (ctx.reconnect) {
            // 窗口状态卡死：重连后重试整个合成（重连后工作台/材料在服务器仍保留）
            log('INFO', `合成遇到窗口状态问题（${emsg.slice(0, 60)}），重连后重试 ${attempt + 1}/3`);
            await ctx.reconnect();
            await sleep(1500);
            continue;
          }
          return fail(emsg);
        }
      }
      return fail(`合成失败（重连重试 3 次仍未恢复）：${lastErr}`);
    }
  );

  // 熔炼并取回（等出炉后自动收回背包；smelt-item 已移除：它只投料不取成品，被 smelt-batch 完整覆盖）
  mcp.registerTool(
    'smelt-batch',
    '熔炼并取回：把原料放入附近熔炉，等到成品出炉自动收回背包（如 raw_iron/iron_ore → iron_ingot xN）',
    {
      item_name: z.string().describe('要熔炼的原料，如 iron_ore / raw_iron'),
      result_name: z.string().describe('成品名，如 iron_ingot / gold_ingot'),
      count: z.number().optional().describe('想要几个成品，默认 1'),
      fuel: z.string().optional().describe('燃料，默认 coal'),
    },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const res = await smeltBatch(
          bot,
          String(args.item_name),
          String(args.result_name),
          Number(args.count ?? 1),
          String(args.fuel ?? 'coal')
        );
        ctx.memory.pushTimeline(res.note);
        return ok(`熔炼完成：${res.note}`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 箱子存放
  mcp.registerTool(
    'chest-deposit',
    '把背包里的指定物品存入附近的箱子',
    { item_name: z.string(), count: z.number().optional().describe('数量，默认全部') },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const chestFound = bot.findBlock({ matching: (b) => b.name.includes('chest') || b.name === 'barrel', maxDistance: 32 }) as unknown as { position?: { x: number; y: number; z: number } } | null;
        if (!chestFound || !chestFound.position) return fail('附近 32 格内没有箱子');
        const chest = chestFound.position;
        // 贴脸（≤4 格）就跳过寻路——新版 pathfinder 对近距离目标会空转误报"卡住"
        const distToChest = bot.entity.position.distanceTo(v3(chest.x, chest.y, chest.z));
        if (distToChest > 4) {
          await gotoSmart(bot, new goals.GoalNear(chest.x, chest.y, chest.z, 2), 20000, '走向箱子');
        }
        const win = (await bot.openBlock(chestFound as never)) as unknown as AnyWindow;
        const item = findItemInInventory(bot, String(args.item_name));
        if (!item) {
          await win.close();
          return fail(`背包里没有 ${args.item_name}`);
        }
        // 新版 mineflayer deposit/withdraw 的 itemType 必须是数字 id（Item.type）；
        // 传 Item 对象或 name 字符串都会 Invalid itemType
        await win.deposit((item.item as unknown as { type: number }).type as never, null, Number(args.count ?? item.count));
        await win.close();
        ctx.memory.pushTimeline(`往箱子存了 ${args.item_name}`);
        return ok(`已存入 ${args.item_name}`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 箱子取出
  mcp.registerTool(
    'chest-withdraw',
    '从附近的箱子取出指定物品',
    { item_name: z.string(), count: z.number().optional().describe('数量，默认 1') },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const chestFound = bot.findBlock({ matching: (b) => b.name.includes('chest') || b.name === 'barrel', maxDistance: 32 }) as unknown as { position?: { x: number; y: number; z: number } } | null;
        if (!chestFound || !chestFound.position) return fail('附近 32 格内没有箱子');
        const chest = chestFound.position;
        // 贴脸（≤4 格）就跳过寻路——新版 pathfinder 对近距离目标会空转误报"卡住"
        const distToChest = bot.entity.position.distanceTo(v3(chest.x, chest.y, chest.z));
        if (distToChest > 4) {
          await gotoSmart(bot, new goals.GoalNear(chest.x, chest.y, chest.z, 2), 20000, '走向箱子');
        }
        const win = (await bot.openBlock(chestFound as never)) as unknown as AnyWindow;
        const items = win.containerItems() as unknown as Array<{ name: string; type: number; count: number; slot: number }>;
        const found = items.find((it) => it.name === String(args.item_name));
        if (!found) {
          await win.close();
          return fail(`箱子里没有 ${args.item_name}`);
        }
        // 修复：withdraw 首参同样是数字 id（Item.type），不是 Item 对象或 name
        await win.withdraw(found.type as never, null, Number(args.count ?? 1));
        await win.close();
        return ok(`已从箱子取出 ${args.item_name}`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 丢弃
  mcp.registerTool(
    'drop-item',
    '丢弃背包中的指定物品',
    { item_name: z.string(), count: z.number().optional().describe('数量，默认全部') },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const item = findItemInInventory(bot, String(args.item_name));
        if (!item) return fail(`背包里没有 ${args.item_name}`);
        await (bot.tossStack as unknown as (i: unknown, c: number) => Promise<void>)(item.item as never, Number(args.count ?? item.count));
        return ok(`已丢弃 ${args.item_name}`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );
}
