import { z } from 'zod';
import type mineflayer from 'mineflayer';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from '../tools/context';
import type { MemoryManager } from '../memory';
import type { StatusData } from '../status';
import { ok, fail, findItemInInventory, withTimeout, gotoSmart, equipByName, smartPlace, smeltBatch, creativeFlyTo, teleportCreative, faceToward } from '../tools/helpers';
import { ensureNetherReady } from '../engine/nether-gate';
import { buildShelterCore } from '../tools/building';
import { fishOnce } from '../tools/fishing';
import type { EmotionSystem } from '../emotion';
import { v3, sleep, log, dimOf } from '../utils';
import { goals } from '@nxg-org/mineflayer-pathfinder';
import { MAX_STEPS } from '../constants';
import { getGlobalLandmark } from '../landmark';

// ─────────────────────────────────────────────
// 生活技能库（lifestyle 自主玩耍用）
// 接口：SkillContext + skills 对象
// ─────────────────────────────────────────────

export interface SkillContext {
  bot: () => mineflayer.Bot | null;
  memory: MemoryManager;
  status: () => StatusData;
  /** 情绪系统 getter（可选：lifestyle 装配时传入，供技能触发情绪） */
  emotion?: () => EmotionSystem | null;
}

export interface SkillResult {
  success: boolean;
  message: string;
}

const LOG_BLOCKS = ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'];
const ORE_BLOCKS = ['coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'diamond_ore', 'emerald_ore', 'redstone_ore', 'lapis_ore', 'deepslate_iron_ore', 'deepslate_coal_ore', 'deepslate_diamond_ore'];

async function walkTo(bot: mineflayer.Bot, pos: { x: number; y: number; z: number }): Promise<void> {
  await gotoSmart(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 2), 30000, '走路');
}

/**
 * findBlock / nearestEntity 返回 Block / 实体（坐标在 .position）。
 * 统一转成 { name?, x, y, z }，让技能代码里的 .x/.y/.z 解引用有效——
 * 修复 skills 层"坐标全 undefined"的系统性 bug（旧代码把 Block 直接断言成 {x,y,z}）。
 */
function bc(b: unknown): { name?: string; x: number; y: number; z: number } | null {
  const blk = b as { name?: string; position?: { x: number; y: number; z: number } } | null | undefined;
  const p = blk?.position;
  return p ? { name: blk.name, x: p.x, y: p.y, z: p.z } : null;
}

/** 计算传送门内孔目标：从一个 portal 方块出发，沿轴找连续 portal 取中心；沿 y 向下找站立脚层。
 *  返回 {x,y,z（站立中心）, axis}。axis=x：portal 沿 x 连续（内孔 x 通常 2 格）；axis=z 同理。 */
function portalCenter(bot: mineflayer.Bot, p: { x: number; y: number; z: number }): { x: number; y: number; z: number; axis: 'x' | 'z' } {
  const blk = bot.blockAt(v3(p.x, p.y, p.z)) as unknown as { getProperties?: () => Record<string, unknown> } | null;
  const axis = String(blk?.getProperties?.().axis ?? 'x') as 'x' | 'z';
  const isPortal = (x: number, y: number, z: number) =>
    (bot.blockAt(v3(x, y, z)) as unknown as { name?: string } | null)?.name === 'nether_portal';
  // 沿 y 向下找内孔底部（站立脚层，脚下方是底框）
  let y0 = p.y;
  while (isPortal(p.x, y0 - 1, p.z)) y0--;
  if (axis === 'x') {
    let x0 = p.x, x1 = p.x;
    while (isPortal(x0 - 1, y0, p.z)) x0--;
    while (isPortal(x1 + 1, y0, p.z)) x1++;
    return { x: (x0 + x1 + 1) / 2, y: y0, z: p.z + 0.5, axis };
  }
  let z0 = p.z, z1 = p.z;
  while (isPortal(p.x, y0, z0 - 1)) z0--;
  while (isPortal(p.x, y0, z1 + 1)) z1++;
  return { x: p.x + 0.5, y: y0, z: (z0 + z1 + 1) / 2, axis };
}

/** bot 当前是否站在 portal 内（脚/头层相交） */
function isInPortal(bot: mineflayer.Bot): boolean {
  const f = bot.entity.position.floored();
  const isPortal = (x: number, y: number, z: number) =>
    (bot.blockAt(v3(x, y, z)) as unknown as { name?: string } | null)?.name === 'nether_portal';
  return isPortal(f.x, f.y, f.z) || isPortal(f.x, f.y + 1, f.z);
}

/**
 * 确保 bot 真正进入 portal 并触发传送。
 * 【已实证】bot 在门附近（portal cooldown/边缘残留的"脏状态"）时，单步 tp 到中心会被服务器推出门、不传送；
 * 必须两步：先 tp 到 portal 法向外 5 格脱离残留，再 tp 进中心 → 0.5~4s 内稳定传送。
 * 仅创造/OP 用 /tp；生存模式不瞬移，靠 pathfinder 走进去（调用方在其返回后轮询维度）。
 */
async function ensureInPortal(
  bot: mineflayer.Bot,
  portalPos: { x: number; y: number; z: number }
): Promise<void> {
  if (bot.game.gameMode !== 'creative') return;
  const t = portalCenter(bot, portalPos);
  // 第 1 步：法向外 5 格（脱离 portal 脏状态）；+5 位不空则退到 -5
  const outPos = t.axis === 'x'
    ? { x: t.x, y: t.y, z: t.z + 5 }
    : { x: t.x + 5, y: t.y, z: t.z };
  const outAir = (bot.blockAt(v3(Math.floor(outPos.x), Math.floor(outPos.y), Math.floor(outPos.z))) as unknown as { name?: string } | null)?.name === 'air';
  const outside = outAir ? outPos : (t.axis === 'x'
    ? { x: t.x, y: t.y, z: t.z - 5 }
    : { x: t.x - 5, y: t.y, z: t.z });
  await teleportCreative(bot, outside.x, outside.y, outside.z, 3000);
  await sleep(1200);
  // 第 2 步：进 portal 中心
  await teleportCreative(bot, t.x, t.y, t.z, 3000);
}

type DigBlock = { name?: string; dig?: () => Promise<void> };

async function digBfs(bot: mineflayer.Bot, start: { x: number; y: number; z: number }, match: (name: string) => boolean, max = MAX_STEPS.treeLogs): Promise<number> {
  let cut = 0;
  const seen = new Set<string>();
  const queue: Array<{ x: number; y: number; z: number }> = [{ x: start.x, y: start.y, z: start.z }];
  const deadline = Date.now() + MAX_STEPS.longTaskMs;
  while (queue.length > 0 && cut < max) {
    if (Date.now() > deadline) {
      log('WARN', `⏱ 挖掘超时，已挖 ${cut}/${max} 块，提前结束`);
      break;
    }
    const pos = queue.shift()!;
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const block = bot.blockAt(v3(pos.x, pos.y, pos.z)) as unknown as DigBlock | null;
    if (!block || !match(block.name ?? '')) continue;
    try {
      await walkTo(bot, pos);
      if (block.dig) await withTimeout(block.dig(), 20000, '挖掘');
      cut++;
      if (cut % MAX_STEPS.progressEvery === 0) {
        log('INFO', `⛏ 挖掘进度: ${cut}/${max} 块`);
      }
    } catch {
      /* 单块失败继续 */
    }
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      queue.push({ x: pos.x + dx, y: pos.y + dy, z: pos.z + dz });
    }
  }
  return cut;
}

async function pickupNearby(ctx: SkillContext): Promise<void> {
  const bot = ctx.bot();
  if (!bot) return;
  try {
    const item = bot.nearestEntity((e) => {
      const t = (e as unknown as { type?: string }).type ?? '';
      return t === 'object';
    }) as unknown as { position?: { x: number; y: number; z: number } } | null;
    if (item && item.position) {
      await walkTo(bot, { x: item.position.x, y: item.position.y, z: item.position.z });
      await sleep(1200);
    }
  } catch {
    /* 捡不到就算了 */
  }
}

