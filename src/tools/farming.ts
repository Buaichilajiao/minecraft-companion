import { z } from 'zod';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { getBot, ok, fail, findItemInInventory, withTimeout } from './helpers';
import { fishOnce } from './fishing';
import { v3, sleep } from '../utils';

export function registerFarmingTools(mcp: McpServerManager, ctx: ToolContext): void {
  // 耕地
  mcp.registerTool(
    'till-land',
    '用锄头把脚下或指定位置的泥土/草方块耕成耕地',
    { x: z.number().optional().describe('X，默认脚下'), y: z.number().optional(), z: z.number().optional() },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const my = ctx.status().self.position;
        const pos = {
          x: Number(args.x ?? my[0]),
          y: Number(args.y ?? my[1] - 1),
          z: Number(args.z ?? my[2]),
        };
        const block = bot.blockAt(v3(pos.x, pos.y, pos.z)) as unknown as { name?: string } | null;
        if (!block || !['dirt', 'grass_block', 'coarse_dirt'].includes(block.name ?? '')) {
          return fail(`(${pos.x}, ${pos.y}, ${pos.z}) 不是泥土，无法耕地`);
        }
        const hoe = findItemInInventory(bot, 'wooden_hoe') || findItemInInventory(bot, 'stone_hoe') || findItemInInventory(bot, 'iron_hoe') || findItemInInventory(bot, 'diamond_hoe');
        if (!hoe) return fail('背包里没有锄头');
        await bot.equip(hoe.item as never, 'hand');
        await withTimeout(bot.activateBlock(block as never), 10000, '耕地');
        return ok(`已耕地 (${pos.x}, ${pos.y}, ${pos.z})`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 种植
  mcp.registerTool(
    'plant-seed',
    '在脚下或指定位置的耕地种植作物种子（wheat_seeds/carrot/potato 等）',
    { seed: z.string().describe('种子/作物物品名，如 wheat_seeds / carrot / potato'), x: z.number().optional(), y: z.number().optional(), z: z.number().optional() },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const my = ctx.status().self.position;
        const pos = {
          x: Number(args.x ?? my[0]),
          y: Number(args.y ?? my[1] - 1),
          z: Number(args.z ?? my[2]),
        };
        const block = bot.blockAt(v3(pos.x, pos.y, pos.z)) as unknown as { name?: string } | null;
        if (!block || !['farmland', 'grass_block', 'dirt'].includes(block.name ?? '')) {
          return fail(`(${pos.x}, ${pos.y}, ${pos.z}) 不是耕地`);
        }
        const seed = String(args.seed);
        const item = findItemInInventory(bot, seed);
        if (!item) return fail(`背包里没有 ${seed}`);
        await bot.equip(item.item as never, 'hand');
        await withTimeout(bot.activateBlock(block as never), 10000, '种植');
        return ok(`已在 (${pos.x}, ${pos.y}, ${pos.z}) 种下 ${seed}`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 骨粉催熟：对指定方块连用骨粉，直到目标方块变化（长成/长大）或用满次数
  mcp.registerTool(
    'use-bone-meal',
    '对指定坐标的植物（树苗/小麦等）使用骨粉催熟，自动连点最多 N 次（默认 8）直到目标长成或变化。树苗催成树后会自动停',
    { x: z.number().describe('目标方块 X'), y: z.number().describe('目标方块 Y'), z: z.number().describe('目标方块 Z'), times: z.number().optional().describe('最多使用次数，默认 8，最大 16') },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const x = Number(args.x), y = Number(args.y), z = Number(args.z);
        const maxTimes = Math.min(Number(args.times ?? 8), 16);
        const item = findItemInInventory(bot, 'bone_meal');
        if (!item) return fail('背包里没有骨粉');
        const first = bot.blockAt(v3(x, y, z)) as unknown as { name?: string } | null;
        if (!first || first.name === 'air') return fail(`(${x}, ${y}, ${z}) 是空气，没有可催熟的植物`);
        await bot.equip(item.item as never, 'hand');
        let used = 0;
        let last = first.name;
        for (let i = 0; i < maxTimes; i++) {
          const block = bot.blockAt(v3(x, y, z)) as unknown as { name?: string } | null;
          if (!block || block.name === 'air') break; // 方块消失（长成被替代）即停
          await withTimeout(bot.activateBlock(block as never), 10000, '使用骨粉');
          used++;
          await sleep(600);
          const after = bot.blockAt(v3(x, y, z)) as unknown as { name?: string } | null;
          if (!after || after.name === 'air') break;
          if (after.name !== last) break; // 方块类型变化说明催熟生效，停
        }
        ctx.memory.pushTimeline(`对 (${x}, ${y}, ${z}) 使用了 ${used} 次骨粉`);
        return ok(`已使用 ${used} 次骨粉（目标 ${first.name}）`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 收获
  mcp.registerTool(
    'harvest',
    '收获附近成熟的作物（小麦/胡萝卜/土豆等），挖掉并拾取',
    { max_distance: z.number().optional().describe('最大距离，默认 48(3 区块)') },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const maxDist = Number(args.max_distance ?? 48);
        const crops = ['wheat', 'carrots', 'potatoes', 'beetroots', 'wheat_block'];
        const crop = bot.findBlock({ matching: (b) => crops.includes(b.name), maxDistance: maxDist }) as unknown as { name?: string; x: number; y: number; z: number } | null;
        if (!crop) return fail(`附近 ${maxDist} 格内没有成熟作物`);
        await withTimeout(bot.dig(crop as never), 20000, '收获'); // 同 dig-block 修正：bot.dig(block)
        ctx.memory.pushTimeline(`收获了 ${crop.name}`);
        return ok(`已收获 ${crop.name}`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 钓鱼
  mcp.registerTool(
    'fish',
    '在附近的水域钓鱼（真实流程：抛竿→等咬钩→自动收杆→判定鱼获，钓到稀有物品会惊喜）。需要钓鱼竿',
    {},
    async () => {
      try {
        const bot = getBot(ctx);
        const result = await fishOnce(bot);
        if (!result.caught) return fail('抛竿等了 45 秒没鱼咬钩，收杆了');
        ctx.memory.pushTimeline(`钓到了${result.item}${result.rare ? '（稀有！）' : ''}`);
        if (result.rare) {
          // fished_rare 情绪：惊喜
          ctx.emotion?.()?.react('fished_rare');
          ctx.memoryV2?.rememberShort(`钓到了稀有物品 ${result.item}，超开心`, 7);
        }
        const rareTxt = result.rare ? '，稀有鱼获！' : '';
        return ok(`钓到了 ${result.item}${rareTxt}`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 繁殖动物
  mcp.registerTool(
    'breed-animal',
    '用食物喂养附近的动物进行繁殖（牛/羊用小麦，猪用胡萝卜，鸡用种子）。需要附近有2只同类成年动物，会各喂一次让它们进入繁殖',
    { animal: z.string().describe('动物类型，如 cow / sheep / pig / chicken'), food: z.string().describe('食物，如 wheat / carrot / wheat_seeds') },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const animalType = String(args.animal);
        const food = String(args.food);
        // 修复①：繁殖要喂 2 只"不同"的同类（旧代码只找 1 只、连喂同一只 2 次，无法繁殖）
        const candidates = Object.values(bot.entities)
          .filter((e) => ((e as unknown as { name?: string }).name ?? '') === animalType)
          .slice(0, 2) as unknown as Array<{ position: { x: number; y: number; z: number } }>;
        if (candidates.length < 2) return fail(`附近只有 ${candidates.length} 只 ${animalType}，繁殖需要 2 只成年同类`);
        const item = findItemInInventory(bot, food);
        if (!item) return fail(`背包里没有 ${food}`);
        await bot.equip(item.item as never, 'hand');
        let fed = 0;
        for (const ent of candidates) {
          await withTimeout(bot.lookAt(v3(ent.position.x, ent.position.y + 1, ent.position.z)), 5000, '看向动物');
          // 修复②：喂食=对实体右键，用 bot.useOn(entity)（实体没有 activate 方法，旧代码必失败）
          await withTimeout((bot as unknown as { useOn: (e: unknown) => Promise<void> }).useOn(ent), 8000, '喂食');
          fed++;
          await sleep(600);
        }
        ctx.memory.pushTimeline(`喂了${fed}只${animalType}（${food}）繁殖`);
        return ok(`已喂 ${fed} 只 ${animalType}（${food}），它们冒出爱心后会去繁殖幼崽`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );
}
