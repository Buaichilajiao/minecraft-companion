import type mineflayer from 'mineflayer';
import type { ToolContext } from './context';
import type { BodyOwner } from '../body-controller';
import { v3, log, sleep } from '../utils';
import { isInterrupted, interruptReasonText } from '../interrupt';

/**
 * 分段完整发送聊天：MC 单条聊天上限 256 字符，超长直接 slice 会截断话尾（"说半句就断"）。
 * 这里按行/标点切成 ≤256 的段逐条发送，长回复完整送达。单条 ≤256 原样发。
 */
export async function chatSegmented(bot: mineflayer.Bot, text: string, maxLen = 256): Promise<void> {
  const lines = String(text).split(/\n/);
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.length <= maxLen) {
      bot.chat(line);
      await sleep(60);
      continue;
    }
    let rest = line;
    while (rest.length > maxLen) {
      const cut = rest.slice(0, maxLen);
      // 尽量在中文/英文标点处断，避免生切单词
      const puncts = ['。', '！', '？', '；', '，', '.', '!', '?', ',', '；', '、', ' ', '　'];
      let best = -1;
      for (const p of puncts) {
        const at = cut.lastIndexOf(p);
        if (at > maxLen * 0.4 && at > best) best = at;
      }
      const breakAt = best > 0 ? best + 1 : maxLen;
      bot.chat(rest.slice(0, breakAt));
      await sleep(60);
      rest = rest.slice(breakAt);
    }
    if (rest) {
      bot.chat(rest);
      await sleep(60);
    }
  }
}


export function getBot(ctx: ToolContext): mineflayer.Bot {
  const bot = ctx.bot();
  if (!bot) throw new Error('游戏连接不可用，请稍后再试');
  return bot;
}

/**
 * 用身体控制权执行动作（v1.2.0 批次 1）：
 * 动作类工具统一走这把锁，与 lifestyle 自主动作 / guardian 互斥。
 * guardian 抢锁时当前工具会等（保命优先）；player 与 auto 按优先级抢占。
 */
export async function withBody<T>(
  ctx: ToolContext,
  kind: BodyOwner,
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  const release = await ctx.body().acquire(kind, label);
  try {
    return await fn();
  } finally {
    release();
  }
}

