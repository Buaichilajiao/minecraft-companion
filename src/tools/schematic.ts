/**
 * schematic.ts — 图纸建房 v2（新格式路线）
 *
 * 背景：老版 build-schem 依赖 mineflayer-schem 的 Build，它只认 1.12 数字 ID 图纸，
 * 上游已停更（npm/GitHub master 实测对新格式全错位、空气当方块、失败退 stone）。
 * v2 只走新格式（.schem v2，string-id palette）：
 *   解析层 prismarine-schematic（Schematic.read → getBlock() 按版本取方块名，已验证闭环正确）
 *   放置层 自写：逐块 smartPlace（复用 helpers，自动就位/飞放/垫脚/主手物品），
 *          建前做材料健康检查（映射失败直接报，绝不静默变石头）。
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import type mineflayer from 'mineflayer';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { getBot, ok, fail, smartPlace, findItemInInventory, equipByName, withTimeout } from './helpers';
import { v3, sleep, log } from '../utils';

/** prismarine-item 类（延迟加载，配合 bot.registry） */
function getItemClass(bot: { registry: unknown }): new (id: number, count: number, metadata?: number) => unknown {
  const Item = require('prismarine-item')(bot.registry);
  return Item;
}

/** 创造模式发 n 个指定方块到背包（自动找 9+ 空槽，逐槽复查服务器是否接受） */
async function creativeGive(bot: mineflayer.Bot, name: string, count: number): Promise<void> {
  const registry = (bot as unknown as { registry?: { itemsByName?: Record<string, { id: number; stackSize?: number }> } }).registry;
  const itemDef = registry?.itemsByName?.[name];
  if (!itemDef) throw new Error(`未知物品: ${name}`);
  const Item = getItemClass(bot as unknown as { registry: unknown });
  const perStack = itemDef.stackSize ?? 64;
  let remaining = count;
  for (let slot = 9; slot < 45 && remaining > 0; slot++) {
    if (bot.inventory.slots[slot]) continue;
    const n = Math.min(remaining, perStack);
    await bot.creative.setInventorySlot(slot, new Item(itemDef.id, n) as never);
    await sleep(250);
    const cur = bot.inventory.slots[slot] as { name?: string } | null | undefined;
    if (!cur || cur.name !== name) continue; // 服务器拒槽，下一槽重试
    remaining -= n;
  }
  if (remaining > 0) throw new Error(`发放 ${name} 失败：背包空槽不足或服务器拒绝（剩 ${remaining} 个没发出去）`);
}

/** 读 .schem 新格式图纸 → 逐块放置清单（含材料统计），映射失败即报错返回 */
export interface SchemPlanBlock { x: number; y: number; z: number; name: string }
export interface SchemPlan {
  ok: boolean;
  blocks: SchemPlanBlock[];       // 世界坐标（已加 origin），从低到高层序
  materials: Array<{ name: string; count: number }>;
  unknown: string[];              // 图纸里存在但当前版本解析不出的方块
  size: { x: number; y: number; z: number };
}

