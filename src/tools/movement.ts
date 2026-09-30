import { z } from 'zod';
import { goals } from '@nxg-org/mineflayer-pathfinder';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { getBot, ok, fail, withTimeout, creativeFlyTo, gotoSmart, walkStraightTo, hfOf, pickGear, applyGear, hopPathClear, parkourAhead, type Gear } from './helpers';
import { v3, sleep, log } from '../utils';
import { isInterrupted, interruptReasonText } from '../interrupt';
import * as fs from 'fs';
import * as path from 'path';

// ── 持续注视会话（gaze-at / stop-gaze）────────────────────────
// 纯工具式注视：大脑调一次 gaze-at 即开启后台盯人（50ms 直写 yaw/pitch 锁定目标），
// 不依赖大脑逐帧介入。刻意【不占身体锁】：任何动作（move/follow/guardian/lifestyle/其他客户端）
// 一拿到 player/guardian 锁，本会话在下一拍检测到就自动让位停止，避免抢视线/卡死后续工具。
interface GazeState {
  key: string;          // 匹配键（玩家名或实体类型）
  name: string;         // 展示名
  deadline: number | null; // 到时自动停；null=直到 stop-gaze
  timer: NodeJS.Timeout | null;
}
let gazeState: GazeState | null = null;

function stopGaze(reason: string | null): void {
  const s = gazeState;
  if (!s) return;
  gazeState = null;
  if (s.timer) { clearInterval(s.timer); s.timer = null; }
  if (reason) log('INFO', `👀 注视 ${s.name} 已停止：${reason}`);
}

type GazeEnt = {
  username?: string; name?: string; kind?: string; mobType?: string;
  position: { x: number; y: number; z: number };
};
function findGazeTarget(bot: ReturnType<typeof getBot>, key: string): GazeEnt | null {
  const ents = Object.values(bot.entities) as unknown as GazeEnt[];
  return ents.find((e) => e.username === key || e.name === key || e.kind === key || e.mobType === key) ?? null;
}


// 可交互方块：目标是这些时 bot 站旁边即可（放行，不误拦；正常 move-to 台子/箱子旁场景）
const INTERACT_BLOCKS = new Set([
  'chest', 'trapped_chest', 'ender_chest', 'barrel', 'crafting_table',
  'furnace', 'blast_furnace', 'smoker', 'anvil', 'brewing_stand',
  'lectern', 'grindstone', 'stonecutter', 'smithing_table', 'cartography_table',
  'fletching_table', 'loom', 'composter', 'cauldron', 'bell', 'respawn_anchor',
]);

// 目标合法性预检：不可达位置直接拒绝，不盲走
function checkTarget(
  bot: ReturnType<typeof getBot>,
  tx: number, ty: number, tz: number
): string | null {
  if (ty < -64 || ty > 320) return `目标 y=${ty} 超出世界高度（-64~320），可能是虚空/天顶，无法到达`;
  try {
    const b = bot.blockAt(v3(tx, ty, tz)) as unknown as { name?: string } | null;
    if (b) {
      const name = b.name ?? '';
      if (name.includes('lava') || name === 'magma') return '目标在岩浆里，不能直接走进去，建议绕路或先铺方块';
      if (name.includes('bedrock')) return '目标是基岩，无法到达';
      // 【9/8 修复】目标是实心方块（矿石/石头/原木等不可站格）→ 提前拦，别让 bot 直线走顶上去
      // 在两个矿物之间反复微抖（实测：move-to 铁矿石本体被台阶自动跳带上矿顶、forward 顶格空转）。
      if (isSolidBlock(b) && !INTERACT_BLOCKS.has(name)) {
        return `目标格是 ${name}（实心方块），bot 站不进去。` +
          `若想采集/挖掘请用 dig-block 或 mine-ore；若想站到它上方，把 y 改成 ${ty + 1}（上方空气格）；想站旁边则用相邻地面坐标`;
      }
    }
  } catch {
    /* 区块未加载就跳过方块检查 */
  }
  return null;
}

// 实心方块判定（空气/水/岩浆不算障碍）
function isSolidBlock(b: unknown): boolean {
  const n = (b as { name?: string } | null)?.name ?? '';
  if (!n) return false;
  if (n === 'air' || n === 'cave_air' || n === 'void_air' || n === 'water' || n === 'lava') return false;
  if (n.includes('lava') || n.includes('fire')) return false;
  return true;
}

/** 根据当前 yaw 与相对方向，返回移动单位水平向量 (dx,dz)。forward=(-sin yaw, -cos yaw)，其余方向旋转。 */
function moveVector(bot: ReturnType<typeof getBot>, dir: 'forward' | 'back' | 'left' | 'right') {
  const yaw = bot.entity.yaw;
  let dx = -Math.sin(yaw);
  let dz = -Math.cos(yaw);
  if (dir === 'back') { dx = -dx; dz = -dz; }
  else if (dir === 'left') { const t = dx; dx = dz; dz = -t; }
  else if (dir === 'right') { const t = dx; dx = -dz; dz = t; }
  return { dx, dz };
}

/** 归一化角度差到 [-π, π]，取最短转向弧 */
function normAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * 【FIX 9/12-v4 · 交还发包朝向不能瞬断】walk-path 结束时若直接 headStat.headYaw = null，
 * 包朝向会从"限速中的头"一步跳回 entity.yaw（身体）——拐弯/掉头刚结束时头身夹角 45~180°，
 * 观测端（玩家）看到的就是"快到看不清的一次猛甩头"。实测抓到单包跳变 45.6° / 65.8°。
 * 改法：后台按 300°/s 把头部朝向收敛到身体朝向，收敛完再撤覆盖（最多 1.5s）。
 */