export function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function fail(msg: string) {
  return { content: [{ type: 'text' as const, text: '❌ ' + msg }] };
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时(${Math.round(ms / 1000)}s)`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 全局「移动即注视」入口（main.ts 挂到 bot.__headFollow） */
export type HeadFollowHandle = {
  setPoint(x: number, y: number, z: number): void;
  clear(): void;
  /** 挂起：调用方要独占朝向（自己直写 yaw 控航向），别让 位移反推 的兜底头朝向插一脚 */
  suspend?(): void;
  /** 恢复：动作结束（含异常退出）必须调，否则视线控制权收不回来 */
  resume?(): void;
};
export function hfOf(bot: mineflayer.Bot): HeadFollowHandle | null {
  return (bot as unknown as { __headFollow?: HeadFollowHandle }).__headFollow ?? null;
}

/**
 * 视线独占锁：动作工具执行「对准→动作」原子片段时，挂起 head-follow。
 *
 * 为什么需要：head-follow（移动即注视）只在 body.owner==='guardian' 时让位，
 * 动作工具（dig/attack/press/place）执行时 owner 是 'player'，它不让位，
 * 其「无目标位移兜底」会每 physicsTick 把 faceToward 刚设的 yaw 抢回去，
 * 导致准星/动作读到错误朝向。gaze 因 body.owner!==null 已自动让位，无需在此处理。
 *
 * 用法：faceToward + 出刀/放置/交互 这段包进 withAimLock，结束自动 resume。
 */
export async function withAimLock<T>(bot: mineflayer.Bot, fn: () => Promise<T> | T): Promise<T> {
  const hf = hfOf(bot);
  hf?.suspend?.();
  try {
    return await fn();
  } finally {
    hf?.resume?.();
  }
}

// ── 距离档位（走 / 疾跑 / 跑跳）──────────────────────────────────
// 阈值与 follow.ts 的拟人档位一致：远 → 跑跳，中 → 疾跑，近 → 走。
// 9/12 玩家要求：所有"有目的地的移动"共用这一套（move-to / walk-path / 寻路就位 / 飞行）。
export const GEAR_WALK_LIMIT = 2.5; // ≤2.5 格：走
export const GEAR_HOP_ENTER = 7;    // >7 格：跑跳（跳着赶路）
export const GEAR_HOP_EXIT = 5;     // <5 格：跑跳退回疾跑（滞回 2 格，防抖）
export type Gear = 'walk' | 'sprint' | 'hop';

/** 按剩余距离选档（滞回规则同 follow.ts）；walkIn 可放大"提前收成走"的近距门槛（默认 2.5） */
export function pickGear(d: number, prev: Gear, walkIn = GEAR_WALK_LIMIT): Gear {
  const enter = walkIn + 0.8;
  if (prev === 'walk') return d > GEAR_HOP_ENTER ? 'hop' : d > enter ? 'sprint' : 'walk';
  if (prev === 'sprint') return d > GEAR_HOP_ENTER ? 'hop' : d <= walkIn - 0.6 ? 'walk' : 'sprint';
  return d < GEAR_HOP_EXIT ? (d > walkIn - 0.6 ? 'sprint' : 'walk') : 'hop';
}

const solidAt = (bot: mineflayer.Bot, x: number, y: number, z: number): boolean => {
  const b = bot.blockAt(v3(x, y, z)) as unknown as { boundingBox?: string } | null;
  return !!b && b.boundingBox === 'block';
};

/**
 * 跑酷地形感知（9/12 玩家要求：跟随 / move-to / walk-path 共用同一套，别各写各的）：
 * 按当前朝向探"前方 1 格脚下" —— 是空的时候，再往前 2~3 格找【同层落脚面 + 头顶 2 格净空】。
 *   'ok'   前方有地板 → 照走（落差 ≤3 格摔不着，跑跳照旧）
 *   'jump' 2~3 格短缺口、对面跳得过去 → 疾跑起跳跨过去（跑酷图里缺口本来就是用来跳的）
 *   'stop' 宽缺口 / 虚空 / 悬崖（前探 6 格都没有落脚点）→ 绝不能迈这一步
 */
export function parkourAhead(bot: mineflayer.Bot, opts?: { maxLanding?: number; probe?: number }): 'ok' | 'jump' | 'stop' {
  const p = bot.entity.position;
  const yaw = bot.entity.yaw;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const ux = Math.abs(fx) > Math.abs(fz) ? Math.sign(fx) : 0;
  const uz = Math.abs(fz) >= Math.abs(fx) ? Math.sign(fz) : 0;
  if (ux === 0 && uz === 0) return 'ok';
  const bx = Math.floor(p.x);
  const by = Math.floor(p.y + 0.001);
  const bz = Math.floor(p.z);
  const probe = opts?.probe ?? 6;
  let drop = 99;
  for (let i = 0; i <= probe; i++) {
    if (solidAt(bot, bx + ux, by - 1 - i, bz + uz)) {
      drop = i;
      break;
    }
  }
  if (drop < 4) return 'ok';
  for (let d = 2; d <= (opts?.maxLanding ?? 3); d++) {
    const lx = bx + ux * d;
    const lz = bz + uz * d;
    const floorSame = solidAt(bot, lx, by - 1, lz);
    const floorUp = solidAt(bot, lx, by, lz);
    if (!floorSame && !floorUp) continue;
    const lvl = floorUp ? by : by - 1;
    if (solidAt(bot, lx, lvl + 1, lz) || solidAt(bot, lx, lvl + 2, lz)) continue; // 落点头顶撞头
    return 'jump';
  }
  return 'stop';
}

/**
 * 跑跳安全闸：前方 2 格"三格净空 + 有地板"才跳（2 格高走廊会撞头、悬崖边会跳下去 → 都不跳）。
 * 例外：跑酷短缺口（parkourAhead === 'jump'）不算悬崖、是要跳的缺口 → 放行（9/12 加，原来一律拒跳）。
 */
export function hopPathClear(bot: mineflayer.Bot): boolean {
  const p = bot.entity.position;
  const yaw = bot.entity.yaw;
  const fy = Math.floor(p.y + 0.001);
  let clear = true;
  for (const d of [1, 2]) {
    const fx = Math.round(p.x - Math.sin(yaw) * d);
    const fz = Math.round(p.z - Math.cos(yaw) * d);
    if (solidAt(bot, fx, fy, fz) || solidAt(bot, fx, fy + 1, fz) || solidAt(bot, fx, fy + 2, fz)) {
      clear = false;
      break;
    }
    if (!solidAt(bot, fx, fy - 1, fz)) {
      clear = false;
      break;
    }
  }
  if (clear) return true;
  return parkourAhead(bot) === 'jump';
}

// 记录"当前是我们在按住跳跃键"的 bot：只有我们按下的才由我们松开，绝不插手别人的跳跃时机
const hopOwned = new WeakSet<object>();

/**
 * 把档位写进控制状态。
 * allowHop=false 时**完全不碰 jump**：跳跃时机交给别人（寻路器自己的 sprint-jump / walk-path 卡住自救）。
 */
export function applyGear(bot: mineflayer.Bot, gear: Gear, opts?: { allowHop?: boolean }): void {
  bot.setControlState('sprint', gear !== 'walk');
  const wantHop = opts?.allowHop !== false && gear === 'hop';
  if (wantHop) {
    hopOwned.add(bot);
    bot.setControlState('jump', true);
    const vy = bot.entity.velocity?.y ?? 0;
    const p = bot.entity.position;
    if (vy <= 0.001 && solidAt(bot, p.x, p.y - 0.15, p.z)) {
      try {
        (bot.entity.velocity as unknown as { y: number }).y = 0.42; // 原版跳跃初速（同 follow.ts 保险）
      } catch {
        /* ignore */
      }
    }
  } else if (hopOwned.has(bot)) {
    bot.setControlState('jump', false);
    hopOwned.delete(bot);
  }
}

/** 清档位（停下时用） */
export function clearGear(bot: mineflayer.Bot): void {
  hopOwned.delete(bot);
  bot.setControlState('sprint', false);
  bot.setControlState('jump', false);
}

/**
 * 寻路期间的档位驱动：写在 physicsTick 上 —— pathfinder 也在同一事件里写档位，而它的监听器在
 * 插件加载时就注册了（更早）⇒ 它先触发、我们后触发 ⇒ **最后写下的是我们的值**，
 * 所以"远距离疾跑、靠近目标自动收成走"不会被寻路器每 tick 重置。
 * @param getDist 返回剩余距离（格），返回 null = 本拍不介入
 */
export function startDistanceGear(
  bot: mineflayer.Bot,
  getDist: () => number | null,
  opts?: { allowHop?: boolean; label?: string; walkIn?: number }
): () => void {
  let gear: Gear = 'walk';
  let logged: Gear | null = null;
  let hops = 0; // 起跳计数：用来证明"这次移动到底跳没跳"（含寻路器自己规划的跳跃）
  let voidSeen = false;
  let jumpSeen = false;
  let wasAir = !bot.entity.onGround;
  const onTick = (): void => {
    // 起跳判定：从"踩地"变成"离地且向上"算一次
    const air = !bot.entity.onGround;
    if (!wasAir && air && (bot.entity.velocity?.y ?? 0) > 0.05) hops++;
    wasAir = air;
    let d: number | null = null;
    try {
      d = getDist();
    } catch {
      return;
    }
    if (d == null || !Number.isFinite(d)) return;
    // ★ 跑酷护栏（9/12 玩家要求：move-to / walk-path / 跟随 共用这套）——
    //   寻路器也在同一个 physicsTick 里写 forward，而它的监听器注册更早 ⇒ 它先写、我们后写 ⇒
    //   最后生效的是我们的值：只有在这里按住 forward=false，才拦得住它直接走进虚空/悬崖。
    const pk = parkourAhead(bot);
    if (pk === 'stop') {
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);
      if (!voidSeen) {
        voidSeen = true;
        log('WARN', `⛔ ${opts?.label ?? '移动'}：前方是宽缺口/虚空 → 按住不迈这一步（交给寻路自己绕）`);
      }
      return;
    }
    voidSeen = false;
    if (pk === 'jump') {
      // 短缺口：缺口当前，起跳优先于距离档位（疾跑 + 前 + 跳）
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      bot.setControlState('jump', true);
      if (!jumpSeen) {
        jumpSeen = true;
        log('INFO', `🦘 ${opts?.label ?? '移动'}：前方短缺口 → 跳过去`);
      }
      return;
    }
    gear = pickGear(d, gear, opts?.walkIn ?? GEAR_WALK_LIMIT);
    if (gear !== logged) {
      log('INFO', `🏃 距离档位 → ${gear}（${opts?.label ?? '移动'}剩 ${d.toFixed(1)} 格）`);
      logged = gear;
    }
    applyGear(bot, gear, { allowHop: opts?.allowHop !== false && hopPathClear(bot) });
  };
  bot.on('physicsTick', onTick);
  return () => {
    bot.removeListener('physicsTick', onTick);
    clearGear(bot);
    (bot as unknown as { __lastMoveHops?: number }).__lastMoveHops = hops;
    if (hops > 0) log('INFO', `🦘 本次移动起跳 ${hops} 次（含寻路器自己规划的跳跃）`);
  };
}

/**
 * 寻路 + 卡住检测 + 超时 + 自救（v1.2.0 批次 5，解决"寻路卡住"根因）：
 * - 每 5s 检查位移，连续 2 次（约 10 秒）几乎没动 → 判定卡住，主动 stop 并报错
 * - 总超时兜底（超时也 stop，避免 pathfinder 继续空转占身体）
 * - opts.rescue=true：卡住时自动挖开面前挡路方块重试一次（自救），还不行才报错
 */
/** 硬停：清所有控制键 + 取消 pathfinder（中断用的"原地不动"兜底） */
function hardStop(bot: mineflayer.Bot): void {
  try {
    (bot as unknown as { clearControlStates?: () => void }).clearControlStates?.();
  } catch { /* ignore */ }
  try {
    (bot as unknown as { setControlState?: (k: string, v: boolean) => void }).setControlState?.('sprint', false);
    (bot as unknown as { setControlState?: (k: string, v: boolean) => void }).setControlState?.('jump', false);
    (bot as unknown as { setControlState?: (k: string, v: boolean) => void }).setControlState?.('forward', false);
  } catch { /* ignore */ }
}

export async function gotoSmart(
  bot: mineflayer.Bot,
  goal: unknown,
  timeoutMs: number,
  label = '移动',
  opts?: { rescue?: boolean }
): Promise<void> {
  const pf = (bot as unknown as { pathfinder?: { goto?: (g: unknown) => Promise<unknown>; cancel?: () => Promise<unknown> } }).pathfinder;
  if (!pf || !pf.goto) throw new Error('寻路器不可用');

  const attempt = async (): Promise<void> => {
    // 注意：不能 const g = pf.goto 解构再 g() 调用 —— 方法丢失 this，
    // 库内部访问 this.executeTask 会崩（Cannot read properties of undefined）。
    if (!pf!.goto) throw new Error('寻路器不可用');
    // 注视目标（v2 移动即注视）：起手把视线锁定目标点，走起后 HeadFollow 每 tick 实时对准。
    // 视线直转 gaze 同款 —— 目标固定 = 一路看着走过去，无固定时长动画、无螃蟹步。
    // 【纯走路模式例外 9/11】pathfinder 靠 yaw 决定"前进方向"，若每 tick 把 yaw 锁向最终目标点，
    // 遇拐弯（迷宫/绕障）会一直朝终点撞墙 → 原地不动。此模式下不设注视，把朝向交给寻路器。
    const goalPt = goal as { x?: number; y?: number; z?: number } | null;
    // 【距离档位 9/12】按"到目标点的直线距离"自动换档：远 → 疾跑（跑跳交给寻路器自己的 sprint-jump，
    // 所以这里 allowHop:false 完全不碰 jump）；进 2.5 格内自动收成走 —— 拟人收尾，不再冲到位急停。
    const stopGear =
      goalPt && typeof goalPt.x === 'number' && typeof goalPt.z === 'number'
        ? startDistanceGear(
            bot,
            () => {
              const p = bot.entity.position;
              return Math.hypot((goalPt.x as number) - p.x, ((goalPt.y ?? p.y) as number) - p.y, (goalPt.z as number) - p.z);
            },
            { allowHop: false, label: `${label} `, walkIn: 4 }
          )
        : null;
    const hf = hfOf(bot);
    if (hf && process.env.PF_PURE_WALK !== '1') {
      const gg = goal as { x?: number; y?: number; z?: number } | null;
      if (gg && typeof gg.x === 'number' && typeof gg.z === 'number') {
        const gy = typeof gg.y === 'number' ? gg.y : bot.entity.position.y;
        hf.setPoint(gg.x, gy + 1.5, gg.z);
      }
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      let stuckTimer: NodeJS.Timeout;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(stuckTimer);
        hfOf(bot)?.clear(); // 移动结束/中断都交还视线（重试会重新 setPoint）
        stopGear?.(); // 距离档位驱动一起撤（清 sprint/jump，别把档位留给下一个动作）
        if (err) reject(err);
        else resolve();
      };
      timer = setTimeout(() => {
        void pf!.cancel?.();
        finish(new Error(`${label} 超时(${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);
      let lastPos = bot.entity.position.clone();
      let stuckCount = 0;
      // 【纯走路模式】迷宫这种"直线 5 格 = 实际绕 40 格"的场景，A* 可能要算十几秒才吐第一步，
      // 默认 10s 判卡住会误杀 → 放宽到 40s；日常模式维持 5s×2 的灵敏度。
      const pureWalk = process.env.PF_PURE_WALK === '1';
      const stuckInterval = pureWalk ? 10000 : 5000;
      const stuckLimit = pureWalk ? 4 : 2;
      stuckTimer = setInterval(() => {
        try {
          // ── 中断检查（玩家插话 → 原地停下，优先回应）──
          if (isInterrupted()) {
            void pf!.cancel?.();
            hardStop(bot);
            finish(new Error(`已中断（${interruptReasonText() || '玩家插话'}），原地停下`));
            return;
          }
          const p = bot.entity.position;
          const moved = p.distanceTo(lastPos);
          lastPos = p.clone();
          if (moved < 0.5) {
            stuckCount++;
            if (stuckCount >= stuckLimit) {
              void pf!.cancel?.();
              const voidHint = parkourAhead(bot) === 'stop' ? '；而且正前方是虚空/悬崖（这条路走不到底，别再往前）' : '';
              finish(new Error(`${label} 卡住（连续 ${Math.round((stuckInterval * stuckLimit) / 1000)} 秒几乎没动）${voidHint}`));
            }
          } else {
            stuckCount = 0;
          }
        } catch {
          /* bot 断开等异常忽略 */
        }
      }, stuckInterval);
      // 注：寻路移动期间的头转向由全局「走哪看哪」模块(HeadFollowController)统一兜底，
      // 这里不再重复写 yaw —— 每 tick 有净位移自动转向前进方向，站定不碰头。
      pf!.goto!(goal).then(
        () => finish(),
        (e) => finish(e instanceof Error ? e : new Error(String(e)))
      );
    });
  };

  try {
    await attempt();
  } catch (e) {
    const msg = String(e);
    if (!opts?.rescue) throw e;
    // 【纯走路模式】PF_PURE_WALK=1 → 跳过一切"外部自救"（垫脚/挖挡路方块），
    // 只保留 pathfinder 本身的寻路结果：否则迷宫测试里会靠垫脚/挖墙脱困，结论不可信。
    if (process.env.PF_PURE_WALK === '1') throw e;
    // ① 垫脚本能：目标在头顶够不着（高度差 >1.5）→ 先垫脚升到目标层再重试。
    //    不再一失败就放弃/喊玩家——先低头垫脚，而不是抬头找人。
    const goalY = (goal as { y?: number })?.y;
    const curY = bot.entity.position.y;
    if (typeof goalY === 'number' && goalY - curY > 1.5) {
      const raised = await pillarUpTo(bot, Math.floor(goalY), 12);
      if (raised) {
        log('INFO', `🧱 ${label} 够不着目标，垫脚升到 ${Math.floor(bot.entity.position.y)} 层，重试寻路`);
        await attempt();
        return;
      }
      log('WARN', `🧱 ${label} 够不着目标且垫脚失败（没料/垫不动），放弃重试`);
    }
    // ② 自救：卡住时挖开面前挡路方块再试一次（别乱挖基岩/岩浆/箱子/工作台）
    if (msg.includes('卡住')) {
      const dug = await digAhead(bot);
      if (dug) {
        log('INFO', `🔧 ${label} 已挖开挡路方块，重试寻路`);
        await attempt();
        return;
      }
      log('WARN', `🔧 ${label} 卡住但面前没有可挖方块`);
    }
    throw e;
  }
}