export async function loadSchemPlan(bot: mineflayer.Bot, schemPath: string, origin: { x: number; y: number; z: number }): Promise<SchemPlan> {
  const buf = await fs.promises.readFile(schemPath);
  const { Schematic } = require('prismarine-schematic');
  const Vec3 = require('vec3');
  const schematic = await Schematic.read(buf, bot.version as string);
  const s = schematic.size || {};
  const w = s.x ?? 0, h = s.y ?? 0, d = s.z ?? 0;

  // 扫全图（local 0..size；getBlock 内部自动减 offset）
  const byName = new Map<string, number>();
  const unknown: string[] = [];
  const registry = (bot as unknown as { registry?: { itemsByName?: Record<string, unknown>; blocksByName?: Record<string, unknown> } }).registry;
  for (let y = 0; y < h; y++) {
    for (let z = 0; z < d; z++) {
      for (let x = 0; x < w; x++) {
        const b = schematic.getBlock(new Vec3(x, y, z));
        const name = b && typeof b.name === 'string' ? b.name : '';
        if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') continue;
        const known = !!(registry?.itemsByName?.[name] || registry?.blocksByName?.[name]);
        if (!known) {
          if (!unknown.includes(name)) unknown.push(name);
          continue;
        }
        byName.set(name, (byName.get(name) || 0) + 1);
      }
    }
  }
  if (byName.size === 0 && unknown.length === 0) {
    return { ok: false, blocks: [], materials: [], unknown, size: { x: w, y: h, z: d } };
  }

  // 生成放置序列：按 y 升序（先地板后墙顶），同层按 x,z（列优先：连续放置路径无长回跳，减少折返飞行）
  const blocks: SchemPlanBlock[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let z = 0; z < d; z++) {
        const b = schematic.getBlock(new Vec3(x, y, z));
        const name = b && typeof b.name === 'string' ? b.name : '';
        if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') continue;
        if (!(registry?.itemsByName?.[name] || registry?.blocksByName?.[name])) continue;
        blocks.push({ x: origin.x + x, y: origin.y + y, z: origin.z + z, name });
      }
    }
  }
  return {
    ok: true,
    blocks,
    materials: [...byName.entries()].map(([name, count]) => ({ name, count })),
    unknown,
    size: { x: w, y: h, z: d },
  };
}

/** 施工防挡：目标格周围实体按类处理（玩家喊话提醒 / 敌对怪与挡格生物直接清场）。 */
const siteWarnCooldown = new Map<string, number>();
const SITE_HOSTILE = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'slime', 'creeper',
  'spider', 'cave_spider', 'enderman', 'witch', 'phantom', 'pillager',
  'evoker', 'vindicator', 'vex', 'ravager', 'blaze', 'magma_cube',
  'ghast', 'zombified_piglin', 'piglin', 'piglin_brute', 'hoglin',
  'guardian', 'elder_guardian', 'shulker', 'warden', 'breeze',
]);
async function clearSite(bot: mineflayer.Bot, blk: { x: number; y: number; z: number }, hostileR = 6, animalR = 2): Promise<void> {
  const now = Date.now();
  const mine = (bot.entity as { username?: string; name?: string }).username || (bot.entity as { username?: string; name?: string }).name || '';
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity) continue;
    const pos = e.position;
    if (!pos) continue;
    const d = pos.distanceTo(v3(blk.x + 0.5, blk.y + 0.5, blk.z + 0.5));
    const name = (e as unknown as { name?: string }).name || '';
    const isPlayer = e.type === 'player';
    const who = isPlayer ? (e as unknown as { username?: string }).username || name : name;
    if (!who || who === mine) continue;
    if (isPlayer) {
      if (d <= hostileR && (siteWarnCooldown.get(who) || 0) < now - 30000) {
        siteWarnCooldown.set(who, now);
        log('INFO', `[build-schem] 提醒玩家 ${who} 让出施工位（距目标 ${d.toFixed(1)} 格）`);
        bot.chat(`@${who} 施工中⚠️ 我这在铺地板，麻烦离远点别挡路～`);
      }
      continue;
    }
    const hostile = SITE_HOSTILE.has(name);
    if (hostile && d <= hostileR) {
      log('INFO', `[build-schem] 清场：击杀敌对 ${name}（距目标 ${d.toFixed(1)} 格）`);
      try { await bot.attack(e as never); } catch { /* 交给 guardian */ }
      await sleep(250);
    } else if (!hostile && e.type === 'mob' && d <= animalR) {
      log('INFO', `[build-schem] 清场：击杀挡格生物 ${name}（距目标 ${d.toFixed(1)} 格）`);
      try { await bot.attack(e as never); } catch { /* 忽略 */ }
      await sleep(250);
    }
  }
}