let headHandbackTimer: ReturnType<typeof setInterval> | null = null;
function stopHeadHandback(): void {
  if (headHandbackTimer) {
    clearInterval(headHandbackTimer);
    headHandbackTimer = null;
  }
}
function startHeadHandback(bot: { entity: { yaw: number } }, headStat: { headYaw: number | null }): void {
  stopHeadHandback();
  const toNotchianDeg = (r: number): number => (((Math.PI - r) * 180) / Math.PI + 720) % 360;
  const t0 = Date.now();
  headHandbackTimer = setInterval(() => {
    try {
      const cur = headStat.headYaw;
      if (typeof cur !== 'number') {
        stopHeadHandback();
        return;
      }
      const d = ((toNotchianDeg(bot.entity.yaw) - cur + 540) % 360) - 180; // 最短弧（度）
      const STEP = 15; // 300°/s × 50ms
      if (Math.abs(d) <= STEP || Date.now() - t0 > 1500) {
        headStat.headYaw = null; // 已收敛到身体朝向 → 撤覆盖，无感
        stopHeadHandback();
        return;
      }
      headStat.headYaw = (cur + Math.sign(d) * STEP + 360) % 360;
    } catch {
      headStat.headYaw = null;
      stopHeadHandback();
    }
  }, 50);
}

/**
 * 智能直走：朝指定方向持续移动 durMs。
 * ・前方 1 格高台阶（脚部有块、头/落点通畅）→ 自动跳跃翻越，不用 pathfinder
 * ・连续 ~1.5s 几乎没位移 → 判定卡死，尝试跳一次自救，仍不动则放弃并报告
 */
export async function autoJumpMove(
  bot: ReturnType<typeof getBot>,
  dir: 'forward' | 'back' | 'left' | 'right',
  durMs: number
): Promise<{ ok: boolean; reason?: string }> {
  const deadline = Date.now() + durMs;
  // 目标方向向量（相对当前 yaw 换算到世界方向）
  const { dx, dz } = moveVector(bot, dir);
  const stepX = Math.abs(dx) > Math.abs(dz) ? Math.sign(dx) : 0;
  const stepZ = Math.abs(dz) >= Math.abs(dx) ? Math.sign(dz) : 0;
  // 边转边走：转头动画与迈步并行。不依赖 lookAt 固定速度——自推 yaw：
  // ①按角度差自适应时长（30°≈0.3s 快扫 / 90°≈0.75s 自然 / 180°≈1.2s 慢转）
  // ②easeOutQuad 缓动（甩头→快到目标减速稳住）
  // 注意不能用 bot.look(yaw,0,true) 逐帧推：其 force 分支直写 lastSentYaw（发包基准），
  // 而 mineflayer updatePosition 每 tick 又把 lastSentYaw 以 yawSpeed(3rad/s) 限速收敛回 entity.yaw，
  // 两套逻辑打架 → 服务器端朝向滞后/不动，玩家看到"面向原方向、身体倒退"的倒车观感。
  // 正确做法：直接驱动 entity.yaw/pitch（本地即时→移动方向跟随），服务器侧由 updatePosition 自动平滑同步。
  // 转头改 yaw 后 mineflayer 的 left/right/back 侧移会随新 yaw 漂移，故统一 forward 控制（真人"转身→迈步"）
  const startYaw = bot.entity.yaw;
  const targetYaw = Math.atan2(-dx, -dz);
  const delta = normAngle(targetYaw - startYaw);
  const turnMs = 300 + 900 * Math.min(Math.abs(delta) / Math.PI, 1);
  const turnStart = Date.now();
  const yawTimer = setInterval(() => {
    const t = Math.min((Date.now() - turnStart) / turnMs, 1);
    bot.entity.yaw = startYaw + delta * (t * (2 - t)); // easeOutQuad
    bot.entity.pitch = 0; // 平视：消除 lookAt 残留的低头
    if (t >= 1) clearInterval(yawTimer);
  }, 50);
  bot.setControlState('forward', true);
  // 移动中随机空挥（拟人细节：真人走路无聊会空挥武器/拳头，几乎没人注意但拟人感强）。
  // swingArm 是纯客户端动画，零副作用、不触发攻击。每 50ms 掷骰 0.3% → 平均约 17s 一次（实测观感再调）。
  const swingTimer = setInterval(() => {
    if (Math.random() < 0.003) bot.swingArm('right');
  }, 50);
  let lastJumpAt = 0;
  let lastPos = bot.entity.position.clone();
  let stuckSince = Date.now();
  let lastReason = '';
  try {
    while (Date.now() < deadline) {
      const p = bot.entity.position;
      // 卡死检测：1.5s 内位移不足 0.35 格
      if (p.distanceTo(lastPos) > 0.35) {
        stuckSince = Date.now();
        lastPos = p.clone();
      } else if (Date.now() - stuckSince > 1500) {
        // 尝试跳一次自救（可能卡在 1 格小坎/半格台阶上）
        bot.setControlState('jump', true);
        await sleep(150);
        bot.setControlState('jump', false);
        await sleep(900);
        if (bot.entity.position.distanceTo(lastPos) < 0.2) {
          // 跳了还不动 → 真被挡（2 格墙/大坑/实体挡路），放弃
          const b = bot.blockAt(v3(Math.floor(p.x) + stepX, Math.floor(p.y), Math.floor(p.z) + stepZ)) as unknown as { name?: string } | null;
          lastReason = `前方被挡：${b?.name ?? '未知'}。建议换方向或 move-to 绕路`;
          break;
        }
        stuckSince = Date.now();
        lastPos = bot.entity.position.clone();
      }
      // 1 格高台阶自动跳：前方脚部层是实心、前方上一层空 → 跳上去
      if (bot.entity.onGround && Date.now() - lastJumpAt > 350) {
        const by = Math.floor(p.y);
        const nxb = Math.floor(p.x) + stepX;
        const nzb = Math.floor(p.z) + stepZ;
        const frontLvl = bot.blockAt(v3(nxb, by, nzb));
        const frontUp = bot.blockAt(v3(nxb, by + 1, nzb));
        if (isSolidBlock(frontLvl) && !isSolidBlock(frontUp)) {
          bot.setControlState('jump', true);
          await sleep(120);
          bot.setControlState('jump', false);
          lastJumpAt = Date.now();
        }
      }
      await sleep(50);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e) };
  } finally {
    clearInterval(yawTimer);
    clearInterval(swingTimer);
    bot.setControlState('forward', false);
    bot.setControlState('jump', false);
  }
}