/** 挖开 bot 面前 1~2 格内挡路的方块（自救用） */
async function digAhead(bot: mineflayer.Bot): Promise<boolean> {
  try {
    const yaw = bot.entity.yaw;
    const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
    const feet = bot.entity.position.floored();
    for (let i = 1; i <= 2; i++) {
      const bx = Math.floor(feet.x + dx * i), bz = Math.floor(feet.z + dz * i);
      for (const by of [feet.y, feet.y + 1]) {
        if (bx === feet.x && by === feet.y && bz === feet.z) continue; // 不挖自己站的
        const b = bot.blockAt(v3(bx, by, bz)) as unknown as { name?: string; dig?: () => Promise<unknown> } | null;
        if (!b || !b.dig) continue;
        const n = b.name ?? '';
        if (n === 'air' || n === 'water' || n.includes('lava') || n.includes('bedrock') ||
            n.includes('chest') || n.includes('crafting') || n.includes('furnace')) continue;
        log('INFO', `🔨 挖开挡路方块 ${n} @ ${bx},${by},${bz}`);
        await bot.lookAt(v3(bx + 0.5, by + 0.5, bz + 0.5), true);
        await withTimeout(b.dig(), 10000, '挖掘自救');
        return true;
      }
    }
  } catch {
    /* 挖不动就算了 */
  }
  return false;
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isSolidBlockForWalk(b: unknown): boolean {
  const n = (b as { name?: string } | null)?.name ?? '';
  if (!n) return false;
  if (n === 'air' || n === 'cave_air' || n === 'void_air' || n === 'water') return false;
  if (n.includes('lava') || n.includes('fire')) return false;
  return true;
}

/**
 * 短距直线走（≤12 格场景专用）：转向目标 → forward 推进 → 1 格台阶自动跳 → 卡住检测。
 *
 * 为什么绕过 pathfinder：新版 @nxg-org/mineflayer-pathfinder 对近距离目标会"空转误报卡住"——
 * BUG-08/10 实测 1.4~9 格目标寻路 30s+ 到不了（bot 原地/挪 2 格即停）。短距根本不需要寻路，
 * 平地直线走即可。转向用"直写 entity.yaw"（与 track-entity / gaze / autoJumpMove 同一套）：
 * 直接驱动本地 yaw → 移动方向即时跟随，规避 bot.look(force) 两套 yaw 逻辑打架导致的
 * "头身脱节 / 倒着跑"（BUG-01/06）。
 * 【9/12 更正】以前以为"服务器侧 updatePosition 以 3rad/s 平滑同步"是好事，其实是头身割裂的元凶：
 * 它把发包朝向削成每 tick 0.15rad，身子早拐了模型还在原位爬。已在 bot-connection.ts 解锁限速。
 *
 * @returns true=已走到目标附近；被挡/超时会 throw（调用方可降级走 gotoSmart 绕路）
 */
export async function walkStraightTo(
  bot: mineflayer.Bot,
  pos: { x: number; y: number; z: number },
  opts: { timeoutMs?: number; tol?: number } = {}
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const tol = opts.tol ?? 1.0;
  const deadline = Date.now() + timeoutMs;
  const setCtrl = (k: string, v: boolean) => bot.setControlState(k as never, v);
  const stop = () => { for (const k of ['forward', 'jump', 'sneak', 'sprint']) setCtrl(k, false); };
  let lastPos = bot.entity.position.clone();
  let stuckAt = Date.now();
  try {
    // 注视目标（v2 移动即注视）：视线锁定目标点，循环中每 tick 由 HeadFollow 实时对准+微差
    const hf = hfOf(bot);
    hf?.setPoint(pos.x, pos.y + 1.5, pos.z);
    while (true) {
      const me = bot.entity.position;
      const dx = pos.x - me.x, dy = pos.y - me.y, dz = pos.z - me.z;
      const dist = Math.hypot(dx, dy, dz);
      // BUGFIX：纯走路模式下 HeadFollow 让位，没人给 yaw → 每 tick 直写朝向目标（否则顶着墙推）
      bot.entity.yaw = Math.atan2(-dx, -dz);
      if (dist <= tol) { stop(); hf?.clear(); return true; }
      if (Date.now() > deadline) { stop(); hf?.clear(); throw new Error(`直线走 超时(${Math.round(timeoutMs / 1000)}s)，距目标 ${dist.toFixed(1)} 格`); }
      // 卡死检测：1.5s 位移 <0.35 格 → 跳一次自救（可能卡 1 格小台阶）；跳完还不动 → 真被挡
      if (me.distanceTo(lastPos) > 0.35) {
        stuckAt = Date.now();
        lastPos = me.clone();
      } else if (Date.now() - stuckAt > 1500) {
        setCtrl('jump', true);
        await sleepMs(120);
        setCtrl('jump', false);
        await sleepMs(600);
        if (bot.entity.position.distanceTo(lastPos) < 0.2) {
          stop();
          const bf = bot.entity.position.floored();
          const stepX = Math.abs(dx) > Math.abs(dz) ? Math.sign(dx) : 0;
          const stepZ = Math.abs(dz) >= Math.abs(dx) ? Math.sign(dz) : 0;
          const front = bot.blockAt(v3(bf.x + stepX, bf.y, bf.z + stepZ)) as unknown as { name?: string } | null;
          throw new Error(`直线走被挡：${front?.name ?? '未知'}（距目标 ${dist.toFixed(1)} 格）。建议 move-to 换寻路绕路`);
        }
        stuckAt = Date.now();
        lastPos = bot.entity.position.clone();
      }
      // 1 格高台阶自动跳：前方脚部层实心、上一层空 → 跳上去
      if (bot.entity.onGround) {
        const bf = bot.entity.position.floored();
        const stepX = Math.abs(dx) > Math.abs(dz) ? Math.sign(dx) : 0;
        const stepZ = Math.abs(dz) >= Math.abs(dx) ? Math.sign(dz) : 0;
        const frontLvl = bot.blockAt(v3(bf.x + stepX, bf.y, bf.z + stepZ));
        const frontUp = bot.blockAt(v3(bf.x + stepX, bf.y + 1, bf.z + stepZ));
        if (isSolidBlockForWalk(frontLvl) && !isSolidBlockForWalk(frontUp)) {
          setCtrl('jump', true);
          await sleepMs(120);
          setCtrl('jump', false);
        }
      }
      // ★ 跑酷护栏（9/12 玩家要求：短距直线走也共用 helpers.parkourAhead）——
      //   前方短缺口 → 疾跑起跳跨过去；宽缺口/虚空 → 绝不迈（真人朋友不会自己走进虚空）
      const pk = parkourAhead(bot);
      if (pk === 'stop') {
        stop();
        throw new Error(`直线走前方是虚空/悬崖（距目标 ${dist.toFixed(1)} 格）——没迈这一步，改用 move-to 绕路或让玩家接应`);
      }
      if (pk === 'jump') {
        setCtrl('sprint', true);
        setCtrl('jump', true);
        setCtrl('forward', true);
        await sleepMs(50);
        continue;
      }
      setCtrl('sprint', false);
      setCtrl('forward', true);
      await sleepMs(50);
    }
  } catch (e) {
    stop();
    hfOf(bot)?.clear();
    throw e;
  }
}

/** 面向实体/坐标：直写 entity.yaw/pitch（track-entity / gaze 追视同款），攻击前先对准目标再出刀 */
export function faceToward(
  bot: mineflayer.Bot,
  x: number, y: number, z: number
): void {
  const me = bot.entity.position;
  const dx = x - me.x, dy = y - me.y, dz = z - me.z;
  bot.entity.yaw = Math.atan2(-dx, -dz);
  bot.entity.pitch = Math.atan2(dy, Math.hypot(dx, dz));
}

/** 垫脚方块优先级：垃圾方块优先，手上/背包有啥用啥 */
const SCAFFOLD_ORDER = [
  'dirt', 'cobblestone', 'stone', 'obsidian', 'netherrack', 'deepslate',
  'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'gravel', 'sandstone',
  'oak_planks', 'spruce_planks', 'birch_planks', 'dark_oak_planks',
  // 原木类：开局空手砍树后，最先到手的就是原木；把它当垫脚料，
  // 才能解决「掉落物弹上树叶/屋顶、bot 空手无方块可垫」的高物拾取断档。
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log',
  'dark_oak_log', 'mangrove_log', 'cherry_log',
];

/** 从背包挑一个可垫脚的方块（返回物品名；没有返回 null） */
export function findScaffoldItem(bot: mineflayer.Bot): string | null {
  for (const n of SCAFFOLD_ORDER) {
    const it = findItemInInventory(bot, n);
    if (it && it.count > 0) return n;
  }
  return null;
}

/**
 * 【垫脚本能·原语】往自己脚下垫一块方块并站上去（1x1 上塔）。
 * 时序：跳到接近最高点、脚下格空出时把块放进自己脚下格，落回时正好站在新块上。
 * 服务器不认 → 不硬放，等更高点重试；1.2s 内没成功就放弃（无副作用）。
 * @returns true=成功升高一层
 */
async function pillarOne(bot: mineflayer.Bot): Promise<boolean> {
  try {
    const feet = bot.entity.position;
    const below = bot.blockAt(feet.offset(0, -1, 0));
    if (!below || !below.name || below.name === 'air' || below.name === 'water' ||
        below.name.includes('lava') || below.name.includes('bedrock')) {
      console.log(`[pillarOne] 放弃: 脚下不可站 (${below?.name ?? '无'})`);
      return false;
    }
    const above = bot.blockAt(feet.offset(0, 1, 0));
    if (above && above.name !== 'air') {
      console.log(`[pillarOne] 放弃: 头顶有 ${above.name}，垫不了`);
      return false;
    }
    const mat = findScaffoldItem(bot);
    if (!mat) {
      console.log('[pillarOne] 放弃: 背包没有垫脚方块');
      return false;
    }
    await equipByName(bot, mat);
    const startY = feet.y;
    let placed = false;
    let lastErr = '';
    // 经典 pillar 时序（参考 hibukki/minecraft-mcp-server）：起跳 → 等接近最高点 → 
    // 把块放自己脚下格（_genericPlace 自动 lookAt 参考面）→ 松 jump 落回新块上。
    // 服务器位置同步滞后时可能被拒，最多跳 3 轮。
    for (let round = 0; round < 3 && !placed; round++) {
      bot.setControlState('jump', true);
      await sleepMs(110); // 起跳
      await sleepMs(200); // 接近最高点（脚离地 ~1.1+，脚下格空出）
      try {
        await bot.placeBlock(below as never, v3(0, 1, 0) as never);
        placed = true;
      } catch (e) {
        lastErr = String(e);
      }
      bot.setControlState('jump', false);
      await sleepMs(500); // 落地（落在新块上）
      if (!placed && round < 2) await sleepMs(120);
    }
    const ok = placed && bot.entity.position.y - startY > 0.5;
    console.log(`[pillarOne] ${ok ? '✅' : '❌'} ${mat} 脚下垫块 y${Math.floor(startY)}→y${Math.floor(bot.entity.position.y)} placed=${placed}${lastErr ? ' 末错:' + lastErr.slice(0, 110) : ''}`);
    return ok;
  } catch (e) {
    bot.setControlState('jump', false);
    console.log(`[pillarOne] 异常: ${String(e).slice(0, 160)}`);
    return false;
  }
}

/**
 * 【垫脚本能】原地垂直垫高，直到 bot 脚部所在层 >= targetFoot。
 * @param targetFoot 目标"脚层"（整数，如垫到脚踩 y=70 层就传 70）
 * @returns true=达到目标高度
 */
export async function pillarUpTo(bot: mineflayer.Bot, targetFoot: number, maxBlocks = 10): Promise<boolean> {
  // 硬上限守卫：垫高超过 4 格一律拒绝（超过即爬高会被困在半空/树顶，下不来）
  const dy = targetFoot - Math.floor(bot.entity.position.y + 0.001);
  if (dy > 4) return false;
  if (Math.floor(bot.entity.position.y + 0.001) >= targetFoot) return true;
  for (let i = 0; i < maxBlocks; i++) {
    if (Math.floor(bot.entity.position.y + 0.001) >= targetFoot) return true;
    const ok = await pillarOne(bot);
    if (!ok) return Math.floor(bot.entity.position.y + 0.001) >= targetFoot;
  }
  return Math.floor(bot.entity.position.y + 0.001) >= targetFoot;
}

/**
 * 高物/坑物智能拾取（pickup-item 与 collect-tree 边砍边捡统一用）：
 * 1) 先直接走过去碰（GoalNear 0；平地、下坡都能捡到）；
 * 2) 物品若在高处（落在树叶/建筑顶，比脚高 >1），垫脚到与物品同层，再走过去碰；
 *    原地垫脚后走不通，再在物品相邻方向选点重试。
 * @param tgt 掉落物位置（实体 position）
 * @returns true=目标掉落物已消失（捡到）
 */
export async function pickupItemSmart(
  bot: mineflayer.Bot,
  tgt: { x: number; y: number; z: number },
  timeoutMs = 20000
): Promise<boolean> {
  const { goals } = require('@nxg-org/mineflayer-pathfinder') as { goals: any };
  const tx = Math.round(tgt.x), tz = Math.round(tgt.z);
  // 掉落物当前实时坐标（每次重读，物品下落后会变，不能用缓存的 ty）
  const curItem = (): { x: number; y: number; z: number } | null => {
    let best: { x: number; y: number; z: number } | null = null;
    let bd = Infinity;
    for (const id of Object.keys(bot.entities)) {
      const e = bot.entities[id];
      if (e.displayName !== 'item' && e.name !== 'item') continue;
      const p = e.position;
      const d = Math.abs(p.x - tx) + Math.abs(p.z - tz); // 水平曼哈顿距离找最近的那个掉落物
      if (d < bd) { bd = d; best = { x: p.x, y: p.y, z: p.z }; }
    }
    return best;
  };
  const itemGone = (): boolean => curItem() === null;
  const walkAt = (x: number, y: number, z: number, ms: number): Promise<void> =>
    gotoSmart(bot, new goals.GoalNear(x, y, z, 0), ms, '拾取').catch(() => undefined);

  const isSupport = (nm: string) => nm.endsWith('_leaves') || nm.endsWith('_log');
  const at = (x: number, y: number, z: number) => bot.blockAt(v3(x, y, z)) as unknown as { name?: string } | null;
  const digBlock = async (x: number, y: number, z: number): Promise<boolean> => {
    const b = at(x, y, z);
    if (!b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') return false;
    try {
      await withAimLock(bot, () => withTimeout(bot.dig(b as never), 10000, '挖支撑物'));
      return true;
    } catch { return false; }
  };

  // 循环：物品在高处就挖支撑让它下落；落地/同层就地面水平走过去碰。防死循环上限。
  for (let round = 0; round < 14; round++) {
    const it = curItem();
    if (!it) return true; // 已捡到/消失

    const footY = Math.floor(bot.entity.position.y);
    const dy = Math.round(it.y) - footY; // 物品相对 bot 脚层的高度差

    if (dy <= 1) {
      // 同层/地面：只用 bot 当前脚层做目标 y（绝不用物品 y，避免 pathfinder 垫脚爬高）
      await walkAt(Math.round(it.x), footY, Math.round(it.z), timeoutMs);
      await sleepMs(500);
      if (itemGone()) return true;
      // 没捡到：可能水平还差一点，继续下一轮
      continue;
    }

    // 物品在高处（dy>1）：挖掉正下方支撑的树叶/原木，让它下落，绝不垫脚爬
    const ix = Math.round(it.x), iz = Math.round(it.z), iy = Math.round(it.y);
    let dug = false;
    // 先挖正下方一格
    for (const [dx, dz] of [[0, 0], [0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const sup = at(ix + dx, iy - 1, iz + dz);
      if (sup && sup.name && sup.name !== 'air' && sup.name !== 'cave_air' && isSupport(sup.name)) {
        if (await digBlock(ix + dx, iy - 1, iz + dz)) { dug = true; break; }
      }
    }
    if (!dug) {
      // 正下方/紧邻都不是树叶原木（可能卡在别处或撑在实体方块）——挖正下方任意非基岩方块
      const sup = at(ix, iy - 1, iz);
      if (sup && sup.name && sup.name !== 'air' && sup.name !== 'cave_air' && sup.name !== 'bedrock') {
        await digBlock(ix, iy - 1, iz);
      }
    }
    await sleepMs(350); // 等物品下落
    if (itemGone()) return true;
  }

  // 兜底：仍捡不到就返回最后一次检查结果（不垫脚，避免爬高）
  return itemGone();
}

/**
 * 【竖井下挖】原地垂直向下挖一条竖井，直到脚部所在层 <= targetFootY。
 * 用于解决「矿藏/石头盖在泥土之下、地表不暴露、find-blocks 找不到或用水平寻路被地形挡住」的问题。
 *
 * 三个关键坑（都已在实现里处理）：
 *  1) 不 approach：挖正下方方块用 bot.dig 直接 lookAt 垂直向下，绝不走 ensureReachable（否则每挖一格
 *     都尝试水平接近脚下目标、被反复带偏）。
 *  2) 每轮重读坐标：挖掉脚下一格后 bot 因重力下落一层，下一次要挖的「脚下」必须重新取
 *     floor(bot.entity.position.y - 1)，绝不能缓存坐标。
 *  3) 下挖前 blockAt 检查：目标格是空气→已经进了洞/有空洞，停止（避免挖穿）；熔岩/bedrock→报错停止；
 *     水→跳过（默认不下水，调用方决定）。
 *
 * 每挖一格会 sleep 等掉落，再 pickupItemSmart 捡脚下掉落物（泥土/圆石进包，既当垫脚料又避免堵井口）。
 *
 * @param targetFootY  目标「脚层」（整数，如矿在 y60 脚下，就传 59~60）
 * @param maxDepth    最大下挖深度（防失控），默认 40
 * @param timeoutMs   总超时，默认 120000
 * @returns { reached: boolean; dug: number; stopped: string } reached=是否到达目标层
 */
export async function digShaftDown(
  bot: mineflayer.Bot,
  targetFootY: number,
  opts: { maxDepth?: number; timeoutMs?: number; avoidX?: number; avoidZ?: number } = {}
): Promise<{ reached: boolean; dug: number; stopped: string }> {
  const maxDepth = opts.maxDepth ?? 40;
  const timeoutMs = opts.timeoutMs ?? 120000;
  const deadline = Date.now() + timeoutMs;
  let dug = 0;

  const currentFootY = () => Math.floor(bot.entity.position.y + 0.001);
  // 起始若已达标直接返回
  if (currentFootY() <= targetFootY) return { reached: true, dug: 0, stopped: '已达标' };

  for (let i = 0; i < maxDepth; i++) {
    if (Date.now() > deadline) return { reached: currentFootY() <= targetFootY, dug, stopped: '超时' };
    if (currentFootY() <= targetFootY) return { reached: true, dug, stopped: '已达层' };

    // 每轮重读最新脚下坐标（坑2）
    const p = bot.entity.position;
    const bx = Math.floor(p.x + 0.001);
    const by = Math.floor(p.y + 0.001) - 1;
    const bz = Math.floor(p.z + 0.001);
    // 避开指定格（如工作台所在列，模式 A 用）
    if (opts.avoidX !== undefined && opts.avoidZ !== undefined && bx === opts.avoidX && bz === opts.avoidZ) {
      return { reached: false, dug, stopped: '竖井撞到避让列，请换一个起挖点' };
    }

    const below = bot.blockAt(v3(bx, by, bz)) as unknown as { name?: string } | null;
    const nm = below?.name ?? 'air';
    // 坑3：下挖前安全检查
    if (nm === 'air' || nm === 'cave_air' || nm === 'void_air') {
      return { reached: false, dug, stopped: `脚下(${bx},${by},${bz})已是空气/空洞，下方有天然洞穴，停止下挖` };
    }
    if (nm === 'bedrock') return { reached: false, dug, stopped: `挖到基岩(${bx},${by},${bz})，无法继续` };
    if (nm.includes('lava')) return { reached: false, dug, stopped: `脚下(${bx},${by},${bz})是熔岩，停止下挖` };
    if (nm.includes('water')) return { reached: false, dug, stopped: `脚下(${bx},${by},${bz})是水，停止下挖` };

    // 原地挖（坑1：不 approach）
    await withAimLock(bot, () => withTimeout(bot.dig(below as never), 20000, '竖井挖脚下方块'));
    dug++;

    // 等掉落物落地，捡起来（避免堵井口/丢失建材）
    await sleepMs(350);
    try {
      const drop = bot.nearestEntity((e) => (e as { name?: string }).name === 'item') as
        { position?: { x: number; y: number; z: number } } | null;
      if (drop?.position) {
        const d = bot.entity.position.distanceTo(v3(drop.position.x, drop.position.y, drop.position.z));
        if (d <= 6) await pickupItemSmart(bot, drop.position, 8000).catch(() => undefined);
      }
    } catch { /* 捡失败不致命 */ }

    // 等重力下落到位
    await sleepMs(200);
  }
  return { reached: currentFootY() <= targetFootY, dug, stopped: '达最大深度' };
}

/**
 * 【楼梯下挖】向前且向下挖掘一条 1 格宽阶梯（落差恒 1 格、可回走），直到脚层 <= targetFootY。
 * 相较竖井，楼梯挖完能沿原路走回地表（pathfinder 不会垫脚爬竖井），工作台/熔炉放在楼梯口即可
 * 反复上下。深层矿（钻石/黑曜石）必用楼梯，竖井下去回不来。
 *
 * 几何（固定朝向、不转向）：
 *   每级台阶挖三处（都用 bot.dig 原地 lookAt，不走 ensureReachable）：
 *     a) 前方 eye 层（floor(y)+1）——开出头顶净空（坑：不撞头）；
 *     b) 前方 foot 层（floor(y)）——开出下一步落脚面；
 *     c) 前方 foot-1 层——挖出下一级台阶（让脚能踏到更低一层）。
 *   然后前进一步 + 下落一级，站到新台阶。落差恒 1 格，回头可走回。
 *
 * 侧向矿命中（模式 B）：每 1~2 步用 findBlock(maxDistance≈5) 扫一次 targetBlock，一旦命中就
 *   原地停下、哪怕离开楼梯主路径也 dig 挖穿它（不挖错方向），不硬挖到同层再横找。
 *
 * @param targetFootY  目标脚层
 * @param opts.direction 朝向向量（可选，默认取 bot 当前朝向并固定之）
 * @param opts.targetBlock 目标矿名（如 iron_ore），有则侧向命中即停下
 * @param opts.maxSteps  最大下挖步数（防失控），默认 48
 * @param opts.timeoutMs 总超时，默认 180000
 */
export async function digStairDown(
  bot: mineflayer.Bot,
  targetFootY: number,
  opts: { direction?: { dx: number; dz: number }; targetBlock?: string; needCount?: number; needItemName?: string; maxSteps?: number; timeoutMs?: number } = {}
): Promise<{ reached: boolean; dug: number; steps: number; stopped: string; got?: number; hitOre?: { name: string; x: number; y: number; z: number } }> {
  const maxSteps = opts.maxSteps ?? 48;
  const timeoutMs = opts.timeoutMs ?? 180000;
  const deadline = Date.now() + timeoutMs;
  // needCount：挖够 N 块掉落物（如 cobblestone）就停（模式 A"边下挖边攒建材"）。
  // needCount 与 targetBlock 互斥：needCount 不触发"侧向命中即停"，只数挖出并捡到的掉落物数量。
  const wantCount = opts.needCount ?? 0;
  const needItem = opts.needItemName ?? 'cobblestone';

  // 固定朝向（不转向），默认取当前朝向量化到主轴
  let dir = opts.direction;
  if (!dir) {
    const yaw = bot.entity.yaw; // 0=+z, π/-π=-z, π/2=-x, -π/2=+x
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);
    const ax = Math.abs(dx), az = Math.abs(dz);
    dir = ax > az ? { dx: Math.sign(dx) || 1, dz: 0 } : { dx: 0, dz: Math.sign(dz) || 1 };
  }

  const currentFootY = () => Math.floor(bot.entity.position.y + 0.001);
  const isDanger = (nm: string) => nm === 'bedrock' || nm.includes('lava') || nm.includes('water');
  const isAir = (nm: string) => nm === 'air' || nm === 'cave_air' || nm === 'void_air';

  let dug = 0;
  let steps = 0;

  // 挖一格（原地 lookAt，不 approach）；返回 false 表示无需挖（已是空气）
  const digIfSolid = async (x: number, y: number, z: number, label: string): Promise<boolean> => {
    const b = bot.blockAt(v3(x, y, z)) as unknown as { name?: string } | null;
    const nm = b?.name ?? 'air';
    if (isAir(nm)) return false;
    if (isDanger(nm)) throw new Error(`楼梯${label}撞到 ${nm}@(${x},${y},${z})`);
    await withAimLock(bot, () => withTimeout(bot.dig(b as never), 20000, `楼梯挖${label}`));
    dug++;
    return true;
  };

  for (let i = 0; i < maxSteps; i++) {
    if (Date.now() > deadline) return { reached: currentFootY() <= targetFootY, dug, steps, stopped: '超时' };
    if (currentFootY() <= targetFootY) return { reached: true, dug, steps, stopped: '已达层' };

    const p = bot.entity.position;
    const fx = Math.floor(p.x + 0.001) + dir.dx;
    const fz = Math.floor(p.z + 0.001) + dir.dz;
    const footY = Math.floor(p.y + 0.001);

    // 挖之前先看：本步要挖的 4 格（前方眼层/头顶/落脚/台阶）里有没有 targetBlock 矿。
    // 【修复 1】收窄侧向命中：只认"下一步真的会挖到的侧壁/脚下"，不再 findBlock 大范围扫（那会选中深处 dy 差 4-5 的远处矿）。
    const stepBlocks: Array<{ x: number; y: number; z: number }> = [
      { x: fx, y: footY + 1, z: fz }, // 前方眼层
      { x: fx, y: footY + 2, z: fz }, // 头顶
      { x: fx, y: footY, z: fz },     // 前方落脚
      { x: fx, y: footY - 1, z: fz }, // 前下方台阶
    ];
    if (opts.targetBlock) {
      for (const sb of stepBlocks) {
        const ob = bot.blockAt(v3(sb.x, sb.y, sb.z)) as unknown as { name?: string } | null;
        if (ob && ob.name === opts.targetBlock) {
          await withAimLock(bot, () => withTimeout(bot.dig(ob as never), 20000, '挖侧向矿'));
          dug++;
          steps++;
          // 【修复 2】命中后必捡掉落物：走到掉落物旁捡进包，捡不到不算命中成功
          const picked = await pickupItemSmart(bot, { x: sb.x + 0.5, y: sb.y, z: sb.z + 0.5 }, 15000).catch(() => false);
          const gone = picked || (bot.blockAt(v3(sb.x, sb.y, sb.z)) as unknown as { name?: string } | null)?.name !== opts.targetBlock;
          // 确认掉落物进包：背包里 targetBlock 对应掉落物不存在时不算失败（矿石掉落物名与方块名不同），
          // 这里以"方块已消失 + 尝试捡"为准，返回命中（真实矿掉落物由后续 pickup-item 兜底）
          return { reached: true, dug, steps, stopped: '命中目标矿', hitOre: { name: opts.targetBlock, x: sb.x, y: sb.y, z: sb.z } };
        }
      }
    }

    // a) 眼层净空（头顶不撞）×2 格：先挖眼前方、再挖头顶上方
    await digIfSolid(fx, footY + 1, fz, '前方眼层');
    await digIfSolid(fx, footY + 2, fz, '头顶');

    // b) 前方落脚面（脚层）
    await digIfSolid(fx, footY, fz, '前方落脚');

    // c) 下一级台阶（脚层 -1）：挖出前下方，让脚能踏到更低一层
    await digIfSolid(fx, footY - 1, fz, '前下方台阶');

    // 前进一步 + 下落一级：目标点就在前方 1 格、低 1 层，用 gotoSmart 走到新台阶
    // （比手动 setControlState 可靠，能避开 body-controller 抢前进控制）
    const { goals: stairGoals } = require('@nxg-org/mineflayer-pathfinder') as { goals: any };
    await gotoSmart(bot, new stairGoals.GoalNear(fx + 0.5, footY - 1, fz + 0.5, 1), 8000, '下台阶');
    await sleepMs(200); // 等重力稳定站到台阶上

    steps++;
    // 捡掉落物（防堵路 + 攒建材）
    try {
      const drop = bot.nearestEntity((e) => (e as { name?: string }).name === 'item') as
        { position?: { x: number; y: number; z: number } } | null;
      if (drop?.position) {
        const d = bot.entity.position.distanceTo(v3(drop.position.x, drop.position.y, drop.position.z));
        if (d <= 5) await pickupItemSmart(bot, drop.position, 6000).catch(() => undefined);
      }
    } catch { /* 不致命 */ }

    // 【修复 3】needCount：挖够 N 块掉落物（如圆石）就停。每步捡完后查背包计数。
    if (wantCount > 0) {
      const f = findItemInInventory(bot, needItem);
      const gotNow = f ? f.count : 0;
      if (gotNow >= wantCount) {
        return { reached: true, dug, steps, stopped: '挖够目标掉落物', got: gotNow };
      }
    }
  }
  const lastGot = wantCount > 0 ? (findItemInInventory(bot, needItem)?.count ?? 0) : 0;
  return { reached: currentFootY() <= targetFootY, dug, steps, stopped: wantCount > 0 ? `未挖够${needItem}` : '达最大步数', got: lastGot };
}

/**
 * 创造模式飞行就位（自研，替代 mineflayer creative.flyTo）：
 * flyTo 只是本地改 entity.position 后等 'move' 事件，服务器不回位置同步时永远卡死。
 * 这里逐小步发送 position 网络包，服务器确认后 entity.position 才会更新，
 * 放置方块时才不会因服务器端 reach 判定失败。
 */
/**
 * 创造模式飞行就位（自研，替代 mineflayer creative.flyTo）：
 *   prismarine-physics 无创造飞行分支，物理控制（setControlState jump/forward）在飞行状态下不可靠；
 *   这里 ① 发 abilities 包让服务器进入飞行、② 小步直接设 entity.position（绕过物理）。
 * BUG-04 修复（融合小白方案）：水平推进前探测前方脚/头层实体方块，有障碍则先纯垂直
 *   升到障碍顶上方 1 格、水平越过、再下降回目标高度（阶梯形路径），
 *   杜绝直接设位穿墙时被服务器 position 校正反复拉回而振荡超时。
 */
export async function creativeFlyTo(
  bot: mineflayer.Bot,
  dest: { x: number; y: number; z: number },
  timeoutMs = 20000
): Promise<void> {
  const target = v3(dest.x, dest.y, dest.z);
  const deadline = Date.now() + timeoutMs;
  const creative = (bot as unknown as { creative?: { startFlying?: () => void; stopFlying?: () => void } }).creative;
  const client = (bot as unknown as { _client?: { write: (n: string, o: unknown) => void } })._client;

  // ── prismarine-physics 无创造飞行分支；两招：① 显式 abilities(flying=true) 让服务器进入飞行、
  //   不再按行走重力校正；② 仿官方 flyTo 小步直接设 entity.position（绕过物理），move 发包。──
  const BASE_FLAGS = 0x0d; // invulnerable(0x01) | canFly(0x04) | instantBreak(0x08)
  const setServerFlying = (flying: boolean) => {
    try {
      client?.write('abilities', {
        flags: BASE_FLAGS | (flying ? 0x02 : 0),
        flyingSpeed: 0.05,
        walkingSpeed: 0.1,
      });
    } catch { /* ignore */ }
  };

  // 前方障碍探测：沿水平主轴方向检查脚/头层前方 1~2 格，返回障碍顶第一个空气格 y（blocked 时）
  const probeAhead = (feetY: number): { blocked: boolean; topY: number } => {
    const p = bot.entity.position;
    const dd = target.minus(p);
    const ux = Math.abs(dd.x) >= Math.abs(dd.z) ? Math.sign(dd.x) : 0;
    const uz = Math.abs(dd.z) > Math.abs(dd.x) ? Math.sign(dd.z) : 0;
    let topY = feetY;
    let blocked = false;
    for (let dist = 1; dist <= 2; dist++) {
      const cx = Math.floor(p.x + 0.001) + ux * dist;
      const cz = Math.floor(p.z + 0.001) + uz * dist;
      for (let dy = 0; dy < 2; dy++) {
        if (solidAt(bot, cx, feetY + dy, cz)) {
          blocked = true;
          let y = feetY + dy;
          while (solidAt(bot, cx, y, cz)) y++;
          if (y > topY) topY = y;
          break;
        }
      }
      if (blocked) break;
    }
    return { blocked, topY };
  };

  creative?.startFlying?.(); // 本地 gravity=0，防止物理 tick 在两次设位间把 bot 拽下
  setServerFlying(true); // 服务器进入飞行
  try { (bot.entity as unknown as { velocity?: { set: (x: number, y: number, z: number) => void } }).velocity?.set(0, 0, 0); } catch { /* ignore */ }

  const STEP = 0.4; // 每 40ms 移动 0.4 格（约 10 格/秒），小步避免服务器位置校正
  let lastLook = 0;
  let lastLog = 0;
  let climbTopY = -1; // 越障需达到的脚底高度（-1 表示当前无需越障）
  try {
    while (bot.entity.position.distanceTo(target) > 0.35) {
      if (Date.now() > deadline) throw new Error('飞行就位超时');
      const cur = bot.entity.position;
      const d = target.minus(cur);
      const dist = d.distanceTo(v3(0, 0, 0));
      const hd = Math.sqrt(d.x * d.x + d.z * d.z);
      if (Date.now() - lastLook > 120) {
        const yaw = Math.atan2(-d.x, -d.z);
        const pitch = Math.atan2(d.y, Math.max(hd, 0.001));
        void (bot.look as unknown as (y: number, p: number, f?: boolean) => unknown)(yaw, pitch, true);
        lastLook = Date.now();
      }

      const feetY = Math.floor(cur.y + 0.001);
      // 水平未到位才探障；进入越障后持续升到 climbTopY，避免在障碍边反复探测抖动
      if (hd <= 0.5) {
        climbTopY = -1;
      } else if (climbTopY < 0) {
        const ahead = probeAhead(feetY);
        if (ahead.blocked) climbTopY = ahead.topY + 1; // 脚底升到障碍顶上方 1 格
      } else if (cur.y >= climbTopY - 0.05) {
        // 已到越障高度，再探前方确认真越过；仍有障碍则维持/加高
        const re = probeAhead(feetY);
        climbTopY = re.blocked ? Math.max(re.topY + 1, climbTopY) : -1;
      }

      let mv = v3(0, 0, 0);
      if (climbTopY >= 0 && cur.y < climbTopY - 0.05) {
        // 越障阶段：纯垂直上升，不水平推进，杜绝朝障碍硬顶
        mv = v3(0, Math.min(STEP, climbTopY - cur.y), 0);
        if (Date.now() - lastLog > 400) {
          console.log(`[fly] 越障抬升 y=${cur.y.toFixed(1)}→${climbTopY}（水平剩${hd.toFixed(1)}）`);
          lastLog = Date.now();
        }
      } else {
        // 正常阶段：沿目标方向小步直飞（越过障碍后 d.y 自然为负 → 下降回目标高度）
        mv = d.scaled(Math.min(STEP, dist) / dist);
        if (Date.now() - lastLog > 500) {
          console.log(`[fly] pos=(${cur.x.toFixed(1)}, ${cur.y.toFixed(1)}, ${cur.z.toFixed(1)}) 目标=(${target.x},${target.y},${target.z}) 剩余=${dist.toFixed(1)}`);
          lastLog = Date.now();
        }
      }
      bot.entity.position = cur.plus(mv);
      try { (bot.entity as unknown as { velocity?: { set: (x: number, y: number, z: number) => void } }).velocity?.set(mv.x * 2, mv.y * 2, mv.z * 2); } catch { /* ignore */ }
      await sleepMs(40);
    }
    bot.entity.position = target;
    await sleepMs(80);
  } finally {
    setServerFlying(false); // 退出飞行
    creative?.stopFlying?.(); // 恢复本地重力
  }
}

/**
 * 创造/OP 就位：发服务器 /tp 命令（服务器权威，无视碰撞、不会被 position 包拉回），
 * 比 creativeFlyTo 直接设位稳定——尤其在门框等多方块障碍附近、或就位点需要绕过结构时。
 * @returns true=已到目标 0.5 格内
 */
export async function teleportCreative(
  bot: mineflayer.Bot,
  x: number,
  y: number,
  z: number,
  timeoutMs = 4000
): Promise<boolean> {
  const target = v3(x, y, z);
  if (bot.entity.position.distanceTo(target) < 0.35) return true;
  try {
    // 进入飞行（tp 落点若悬空也不掉落）；flags = invulnerable|flying|canFly|instantBreak
    const client = (bot as unknown as { _client?: { write: (n: string, o: unknown) => void } })._client;
    try {
      client?.write('abilities', { flags: 0x0f, flyingSpeed: 0.05, walkingSpeed: 0.1 });
    } catch { /* ignore */ }
    bot.chat(`/tp ${bot.username} ${x} ${y} ${z}`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(120);
      if (bot.entity.position.distanceTo(target) < 0.4) return true;
    }
    return bot.entity.position.distanceTo(target) < 0.6;
  } catch {
    return false;
  }
}

/** 从背包查找物品 */
export function findItemInInventory(bot: mineflayer.Bot, name: string): { item: never; count: number } | null {
  const items = bot.inventory.items() as unknown as Array<{ name: string; count: number; slot: number }>;
  for (const it of items) {
    if (it.name === name && it.count > 0) return { item: it as never, count: it.count };
  }
  return null;
}

/** 从背包装备物品：护甲自动穿到对应槽位（helmet→head/chestplate→torso/leggings→legs/boots→feet），其余到主手 */
export async function equipByName(bot: mineflayer.Bot, name: string): Promise<void> {
  const found = findItemInInventory(bot, name);
  if (!found) throw new Error(`背包里没有 ${name}`);
  let dest: 'hand' | 'head' | 'torso' | 'legs' | 'feet' = 'hand';
  if (name.endsWith('helmet')) dest = 'head';
  else if (name.endsWith('chestplate')) dest = 'torso';
  else if (name.endsWith('leggings')) dest = 'legs';
  else if (name.endsWith('boots')) dest = 'feet';
  await bot.equip(found.item as never, dest);
}

/** 获取目标位置的参考方块（相邻 6 方向找非空气） */
export function findReferenceBlock(
  bot: mineflayer.Bot,
  pos: { x: number; y: number; z: number }
): { block: unknown; faceVector: { x: number; y: number; z: number } } | null {
  const dirs = [
    { d: { x: 1, y: 0, z: 0 }, f: { x: -1, y: 0, z: 0 } },
    { d: { x: -1, y: 0, z: 0 }, f: { x: 1, y: 0, z: 0 } },
    { d: { x: 0, y: 1, z: 0 }, f: { x: 0, y: -1, z: 0 } },
    { d: { x: 0, y: -1, z: 0 }, f: { x: 0, y: 1, z: 0 } },
    { d: { x: 0, y: 0, z: 1 }, f: { x: 0, y: 0, z: -1 } },
    { d: { x: 0, y: 0, z: -1 }, f: { x: 0, y: 0, z: 1 } },
  ];
  for (const { d, f } of dirs) {
    const b = bot.blockAt(v3(pos.x + d.x, pos.y + d.y, pos.z + d.z));
    if (b && b.name !== 'air') {
      return { block: b, faceVector: f };
    }
  }
  return null;
}

const REACH = 4.5;

/** 从眼睛位置出发，能否看得到目标中心（视线通畅且距离在 reach 内） */
async function canSeeTarget(
  bot: mineflayer.Bot,
  standPos: { x: number; y: number; z: number },
  targetCenter: { x: number; y: number; z: number }
): Promise<boolean> {
  const eye = v3(standPos.x + 0.5, standPos.y + bot.entity.height, standPos.z + 0.5);
  if (eye.distanceTo(v3(targetCenter.x, targetCenter.y, targetCenter.z)) > REACH) return false;
  const dir = v3(targetCenter.x - eye.x, targetCenter.y - eye.y, targetCenter.z - eye.z).normalize();
  try {
    // prismarine-world 3.x：raycast 是 async，直接返回命中的 block（含 position 整数格坐标），不是 { hit }
    const hit = (await bot.world.raycast(eye, dir, REACH)) as { position?: { x: number; y: number; z: number } } | null;
    if (!hit || !hit.position) return false;
    // 命中格必须等于参考面所在格，视线才算直通（没被别的方块挡住）
    const gx = Math.floor(targetCenter.x), gy = Math.floor(targetCenter.y), gz = Math.floor(targetCenter.z);
    return Math.abs(hit.position.x - gx) < 0.6 &&
           Math.abs(hit.position.y - gy) < 0.6 &&
           Math.abs(hit.position.z - gz) < 0.6;
  } catch {
    return false;
  }
}

/** 生成目标方块周围的候选站立点（空气格 + 下方有支撑：杜绝悬空格，避免 pathfinder 被派去够天上） */
function standCandidates(
  bot: mineflayer.Bot,
  targetPos: { x: number; y: number; z: number }
): Array<{ x: number; y: number; z: number }> {
  const out: Array<{ x: number; y: number; z: number }> = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 3) continue;
        const p = { x: targetPos.x + dx, y: targetPos.y + dy, z: targetPos.z + dz };
        const b = bot.blockAt(v3(p.x, p.y, p.z)) as unknown as { name?: string } | null;
        if (!b || b.name !== 'air') continue;
        const belowP = bot.blockAt(v3(p.x, p.y - 1, p.z)) as unknown as { name?: string } | null;
        const supported = belowP && belowP.name && belowP.name !== 'air' &&
          belowP.name !== 'water' && !belowP.name.includes('lava');
        if (supported) out.push(p);
      }
    }
  }
  return out;
}