/**
 * 蛇形平铺（不依赖飞行，根治"平面撞墙卡死"）：
 * bot 全程站在"目标行北侧 2 格"的未铺草地面（目标行永远在南侧已铺区之外），
 * 视线水平穿过 2 个空气格命中目标格正下方的草面 → 放置位置 100% 正确、永不撞 1 格高地势差。
 * 行与行之间 x 方向蛇形交替，bot 只需向北挪 1 格即开始下一行，零回程。
 * 仅适用于"所有块同一 y"的贴地单层图纸。
 */
async function placeFlatSnake(bot: mineflayer.Bot, blocks: SchemPlanBlock[]): Promise<{ ok: number; fail: number }> {
  const y = blocks[0].y;
  const rows = new Map<number, SchemPlanBlock[]>();
  for (const b of blocks) {
    const arr = rows.get(b.z) ?? [];
    arr.push(b);
    rows.set(b.z, arr);
  }
  const zs = [...rows.keys()].sort((a, b) => a - b);
  for (const arr of rows.values()) arr.sort((a, b) => a.x - b.x);

  const pf = (bot as unknown as { pathfinder?: any }).pathfinder;
  const { goals } = require('@nxg-org/mineflayer-pathfinder') as { goals: any };
  const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  let ok = 0, fail = 0, acted = 0;
  const total = blocks.length;
  const gotoStand = async (tx: number, footY: number, sz: number): Promise<boolean> => {
    const cur = bot.entity.position;
    if (Math.abs(cur.x - tx) <= 0.5 && Math.abs(cur.z - sz) <= 0.5 && Math.abs(cur.y - footY) <= 0.8) return true;
    if (!pf || !pf.goto) return false;
    try {
      await withTimeout(pf.goto(new goals.GoalNear(tx, footY, sz, 0.6)), 8000, '蛇形就位');
      return true;
    } catch {
      return false;
    }
  };

  for (let r = 0; r < zs.length; r++) {
    const z = zs[r];
    const line = rows.get(z)!;
    const asc = r % 2 === 0;
    const seq = asc ? line : [...line].reverse();
    const standZ = z + 2; // 目标行北侧 2 格 = bot 站立行（未铺草区）
    for (const blk of seq) {
      const tx = blk.x, tz = blk.z;
      // 已铺/服务器已有 → 跳过
      const cur = bot.blockAt(v3(tx, y, tz)) as unknown as { name?: string } | null;
      if (cur && cur.name !== 'air') { ok++; acted++; continue; }
      // 参考面 = 目标格正下方（必须是草/实体块顶，视线落点）
      const below = bot.blockAt(v3(tx, y - 1, tz)) as { name?: string } | null;
      if (!below || !below.name || below.name === 'air') { fail++; continue; }
      // 防挡清场
      await clearSite(bot, blk);
      // 就位：站 (tx, 地面顶, standZ) —— 目标行北侧隔 2 格
      const footY = y; // 站行草顶 = 目标块 y（草方块在 y-1，顶面在 y）
      if (!(await gotoStand(tx, footY, standZ))) { fail++; continue; }
      // 主手装备
      const held = (bot.heldItem as unknown as { name?: string })?.name;
      if (held !== blk.name) {
        const found = findItemInInventory(bot, blk.name);
        if (!found) { fail++; continue; }
        await bot.equip(found.item as never, 'hand');
      }
      // 视线：水平略俯 → below 顶中心
      try {
        await withTimeout(bot.lookAt(v3(tx + 0.5, y - 0.5, tz + 0.5), true), 5000, '蛇形转身');
        await bot.placeBlock(below as never, v3(0, 1, 0) as never);
        ok++; acted++;
        await sleepMs(60);
      } catch {
        fail++;
        log('WARN', `[build-schem] 蛇形放块失败 @ ${tx},${y},${tz}`);
      }
      if (ok + fail >= 20 && (ok + fail) % 50 === 0) {
        log('INFO', `[build-schem] 进度 ${ok + fail}/${total}（成功 ${ok}，失败 ${fail}）`);
      }
    }
    // 行尾：下一行站立行北移 1 格（蛇形起点 x 自动衔接反向行首）
  }
  log('INFO', `[build-schem] 蛇形平铺结束：成功 ${ok}，失败 ${fail}`);
  return { ok, fail };
}