async function chopTree(ctx: SkillContext): Promise<SkillResult> {
  const bot = ctx.bot();
  if (!bot) return { success: false, message: '游戏未连接' };
  try {
    const tree = bc(bot.findBlock({ matching: (b) => LOG_BLOCKS.includes(b.name), maxDistance: 40 }));
    if (!tree) return { success: false, message: '附近 40 格内没有树' };
    const cut = await digBfs(bot, { x: tree.x, y: tree.y, z: tree.z }, (n) => LOG_BLOCKS.includes(n));
    await pickupNearby(ctx);
    ctx.memory.pushTimeline(`自主砍树（${cut} 个原木）`);
    return { success: true, message: `砍了 ${cut} 个原木` };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

async function mineStone(ctx: SkillContext): Promise<SkillResult> {
  const bot = ctx.bot();
  if (!bot) return { success: false, message: '游戏未连接' };
  try {
    const stone = bc(bot.findBlock({ matching: (b) => b.name === 'stone', maxDistance: 32 }));
    if (!stone) return { success: false, message: '附近没有石头' };
    let got = 0;
    const deadline = Date.now() + MAX_STEPS.longTaskMs;
    for (let i = 0; i < MAX_STEPS.stone; i++) {
      if (Date.now() > deadline) {
        log('WARN', `⏱ 挖石头超时，已挖 ${got} 块，提前结束`);
        break;
      }
      const b = bot.blockAt(v3(stone.x, stone.y, stone.z)) as unknown as DigBlock | null;
      if (!b || b.name !== 'stone') break;
      try {
        await walkTo(bot, { x: stone.x, y: stone.y, z: stone.z });
        if (b.dig) await withTimeout(b.dig(), 20000, '挖石头');
        got++;
        if (got % MAX_STEPS.progressEvery === 0) {
          log('INFO', `⛏ 挖石头进度: ${got}/${MAX_STEPS.stone} 块`);
        }
      } catch {
        break;
      }
      await sleep(200);
    }
    await pickupNearby(ctx);
    ctx.memory.pushTimeline(`自主挖石头（${got} 块）`);
    return { success: true, message: `挖了 ${got} 块圆石` };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

async function mineIron(ctx: SkillContext): Promise<SkillResult> {
  const bot = ctx.bot();
  if (!bot) return { success: false, message: '游戏未连接' };
  try {
    const ore = bc(bot.findBlock({ matching: (b) => ORE_BLOCKS.includes(b.name), maxDistance: 48 }));
    if (!ore) return { success: false, message: '附近 48 格内没有矿石' };
    await walkTo(bot, { x: ore.x, y: ore.y, z: ore.z });
    const b = bot.blockAt(v3(ore.x, ore.y, ore.z)) as unknown as DigBlock | null;
    if (!b || !b.dig) return { success: false, message: '无法挖掘' };
    await withTimeout(b.dig(), 30000, '挖矿');
    await pickupNearby(ctx);
    ctx.memory.pushTimeline(`自主挖矿（${ore.name}）`);
    return { success: true, message: `挖到了 ${ore.name}` };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

/**
 * A1 M1 钻石镐（DESIGN_A1_NETHER.md §2）：装备铁镐 → 找钻石矿挖 ≥3 颗 → 工作台合成钻石镐。
 * 自带守卫：没有铁镐不硬挖（空手挖钻石不掉落）；凑够 3 颗但缺工作台/木棍 → 收好钻石等待再试。
 */
async function mineDiamond(ctx: SkillContext): Promise<SkillResult> {
  const bot = ctx.bot();
  if (!bot) return { success: false, message: '游戏未连接' };
  try {
    // 守卫 1：必须铁镐及以上（石头镐挖不动钻石）
    const hasIronPick = !!findItemInInventory(bot, 'iron_pickaxe');
    const hasDiaPick = !!findItemInInventory(bot, 'diamond_pickaxe');
    if (!hasIronPick && !hasDiaPick) return { success: false, message: '需要铁镐才能挖钻石（A1 M1 前置）：先去挖铁合成铁镐再来' };
    const toEquip = hasDiaPick ? 'diamond_pickaxe' : 'iron_pickaxe';
    if (bot.heldItem?.name !== toEquip) {
      try { await equipByName(bot, toEquip); } catch { /* ignore */ }
    }
    const ore = bc(bot.findBlock({
      matching: (b) => b.name === 'diamond_ore' || b.name === 'deepslate_diamond_ore',
      maxDistance: 64,
    }));
    if (!ore) return { success: false, message: '附近 64 格内没看到钻石矿，往下挖挖看（钻石一般在地下深处）' };
    await walkTo(bot, { x: ore.x, y: ore.y, z: ore.z });
    const blk = bot.blockAt(v3(ore.x, ore.y, ore.z)) as unknown as DigBlock | null;
    if (!blk || !blk.dig) return { success: false, message: '够不着或无法挖掘' };
    await withTimeout(blk.dig(), 30000, '挖钻石矿');
    await pickupNearby(ctx);
    const diamonds = findItemInInventory(bot, 'diamond');
    const have = diamonds?.count ?? 0;
    if (have < 3) {
      ctx.memory.pushTimeline(`挖到钻石矿（${ore.x},${ore.y},${ore.z}），还差 ${3 - have} 颗就能做钻石镐`);
      return { success: true, message: `挖到钻石，当前背包 diamond x${have}（凑 3 颗做镐）` };
    }
    // 守卫 2：凑够 3 颗 → 合成钻石镐（3 钻石 + 2 木棍，3×3 需要工作台）
    const crafted = await craftItemAtTable(bot, 'diamond_pickaxe');
    if (!crafted) {
      ctx.memory.pushTimeline(`钻石够 ${have} 颗了，但缺工作台/木棍，先把钻石收好`);
      return { success: false, message: `钻石够了（x${have}），但附近没工作台或木棍不足，先把钻石收好等有条件再合成` };
    }
    ctx.memory.addTech('diamond_pickaxe');
    ctx.memory.pushTimeline('用钻石合成了钻石镐！这是进下界的第一个硬条件');
    return { success: true, message: '挖到钻石并合成了钻石镐！' };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

/** 通用合成：在附近/自放的工作台上合成任意物品（itemName）。缺材料/工作台返回 false。 */
async function craftItemAtTable(bot: mineflayer.Bot, itemName: string): Promise<boolean> {
  try {
    // 1.21+ registry.recipes 键是数字 id（非物品名），名字需先转 id 才能查到配方
    const reg = (bot as never as { registry?: { itemsByName?: Record<string, { id: number }> } }).registry;
    const itemId = reg?.itemsByName?.[itemName]?.id;
    if (itemId == null) return false;
    // mineflayer 过滤 requiresTable 且未传工作台的配方 → 无台查不到时,须带工作台重查
    const recipesNoTable = bot.recipesFor(itemId as never, null, null, null) as unknown as Array<{ requiresTable?: boolean }>;
    let recipe = recipesNoTable?.find((r) => !r.requiresTable) ?? null;
    let table: unknown = null;
    if (!recipe) {
      // 确需工作台:就近找(没有就从背包放一个),走位后带表查配方
      let tb = bc(bot.findBlock({ matching: (b) => b.name === 'crafting_table', maxDistance: 32 }));
      if (!tb) {
        const tbItem = findItemInInventory(bot, 'crafting_table');
        if (!tbItem) return false;
        const my = bot.entity.position;
        const spots: Array<[number, number, number]> = [
          [Math.floor(my.x) + 1, Math.floor(my.y), Math.floor(my.z)],
          [Math.floor(my.x) - 1, Math.floor(my.y), Math.floor(my.z)],
          [Math.floor(my.x), Math.floor(my.y), Math.floor(my.z) + 1],
          [Math.floor(my.x), Math.floor(my.y), Math.floor(my.z) - 1],
        ];
        let target: [number, number, number] | null = null;
        for (const sp of spots) {
          const blk = bot.blockAt(v3(sp[0], sp[1], sp[2]));
          const under = bot.blockAt(v3(sp[0], sp[1] - 1, sp[2]));
          if (blk && blk.name === 'air' && under && under.name !== 'air') { target = sp; break; }
        }
        if (!target) return false;
        try { await equipByName(bot, 'crafting_table'); } catch { /* ignore */ }
        const ref = bot.blockAt(v3(target[0], target[1] - 1, target[2]));
        if (!ref) return false;
        await bot.placeBlock(ref as never, v3(0, 1, 0) as never).catch(() => undefined);
        tb = { x: target[0], y: target[1], z: target[2] };
      }
      // 必须站到工作台 4 格内才能合成：超距 craft 会失败（贴脸就跳过寻路，防空转误报"卡住"）
      const distToTable = bot.entity.position.distanceTo(v3(tb.x, tb.y, tb.z));
      if (distToTable > 4) {
        const { goals } = require('@nxg-org/mineflayer-pathfinder') as { goals: any };
        await gotoSmart(bot, new goals.GoalNear(tb.x, tb.y, tb.z, 2), 20000, '走到工作台');
      }
      // findBlock 返回对象本身即 Block；1.21.1 下 blockAt 二次查询可能返回 null，别用
      const recipesT = bot.recipesFor(itemId as never, null, null, tb as never) as unknown as Array<{ requiresTable?: boolean }>;
      if (!recipesT || recipesT.length === 0) return false;
      recipe = recipesT[0];
      table = tb;
    }
    await (bot as never as { craft: (r: unknown, c: number, t: unknown) => Promise<void> }).craft(recipe as never, 1, table);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从附近水源用水桶装水（放置水后桶变空，回收复用）。无空桶/无水源返回 false。
 */
async function fillBucketFromWater(bot: mineflayer.Bot): Promise<boolean> {
  if (findItemInInventory(bot, 'water_bucket')) return true;
  if (!findItemInInventory(bot, 'bucket')) return false;
  const water = bc(bot.findBlock({ matching: (b) => b.name === 'water' || b.name === 'flowing_water', maxDistance: 24 }));
  if (!water) return false;
  const wx = water.x, wy = water.y, wz = water.z;
  let ref = bot.blockAt(v3(wx, wy - 1, wz)) as unknown as { name?: string; position: { x: number; y: number; z: number } } | null;
  let face: ReturnType<typeof v3> | null = v3(0, 1, 0);
  if (!ref || ref.name === 'air') {
    const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let found: typeof ref = null;
    for (const [dx, dz] of dirs) {
      const b = bot.blockAt(v3(wx + dx, wy, wz + dz)) as unknown as { name?: string; position: { x: number; y: number; z: number } } | null;
      if (b && b.name && b.name !== 'air' && !b.name.includes('water')) { found = b; break; }
    }
    if (!found) return false;
    ref = found;
    face = v3(ref.position.x - wx, ref.position.y - wy, ref.position.z - wz);
  }
  if (!face) return false;
  try {
    await equipByName(bot, 'bucket');
    await bot.placeBlock(ref as never, face as never).catch(() => undefined);
    await sleep(600);
  } catch {
    return false;
  }
  return !!findItemInInventory(bot, 'water_bucket');
}

/**
 * A1 M2 黑曜石（DESIGN_A1_NETHER.md §2）：装备钻石镐 → 找岩浆源 → 水桶浇成黑曜石 → 挖。
 * 关注点：放置失败每源重试 ≤3 次（对齐用户验收口径）；桶空了自动去水源装回；凑满 14 块解锁 obsidian。
 */
async function mineObsidian(ctx: SkillContext): Promise<SkillResult> {
  const bot = ctx.bot();
  if (!bot) return { success: false, message: '游戏未连接' };
  const NEED = 14;
  try {
    // 守卫 1：必须钻石镐（石头/铁镐挖不动黑曜石）
    const hasDia = !!findItemInInventory(bot, 'diamond_pickaxe');
    if (!hasDia) return { success: false, message: '需要钻石镐才能挖黑曜石（A1 M2 前置）：先完成 M1 钻石镐' };
    // 守卫 2：得先有一桶水
    if (!(await fillBucketFromWater(bot))) return { success: false, message: '没有水桶（bucket/water_bucket），先去合成铁桶装水再来' };

    const countObsidian = () => {
      const it = findItemInInventory(bot, 'obsidian');
      return it?.count ?? 0;
    };
    const steps: string[] = [];
    let tries = 0;
    while (countObsidian() < NEED && tries < 24) {
      tries += 1;
      if (!(await fillBucketFromWater(bot))) { steps.push('桶空了且附近没水源，先歇着等有水'); break; }
      const lava = bc(bot.findBlock({ matching: (b) => b.name === 'lava', maxDistance: 48 }));
      if (!lava) { steps.push('附近 48 格内没岩浆源了，下挖或找岩浆湖再继续'); break; }
      // 站到安全距离
      await walkTo(bot, { x: lava.x + 2, y: lava.y, z: lava.z + 2 }).catch(() => undefined);
      // 找倒水点：岩浆源旁/上方空位
      const cands: Array<[number, number, number]> = [
        [lava.x + 1, lava.y, lava.z], [lava.x - 1, lava.y, lava.z],
        [lava.x, lava.y, lava.z + 1], [lava.x, lava.y, lava.z - 1],
        [lava.x, lava.y + 1, lava.z],
      ];
      let pour: [number, number, number] | null = null;
      for (const c of cands) {
        const blk = bot.blockAt(v3(c[0], c[1], c[2]));
        if (blk && blk.name === 'air') { pour = c; break; }
      }
      if (!pour) { steps.push('岩浆源被围住了，换个源'); continue; }
      // 放置水（重试 ≤3 次；每次等方块更新再判）
      let became = false;
      for (let retry = 0; retry < 3 && !became; retry++) {
        try {
          await equipByName(bot, 'water_bucket');
          const ref = bot.blockAt(v3(lava.x, lava.y, lava.z));
          if (!ref) break;
          await bot.placeBlock(ref as never, v3(pour[0] - lava.x, pour[1] - lava.y, pour[2] - lava.z) as never).catch(() => undefined);
        } catch { /* 继续重试 */ }
        await sleep(900);
        const now = bot.blockAt(v3(lava.x, lava.y, lava.z)) as unknown as { name?: string } | null;
        if (now?.name === 'obsidian') became = true;
      }
      if (!became) { steps.push('连续 3 次没把岩浆浇成黑曜石，跳过这个源'); continue; }
      // 挖黑曜石（钻石镐）
      const blk = bot.blockAt(v3(lava.x, lava.y, lava.z)) as unknown as DigBlock | null;
      if (!blk || !blk.dig) continue;
      try {
        await equipByName(bot, 'diamond_pickaxe');
        await withTimeout(blk.dig(), 30000, '挖黑曜石');
        await pickupNearby(ctx);
        steps.push(`浇成并挖到黑曜石（x${countObsidian()}/${NEED}）`);
      } catch (e) {
        steps.push(`挖黑曜石卡住：${String(e).slice(0, 60)}`);
        break;
      }
    }
    const have = countObsidian();
    if (have >= NEED) {
      ctx.memory.addTech('obsidian');
      ctx.memory.pushTimeline(`自主浇岩浆做出了 ${NEED} 块黑曜石！下界门材料到手`);
      return { success: true, message: `黑曜石已凑满 ${have} 块！解锁 obsidian` };
    }
    return { success: false, message: `黑曜石还差（${have}/${NEED}）。${steps.slice(-2).join('；') || '继续找岩浆'}` };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

/**
 * A1 M3 下界传送门（DESIGN_A1_NETHER.md §2 + B2 执行方案）：选址 → 10 块黑曜石搭 4×5 框（内孔 2×3）
 * → 打火石点火 → 确认 portal 激活 → Landmark 写 nether_portal。
 * 关注点（用户验收口径）：选址检测（脚下平整/上方净空/无易燃物），失败自动换候选地，不原地死磕。
 */
async function buildPortal(ctx: SkillContext): Promise<SkillResult> {
  const bot = ctx.bot();
  if (!bot) return { success: false, message: '游戏未连接' };
  if (dimOf(bot) !== 'overworld') return { success: false, message: '搭主世界下界门只能在主世界（现在在别的维度），先回主世界再来' };
  try {
    const obsidian = findItemInInventory(bot, 'obsidian');
    if (!obsidian || obsidian.count < 14) return { success: false, message: '黑曜石不足 14 块（M3 前置）：先完成 M2' };
    const flint = findItemInInventory(bot, 'flint_and_steel');
    if (!flint) return { success: false, message: '需要打火石（flint_and_steel）点火：用铁锭+燧石合成一个再来' };
    const my = ctx.status().self.position;
    const home = ctx.memory.data.identity.home;

    // ── Phase 1 选址：在家附近（没家就用当前位置）扫平坦空地；失败半径递增换位 ──
    const base: [number, number, number] = home ?? [Math.floor(my[0]), Math.floor(my[1]), Math.floor(my[2])];
    const stand: [number, number, number] = [base[0], base[1], base[2]];
    const groundYAt = (x: number, z: number): number => {
      for (let y = stand[1] + 4; y >= stand[1] - 8; y--) {
        const b = bot.blockAt(v3(x, y, z));
        if (b && b.name !== 'air' && !b.name.includes('water') && !b.name.includes('lava')) return y;
      }
      return -999;
    };
    const isFlammable = (n: string): boolean =>
      /log|leaves|planks|wool|hay|fence|door|tnt|torch|flower|grass|bamboo|vine/.test(n) || n.includes('lava');

    let anchor: [number, number, number] | null = null;
    outer:
    for (let ring = 0; ring < 5; ring++) {
      const r = 2 + ring * 7; // 半径 2 → 9 → 16 → 23 → 30，离家越来越远
      const cands: Array<[number, number]> = [];
      for (let dz = -r; dz <= r; dz += 2) {
        for (let dx = -r; dx <= r; dx += 2) {
          if (Math.abs(dx) < r - 1 && Math.abs(dz) < r - 1) continue; // 只扫环带
          cands.push([base[0] + dx, base[2] + dz]);
        }
      }
      for (const [cx, cz] of cands) {
        const g = groundYAt(cx, cz);
        if (g < 0) continue;
        // ① 门框占位：5 行高 × 4 列宽（x=cx..cx+3, z=cz 面）+ 上方 2 格净空，全部空气
        let clean = true;
        for (let y = g + 1; y <= g + 7 && clean; y++) {
          for (let dx = 0; dx <= 3 && clean; dx++) {
            const b = bot.blockAt(v3(cx + dx, y, cz));
            if (!b || (b.name !== 'air' && !b.name.includes('water'))) clean = false;
          }
        }
        // ② 周围 2 格 + 洞内地面：无易燃物（别把火引到树/木屋/草地火把堆）
        if (clean) {
          for (let dx = -3; dx <= 6 && clean; dx++) {
            for (let dz = -2; dz <= 2 && clean; dz++) {
              for (const yy of [g, g + 1, g + 2]) {
                const b = bot.blockAt(v3(cx + dx, yy, cz + dz));
                if (b && isFlammable(b.name)) { clean = false; break; }
              }
            }
          }
        }
        // ③ 地面平不平：4 列脚下都必须是实体（非空气），高低差由 groundYAt 一致保证
        if (clean) {
          for (let dx = 0; dx <= 3 && clean; dx++) {
            const bg = bot.blockAt(v3(cx + dx, g, cz));
            if (!bg || bg.name === 'air') clean = false;
          }
        }
        if (clean) { anchor = [cx, g, cz]; break outer; }
      }
      // 这圈没有 → 走远点再试（换位置，不原地死磕）
      if (!anchor) {
        await gotoSmart(bot, new goals.GoalNear(base[0] + r, stand[1], base[2] + r, 4), 20000, '换个地方选址').catch(() => undefined);
      }
    }
    if (!anchor) return { success: false, message: '附近 30 格没找到能搭门的平地（太挤/易燃/高低不平），先探索别处再说' };

    // ── Phase 2 搭框（标准 4×5 坐地面上，共 14 块）：底框 4 + 侧柱 6 + 顶框 4 ──
    // 底框黑曜"坐"在地面 y=gy+1 上（玩家自然搭法，不用挖地面）：实测"无底框"
    // （内孔底面是石头）打火石只产生单个 fire，PortalChecker 要求底框是 obsidian。
    const [gx, gy, gz] = anchor;
    // 底框 y=gy+1（4 块，对地面 gy 顶面放）
    const bottom: Array<[number, number, number]> = [];
    for (let dx = 0; dx <= 3; dx++) bottom.push([gx + dx, gy + 1, gz]);
    // 侧柱中段 y=gy+2..gy+4（两端各 3 = 6 块）
    const sides: Array<[number, number, number]> = [];
    for (let y = gy + 2; y <= gy + 4; y++) {
      sides.push([gx, y, gz]); sides.push([gx + 3, y, gz]);
    }
    // 顶框 y=gy+5（4 块，含两角）
    const top: Array<[number, number, number]> = [];
    for (let dx = 0; dx <= 3; dx++) top.push([gx + dx, gy + 5, gz]);
    const allFrame = [...bottom, ...sides, ...top];
    for (const [x, y, z] of allFrame) {
      // 已有黑曜石（如重入）跳过
      const haveB = bot.blockAt(v3(x, y, z)) as unknown as { name?: string } | null;
      if (haveB?.name === 'obsidian') { await sleep(80); continue; }
      const okp = await smartPlace(bot, { x, y, z }, 'obsidian');
      if (!okp) return { success: false, message: `搭门放黑曜石失败（${x},${y},${z}），下轮继续` };
      await sleep(200);
    }
    // 自检：全部 14 块在位
    for (const [x, y, z] of allFrame) {
      const b = bot.blockAt(v3(x, y, z)) as unknown as { name?: string } | null;
      if (b?.name !== 'obsidian') return { success: false, message: `框架缺块（${x},${y},${z}），重新搭` };
    }

    // ── Phase 3 点火：飞到门外上方（z=gz+2，不在 portal 内）俯视底框打火，fire 落内孔 ──
    const tryIgnite = async (): Promise<void> => {
      // 门外 2 格、高度 gy+2 俯视底框（bot 不在 portal 内，点着后不被传送）
      await creativeFlyTo(bot, v3(gx + 1.5, gy + 2.0, gz + 2.0), 12000).catch(() => undefined);
      await equipByName(bot, 'flint_and_steel');
      const ref = bot.blockAt(v3(gx + 1, gy + 1, gz)); // 底框
      if (ref) {
        // 俯视底框顶面（y=gy+2 平面），fire 落内孔 (gx+1,gy+2,gz)
        await bot.lookAt(v3(gx + 1.5, gy + 2.0, gz + 0.5), true).catch(() => undefined);
        await bot.activateBlock(ref as never).catch(() => undefined);
      }
      await sleep(1600);
    };
    let lit = false;
    for (let i = 0; i < 3 && !lit; i++) {
      await tryIgnite();
      const portal = bc(bot.findBlock({ matching: (b) => b.name === 'nether_portal', maxDistance: 8 }));
      if (portal) lit = true;
    }
    if (!lit) return { success: false, message: '门搭好了但没点着（点 3 次都没着，可能结构/位置问题），框先留着下次再点' };

    // ── 完成：坐标落 memory（主世界门）+ Landmark（nether_portal 保护类型，问答/回程可用）──
    const center: [number, number, number] = [gx + 1, gy + 3, gz];
    ctx.memory.data.identity.portal = center;
    getGlobalLandmark()?.addLandmark('nether_portal', '下界传送门', { x: center[0], y: center[1], z: center[2] }, dimOf(bot), '自主搭建并点亮');
    ctx.memory.addTech('portal');
    ctx.memory.setGoal('准备装备，进下界（找要塞打烈焰人）');
    ctx.memory.pushTimeline(`搭好了下界传送门（${center.join(',')}），主世界坐标已记住`, center);
    ctx.emotion?.()?.react('achievement');
    return { success: true, message: '下界传送门搭好并点亮了！位置已记进 Landmark' };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

/**
 * A1 M5 进入下界（DESIGN §2 / 附录 B3）：走到主世界门 → 站入 portal 方块等传送（轮询 dimension）→
 * 落地记下界侧出口门坐标 identity.nether_portal（Guardian 撤退锚点）。
 * 自带守卫：主世界才执行、没记门先 build_portal；15s 没触发挪位重试 ≤3。
 */
async function enterNether(ctx: SkillContext): Promise<SkillResult> {
  const bot = ctx.bot();
  if (!bot) return { success: false, message: '游戏未连接' };
  try {
    if (dimOf(bot) !== 'overworld') return { success: false, message: '只能在主世界进下界（现在不在主世界）' };
    const portal = ctx.memory.data.identity.portal as [number, number, number] | undefined;
    if (!portal) return { success: false, message: '还没记主世界传送门坐标（identity.portal），先搭门（build_portal）再来' };
    const [px, py, pz] = portal; // 内孔中心（y=gy+2）；站进洞的高度是 gy+1
    const standY = py - 1;
    let entered = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await gotoSmart(bot, new goals.GoalNear(px, standY, pz, 1.0), 40000, `进传送门（第 ${attempt} 次）`);
      } catch { /* pathfinder 报错不致命：就地尝试触发 */ }
      await ensureInPortal(bot, { x: px, y: py, z: pz }); // 确保真进入 portal
      // 站进去轮询等待传送（最多 15s）
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (dimOf(bot) === 'nether') break;
        await sleep(500);
      }
      if (dimOf(bot) === 'nether') { entered = true; break; }
      // 没触发 → 绕着门心挪一格重新站
      const here = bot.entity.position;
      const opts: Array<[number, number]> = [[px + 1, pz], [px - 1, pz], [px, pz + 1], [px, pz - 1]];
      const nxt = opts.find(([x, z]) => x !== Math.floor(here.x) || z !== Math.floor(here.z));
      if (!nxt) break;
      try { await gotoSmart(bot, new goals.GoalNear(nxt[0], standY, nxt[1], 0.5), 15000, '挪位触发传送'); } catch { /* */ }
    }
    if (!entered) return { success: false, message: '站进传送门 3 次都没触发传送——门可能没点亮或被堵，回主世界查一下' };
    // ── 已在下界：等落地安稳，记录出口门坐标 ──
    await sleep(3000);
    const pos = bot.entity.position;
    let spot: [number, number, number] = [Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)];
    const exitPortal = bc(bot.findBlock({ matching: (b) => b.name === 'nether_portal', maxDistance: 24 }));
    if (exitPortal) spot = [exitPortal.x, exitPortal.y, exitPortal.z];
    ctx.memory.data.identity.nether_portal = spot;
    ctx.memory.addTech('nether');
    ctx.memory.setGoal('安全探索下界，回去前找要塞打烈焰人（B4 才开放）');
    ctx.memory.pushTimeline(`穿过传送门进入下界！出口门记在 (${spot.join(',')})`, spot);
    ctx.emotion?.()?.react('achievement');
    return { success: true, message: `已进入下界！出口门记在 (${spot.join(',')})，坐标已记住，随时可以回穿` };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

/**
 * A1 M8 雏形/安全网 return_home（DESIGN 附录 B3）：下界 → 走回出口门 → 站框传回主世界。
 * B4 接入 blaze 验收前，它保证 bot 在下界不被困住。
 */
async function returnHome(ctx: SkillContext): Promise<SkillResult> {
  const bot = ctx.bot();
  if (!bot) return { success: false, message: '游戏未连接' };
  try {
    if (dimOf(bot) !== 'nether') return { success: false, message: '当前不在下界，不用回穿' };
    // 目标门：先找点亮的 portal 方块（通常是刚进来的出口门），没有再用记录的坐标
    let gatePos = bc(bot.findBlock({ matching: (b) => b.name === 'nether_portal', maxDistance: 80 }));
    const recorded = ctx.memory.data.identity.nether_portal as [number, number, number] | undefined;
    if (!gatePos && recorded) {
      await gotoSmart(bot, new goals.GoalNear(recorded[0], recorded[1], recorded[2], 4), 60000, '走回记录的门').catch(() => undefined);
      gatePos = bc(bot.findBlock({ matching: (b) => b.name === 'nether_portal', maxDistance: 24 }));
    }
    if (!gatePos) return { success: false, message: '没找到点亮的传送门（可能要打火石重新点火，先别乱跑）' };
    let back = false;
    for (let attempt = 1; attempt <= 3 && !back; attempt++) {
      try {
        await gotoSmart(bot, new goals.GoalNear(gatePos.x, gatePos.y, gatePos.z, 1.0), 40000, `回穿（第 ${attempt} 次）`);
      } catch { /* 就地尝试 */ }
      await ensureInPortal(bot, gatePos); // 确保真进入 portal（pathfinder 常停在边缘）
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (dimOf(bot) === 'overworld') break;
        await sleep(500);
      }
      if (dimOf(bot) === 'overworld') back = true;
    }
    if (!back) return { success: false, message: '站门里没传回主世界，检查门是否点亮' };
    ctx.memory.pushTimeline('从下界安全回穿主世界！');
    return { success: true, message: '已从下界安全回到主世界！' };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

/** 挖一块指定矿石（铁镐/钻石镐优先），成功返回 true。 */
async function digOre(bot: mineflayer.Bot, names: string[], ctx: SkillContext): Promise<boolean> {
  const ore = bc(bot.findBlock({ matching: (b) => names.includes(b.name), maxDistance: 64 }));
  if (!ore) return false;
  await walkTo(bot, { x: ore.x, y: ore.y, z: ore.z });
  const pick = findItemInInventory(bot, 'diamond_pickaxe') ? 'diamond_pickaxe'
    : findItemInInventory(bot, 'iron_pickaxe') ? 'iron_pickaxe' : null;
  if (pick) { try { await equipByName(bot, pick); } catch { /* ignore */ } }
  const blk = bot.blockAt(v3(ore.x, ore.y, ore.z)) as unknown as DigBlock | null;
  if (!blk || !blk.dig) return false;
  await withTimeout(blk.dig(), 30000, '挖矿');
  await pickupNearby(ctx);
  return true;
}

/** 确保附近有熔炉：现成的直接可用；没有 → 8 圆石合成一个放脚边。 */
async function ensureFurnace(bot: mineflayer.Bot, ctx: SkillContext): Promise<boolean> {
  const have = bot.findBlock({ matching: (b) => b.name === 'furnace', maxDistance: 32 });
  if (have) return true;
  if (countOf(bot, 'cobblestone') < 8) return false;
  if (!(await craftItemAtTable(bot, 'furnace'))) return false;
  const my = bot.entity.position;
  const spots: Array<[number, number, number]> = [
    [Math.floor(my.x) + 1, Math.floor(my.y), Math.floor(my.z)],
    [Math.floor(my.x) - 1, Math.floor(my.y), Math.floor(my.z)],
    [Math.floor(my.x), Math.floor(my.y), Math.floor(my.z) + 1],
    [Math.floor(my.x), Math.floor(my.y), Math.floor(my.z) - 1],
  ];
  for (const [x, y, z] of spots) {
    const blk = bot.blockAt(v3(x, y, z));
    const under = bot.blockAt(v3(x, y - 1, z));
    if (blk && blk.name === 'air' && under && under.name !== 'air') {
      try { await equipByName(bot, 'furnace'); } catch { /* ignore */ }
      await bot.placeBlock(bot.blockAt(v3(x, y - 1, z)) as never, v3(0, 1, 0) as never).catch(() => undefined);
      return !!bot.findBlock({ matching: (b) => b.name === 'furnace', maxDistance: 4 });
    }
  }
  return false;
}

/** 熔炼原料探测：1.17+ 用 raw_iron/raw_gold，老版本挖矿掉 ore 本体也兼容。 */
function smeltSource(bot: mineflayer.Bot, rawName: string, oreName: string): string | null {
  if (countOf(bot, rawName) > 0) return rawName;
  if (countOf(bot, oreName) > 0) return oreName;
  return null;
}

/**
 * A1 M4 补给 gear_up（DESIGN 附录 B3）：进下界前缺啥补啥。
 * 金锭不足 → 挖金矿/熔炼补齐 4；缺铁器（剑/甲/打火石）→ 熔炼铁锭后逐件合成。
 * 缺食物不管（交主链日常）；材料/炉子没有就明确报缺，不硬凑。
 */
async function gearUp(ctx: SkillContext): Promise<SkillResult> {
  const bot = ctx.bot();
  if (!bot) return { success: false, message: '游戏未连接' };
  try {
    const s = ctx.status();
    const gate = ensureNetherReady(s);
    if (gate.ok) return { success: true, message: '装备已齐（铁剑/铁甲/打火石/金锭），随时可以进下界' };
    const steps: string[] = [];
    const invCount = (n: string) => s.self.inventory.filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);

    // ── 1) 金锭补到 4 ──
    let goldHave = invCount('gold_ingot');
    if (goldHave < 4) {
      const need = 4 - goldHave;
      let src = smeltSource(bot, 'raw_gold', 'gold_ore');
      let triedMine = false;
      while (!src || invCount('raw_gold') + invCount('gold_ore') < need) {
        if (!(await digOre(bot, ['gold_ore', 'deepslate_gold_ore'], ctx))) break;
        triedMine = true;
        src = smeltSource(bot, 'raw_gold', 'gold_ore');
      }
      if (!src) return { success: false, message: triedMine ? '挖了一圈没找到金矿，金锭暂时凑不齐（可在恶地找找）' : '附近 64 格没看到金矿，金锭补给需要找矿源' };
      if (!(await ensureFurnace(bot, ctx))) return { success: false, message: '需要熔炉熔炼金锭：附近没有熔炉，圆石也不够 8 块造，先攒圆石/找熔炉' };
      try {
        const res = await smeltBatch(bot, src, 'gold_ingot', need);
        steps.push(res.note);
        goldHave = invCount('gold_ingot');
      } catch (e) {
        return { success: false, message: `熔炼金锭失败: ${String(e)}` };
      }
    }

    // ── 2) 铁器：剑/四件甲/打火石 缺啥合成啥 ──
    const need = s.self.inventory; // refresh
    const invH = (frag: string) => s.self.inventory.some((i) => i.name.includes(frag));
    const eqH = (slot: 'head' | 'torso' | 'legs' | 'feet' | 'hand', frag: string) => (s.self.equipment[slot] ?? '').includes(frag);
    const metal = ['iron_', 'diamond_', 'netherite_', 'golden_'];
    const pieces: Array<[string, string, string, number]> = [
      ['iron_sword', 'sword', 'hand', 2],
      ['iron_helmet', 'helmet', 'head', 5],
      ['iron_chestplate', 'chestplate', 'torso', 8],
      ['iron_leggings', 'leggings', 'legs', 7],
      ['iron_boots', 'boots', 'feet', 4],
      ['flint_and_steel', 'flint_and_steel', 'hand', 1],
    ];
    const toCraft: Array<[string, number]> = [];
    for (const [ironName, frag, slot, ingots] of pieces) {
      if (frag === 'flint_and_steel') {
        if (!invH('flint_and_steel')) toCraft.push([ironName, ingots]);
      } else if (!metal.some((m) => invH(`${m}${frag}`) || eqH(slot as 'head' | 'torso' | 'legs' | 'feet' | 'hand', `${m}${frag}`))) {
        toCraft.push([ironName, ingots]);
      }
    }
    if (toCraft.length > 0) {
      const needIron = toCraft.reduce((a, [, n]) => a + n, 0) - invCount('iron_ingot');
      if (needIron > 0) {
        const ironSrc = smeltSource(bot, 'raw_iron', 'iron_ore');
        let mined = 0;
        while (!ironSrc || invCount('raw_iron') + invCount('iron_ore') < needIron) {
          if (!(await digOre(bot, ['iron_ore', 'deepslate_iron_ore'], ctx))) break;
          mined++;
        }
        const src2 = smeltSource(bot, 'raw_iron', 'iron_ore');
        if (!src2) return { success: false, message: mined ? '挖了一轮也没见到铁矿石，铁锭补给需要铁源（去地下找找）' : '附近没有铁矿/铁锭，先挖铁（mine_iron）再来合成' };
        if (!(await ensureFurnace(bot, ctx))) return { success: false, message: '需要熔炉熔炼铁锭：附近没有熔炉，圆石也不够 8 块造' };
        try {
          const res = await smeltBatch(bot, src2, 'iron_ingot', needIron);
          steps.push(res.note);
        } catch (e) {
          return { success: false, message: `熔炼铁锭失败: ${String(e)}` };
        }
      }
      // 逐件合成
      for (const [itemName] of toCraft) {
        const okC = await craftItemAtTable(bot, itemName);
        steps.push(okC ? `合成了 ${itemName}` : `合成 ${itemName} 失败（缺材料/工作台）`);
      }
      if (findItemInInventory(bot, 'iron_sword')) { try { await equipByName(bot, 'iron_sword'); } catch { /* ignore */ } }
    }

    const after = ensureNetherReady(ctx.status());
    ctx.memory.pushTimeline(`A1 补给: ${steps.join('；') || '盘点了一遍，没啥能补的'}`);
    // 食物由主链日常兜底，不属于 gear_up 职责 → 判定成败时剔除"食物"项
    const nonFood = after.missing.filter((m) => !m.includes('食物'));
    return nonFood.length === 0
      ? { success: true, message: `装备补给完成！${steps.join('；') || '装备已齐'} —— 可以进下界了（食物交给日常攒）` }
      : { success: false, message: `补给做了一部分（${steps.join('；')}），还缺 ${nonFood.join('、')}（铁器/金锭下次再试）` };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}


async function plantFarm(ctx: SkillContext): Promise<SkillResult> {
  const bot = ctx.bot();
  if (!bot) return { success: false, message: '游戏未连接' };
  try {
    const my = ctx.status().self.position;
    const seedCandidates = ['wheat_seeds', 'carrot', 'potato'] as const;
    let seedName: string | null = null;
    let seedItem: ReturnType<typeof findItemInInventory> = null;
    for (const s of seedCandidates) {
      const found = findItemInInventory(bot, s);
      if (found) { seedName = s; seedItem = found; break; }
    }
    if (!seedName || !seedItem) return { success: false, message: '没有种子' };
    const hoe = findItemInInventory(bot, 'wooden_hoe') || findItemInInventory(bot, 'stone_hoe') || findItemInInventory(bot, 'iron_hoe') || findItemInInventory(bot, 'diamond_hoe');
    if (!hoe) return { success: false, message: '没有锄头' };
    // 耕地（脚下或附近 dirt）
    const ground = bot.blockAt(v3(Math.round(my[0]), Math.round(my[1]) - 1, Math.round(my[2]))) as unknown as { name?: string } | null;
    let target = ground && ['dirt', 'grass_block'].includes(ground.name ?? '') ? { x: Math.round(my[0]), y: Math.round(my[1]) - 1, z: Math.round(my[2]) } : null;
    if (!target) {
      const dirt = bc(bot.findBlock({ matching: (b) => ['dirt', 'grass_block'].includes(b.name), maxDistance: 16 }));
      if (!dirt) return { success: false, message: '附近没有可耕地' };
      target = { x: dirt.x, y: dirt.y, z: dirt.z };
    }
    await walkTo(bot, target);
    await bot.equip(hoe.item as never, 'hand');
    const tBlock = bot.blockAt(v3(target.x, target.y, target.z)) as unknown as { name?: string };
    await withTimeout(bot.activateBlock(tBlock as never), 10000, '耕地');
    await sleep(300);
    await bot.equip(seedItem.item as never, 'hand');
    await withTimeout(bot.activateBlock(tBlock as never), 10000, '播种');
    ctx.memory.pushTimeline(`自主种了 ${seedName}`);
    return { success: true, message: `在 (${target.x}, ${target.y}, ${target.z}) 种了 ${seedName}` };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

async function fishSkill(ctx: SkillContext): Promise<SkillResult> {
  const bot = ctx.bot();
  if (!bot) return { success: false, message: '游戏未连接' };
  try {
    // 与 MCP fish 工具共用同一实现（P2-1：真实抛竿→等咬钩→自动收杆→判定）
    const result = await fishOnce(bot);
    if (!result.caught) {
      return { success: false, message: '等了一会儿没有鱼咬钩，收杆了' };
    }
    if (result.rare) {
      ctx.emotion?.()?.react('fished_rare');
    }
    ctx.memory.pushTimeline(`钓到了${result.item}${result.rare ? '（稀有！）' : ''}`);
    return { success: true, message: `钓到了 ${result.item}${result.rare ? '，稀有鱼获！' : ''}` };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

/** 生活技能表（lifestyle.pickSkill 的 key 对应这里） */
/** 探索：随机方向走 28~50 格，看看有没有新地方（SoloEngine 休闲/兜底用） */
async function exploreAround(ctx: SkillContext): Promise<SkillResult> {
  const bot = ctx.bot();
  if (!bot) return { success: false, message: '游戏未连接' };
  try {
    const p = bot.entity.position;
    const yaw = Math.random() * Math.PI * 2;
    const dist = 28 + Math.floor(Math.random() * 23); // 28~50 格
    const tx = Math.round(p.x + Math.sin(yaw) * dist);
    const tz = Math.round(p.z + Math.cos(yaw) * dist);
    log('INFO', `🧭 探索目标: (${tx}, ${tz})，距离 ${dist} 格`);
    await gotoSmart(bot, new goals.GoalNear(tx, p.y, tz, 5), 60000, '探索');
    await pickupNearby(ctx);
    ctx.memory.pushTimeline(`探索到新地方 (${tx}, ${tz})`);
    return { success: true, message: `探索到 (${tx}, ${tz})` };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}


const HOSTILE_MOBS2 = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned',
  'skeleton', 'stray', 'creeper', 'spider', 'cave_spider',
  'enderman', 'witch', 'slime', 'magma_cube', 'phantom',
  'blaze', 'ghast', 'wither_skeleton', 'zombified_piglin', 'piglin',
  'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'guardian', 'elder_guardian', 'hoglin', 'zoglin', 'piglin_brute',
]);

/** 背包中某物品的总数（跨堆累加） */
function countOf(bot: mineflayer.Bot, name: string): number {
  try {
    return (bot.inventory.items() as unknown as Array<{ name: string; count: number }>)
      .filter((i) => i.name === name).reduce((a, i) => a + i.count, 0);
  } catch { return 0; }
}

/** 可作建材的方块及优先级（越大越优先，先圆石后木板） */
const BUILD_MATERIALS = ['cobblestone', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'oak_log'];
/** 5x5x4 小屋大约要 108 块，备 1 组半以上再动手 */
const BUILD_NEED = 128;

/** 技能·盖房子：温饱解决后安个家。成功后写 memory.home（companion 问候语/guardian 防走丢共用锚点） */
async function buildHome(ctx: SkillContext): Promise<SkillResult> {
  const bot = ctx.bot();
  if (!bot) return { success: false, message: '游戏未连接' };
  try {
    if (ctx.memory.data.identity.home) return { success: false, message: '已经有家啦，先住着吧' };

    // 材料盘点：挑库存最多的候选建材，够 BUILD_NEED 才动工
    const stock = BUILD_MATERIALS.map((n) => ({ n, c: countOf(bot, n) })).sort((a, b) => b.c - a.c);
    const best = stock[0];
    if (!best || best.c < BUILD_NEED) {
      return { success: false, message: `建材不够（${best ? best.n + ':' + best.c : '无'}，需要 ${BUILD_NEED}），先囤圆石/木板` };
    }

    // 找一块平地：最近的草/泥土块上方
    const ground = bc(bot.findBlock({ matching: (b) => b.name === 'grass_block' || b.name === 'dirt', maxDistance: 24 }));
    const cx = ground ? ground.x : Math.floor(bot.entity.position.x);
    const cz = ground ? ground.z : Math.floor(bot.entity.position.z);
    const gy = ground ? ground.y + 1 : Math.floor(bot.entity.position.y);
    const sx = cx - 2, sz = cz - 2; // 5x5 小屋：以落点为中心

    const placed = await buildShelterCore(bot, { blockType: best.n, sx, sy: gy, sz, width: 5, depth: 5, height: 4 });
    if (placed < 30) return { success: false, message: `盖到一半卡住了（只放了 ${placed} 块），换个地方再试` };

    // 家 = 小屋中心（guardian 防走丢锚点，companion 问候语用）
    const homePos = [sx + 2, gy + 1, sz + 2] as [number, number, number];
    ctx.memory.data.identity.home = homePos;
    // 记忆点系统：安家落一条 home（旧 home 自动废弃）
    getGlobalLandmark()?.setHome(dimOf(bot), { x: homePos[0], y: homePos[1], z: homePos[2] }, '');
    ctx.memory.addTech('home');
    ctx.memory.setGoal('经营自己的小屋');
    ctx.memory.pushTimeline(`盖好了自己的 ${best.n} 小屋（${placed} 块）`, [sx + 2, gy, sz + 2]);
    return { success: true, message: `盖好了小屋！用 ${placed} 块 ${best.n} 搭的，以后这就是咱家` };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

/** 技能·帮打（rescue）：玩家身边有敌对生物时冲上去清掉（P1.5 战斗支援） */
async function defendPlayer(ctx: SkillContext): Promise<SkillResult> {
  const bot = ctx.bot();
  if (!bot) return { success: false, message: '游戏未连接' };
  try {
    const players = ctx.status().world.players;
    if (!players.some((p) => p.position)) return { success: false, message: '没看到需要保护的玩家' };

    const target = bot.nearestEntity((e) => {
      const name = ((e as unknown as { name?: string }).name ?? '').toLowerCase();
      return HOSTILE_MOBS2.has(name);
    }) as unknown as { name?: string; id?: number; position?: { x: number; y: number; z: number }; attack?: () => Promise<void> } | null;
    if (!target || !target.position || !target.attack) return { success: false, message: '附近没有敌对生物' };
    const name = target.name ?? '敌对生物';
    const d0 = Math.hypot(target.position.x - bot.entity.position.x, target.position.y - bot.entity.position.y, target.position.z - bot.entity.position.z);
    if (d0 > 24) return { success: false, message: `最近的怪物在 ${Math.round(d0)} 格外，够不着` };

    // 冲上去贴脸输出：最多 10 轮，目标消失/死亡即算击退
    let hits = 0;
    for (let i = 0; i < 10; i++) {
      const still = bot.nearestEntity((e) => (e as unknown as { id?: number }).id === target.id) as unknown as { id?: number; position?: { x: number; y: number; z: number }; attack?: () => Promise<void> } | null;
      if (!still || !still.position) break; // 已清掉
      const d = Math.hypot(still.position.x - bot.entity.position.x, still.position.y - bot.entity.position.y, still.position.z - bot.entity.position.z);
      if (d > 3.2) {
        await gotoSmart(bot, new goals.GoalNear(still.position.x, still.position.y, still.position.z, 2), 15000, '追怪');
      }
      if (!still.attack) break;
      try {
        await withTimeout(still.attack(), 5000, '攻击');
        hits++;
      } catch { break; }
      await sleep(250);
    }
    if (hits === 0) return { success: false, message: `${name} 太难缠了，没打中` };
    const victim = players.find((p) => p.position)?.name ?? '玩家';
    ctx.memory.pushTimeline(`帮 ${victim} 击退了 ${name}`);
    return { success: true, message: `冲上去把 ${name} 打跑了（${hits} 连击），${victim} 你没事吧！` };
  } catch (e) {
    return { success: false, message: String(e) };
  }
}

/** 死亡点附近（含半径内）最近的可拾取掉落物（type=object 实体） */
function lootNear(bot: mineflayer.Bot, pos: [number, number, number], r: number): { position: { x: number; y: number; z: number } } | null {
  let best: { position: { x: number; y: number; z: number } } | null = null;
  let bestD = r * r;
  try {
    for (const [, ent] of Object.entries(bot.entities || {})) {
      const e = ent as { type?: string; position?: { x: number; y: number; z: number } };
      if (e.type !== 'object' || !e.position) continue;
      const d = (e.position.x - pos[0]) ** 2 + (e.position.z - pos[2]) ** 2;
      if (d < bestD) { bestD = d; best = { position: e.position }; }
    }
  } catch { /* ignore */ }
  return best;
}

/** 技能·死亡回捡（A1 M0 硬门槛）：重生后回死亡点捡掉落物。
 *  第一次「有掉落 → 走过去 → 捡干净」成功 → 解锁 death_recovery，
 *  此后才允许进入下界链（M5 闸门）。 */
async function deathRecover(ctx: SkillContext): Promise<SkillResult> {
  const bot = ctx.bot();
  if (!bot) return { success: false, message: '游戏未连接' };
  const dp = ctx.memory.data.death_point;
  if (!dp) return { success: false, message: '没有待捡的死亡点（没死过或已经捡回来了）' };
  try {
    const dim = dimOf(bot);
    if (dim !== dp.dim) {
      return { success: false, message: `死亡点在${dp.dim}（${dp.pos.join(',')}），我现在在${dim}，回去那边才能捡` };
    }
    // 死亡点附近原本有没有掉落？没有 = 掉落已消失（超时）或空包死 → 不纠缠，清点收工（不解锁）
    if (!lootNear(bot, dp.pos, 10)) {
      ctx.memory.clearDeathPoint();
      getGlobalLandmark()?.markRetrievedNear({ x: dp.pos[0], y: dp.pos[1], z: dp.pos[2] }); // 已处理完，免当"待回收"悬着
      ctx.memory.pushTimeline(`去${dp.dim}死亡点(${dp.pos.join(',')})看过了，掉落物已消失`);
      return { success: true, message: '过去看了下，掉落物已经消失了（可能隔太久），只能重新攒了' };
    }
    // 走过去，绕死亡点拾取直到清空或超时
    await walkTo(bot, { x: dp.pos[0], y: dp.pos[1], z: dp.pos[2] });
    const deadline = Date.now() + MAX_STEPS.recoverWaitMs;
    while (Date.now() < deadline) {
      const drop = lootNear(bot, dp.pos, 10);
      if (!drop) break; // 捡干净了
      await gotoSmart(bot, new goals.GoalNear(Math.floor(drop.position.x), Math.floor(drop.position.y), Math.floor(drop.position.z), 1), 15000, '捡掉落');
      await sleep(1500);
    }
    const cleared = !lootNear(bot, dp.pos, 10);
    ctx.memory.clearDeathPoint();
    if (!cleared) {
      ctx.memory.pushTimeline(`回${dp.dim}死亡点(${dp.pos.join(',')})捡装备，还剩一点没捡完`);
      return { success: false, message: '回去捡了一部分，还有掉落没捡完（可能卡在方块里），先撤，稍后再来' };
    }
    // 捡干净 → 演练/恢复成功 → 解锁 death_recovery（进下界硬门槛）
    getGlobalLandmark()?.markRetrievedNear({ x: dp.pos[0], y: dp.pos[1], z: dp.pos[2] });
    ctx.memory.addTech('death_recovery');
    ctx.memory.pushTimeline(`回${dp.dim}死亡点(${dp.pos.join(',')})把掉落物都捡回来了！`, dp.pos);
    ctx.memory.setActivity('死亡回捡');
    ctx.emotion?.()?.react('recovered_items');
    return { success: true, message: `把掉在${dp.dim}（${dp.pos.join(',')}）的东西都捡回来了，失而复得！` };
  } catch (e) {
    return { success: false, message: `死亡回捡出岔子: ${String(e)}` };
  }
}

export const skills: Record<string, (ctx: SkillContext) => Promise<SkillResult>> = {
  chop_tree: chopTree,
  mine_stone: mineStone,
  mine_iron: mineIron,
  mine_diamond: mineDiamond,
  mine_obsidian: mineObsidian,
  build_portal: buildPortal,
  gear_up: gearUp,
  enter_nether: enterNether,
  return_home: returnHome,
  plant_farm: plantFarm,
  fish: fishSkill,
  explore: exploreAround,
  build_home: buildHome,
  defend_player: defendPlayer,
  death_recover: deathRecover,
};

// ─────────────────────────────────────────────
// MCP 技能工具（大脑/AstrBot 可一键触发的复合流程）
// ─────────────────────────────────────────────

/** 从工具返回文本中提取第一个坐标 (x, y, z) */
function extractPos(text: string): [number, number, number] | null {
  const m = /\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)/.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 判断工具结果是否成功（失败文本以 ❌ 开头或含"没有"） */
function okRes(res: string): boolean {
  return !res.includes('❌') && !res.includes('没有');
}

export function registerSkillTools(mcp: McpServerManager, ctx: ToolContext): number {
  // ── 技能 1：新手起步（砍树→木板→木棍→工作台→木镐→木斧） ──
  mcp.registerTool(
    'skill-setup-base',
    '【技能·新手起步】一站式初始装备：砍树、拾取、合成木板/木棍/工作台/木镐/木斧',
    {},
    async () => {
      const steps: string[] = [];
      const treeRes = await mcp.callTool('collect-tree', {});
      steps.push(treeRes);
      const nMatch = /共\s*(\d+)\s*个原木/.exec(treeRes);
      const logN = Number(nMatch?.[1] ?? 0);
      await sleep(800);
      // 循环拾取：一根原木一个掉落物，pickup-item 一次只捡最近一个，分散/掉低洼处会漏。
      // 反复拾取直到附近没有掉落物（最多 6 次）。
      for (let pi = 0; pi < 6; pi++) {
        try {
          const pr = await mcp.callTool('pickup-item', { max_distance: 24 });
          if (typeof pr === 'string' && pr.includes('❌')) break;
          steps.push(pr);
        } catch { break; }
        await sleep(300);
      }
      await sleep(500);
      // 硬伤1 修复：不再硬编码 oak_planks。砍回来的原木可能是桦木/云杉/丛林木等，
      // 按背包实际存量反推对应木板名（birch_log → birch_planks），否则合成会因材料不匹配失败。
      const bot = ctx.bot();
      const logToPlanks: Record<string, string> = {
        oak_log: 'oak_planks', spruce_log: 'spruce_planks', birch_log: 'birch_planks',
        jungle_log: 'jungle_planks', acacia_log: 'acacia_planks', dark_oak_log: 'dark_oak_planks',
        mangrove_log: 'mangrove_planks', cherry_log: 'cherry_planks',
      };
      let plankName: string | null = null;
      if (bot) {
        const inv = bot.inventory.items() as unknown as Array<{ name: string; count: number }>;
        for (const it of inv) {
          const p = logToPlanks[it.name];
          if (p && it.count > 0) { plankName = p; break; }
        }
      }
      if (!plankName) {
        plankName = 'oak_planks';
        steps.push('（未识别到原木种类，默认按橡木处理）');
      }
      // 修复：旧的 8 木板会被木棍+工作台耗尽，木镐/木斧没材料（"没有可用配方"）。
      // 需求木板 = 木棍(8根→4板) + 工作台(4板) + 木镐(3板) + 木斧(3板) = 14 板（4 原木）。
      // 砍 N 原木 → 尽量全转化为木板(N*4)，再按顺序合成。
      const plankCount = Math.max(logN * 4, 16);
      if (logN < 4) steps.push(`⚠ 只砍到 ${logN} 个原木，木板可能不足，建议再砍一棵`);
      // 1) 木板（全部转化）
      steps.push(await mcp.callTool('craft-item', { item_name: plankName, count: plankCount }));
      // 2) 木棍（8 根：木镐2+木斧2，留 4 根给后续石镐等工具用）
      steps.push(await mcp.callTool('craft-item', { item_name: 'stick', count: 8 }));
      // 3) 工作台（合成后在背包）
      steps.push(await mcp.callTool('craft-item', { item_name: 'crafting_table', count: 1 }));
      // 4) 木镐（craft-item 会自动把背包工作台放到脚边，然后合成）
      steps.push(await mcp.callTool('craft-item', { item_name: 'wooden_pickaxe', count: 1 }));
      // 5) 木斧（此时工作台已在地面）
      steps.push(await mcp.callTool('craft-item', { item_name: 'wooden_axe', count: 1 }));
      ctx.memory.pushTimeline('执行了技能：新手起步');
      return ok(`【新手起步】\n${steps.join('\n')}`);
    }
  );

  // ── 技能 2：挖铁流程（找铁→挖→圆石→熔炉→熔炼） ──
  mcp.registerTool(
    'skill-mine-iron',
    '【技能·挖铁】找铁矿石、挖掘、收集圆石造熔炉、把铁矿石放入熔炉熔炼',
    {},
    async () => {
      const steps: string[] = [];
      const bot = ctx.bot();
      if (!bot) return fail('游戏未连接');

      // 硬伤2 修复：挖铁矿必须用石镐（或更高级），空手/木镐挖铁矿不掉落会白挖。
      // 有更高级镐就跳过；否则先确保石镐 → 没有就先挖圆石合成。
      const hasStoneOrBetter = (['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'] as const)
        .some((n) => findItemInInventory(bot, n));
      if (!hasStoneOrBetter) {
        // 石镐配方 = 3 圆石 + 2 木棍。
        // a) 确保木棍：setup-base 后可能用完；有任意木板就补造 4 根，否则失败。
        const stickInfo = await mcp.callTool('find-item', { item_name: 'stick' });
        if (!okRes(stickInfo)) {
          let plankKind: string | null = null;
          for (const pk of ['oak_planks','spruce_planks','birch_planks','jungle_planks','acacia_planks','dark_oak_planks']) {
            if (okRes(await mcp.callTool('find-item', { item_name: pk }))) { plankKind = pk; break; }
          }
          if (!plankKind) return fail('造石镐需要木棍，但背包没有木板做木棍，先去砍树（setup-base）');
          steps.push(await mcp.callTool('craft-item', { item_name: 'stick', count: 4 }));
        }
        // b) 挖圆石：石头盖在泥土之下、地表不暴露。用楼梯模式浅挖到石头层，每步捡掉落物，
        //    挖够 12 块圆石就停（不触发"命中 stone 即停"，石头到处都是、命中没意义）。
        const startFootY = Math.floor(bot.entity.position.y);
        const downRes = await mcp.callTool('mine-down', {
          need_count: 12,
          target_depth: startFootY - 6,
          max_depth: 12,
          staircase: true,
        });
        steps.push(`楼梯下挖石头：${downRes}`);
        await sleep(600);
        const finalCobble = await mcp.callTool('find-item', { item_name: 'cobblestone' });
        if (!okRes(finalCobble)) {
          return fail(`楼梯下挖后仍没挖到圆石（${downRes}），无法造石镐`);
        }
        const cm = /x(\d+)/.exec(finalCobble);
        const gotStone = cm ? Number(cm[1]) : 0;
        steps.push(`为造石镐挖到 ${gotStone} 块圆石`);
        // 沿楼梯回地表（工作台在楼梯口，平走几步即可到）
        try {
          const table = bot.findBlock({ matching: (b: { name: string }) => b.name === 'crafting_table', maxDistance: 24 }) as unknown as
            { position?: { x: number; y: number; z: number } } | null;
          if (table?.position) {
            const { goals } = require('@nxg-org/mineflayer-pathfinder') as { goals: any };
            await gotoSmart(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 20000, '回工作台');
          }
        } catch { /* 回不去则不致命，craft-item 会再尝试 */ }
        // c) 合成石镐（需要工作台，craft-item 会自动放置）
        const spRes = await mcp.callTool('craft-item', { item_name: 'stone_pickaxe', count: 1 });
        if (!okRes(spRes)) return fail(`圆石够了但石镐没合成（可能缺木棍/工作台）：${spRes}`);
        steps.push('合成了石镐');
      }
      try { await equipByName(bot, 'stone_pickaxe'); } catch { /* 装备失败不致命 */ }

      const findRes = await mcp.callTool('find-blocks', { block_type: 'iron_ore', max_distance: 48 });
      const pos = extractPos(findRes);
      if (!pos) return fail('附近 48 格内没有铁矿，换个地方再试');
      steps.push(findRes);
      // 面向铁矿，让楼梯斜挖朝矿方向推进（侧向命中即停）
      faceToward(bot, pos[0], pos[1], pos[2]);

      // 模式 B：铁矿常在地下不暴露。走到矿附近地表 → 面向矿 → 楼梯斜下挖（侧向命中 iron_ore 即停）。
      // 楼梯可回走，挖完能沿台阶回工作台（不搞竖井，竖井下去回不来）。
      const ironDRes = await mcp.callTool('mine-down', {
        target: 'iron_ore',
        target_depth: Math.max(-40, pos[1] - 1),
        max_depth: 48,
        staircase: true,
      });
      steps.push(ironDRes);
      await sleep(800);
      try {
        steps.push(await mcp.callTool('pickup-item', { max_distance: 20 }));
      } catch { /* 无掉落物 */ }

      // 硬伤3 修复：熔炉改用 ensureFurnace（内部会检查目标格空气+下方支撑、8 圆石合成、就近/自放）。
      // 它不是"尽力而为"，放不了会返回 false，这里才真正 fail。
      const hasFurnace = await ensureFurnace(bot, ctx as never);
      if (!hasFurnace) return fail('没有熔炉：附近无现成熔炉，圆石也不够 8 块造一个，先回去造个工作台并攒圆石');
      steps.push('熔炉就绪');

      // 熔炼并取回铁锭（挖掉的铁矿石掉落 raw_iron，按实际库存选原料名；等出炉自动收成品）
      const coal = await mcp.callTool('find-item', { item_name: 'coal' });
      const fuel = okRes(coal) ? 'coal' : 'oak_planks';
      const rawItem = await mcp.callTool('find-item', { item_name: 'raw_iron' });
      const rawName = okRes(rawItem) ? 'raw_iron' : 'iron_ore';
      const smelt = await mcp.callTool('smelt-batch', { item_name: rawName, result_name: 'iron_ingot', count: 1, fuel });
      steps.push(smelt);
      ctx.memory.pushTimeline('执行了技能：挖铁');
      return ok(`【挖铁流程】\n${steps.join('\n')}`);
    }
  );


  // ── 技能 7：挖钻石做钻石镐（A1 M1：下界链第一步硬装备） ──
  mcp.registerTool(
    'skill-mine-diamond',
    '【技能·挖钻石】装备铁镐找钻石矿挖钻石，凑 3 颗用工作台合成钻石镐（解锁 diamond_pickaxe）。下界链 M1 里程碑',
    {},
    async () => {
      const res = await skills.mine_diamond(ctx as never);
      return res.success ? ok(`【挖钻石】${res.message}`) : fail(res.message);
    }
  );

  // ── 技能 8：水浇岩浆挖黑曜石（A1 M2：传送门材料） ──
  mcp.registerTool(
    'skill-mine-obsidian',
    '【技能·挖黑曜石】装备钻石镐，用水桶把岩浆源浇成黑曜石再挖。单源放置失败自动重试≤3次，桶空自动去水源装回，凑满 14 块解锁 obsidian（下界链 M2 里程碑）',
    {},
    async () => {
      const res = await skills.mine_obsidian(ctx as never);
      return res.success ? ok(`【挖黑曜石】${res.message}`) : fail(res.message);
    }
  );

  // ── 技能 9：搭下界传送门（A1 M3：点火点亮） ──
  mcp.registerTool(
    'skill-build-portal',
    '【技能·搭传送门】选址检测（脚下平整/上方净空/无易燃物），失败自动换候选位置不原地死磕；10 块黑曜石搭 4×5 框、打火石点火、确认 portal 激活。解锁 portal（下界链 M3 里程碑）',
    {},
    async () => {
      const res = await skills.build_portal(ctx as never);
      return res.success ? ok(`【搭传送门】${res.message}`) : fail(res.message);
    }
  );

  // ── 技能 10：进下界（A1 M5：进传送门 + 记下界出口门坐标） ──
  mcp.registerTool(
    'skill-enter-nether',
    '【技能·进下界】走到主世界传送门站入 portal 块等传送，落地后记下界侧出口门坐标（identity.nether_portal），解锁 nether。3 次没触发就报错不硬闯',
    {},
    async () => {
      const res = await skills.enter_nether(ctx as never);
      return res.success ? ok(`【进下界】${res.message}`) : fail(res.message);
    }
  );

  // ── 技能 11：下界回穿（A1 M8 雏形/安全网） ──
  mcp.registerTool(
    'skill-return-home',
    '【技能·回穿主世界】在下界走回出口传送门并站框传回主世界。找不到点亮门会报错提示，不在下界时直接拒绝',
    {},
    async () => {
      const res = await skills.return_home(ctx as never);
      return res.success ? ok(`【回穿主世界】${res.message}`) : fail(res.message);
    }
  );

  // ── 技能 12：下界前装备补给（A1 M4 gate 的补给闭环） ──
  mcp.registerTool(
    'skill-gear-up',
    '【技能·装备补给】进下界前缺啥补啥：金锭不足挖金矿熔炼补齐 4 个；缺铁剑/铁甲/打火石就熔炼铁锭逐件合成。缺食物不管（交给日常）',
    {},
    async () => {
      const res = await skills.gear_up(ctx as never);
      return res.success ? ok(`【装备补给】${res.message}`) : fail(res.message);
    }
  );

  return 8;
}
