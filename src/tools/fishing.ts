/**
 * 钓鱼核心（P2-1：真实钓鱼流程）
 * ─────────────────────────────────────────────
 * 与 P1.5 buildShelterCore 同一原则：MCP fish 工具与 lifestyle fish 技能
 * 共用同一份实现，避免"工具一套、技能一套"的分裂。
 *
 * 真实流程（对照旧简化版 8s 硬收杆）：
 *   抛竿(bot.fish cast) → 等咬钩粒子 → mineflayer 自动收杆 → 判定鱼获
 * mineflayer 的 bot.fish() 返回的 Promise 在"检测到咬钩粒子并自动收杆"时 resolve，
 * 超时/鱼脱钩（bobber 销毁）时 reject —— 我们据此判定本次是否真正钓到。
 * 不再用 activateBlock 假抛竿 + 固定 8s 收杆（那种做法根本没判定过是否上钩）。
 *
 * 鱼获判定：抛竿前后背包快照 diff（收杆后掉落物可能延迟到身边，先等 1.2s，
 * 没捡到再尝试走到最近的掉落物旁）。
 * 稀有判定：对照钓鱼 treasure 战利品表（bow/enchanted_book/name_tag/
 * nautilus_shell/saddle），命中则返回 rare=true 供调用方触发 fished_rare 情绪。
 */
import type mineflayer from 'mineflayer';
import { log, sleep, v3 } from '../utils';
import { findItemInInventory, withTimeout, gotoSmart } from './helpers';
import { goals } from '@nxg-org/mineflayer-pathfinder';

export interface FishCatch {
  caught: boolean;
  /** 鱼获物品名（没识别到为空串） */
  item: string;
  /** 是否稀有（treasure 战利品） */
  rare: boolean;
}

/** 钓鱼 treasure 战利品表（1.14+ 的 fishing/treasure.json 掉落物） */
const TREASURE_ITEMS = new Set([
  'bow', 'enchanted_book', 'name_tag', 'nautilus_shell', 'saddle',
]);

function invSnapshot(bot: mineflayer.Bot): Map<string, number> {
  const map = new Map<string, number>();
  for (const it of bot.inventory?.items?.() ?? []) {
    const name = (it as { name?: string }).name ?? 'unknown';
    const count = (it as { count?: number }).count ?? 0;
    map.set(name, (map.get(name) ?? 0) + count);
  }
  return map;
}

/** 抛竿后新增的物品名（before 里没有或数量变多的那个），没有返回 null */
function gainedItem(before: Map<string, number>, after: Map<string, number>): string | null {
  for (const [name, afterCount] of after) {
    const beforeCount = before.get(name) ?? 0;
    if (afterCount > beforeCount) return name;
  }
  return null;
}

/** 尝试走到最近的掉落物旁等它进包（捡不到不致命） */
async function tryPickupNearby(bot: mineflayer.Bot): Promise<void> {
  try {
    const item = bot.nearestEntity((e) => {
      const t = (e as unknown as { type?: string }).type ?? '';
      return t === 'object';
    }) as unknown as { position?: { x: number; y: number; z: number } } | null;
    if (!item?.position) return;
    const my = bot.entity.position;
    const dist = Math.hypot(item.position.x - my.x, item.position.y - my.y, item.position.z - my.z);
    if (dist > 14) return;
    await gotoSmart(
      bot,
      new goals.GoalNear(item.position.x, item.position.y, item.position.z, 1.8),
      20000,
      '捡鱼获'
    );
    await sleep(1500);
  } catch {
    /* 在水中央等走不到的地方就放弃 */
  }
}

/**
 * 完整钓一次鱼（抛竿 → 等咬钩 → 自动收杆 → 判定鱼获）。
 * 失败抛错（无竿/无水/等待被取消），调用方决定怎么处理。
 */
export async function fishOnce(
  bot: mineflayer.Bot,
  opts?: { castTimeoutMs?: number }
): Promise<FishCatch> {
  const rod = findItemInInventory(bot, 'fishing_rod');
  if (!rod) throw new Error('背包里没有钓鱼竿');
  const water = bot.findBlock({
    matching: (b) => b.name === 'water' || b.name === 'flowing_water',
    maxDistance: 20,
  }) as unknown as { position: { x: number; y: number; z: number } } | null;
  if (!water) throw new Error('附近 20 格内没有水');
  // 修复：Block 坐标在 .position，旧代码误用 .x/.y/.z（undefined）致寻水/抛竿全失败
  const wx = water.position.x, wy = water.position.y, wz = water.position.z;

  // 1) 装备鱼竿，走到水边
  await bot.equip(rod.item as never, 'hand');
  try {
    await gotoSmart(bot, new goals.GoalNear(wx, wy, wz, 1.6), 30000, '走到水边');
  } catch (e) {
    log('WARN', `[fish] 走到水边失败，原地抛竿: ${e}`);
  }

  // 2) 面向水面（bobber 落点贴近岸边，收杆后掉落物好捡）
  const castPoint = { x: wx + 0.5, y: wy + 0.5, z: wz + 0.5 };
  try {
    await withTimeout(bot.lookAt(v3(castPoint.x, castPoint.y, castPoint.z)), 5000, '看向水面');
  } catch {
    /* lookAt 失败不致命 */
  }
  await sleep(300);

  // 3) 抛竿并等咬钩（mineflayer 检测到咬钩粒子会自动收杆并 resolve）
  const before = invSnapshot(bot);
  try {
    await withTimeout(bot.fish(), opts?.castTimeoutMs ?? 45000, '等鱼上钩');
  } catch (e) {
    // 超时/鱼脱钩：手动收杆取消当前鱼钩，别留个 bobber 在水里
    try {
      await bot.activateItem();
    } catch {
      /* ignore */
    }
    log('INFO', `[fish] 没钓到（${e instanceof Error ? e.message : String(e)}）`);
    return { caught: false, item: '', rare: false };
  }

  // 4) 收杆成功：等掉落物飞过来，判定鱼获
  await sleep(1200);
  let after = invSnapshot(bot);
  let item = gainedItem(before, after);
  if (!item) {
    // 可能掉在水里没捡到 → 尝试走近一点再判定一次
    await tryPickupNearby(bot);
    after = invSnapshot(bot);
    item = gainedItem(before, after);
  }
  const name = item ?? 'unknown';
  const rare = !!item && TREASURE_ITEMS.has(item);
  log('INFO', `[fish] 钓到了 ${name}${rare ? '（稀有！）' : ''}`);
  return { caught: true, item: name, rare };
}