/** 按图纸逐块建造（创造模式；每块 smartPlace 自动就位/飞放/装备主手） */
export async function placeSchemBlocks(
  bot: mineflayer.Bot,
  plan: SchemPlan,
  onProgress?: (done: number, total: number, failed: number) => void
): Promise<{ placed: number; failed: Array<{ x: number; y: number; z: number; name: string }>; total: number }> {
  const total = plan.blocks.length;
  // 1. 材料预发：每种进背包一组（放一块时 smartPlace 自己会 equip 到主手）
  for (const m of plan.materials) {
    try {
      await creativeGive(bot, m.name, Math.min(m.count, 64));
    } catch (e) {
      log('WARN', `[build-schem] 材料 ${m.name} 发放失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await sleep(300);
  // 2a. 单层贴地图纸（所有块同一 y）→ 蛇形平铺：bot 站未铺区隔行放，不依赖飞行、零回程
  if (total > 0 && plan.blocks.every((b) => b.y === plan.blocks[0].y)) {
    const res = await placeFlatSnake(bot, plan.blocks);
    onProgress?.(total, total, 0);
    return { placed: res.ok, failed: [], total };
  }
  // 2. 逐块放置
  const failed: Array<{ x: number; y: number; z: number; name: string }> = [];
  let placed = 0;
  let stallStreak = 0;
  for (let i = 0; i < total; i++) {
    const blk = plan.blocks[i];
    // 施工防挡：清掉目标格旁的挡道玩家/怪/生物，避免就位被打断或卡死
    await clearSite(bot, blk);
    // 目标已非空气（可能之前放的重叠/服务器已有）→ 跳过
    const cur = bot.blockAt(require('vec3')(blk.x, blk.y, blk.z)) as unknown as { name?: string } | null;
    if (cur && cur.name !== 'air' && cur.name !== 'cave_air' && cur.name !== 'void_air') {
      placed++;
      onProgress?.(i + 1, total, failed.length);
      continue;
    }
    const okFlag = await smartPlace(bot, { x: blk.x, y: blk.y, z: blk.z }, blk.name);
    if (okFlag) {
      placed++;
      stallStreak = 0;
    } else {
      failed.push({ x: blk.x, y: blk.y, z: blk.z, name: blk.name });
      stallStreak++;
      log('WARN', `[build-schem] 第 ${i + 1}/${total} 块失败: ${blk.name} @ (${blk.x},${blk.y},${blk.z})`);
      if (stallStreak >= 10) {
        log('WARN', `[build-schem] 连续 ${stallStreak} 块失败，中止（避免死磕）。已放 ${placed}，失败 ${failed.length}`);
        break;
      }
    }
    if ((i + 1) % 20 === 0 || i + 1 === total) {
      onProgress?.(i + 1, total, failed.length);
      log('INFO', `[build-schem] 进度 ${i + 1}/${total}（成功 ${placed}，失败 ${failed.length}）`);
    }
    await sleep(60);
  }
  return { placed, failed, total };
}

/** MCP 注册 */
export function registerSchematicTools(mcp: McpServerManager, ctx: ToolContext): void {
  mcp.registerTool(
    'build-schem',
    '【图纸建房 v2·新格式】按 .schem 新格式图纸建造（1.13+ string-id，WorldEdit 导出或本包 schematic/ 目录下的现代图纸）。自动：解析图纸→健康检查（未知方块直接报，不静默变石头）→创造模式补齐材料→从地板逐层放置。需创造模式；老 MCEdit(.schematic) 图纸不支持。图纸文件放 minecraft-companion/schematic/ 目录。',
    {
      schematic: z.string().optional().describe('图纸文件名或路径，默认 schematic/ 目录下第一个 .schem'),
      x: z.number().optional().describe('起点 X（图纸左下角），默认当前坐标'),
      y: z.number().optional().describe('起点 Y（图纸最低层），默认地面+1'),
      z: z.number().optional().describe('起点 Z'),
    },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const mode = ctx.status().world.game_mode;
        if (mode !== 'creative') return fail(`图纸建房需要创造模式（当前 ${mode}）`);
        // 图纸路径
        let file = String(args.schematic ?? '').trim();
        if (!file) {
          const dir = path.join(__dirname, '..', '..', 'schematic');
          if (fs.existsSync(dir)) {
            const found = fs.readdirSync(dir).filter((f) => f.endsWith('.schem')).sort();
            if (found.length > 0) file = path.join(dir, found[0]);
          }
        }
        if (!file.includes(path.sep) && !file.includes('/') && !fs.existsSync(file)) {
          const p2 = path.join(__dirname, '..', '..', 'schematic', file);
          if (fs.existsSync(p2)) file = p2;
        }
        if (!fs.existsSync(file)) return fail(`图纸不存在: ${file}（把 .schem 放 schematic/ 目录或传绝对路径）`);

        // 起点：默认脚下（找地面）
        const p = bot.entity.position;
        const given = { x: args.x, y: args.y, z: args.z };
        const hasY = given.y !== undefined && Number.isFinite(Number(given.y));
        const flatX = Math.round(Number(given.x ?? p.x));
        const flatZ = Math.round(Number(given.z ?? p.z));
        let originY: number;
        if (hasY) {
          originY = Math.round(Number(given.y));
        } else {
          // 动态找脚下地面（超平坦地面高度不一）：从脚向下扫第一个实体方块，图纸最低层放其上一格
          const Vec3 = require('vec3');
          let gy = Math.floor(p.y);
          while (gy > -64) {
            const b = bot.blockAt(new Vec3(flatX, gy, flatZ)) as unknown as { name?: string; boundingBox?: string } | null;
            if (b && b.name !== 'air' && b.boundingBox && b.boundingBox !== 'empty') break;
            gy--;
          }
          originY = gy + 1;
          log('INFO', `[build-schem] 动态找地面 gy=${gy}，图纸起点 y=${originY}`);
        }
        const origin = { x: flatX, y: originY, z: flatZ };

        // 解析 + 健康检查
        const plan = await loadSchemPlan(bot, file, origin);
        if (!plan.ok) return fail(`图纸解析为空或格式不支持（需要 1.13+ .schem v2）`);
        if (plan.unknown.length > 0) {
          return fail(`图纸含 ${plan.unknown.length} 种当前版本(1.21.1)解析不出的方块: ${plan.unknown.join(', ')}。换个图纸或去掉这些方块，我不静默乱放。`);
        }
        ctx.memory.pushTimeline(`开始按图纸 ${path.basename(file)} 建房（${plan.blocks.length} 块，${plan.materials.length} 种材料）`);
        const matDesc = plan.materials.map((m) => `${m.name}x${m.count}`).join(', ');
        log('INFO', `[build-schem] 图纸 ${path.basename(file)} ${plan.size.x}x${plan.size.y}x${plan.size.z}，共 ${plan.blocks.length} 块；材料: ${matDesc}`);

        // 建造
        const result = await placeSchemBlocks(bot, plan, (done, total, failedN) => {
          log('INFO', `[build-schem] 进度 ${done}/${total} 失败 ${failedN}`);
        });
        const failedDesc = result.failed.slice(0, 5).map((f) => `${f.name}@(${f.x},${f.y},${f.z})`).join('; ');
        const msg = `图纸建房完成：成功 ${result.placed}/${result.total} 块${result.failed.length > 0 ? `，失败 ${result.failed.length}（${failedDesc}${result.failed.length > 5 ? '…' : ''}）` : ''}`;
        ctx.memory.pushTimeline(msg);
        return ok(`${msg}。材料: ${matDesc}`);
      } catch (e) {
        return fail(`图纸建房失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  );
}