/** 创造模式直线飞行到坐标（共用实现：move-to mode=fly 与废弃兼容的 fly-to 都走这里） */
async function flyToCoord(
  bot: ReturnType<typeof getBot>,
  tx: number, ty: number, tz: number
): Promise<{ ok: boolean; msg: string }> {
  if (!(bot as unknown as { creative?: object }).creative) return { ok: false, msg: '当前模式不支持飞行（需创造模式或开启飞行）' };
  // 超时预算按距离动态给：实测 mineflayer 平飞 ~4.5 格/秒，按 dist*300ms 估算 + 5s 余量，15s 起步、上限 120s（自动飞行可达 ~500 格）
  const dist = bot.entity.position.distanceTo(v3(tx, ty, tz));
  const budget = Math.min(120000, Math.max(15000, Math.round(dist * 300) + 5000));
  try {
    await withTimeout(creativeFlyTo(bot, { x: tx, y: ty, z: tz }, budget), budget, '飞行就位');
    return { ok: true, msg: `已飞到 (${tx}, ${ty}, ${tz})` };
  } catch (e) {
    return { ok: false, msg: `飞行失败：${String(e)}` };
  }
}

/**
 * 【垫脚自救 v1 9/12】玩家点名要的"垫方块"：跳起来在脚下放一块，站上去，逐层爬高。
 * 用途：正前方 ≥2 格实心墙时，跳跃只抬 1.25 格，跳一百次也上不去，必须垫脚。
 * 返回实际爬升格数；没方块 / 放不上 / 没爬升都如实返回，不假装成功。
 */
async function pillarUpRescue(bot: ReturnType<typeof getBot>, maxUp = 3): Promise<number> {
  const y0 = bot.entity.position.y;
  let placed = 0;
  for (let i = 0; i < maxUp; i++) {
    const me = bot.entity.position;
    const item = bot.inventory
      .items()
      .find((it: { name: string }) => /(_concrete|cobblestone|dirt|_planks|stone|_wool|sand|gravel)/.test(it.name));
    if (!item) {
      log('WARN', '🪜 垫脚自救失败：背包里没有可放置方块');
      break;
    }
    try {
      await bot.equip(item, 'hand');
    } catch {
      break;
    }
    const below = bot.blockAt(v3(Math.floor(me.x), Math.floor(me.y) - 1, Math.floor(me.z)));
    if (!below) break;
    let ok = false;
    bot.setControlState('jump', true);
    await sleep(320); // 上升途中（落地前）在脚下方块顶面放新块
    try {
      await bot.placeBlock(below as never, v3(0, 1, 0));
      ok = true;
    } catch {
      ok = false;
    }
    bot.setControlState('jump', false);
    await sleep(300);
    if (bot.entity.position.y > me.y + 0.5) placed++;
    else if (!ok) break; // 放不上又没爬升 → 不硬撑
  }
  log(
    'INFO',
    `🪜 垫脚自救：爬升 ${placed} 格（y ${y0.toFixed(1)} → ${bot.entity.position.y.toFixed(1)}）`
  );
  return placed;
}