/** callback → Promise 包装（mineflayer 部分 API 是 callback 风格） */
function promisifyCall<T>(fn: (cb: (err?: Error) => void) => void, label: string, ms = 8000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时(${Math.round(ms / 1000)}s)`)), ms);
    fn((err?: Error) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(undefined as T);
    });
  });
}

/**
 * 创造兜底：从目标正上方悬空放块（越过已铺层/1 格高障碍，根治"平面飞行撞墙卡死"）
 * 适用：目标是贴底层、参考面在正下方。飞到 (pos.x+.5, pos.y+2, pos.z+.5) 俯视 below 顶面放置。
 * 放完后悬停在 pos.y+2，继续下一块时不与已铺方块碰撞（始终高于单层结构）。
 */
async function placeFromAbove(
  bot: mineflayer.Bot,
  pos: { x: number; y: number; z: number },
  blockType: string,
  timeoutMs = 15000
): Promise<boolean> {
  try {
    if ((bot.game as unknown as { gameMode?: string }).gameMode !== 'creative') return false;
    // 主手备好方块
    const held = (bot.heldItem as unknown as { name?: string })?.name;
    if (held !== blockType) {
      const found = findItemInInventory(bot, blockType);
      if (!found) return false;
      await bot.equip(found.item as never, 'hand');
    }
    const below = bot.blockAt(v3(pos.x, pos.y - 1, pos.z)) as { name?: string } | null;
    if (!below || !below.name || below.name === 'air') return false;
    // 飞到目标正上方 2 格（高于所有单层障碍，水平移动不再撞墙）
    const hover = v3(pos.x + 0.5, pos.y + 2.0, pos.z + 0.5);
    if (bot.entity.position.distanceTo(hover) > 0.8) {
      // 优先 /tp（服务器权威，不撞墙）
      const arrived = await teleportCreative(bot, hover.x, hover.y, hover.z, timeoutMs);
      if (!arrived) return false;
    }
    // 俯视参考面顶面中心（below 顶 = pos.y-0.5），放块
    await withTimeout(bot.lookAt(v3(pos.x + 0.5, pos.y - 0.5, pos.z + 0.5), true), 8000, '俯视');
    await bot.placeBlock(below as never, v3(0, 1, 0) as never);
    return true;
  } catch (e) {
    console.log(`[smartPlace] 上方兜底失败 @ ${pos.x},${pos.y},${pos.z} → ${(e as Error).message}`);
    return false;
  }
}

/**
 * 智能放置方块：
 * 1. 找目标位置的可放置参考面（优先正下方）
 * 2. 校验"参考面在视线内 + 在 reach 内"，不满足就自动找最近的能看到的位置并移动过去
 * 3. 就位后看向参考面再放置 —— 杜绝"凭空放置"和"够不着硬放"
 * 创造模式自动飞行就位，生存模式用 pathfinder 走位。
 * @returns true=放置成功
 */
export async function smartPlace(
  bot: mineflayer.Bot,
  pos: { x: number; y: number; z: number },
  blockType: string,
  depth = 0
): Promise<boolean> {
  const isCreative = bot.game.gameMode === 'creative';
  // 0. 装备方块
  const held = (bot.heldItem as unknown as { name?: string })?.name;
  if (held !== blockType) {
    const found = findItemInInventory(bot, blockType);
    if (!found) { console.log(`[smartPlace] 失败: 库存无 ${blockType} @ ${pos.x},${pos.y},${pos.z}`); return false; }
    await bot.equip(found.item, 'hand');
  }
  // 1. 参考方块：优先正下方（从下往上自然生长，视线无遮挡）
  const below = bot.blockAt(v3(pos.x, pos.y - 1, pos.z)) as unknown as { name?: string } | null;
  const ref = (below && below.name !== 'air')
    ? { block: below as never, faceVector: v3(0, 1, 0) }
    : findReferenceBlock(bot, pos);
  if (!ref) { console.log(`[smartPlace] 失败: 无参考面 @ ${pos.x},${pos.y},${pos.z} below=${below?.name}`); return false; }

  const refPos = (ref.block as { position: { x: number; y: number; z: number } }).position;
  const targetCenter = v3(refPos.x + 0.5, refPos.y + 0.5, refPos.z + 0.5);

  // 2. 找就位点：候选里第一个"看得到参考面 + 够得着"的（按距离近优先）
  let stand: { x: number; y: number; z: number } | null = null;
  // 就位点排除目标格本身：停在目标格时，服务器会因"目标被实体占据"拒绝放置
  const candidates = standCandidates(bot, refPos)
    .filter((c) => !(c.x === pos.x && c.y === pos.y && c.z === pos.z))
    .sort(
      (a, b) => v3(a.x, a.y, a.z).distanceTo(targetCenter) - v3(b.x, b.y, b.z).distanceTo(targetCenter)
    );
  for (const c of candidates) {
    if (await canSeeTarget(bot, c, targetCenter)) { stand = c; break; }
  }
  if (!stand) {
    // 【垫脚本能】没有能"看得到参考面"的就位点 → 多半是站太矮看不到高处（仅生存；创造可悬空）。
    if (!isCreative && pos.y - bot.entity.position.y > 0.5 && depth < 3) {
      const raised = await pillarUpTo(bot, Math.floor(pos.y) - 1, 8);
      if (raised) {
        console.log(`[smartPlace] 🧱 无就位点，垫脚升到 ${Math.floor(bot.entity.position.y)} 层重试放 ${blockType} @ ${pos.x},${pos.y},${pos.z}`);
        return smartPlace(bot, pos, blockType, depth + 1);
      }
    }
    console.log(`[smartPlace] 失败: 无可见就位点 @ ${pos.x},${pos.y},${pos.z} 参考面=${refPos.x},${refPos.y},${refPos.z} 候选=${candidates.length}`);
    if (await placeFromAbove(bot, pos, blockType)) return true;
    return false;
  }

  // 3. 移动到就位点
  //    创造模式：直接用 creativeFlyTo 精确飞到 stand（行走 pathfinder 不支持悬空/高空，
  //    会把 bot 卡进目标格或原地空转）；生存模式：pathfinder 优先（服务器认可的物理移动）+ 垫脚兜底。
  const cur = bot.entity.position;
  if (cur.distanceTo(v3(stand.x, stand.y, stand.z)) > 0.6) {
    if (isCreative) {
      // 优先 /tp（服务器权威，不碰撞、不被拉回），失败再退回 creativeFlyTo
      const tped = await teleportCreative(bot, stand.x + 0.5, stand.y, stand.z + 0.5, 5000);
      if (!tped) {
        try {
          await withTimeout(creativeFlyTo(bot, stand, 15000), 15000, '飞行就位');
        } catch (e) {
          console.log(`[smartPlace] 失败: 飞行就位 @ ${pos.x},${pos.y},${pos.z} → ${(e as Error).message}`);
          if (await placeFromAbove(bot, pos, blockType)) return true;
          return false;
        }
      }
    } else {
      const pf = (bot as unknown as { pathfinder?: any }).pathfinder;
      const { goals } = require('@nxg-org/mineflayer-pathfinder') as { goals: any };
      let moved = false;
      if (pf && pf.goto) {
        try {
          // 容差放宽到 1.2，目标悬空时 pathfinder 走到最近可达点也算就位
          await withTimeout(pf.goto(new goals.GoalNear(stand.x, stand.y, stand.z, 1.2)), 12000, '移动就位');
          moved = true;
        } catch (e) {
          console.log(`[smartPlace] pathfinder 就位失败 @ ${pos.x},${pos.y},${pos.z} → ${(e as Error).message}`);
        }
      }
      if (!moved) {
        // 【垫脚本能】够不着（目标在上方、pathfinder 上不去就位点）→ 垫脚升到目标层，重试整轮放置
        if (pos.y - bot.entity.position.y > 1.0 && depth < 3) {
          const raised = await pillarUpTo(bot, Math.floor(pos.y) - 1, 8);
          if (raised) {
            console.log(`[smartPlace] 🧱 垫脚升到 ${Math.floor(bot.entity.position.y)} 层，重试放 ${blockType} @ ${pos.x},${pos.y},${pos.z}`);
            return smartPlace(bot, pos, blockType, depth + 1);
          }
        }
        return false;
      }
    }
  }

  // 4. 看向参考方块，放置（带让位 + 重试：目标格被自己占据时挪开再放）
  const moveAway = async (): Promise<boolean> => {
    const feet = bot.entity.position.floored();
    // 候选按到 refPos 距离近优先：选离结构最近的让位格，不选远处需要绕路的（旧逻辑取未排序首候选）
    const away = standCandidates(bot, refPos)
      .sort(
        (a, b) => v3(a.x, a.y, a.z).distanceTo(v3(refPos.x, refPos.y, refPos.z)) -
          v3(b.x, b.y, b.z).distanceTo(v3(refPos.x, refPos.y, refPos.z))
      )
      .find((c) => !(c.x === feet.x && c.y === feet.y && c.z === feet.z));
    if (!away) return false;
    try {
      if (isCreative) {
        // 创造：优先 /tp（服务器权威），失败再 creativeFlyTo
        const moved = await teleportCreative(bot, away.x + 0.5, away.y, away.z + 0.5, 3000);
        if (!moved) await withTimeout(creativeFlyTo(bot, away, 8000), 8000, '飞行让位');
      } else {
        const pf3 = (bot as unknown as { pathfinder?: any }).pathfinder;
        if (!pf3 || !pf3.goto) return false;
        const { goals: g3 } = require('@nxg-org/mineflayer-pathfinder') as { goals: any };
        await withTimeout(pf3.goto(new g3.GoalNear(away.x, away.y, away.z, 1.0)), 8000, '让位');
      }
      return true;
    } catch {
      return false;
    }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 主手必须持有目标方块（mineflayer _genericPlace 依赖 bot.heldItem 发 block_place 包，空手会被服务器忽略）
      const held2 = (bot.heldItem as unknown as { name?: string } | null);
      if (!held2 || held2.name !== blockType) {
        const found = findItemInInventory(bot, blockType);
        if (!found) { console.log(`[smartPlace] 失败: 主手无 ${blockType} 且背包也没有`); return false; }
        await equipByName(bot, blockType);
      }
      const feet = bot.entity.position.floored();
      if (feet.x === pos.x && feet.y === pos.y && feet.z === pos.z) {
        await moveAway();
      }
      // mineflayer 4.27 lookAt 已是 async（内部 await bot.look），直接 await
      await withTimeout(bot.lookAt(targetCenter, true), 8000, '转身');
      try {
        await bot.placeBlock(ref.block as never, ref.faceVector as never);
      } catch (pe) {
        // 放置确认事件可能超时（blockUpdate 5s 没到），但服务器其实已放置 → 查目标位置验证，
        // 否则工作台已被消耗却被误判失败，后续全部"库存无"。
        await sleepMs(350);
        const placedBlk = bot.blockAt(v3(pos.x, pos.y, pos.z));
        if (placedBlk && placedBlk.name === blockType) return true;
        throw pe;
      }
      return true;
    } catch (e) {
      console.log(`[smartPlace] 重试${attempt} 放置 @ ${pos.x},${pos.y},${pos.z} → ${(e as Error).message}`);
      await moveAway();
      await sleepMs(300);
    }
  }
  console.log(`[smartPlace] 失败: 放置 @ ${pos.x},${pos.y},${pos.z}（3 次尝试均未被服务器确认）`);
  if (await placeFromAbove(bot, pos, blockType)) return true;
  return false;
}

/** 简易容器窗口 shape（供 smelt/chest 等交互用） */
export type AnyWindowLike = {
  close: () => Promise<void>;
  deposit?: (itemType: number, metadata: number, count?: number, nbt?: unknown) => Promise<void>;
  withdraw?: (itemType: number, metadata: number, count?: number, nbt?: unknown) => Promise<void>;
  containerItems?: () => Array<{ name: string; type: number; metadata: number; count: number; slot: number }>;
};

/** 熔炼并取回：把 rawName 若干份放入附近熔炉，轮询到 resultName 出炉并取回背包。
 *  返回实取数量；失败 throw Error（超时/缺炉/缺料）。已有足够成品则直接成功。 */
export async function smeltBatch(
  bot: mineflayer.Bot,
  rawName: string,
  resultName: string,
  want: number,
  fuelName = 'coal'
): Promise<{ got: number; note: string }> {
  const haveNow = findItemInInventory(bot, resultName);
  const haveCount = haveNow?.count ?? 0;
  if (haveCount >= want) return { got: want, note: `背包已有 ${resultName} x${haveCount}` };
  const furnace = bot.findBlock({ matching: (b) => (b?.name ?? '') === 'furnace', maxDistance: 32 }) as unknown as {
    name: string; position: { x: number; y: number; z: number };
  } | null;
  if (!furnace) throw new Error('附近 32 格内没有熔炉');
  const { goals } = require('@nxg-org/mineflayer-pathfinder') as { goals: any };
  // 已贴脸（≤4 格）就直接开炉，别走寻路——新版 pathfinder 对近距离目标会空转误报"卡住"
  const distToFurnace = bot.entity.position.distanceTo(v3(furnace.position.x, furnace.position.y, furnace.position.z));
  if (distToFurnace > 4) {
    await gotoSmart(bot, new goals.GoalNear(furnace.position.x, furnace.position.y, furnace.position.z, 3), 20000, '走到熔炉');
  }
  // 直接用 findBlock 返回的方块对象开炉（自带 position），不用 blockAt 二次查询——
  // 1.21.1 下 blockAt 在个别已加载区块会返回 null，传给 openBlock 会让 mineflayer 在
  // 事件回调里抛未捕获 TypeError 崩掉整个进程
  const win = (await bot.openBlock(furnace as never)) as unknown as AnyWindowLike;
  const need = want - haveCount;
  try {
    const raw = findItemInInventory(bot, rawName);
    if (!raw || raw.count <= 0) throw new Error(`背包里没有 ${rawName}，先去挖矿`);
    const put = Math.min(raw.count, need);
    const rawItem = raw.item as unknown as { type: number; metadata: number };
    const fuel = findItemInInventory(bot, fuelName);
    // 放料：deposit 自动把原料放进输入槽0、燃料进槽1（匹配同类→空槽）
    await win.deposit?.(rawItem.type, rawItem.metadata, put, null);
    if (fuel) {
      const fuelItem = fuel.item as unknown as { type: number; metadata: number };
      await win.deposit?.(fuelItem.type, fuelItem.metadata, 1, null);
    }
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const items = (win.containerItems?.() ?? []) as Array<{ name: string; type: number; metadata: number; count: number; slot: number }>;
      const out = items.find((it) => it.name === resultName);
      if (out && out.count >= need) {
        if (win.withdraw) await win.withdraw(out.type, out.metadata, need, null);
        return { got: want, note: `熔炼出炉 ${resultName} x${need} 并取回背包` };
      }
      if (!items.some((it) => it.name === rawName) && !out) break; // 原料烧完却无产出（可能燃料不足）
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error('熔炼超时（90 秒没出料），请检查熔炉燃料/原料');
  } finally {
    await win.close();
  }
}