export function registerMovementTools(mcp: McpServerManager, ctx: ToolContext): void {
  // 移动到坐标
  mcp.registerTool(
    'move-to',
    '移动到指定坐标。mode: walk=走路寻路 / fly=直线飞行（需创造模式）/ auto=自动判断（超 128 格自动切飞行）。20 秒内没走到会报告当前距离和卡住原因，并给出下一步建议',
    { x: z.number(), y: z.number(), z: z.number(), tolerance: z.number().optional().describe('到达容差，默认 1 格'), mode: z.enum(['walk', 'fly', 'auto']).optional().describe('移动方式：walk=走路寻路, fly=飞行直线, auto=自动判断（超128格自动飞），默认 auto') },
    async (args) => {
      const bot = getBot(ctx);
      const tol = Number(args.tolerance ?? 1);
      const tx = Number(args.x), ty = Number(args.y), tz = Number(args.z);
      try {
        const start = bot.entity.position;
        const dist = start.distanceTo(v3(tx, ty, tz));
        // 预检 1：已经在目标附近，直接完成
        if (dist <= tol) return ok(`已经在 (${tx}, ${ty}, ${tz}) 附近`);
        // 预检 2：目标合法性（虚空/岩浆/基岩）
        const bad = checkTarget(bot, tx, ty, tz);
        if (bad) return fail(bad);
        // 移动方式：walk=寻路 / fly=直线飞行 / auto=近处寻路、超远(>128)自动切飞行（需创造）
        const mode = String(args.mode ?? 'auto');
        const isCreative = !!(bot as unknown as { creative?: object }).creative;
        const wantFly = mode === 'fly' || (mode === 'auto' && dist > 128 && isCreative);
        if (wantFly) {
          const r = await flyToCoord(bot, tx, ty, tz);
          return r.ok ? ok(r.msg) : fail(r.msg);
        }
        // 预检 3：超远目标且不飞行（寻路容易超时）
        if (dist > 128) {
          return fail(`目标距离 ${Math.round(dist)} 格太远，直接寻路容易超时。建议先分几步走（每次 ≤64 格）或创造模式改用 move-to mode='fly'`);
        }
        // 进度提示：每 5 秒报一次剩余距离
        const progressTimer = setInterval(() => {
          try {
            const d = bot.entity.position.distanceTo(v3(tx, ty, tz));
            log('INFO', `⏳ 前往 (${tx}, ${ty}, ${tz}) 中… 还差 ${Math.round(d)} 格`);
          } catch { /* bot 可能已断开 */ }
        }, 5000);
        try {
          // 短距（≤12 格）直线走：不寻路——新版 pathfinder 对近距离目标会空转误报"卡住"（BUG-08/10），
          // 平地直走（转向用直写 yaw，同追视那套）又快又稳。被挡/超时才降级 gotoSmart 绕路。
          if (dist <= 12) {
            try {
              await walkStraightTo(bot, { x: tx, y: ty, z: tz }, { timeoutMs: 15000, tol });
              const me = bot.entity.position;
              const actual = me.distanceTo(v3(tx, ty, tz));
              // 到达后读浮点坐标回报实际偏差（BUG-02：不拿取整坐标自欺欺人）
              return ok(actual <= tol + 0.2
                ? `已到达 (${tx}, ${ty}, ${tz})（实际偏差 ${actual.toFixed(2)} 格）`
                : `已走到 (${tx}, ${ty}, ${tz}) 附近（偏差 ${actual.toFixed(1)} 格，直线走够近即算）`);
            } catch (e) {
              const still = bot.entity.position.distanceTo(v3(tx, ty, tz));
              if (still <= tol + 0.5) {
                return ok(`已到达 (${tx}, ${ty}, ${tz})（容差内，实际偏差 ${still.toFixed(2)} 格）`);
              }
              log('INFO', `🔄 直线走未达（${String(e)}），降级 pathfinder 绕路`);
            }
          }
          // gotoSmart：日常 20s 超时 + 每 5s 卡住检测（连续 10s 没动自动停）+ 卡住自动挖面前方块自救
          // 纯走路模式（迷宫测试）：给 A* 充足预算，否则长路径还没算完就被判超时
          const pureWalk = process.env.PF_PURE_WALK === '1';
          await gotoSmart(bot, new goals.GoalNear(tx, ty, tz, tol), pureWalk ? 105000 : 20000, '移动', { rescue: true });
          const me = bot.entity.position;
          const actual = me.distanceTo(v3(tx, ty, tz));
          const hops = (bot as unknown as { __lastMoveHops?: number }).__lastMoveHops ?? 0;
          const hopTxt = hops > 0 ? `，途中起跳 ${hops} 次` : '，途中没起跳';
          return ok(actual <= tol + 0.2
            ? `已到达 (${tx}, ${ty}, ${tz})（实际偏差 ${actual.toFixed(2)} 格${hopTxt}）`
            : `已到达 (${tx}, ${ty}, ${tz})（容差内，偏差 ${actual.toFixed(1)} 格${hopTxt}）`);
        } catch (e) {
          const nowDist = bot.entity.position.distanceTo(v3(tx, ty, tz));
          if (nowDist <= tol + 1) return ok(`已到达 (${tx}, ${ty}, ${tz})（容差内）`);
          const msg = String(e);
          // 自救 2：挖完还卡住 → 尝试 tp（有权限/创造模式时）；纯走路模式(PF_PURE_WALK)下禁用，防瞬移作弊
          if (msg.includes('卡住') && process.env.PF_PURE_WALK !== '1') {
            try {
              log('WARN', `⚠️ 移动卡住，尝试 tp 脱困 (${tx}, ${ty}, ${tz})`);
              bot.chat(`/tp ${bot.username} ${tx} ${ty} ${tz}`);
              await sleep(2500);
              const d = bot.entity.position.distanceTo(v3(tx, ty, tz));
              if (d <= tol + 1) return ok(`已 tp 到 (${tx}, ${ty}, ${tz})`);
            } catch { /* tp 无权限或失败，继续 */ }
            // 自救 3：tp 也不行 → 不再当场喊玩家（把失败原因交回大脑判断，trivial 情况自己消化）
            log('WARN', `🚨 移动彻底卡住（挖方块+垫脚+tp 均失败）`);
            return fail(
              `没能走到 (${tx}, ${ty}, ${tz})：${msg}（已尝试挖方块和 tp，都不行）。` +
              `若只是差一两格高度，可再次调用 move-to 让垫脚本能生效`
            );
          }
          return fail(
            `没能走到 (${tx}, ${ty}, ${tz})：${msg}。当前距目标约 ${Math.round(nowDist)} 格，` +
            `建议：换一条路线 / 先 dig-block 挖掉挡路的方块 / 创造模式用 fly-to 直接飞过去`
          );
        } finally {
          clearInterval(progressTimer);
        }
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 向方向移动
  mcp.registerTool(
    'move-direction',
    '朝指定方向移动一段时间（方向: forward/back/left/right，duration 秒）',
    { direction: z.enum(['forward', 'back', 'left', 'right']), duration: z.number().describe('移动秒数，默认 2') },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const dir = String(args.direction) as 'forward' | 'back' | 'left' | 'right';
        const dur = Number(args.duration ?? 2);
        // 智能直走：自动跳 1 格高台阶；卡死检测，被挡会报告并自动停下
        const res = await autoJumpMove(bot, dir, Math.min(dur, 10) * 1000);
        if (!res.ok) {
          return fail(`向 ${dir} 移动失败：${res.reason ?? '未知原因'}（已自动停下）`);
        }
        const { x, y, z } = bot.entity.position;
        return ok(`已向 ${dir} 移动 ${dur} 秒，现在位于 (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 跳跃
  mcp.registerTool(
    'jump',
    '原地跳跃（可以跳过障碍或表达开心）',
    {},
    async () => {
      try {
        const bot = getBot(ctx);
        bot.setControlState('jump', true);
        await sleep(400);
        bot.setControlState('jump', false);
        return ok('跳了一下');
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 看向
  mcp.registerTool(
    'look-at',
    '让 bot 看向指定坐标方向',
    { x: z.number(), y: z.number(), z: z.number() },
    async (args) => {
      try {
        const bot = getBot(ctx);
        await bot.lookAt(v3(Number(args.x), Number(args.y), Number(args.z)));
        // 常驻注视让位：主动看别处 2.5s（看完自动恢复盯附近玩家，拟人"回头看你"）
        ctx.gaze?.()?.pause(2500, '大脑 look-at 主动视线');
        return ok(`已看向 (${args.x}, ${args.y}, ${args.z})`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 持续追踪实体（追视：盯住移动目标，视线平滑跟随，身体不动）
  mcp.registerTool(
    'track-entity',
    '持续注视指定实体（玩家名/实体类型如 chest_minecart/zombie），期间每 50ms 把视线对准目标当前位置实现平滑追视，身体保持不动；目标消失自动保持原朝向不甩头',
    { entity: z.string().describe('玩家名或实体类型，如 Steve / chest_minecart / zombie / player'), duration: z.number().optional().describe('追踪秒数，默认 8，最大 30') },
    async (args) => {
      try {
        const bot = getBot(ctx);
        stopGaze('track-entity 接管'); // 一次性追视接管，停掉后台注视会话避免抢视线
        const dur = Math.min(30, Math.max(1, Number(args.duration ?? 8))) * 1000;
        const key = String(args.entity);
        const deadline = Date.now() + dur;
        const timer = setInterval(() => {
          try {
            if (Date.now() > deadline) { clearInterval(timer); return; }
            // 让位（v17）：身体被动作占用（跟随/移动/保命）时不抢视线，避免两套朝向逻辑互相覆盖
            if (ctx.body().current().owner !== null) {
              clearInterval(timer);
              log('INFO', '👀 track-entity 让位：身体被动作占用，停止追视');
              return;
            }
            const ents = Object.values(bot.entities) as Array<{ username?: string; name?: string; kind?: string; mobType?: string; position: { x: number; y: number; z: number } }>;
            const t = ents.find(e => e.username === key || e.name === key || e.kind === key || e.mobType === key);
            if (!t) return;
            const me = bot.entity.position;
            const p = t.position;
            const dy = (p.y + (t.username ? 1.6 : 0.5)) - (me.y + 1.62);
            bot.entity.yaw = Math.atan2(-(p.x - me.x), -(p.z - me.z));
            bot.entity.pitch = Math.atan2(dy, Math.hypot(p.x - me.x, p.z - me.z));
          } catch { /* bot 可能断开 */ }
        }, 50);
        await sleep(dur);
        return ok(`已追踪 ${key} ${Math.round(dur / 1000)}s`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 飞行（创造模式）——已废弃：统一走 move-to mode='fly'，本工具保留 2 周过渡兼容
  mcp.registerTool(
    'fly-to',
    '【已废弃】请使用 move-to 并设置 mode="fly"。本工具保留兼容，内部同样走直线飞行（需创造模式或开启飞行）',
    { x: z.number(), y: z.number(), z: z.number() },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const r = await flyToCoord(bot, Number(args.x), Number(args.y), Number(args.z));
        return r.ok ? ok(r.msg) : fail(r.msg);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 持续注视目标（纯工具·会话式）：大脑调一次即开启后台盯人，50ms 机械循环实时锁定视线，
  // 不再依赖大脑逐帧往返（逐帧 = 每步都走大脑回路 → 高延迟）；默认一直盯到 stop-gaze /
  // 目标消失 2.5s / 身体被动作占用（自动让位，动作做完不复活，要盯再喊一声）
  mcp.registerTool(
    'gaze-at',
    '开始持续注视：大脑调一次即可，后台每 50ms 把视线对准目标（玩家/实体）当前位置并平滑跟随，身体保持不动，无需大脑持续介入（无逐帧大脑延迟）。默认一直盯到 stop-gaze 或目标消失；可选 durationSec 到时自动停。注视是软会话：你让它移动/战斗时它自动停止让位，想继续再调一次',
    {
      entity: z.string().optional().describe('玩家名或实体类型（如 Steve / zombie / cow），缺省=最近的玩家'),
      durationSec: z.number().optional().describe('注视秒数（1~3600），缺省=一直盯直到 stop-gaze'),
    },
    async (args) => {
      try {
        const bot = getBot(ctx);
        stopGaze('切换目标');
        // 解析目标：指定实体 or 最近的玩家
        let key: string;
        let display: string;
        if (args.entity != null && String(args.entity) !== '') {
          key = String(args.entity);
          const hit = findGazeTarget(bot, key);
          if (!hit) return fail(`找不到目标 ${key}（不在视野/未加载），换个名字试试`);
          display = hit.username ?? hit.name ?? hit.mobType ?? hit.kind ?? key;
        } else {
          const near = Object.keys(bot.players)
            .filter((n) => n !== bot.username)
            .map((n) => ({ n, e: bot.players[n].entity }))
            .filter((o): o is { n: string; e: NonNullable<typeof o.e> } => !!o.e)
            .sort((a, b) => bot.entity.position.distanceTo(a.e.position) - bot.entity.position.distanceTo(b.e.position));
          if (!near.length) return fail('附近没有已加载的可注视玩家');
          key = near[0].n;
          display = key;
        }
        const dur = args.durationSec != null ? Math.min(3600, Math.max(1, Number(args.durationSec))) : null;
        const deadline = dur ? Date.now() + dur * 1000 : null;
        let lostSince = 0;
        const timer = setInterval(() => {
          try {
            if (!ctx.bot()) { stopGaze('bot 已断开'); return; }
            if (deadline && Date.now() > deadline) { stopGaze('注视时长到'); return; }
            // 身体被任何动作占用（move/follow/guardian/lifestyle/其他客户端）→ 自动让位，避免抢视线
            const cur = ctx.body().current();
            if (cur.owner !== null) { stopGaze(`身体被占用(${cur.owner}/${cur.label})`); return; }
            const t = findGazeTarget(bot, key);
            if (!t) {
              if (lostSince === 0) lostSince = Date.now();
              else if (Date.now() - lostSince > 2500) stopGaze('目标消失或离开视野');
              return;
            }
            lostSince = 0;
            const me = bot.entity.position;
            const p = t.position;
            // 玩家瞄眼睛(y+1.6)，生物瞄身体(y+0.5)；本地直写 yaw/pitch，服务器按 3rad/s 平滑收敛 = 玩家看到平滑转头
            const eyeY = p.y + (t.username ? 1.6 : 0.5);
            bot.entity.yaw = Math.atan2(-(p.x - me.x), -(p.z - me.z));
            bot.entity.pitch = Math.atan2(eyeY - (me.y + 1.62), Math.hypot(p.x - me.x, p.z - me.z));
          } catch { /* bot 断开等瞬时异常：下一拍自然恢复或由断开逻辑收尾 */ }
        }, 50);
        gazeState = { key, name: display, deadline, timer };
        log('INFO', `👀 开始注视 ${display}（${dur ? `${dur}s` : '持续到 stop-gaze'}, 50ms 机械循环）`);
        return ok(`开始注视 ${display}${dur ? ` ${dur} 秒` : ''}：身体不动、视线实时锁定，大脑不用再管；想停就说 stop-gaze`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 停止持续注视
  mcp.registerTool(
    'stop-gaze',
    '停止当前持续注视（gaze-at 开启的盯人）',
    {},
    async () => {
      const s = gazeState;
      if (!s) return ok('当前没有在注视');
      stopGaze('手动停止');
      return ok(`已停止注视 ${s.name}`);
    }
  );
  // 原始浮点坐标（高精度轨迹分析用）：不做任何取整
  mcp.registerTool(
    'pos-raw',
    '返回 bot 原始浮点坐标与朝向（不取整）+ 实际发包朝向 sentYaw（notchian 度，= 别人看到的头部朝向；与 yaw(弧度) 的夹角可量化"头身割裂"）+ yawSpeed，用于高精度轨迹分析',
    {},
    async () => {
      const bot = getBot(ctx);
      const p = bot.entity.position;
      const net = (bot as unknown as { __netStat?: { sentYaw: number | null } }).__netStat;
      return ok(
        JSON.stringify({
          x: p.x,
          y: p.y,
          z: p.z,
          yaw: bot.entity.yaw,
          sentYaw: net?.sentYaw ?? null,
          yawSpeed: (bot as unknown as { physics?: { yawSpeed?: number } }).physics?.yawSpeed ?? null,
          onGround: bot.entity.onGround
        })
      );
    }
  );
  // 沿路点走路（自研窄走廊执行器）：直写 yaw + 恒速前进，不依赖 HeadFollow / pathfinder
  mcp.registerTool(
    'walk-path',
    '沿路点文件走路（自研执行器 v2·投影式推进，专治 1 格宽走廊迷宫）：航向始终顺着当前走廊段，越过节点才换段（不再 1.6 格跳点斜切顶墙）；卡住自动跳跃自救，分批执行返回走到第几点',
    {
      file: z.string().optional().describe('路点文件（每行 x y z），默认 path_maze.txt'),
      from: z.number().optional().describe('起始路点索引，默认 0'),
      count: z.number().optional().describe('本次最多走多少个路点，默认 250'),
      timeLimitSec: z.number().optional().describe('本次时间上限（秒），默认 45'),
      trace: z
        .string()
        .optional()
        .describe('轨迹文件名（相对 cwd）：每 50ms 追加一行 t,x,y,z,yaw,idx；from=0 时自动清空重写')
    },
    async (args) => {
      const a = args as {
        file?: string;
        from?: number;
        count?: number;
        timeLimitSec?: number;
        trace?: string;
      };
      const bot = getBot(ctx);
      const file = a.file ?? path.join(process.cwd(), 'path_maze.txt');
      if (!fs.existsSync(file)) return fail(`路点文件不存在: ${file}`);
      const wps = fs
        .readFileSync(file, 'utf8')
        .split(String.fromCharCode(10))
        .filter((l) => l.trim())
        .map((l) => l.trim().split(/\s+/).map(Number));
      const from = Math.max(0, Math.floor(a.from ?? 0));
      const count = Math.max(1, Math.floor(a.count ?? 250));
      const timeLimitMs = Math.max(5, a.timeLimitSec ?? 45) * 1000;
      const t0 = Date.now();
      const traceFile = a.trace ? path.join(process.cwd(), a.trace) : null;
      if (traceFile && from === 0) {
        try {
          fs.writeFileSync(traceFile, 't,x,y,z,yaw,idx,head' + String.fromCharCode(10));
        } catch {
          /* ignore */
        }
      }
      const stopAll = () => {
        for (const k of ['forward', 'jump', 'sprint', 'sneak'] as const) {
          try {
            bot.setControlState(k, false);
          } catch {
            /* bot 断开 */
          }
        }
      };
      let idx = Math.max(0, Math.min(wps.length - 2, from - 1));
      const segStart = idx;
      let lastPos = bot.entity.position.clone();
      let stuckAt = Date.now();
      let jumps = 0;
      // 【距离档位 9/12】按剩余路程自动换档：远 → 跑跳/疾跑，快到头 → 收成走（avgSeg=路点平均间距，用来把"还剩几个点"折算成格）
      let gear: Gear = 'walk';
      const avgSeg = (() => {
        let s = 0;
        for (let i = 0; i + 1 < wps.length; i++) s += Math.hypot(wps[i + 1][0] - wps[i][0], wps[i + 1][2] - wps[i][2]);
        return wps.length > 1 ? s / (wps.length - 1) : 0.5;
      })();
      // 【BUGFIX 9/12 原地跳不停】记录"到当前目标节点的历史最近距离"：只有朝目标推进才算有效进展
      let bestDist = Infinity;
      let lastTargetIdx = -1;
      let tx = wps[idx + 1][0];
      let ty = wps[idx + 1][1];
      let tz = wps[idx + 1][2];
      // 【头身割裂 BUGFIX 9/12】本执行器自己直写 yaw 控航向 → 必须让 HeadFollow 挂起：
      // 否则它的"位移反推兜底"每 tick 用滞后的方向覆盖正确朝向，拐点减速时还会冻住头，
      // 观感就是"身子转了头还朝旧方向、然后猛地甩过去"。挂起后本执行器是唯一朝向来源。
      const hf = hfOf(bot);
      hf?.suspend?.();
      // 【拟人转头 v3 9/12】玩家反馈"弯道密集的地方疯狂左右摆头，速度还非常快，很不拟人"。
      // 根因两层：①每 50ms 把 yaw 直写成"朝【下一个路点】中心"，而那个点离身子只有 0.5~1 格
      //   —— 走位左右那点抖动被这么短的基线放大成 ±5~15°；②昨夜解锁 yawSpeed=200 后发包即时，
      //   抖动 1:1 传到玩家眼里 = 20Hz 抽搐（3rad/s 限速时代被抹平了，解锁后暴露出来）。
      // 真人也得这么转脑袋，故：①瞄点改"沿走廊往前看"（直段 2.5 格 = 长基线，抖动天然变小）；
      // ②限速 300°/s（90° 拐弯 ≈0.3s，真人快扫量级）取代瞬间跳变；③2° 死区滤掉微抖；
      // ④拐点前 0.55 格就瞄进新走廊 → 头先转、身子后拐。
      // 【头身解耦】entity.yaw 仍即时对准下一节点（推力平滑会让身子斜切戳墙），
      // 玩家看到的头部朝向走发包覆盖 __netStat.headYaw（见 bot-connection.ts）。
      const headStat = (bot as unknown as { __netStat?: { headYaw: number | null } }).__netStat;
      stopHeadHandback(); // 新一段走路接手：先掐掉上一段的"交还收敛"定时器
      const prevSentHead = headStat && typeof headStat.headYaw === 'number' ? headStat.headYaw : null;
      const YAW_RATE = 5.2; // rad/s ≈ 300°/s
      const YAW_DEAD = 0.035; // ≈2°：小于此的偏差不追
      const LOOK_AHEAD = 2.5; // 直走廊里瞄多远（格）
      const TURN_LEAD = 0.55; // 距拐点多少格开始提前转头
      // 起点朝向续"上一包实际发给服务器的头朝向"，别从 entity.yaw 重新起跳（又是一次瞬转）
      let headYaw = prevSentHead === null ? bot.entity.yaw : Math.PI - (prevSentHead * Math.PI) / 180;
      const ctrX = (i: number): number => wps[i][0] + 0.5;
      const ctrZ = (i: number): number => wps[i][2] + 0.5;
      /** 沿路径往前看的瞄点：与当前段同向（夹角<10°）且不超过 LOOK_AHEAD 格就继续往远看 */
      const aimPoint = (me: { x: number; z: number }): { x: number; z: number } => {
        const segDir = (i: number): { x: number; z: number } => {
          const dx = wps[i + 1][0] - wps[i][0];
          const dz = wps[i + 1][2] - wps[i][2];
          const n = Math.hypot(dx, dz) || 1;
          return { x: dx / n, z: dz / n };
        };
        let j = Math.min(idx + 1, wps.length - 1);
        let px = ctrX(j);
        let pz = ctrZ(j);
        const d0 = segDir(Math.min(idx, wps.length - 2));
        while (j + 1 < wps.length) {
          const d1 = segDir(j);
          if (d0.x * d1.x + d0.z * d1.z < 0.985) break; // 前面拐弯：瞄点停在拐点
          const nx = ctrX(j + 1);
          const nz = ctrZ(j + 1);
          if (Math.hypot(nx - me.x, nz - me.z) > LOOK_AHEAD) break;
          px = nx;
          pz = nz;
          j++;
        }
        return { x: px, z: pz };
      };
      try {
        while (idx + 1 < wps.length && idx + 1 - segStart < count && Date.now() - t0 < timeLimitMs) {
          // ★ 玩家插话 → 中断走路（原地停下）
          if (isInterrupted()) {
            stopAll();
            throw new Error(`已中断（${interruptReasonText() || '玩家插话'}），走路停下`);
          }
          let me = bot.entity.position;
          // 【v2 投影式推进】只有"越过当前节点"才切到下一段。
          // 旧版按 1.6 格半径跳路点：拐角处会直接瞄向拐弯后的远处点 → 航向斜 45° 顶墙、沿墙滑动，观感很人机。
          for (let g = 0; g < 64 && idx + 1 < wps.length; g++) {
            const ax = wps[idx][0] + 0.5;
            const az = wps[idx][2] + 0.5;
            const bx = wps[idx + 1][0] + 0.5;
            const bz = wps[idx + 1][2] + 0.5;
            const sx = bx - ax;
            const sz = bz - az;
            const l2 = sx * sx + sz * sz || 1;
            const t = ((me.x - ax) * sx + (me.z - az) * sz) / l2;
            // 【FIX 9/12-v5】bot 恰好站在节点中心时 t==1，原用 `t > 1` 不推进 →
            // 目标点 = 脚下这个点 → 顶着自己原地走 → 卡住检测误报"原地跳无进展（前方 air/air）"。
            if (t >= 1) idx++;
            else break;
          }
          if (idx + 1 >= wps.length) break;
          tx = wps[idx + 1][0];
          ty = wps[idx + 1][1];
          tz = wps[idx + 1][2];
          const cornerX = tx + 0.5;
          const cornerZ = tz + 0.5;
          // 换目标节点 → 重置进度基准（否则新段的"更远"会被当成没进展）
          if (idx !== lastTargetIdx) {
            lastTargetIdx = idx;
            bestDist = Infinity;
            stuckAt = Date.now();
            jumps = 0;
          }
          // 位移方向：即时对准下一节点中心（推力不能平滑，否则拐弯时会斜切戳墙/被卡）
          bot.entity.yaw = Math.atan2(-(cornerX - me.x), -(cornerZ - me.z));
          // 头部朝向：平时沿走廊往前看；快到拐点就提前瞄进新走廊（头先转、身子后拐）
          const aim = aimPoint(me);
          let gx = aim.x;
          let gz = aim.z;
          if (idx + 2 < wps.length && Math.hypot(cornerX - me.x, cornerZ - me.z) < TURN_LEAD) {
            const ux = cornerX - ctrX(idx);
            const uz = cornerZ - ctrZ(idx);
            const vx = ctrX(idx + 2) - cornerX;
            const vz = ctrZ(idx + 2) - cornerZ;
            const n1 = Math.hypot(ux, uz) || 1;
            const n2 = Math.hypot(vx, vz) || 1;
            if ((ux / n1) * (vx / n2) + (uz / n1) * (vz / n2) < 0.94) {
              gx = ctrX(idx + 2); // 夹角 >20° = 真拐弯
              gz = ctrZ(idx + 2);
            }
          }
          const wantYaw = Math.atan2(-(gx - me.x), -(gz - me.z));
          const maxStep = YAW_RATE * 0.05;
          let dErr = normAngle(wantYaw - headYaw);
          if (Math.abs(dErr) < YAW_DEAD) dErr = 0;
          headYaw = normAngle(headYaw + Math.max(-maxStep, Math.min(maxStep, dErr)));
          // ⚠️ 发包里的 yaw 是 notchian 度数，不是内部弧度！mineflayer: toNotchianYaw = toDegrees(PI - yaw)。
          // 第一版直接把弧度写进去 → 服务器把 3.14 当成 3.14° 读，头直接歪 90~180°（量化工具当场抓出来）。
          if (headStat) headStat.headYaw = (((Math.PI - headYaw) * 180) / Math.PI + 360) % 360;
          // ★ 跑酷护栏（9/12 玩家要求：walk-path 也共用同一套 helpers.parkourAhead）——
          //   前方是宽缺口/虚空 → 站住报错，绝不让路点把身体带进虚空；
          //   迷宫那种全程有地板的路线恰好永远返回 'ok'，不影响原有行为。
          const pk = parkourAhead(bot);
          if (pk === 'stop') {
            stopAll();
            return fail(
              `walk-path 第 ${idx}/${wps.length} 点 (${tx},${ty},${tz}) 前方是虚空/悬崖（断头路）——没迈这一步，人还在 (${me.x.toFixed(1)},${me.y.toFixed(1)},${me.z.toFixed(1)})`
            );
          }
          bot.setControlState('forward', true);
          if (pk === 'jump') {
            // 短缺口：缺口就在眼前 → 疾跑起跳跨过去（这一拍别被距离档位收成走）
            bot.setControlState('sprint', true);
            bot.setControlState('jump', true);
            gear = 'hop';
          } else {
          // 【距离档位 9/12】远 → 跑跳/疾跑，近终点 → 走；前方要拐弯（瞄点与身子差 >20°）先收成走，
          // 免得顺拐撞墙。跑跳还要过"净空 + 有地板"安全闸（2 格高走廊撞头、悬崖边不跳）。
          {
            const remainD = Math.max(0, wps.length - 2 - idx) * avgSeg;
            let g = pickGear(remainD, gear);
            if (g !== 'walk' && Math.abs(normAngle(wantYaw - bot.entity.yaw)) > 0.35) g = 'walk';
            applyGear(bot, g, { allowHop: hopPathClear(bot) });
            gear = g;
          }
          }
          await sleep(50);
          me = bot.entity.position;
          if (traceFile) {
            try {
              fs.appendFileSync(
                traceFile,
                `${Date.now() - t0},${me.x.toFixed(2)},${me.y.toFixed(2)},${me.z.toFixed(2)},${bot.entity.yaw.toFixed(3)},${idx},${headYaw.toFixed(3)}
`
              );
            } catch {
              /* ignore */
            }
          }
          // 【BUGFIX 9/12 原地跳不停】卡住判定改为"只认朝目标节点推进"（刷新历史最近距离），
          // 不再用"位置动没动 0.25 格"——原地蹦本身就能让身子挪 >0.25 格（上下+沿墙滑），
          // 旧判定被自己刷掉计时 → 无限跳直到 MCP 超时。跳之前先探正前方是否 2 格实心墙。
          const distTgt = Math.hypot(tx + 0.5 - me.x, tz + 0.5 - me.z);
          if (distTgt < bestDist - 0.2) {
            bestDist = distTgt;
            stuckAt = Date.now();
            jumps = 0;
          } else if (Date.now() - stuckAt > 900) {
            const hyaw = bot.entity.yaw;
            const fx = Math.round(me.x - Math.sin(hyaw));
            const fz = Math.round(me.z - Math.cos(hyaw));
            const by = Math.floor(me.y);
            const fFeet = bot.blockAt(v3(fx, by, fz)) as unknown as { name?: string } | null;
            const fHead = bot.blockAt(v3(fx, by + 1, fz)) as unknown as { name?: string } | null;
            if (isSolidBlock(fFeet) && isSolidBlock(fHead)) {
              // 正前方 ≥2 格实心墙：跳跃只抬 1.25 格 = 白跳 → 垫方块爬上去（玩家点名要的）
              bot.setControlState('forward', false);
              const up = await pillarUpRescue(bot, 3);
              if (up > 0) {
                lastPos = bot.entity.position.clone();
                bestDist = Infinity;
                stuckAt = Date.now();
                jumps = 0;
                continue;
              }
              stopAll();
              return fail(
                `walk-path 卡住：第 ${idx}/${wps.length} 点 (${tx},${ty},${tz}) 正前方 2 格实心墙（${fHead?.name ?? '?'}），垫脚自救也上不去（背包没方块 / 放不上）。当前 (${me.x.toFixed(1)},${me.y.toFixed(1)},${me.z.toFixed(1)})`
              );
            }
            if (jumps >= 4) {
              stopAll();
              return fail(
                `walk-path 卡住：第 ${idx}/${wps.length} 点 (${tx},${ty},${tz}) 原地跳 ${jumps} 次无进展（前方 ${fFeet?.name ?? '?'}/${fHead?.name ?? '?'}，近 900ms 位移 ${me.distanceTo(lastPos).toFixed(2)} 格）。当前 (${me.x.toFixed(1)},${me.y.toFixed(1)},${me.z.toFixed(1)})`
              );
            }
            bot.setControlState('jump', true);
            await sleep(120);
            bot.setControlState('jump', false);
            stuckAt = Date.now();
            lastPos = me.clone();
            jumps++;
          }
        }
        stopAll();
        const me = bot.entity.position;
        return ok(
          `walk-path: 到第 ${idx + 1}/${wps.length} 点，当前 (${me.x.toFixed(1)}, ${me.y.toFixed(1)}, ${me.z.toFixed(1)})，本次 ${((Date.now() - t0) / 1000).toFixed(1)}s`
        );
      } catch (e) {
        stopAll();
        const me = bot.entity.position;
        return fail(`walk-path 异常于第 ${idx} 点：${String(e)}；当前 (${me.x.toFixed(1)}, ${me.y.toFixed(1)}, ${me.z.toFixed(1)})`);
      } finally {
        // 无论走到第几点 / 卡住 / 异常，都要交还视线控制权（否则 HeadFollow 永久哑火）
        hf?.resume?.();
        // 交还发包朝向：不能瞬断（否则头会一步跳回身体朝向 = 玩家看到的"猛甩头"）
        // 改成后台按 300°/s 收敛到 entity.yaw，收敛完再撤覆盖
        if (headStat) startHeadHandback(bot, headStat);
      }
    }
  );
}
