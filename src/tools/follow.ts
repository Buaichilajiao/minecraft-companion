import { z } from 'zod';
import { goals } from '@nxg-org/mineflayer-pathfinder';
import type { Vec3 } from 'vec3';
import type mineflayer from 'mineflayer';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { getBot, ok, fail, withTimeout, parkourAhead } from './helpers';
import { log, v3 } from '../utils';
import { isInterrupted } from '../interrupt';

/**
 * 跟随玩家（拟人化跟随 v2 · 2026-09-09）
 * ────────────────────────────
 * 后台持续跟随，像真人朋友一样（讨论定稿）：
 * - 站位【侧后方】：目标 = 玩家身后 ± 侧偏的 followPoint（不站球心最近点、不踩脚跟）；
 *   侧向大脑可指定 left/right，不传 auto 随机定一侧。玩家原地小动/转身 ≤90° 不追着绕，
 *   真走远或大转身才绕弧线换位（拟人走位，转向弧线由注视机制自然带出）。
 * - 自动档位（身体机械，不经大脑）：按"到 followPoint 的水平距离"切档——
 *   正常走 → 疾跑（快步追）→ 疾跑+连跳（bunny hop ≈7.1m/s 最快，且能跳 1.25 格障碍）；
 *   饥饿 ≤7 禁疾跑只走（MC：饥饿 ≤6 疾跑自动断，提前一档防闪断）；撞墙自动降级+pathfinder 绕障。
 * - 看路【停才看人】：追击时视线朝移动方向（直写 yaw），不回头盯人；就位站定才转头看玩家眼睛。
 * - 掉队喊话【身体检测 → 大脑台词】：被甩 >12 格持续 2s 触发一次、>22 格 1.5s 升级再触发；
 *   身体只做距离检测，喂【模糊距离词 + 移动状态 + 相对方位】（绝不喂精确格数），
 *   台词 100% 经大脑（companion.sayGap）现编；回到 9 格内视为跟上了，重置档位。
 * - 创造模式 → 飞行跟随（慢/加速两档）；生存模式 → 步行状态机。
 * 通用：目标极远（>160 格，超出实体跟踪前一直追）不硬追，原地等；目标暂出实体表 4s 内恢复继续跟；
 * 真消失/掉线/bot 断开自动停。
 * 跟随期间持有 player 身体锁，其他移动指令会排队，需先 stop-follow。
 */

type Side = 'left' | 'right';

interface FollowState {
  bot: mineflayer.Bot;
  targetName: string;
  range: number;
  side: Side;
  timer: NodeJS.Timeout | null;
  pending: Promise<unknown> | null;
  loopId: number;        // 追赶/跟随循环编号：cancelPending 时 +1 → 旧循环自行退出（防两个循环同时驱身）
  release: (() => void) | null;
  creative: boolean;
  // ── 掉队喊话状态（tick 每 1.2s 评估一次）──
  gapStage: number;      // 0=正常 1=已喊过第一档 2=已喊过第二档
  gapSince: number;      // 进入当前远档的时刻（0=不在档）
  prevPos: Vec3 | null;  // 玩家上一 tick 位置（估移动速度）
  lostSince: number;     // 目标实体暂缺的开始时刻（0=在视野内；4s 缓冲防瞬断误停）
  fpCache: { x: number; z: number } | null; // 期望站位缓存（玩家原地转视角不重算，防绕圈 9/10）
  accX: number;          // 玩家累计位移基准（重算站位时刷新）
  accZ: number;
}

let state: FollowState | null = null;

const TICK_MS = 1200; // 跟随检测周期
const GOTO_TIMEOUT_MS = 30000; // 生存模式单次追赶超时
const OBSTACLE_TIMEOUT_MS = 12000; // 单次绕障上限（够绕开一小段地形；超时立刻回直走，不硬耗）
// ── v25 撞墙治理（玩家 9/12 实测反馈："一直搁墙那边跳来跳去是何意味"）──────────────
// 病根两条：① 跑跳档【无脑按住跳跃键】—— 1 格台阶和 3 格实墙一视同仁地蹦；
//          ② 撞墙 → blocked → pathfinder 绕障 → 绕完【立刻切回直走】→ 又冲着同一堵墙去 → 再 blocked…
//             往复 = 玩家眼里的"在墙那边跳来跳去"。
// 治法：① hop 档先看脚前/头前方块，两格都实心 = 真墙（跳也上不去）→ 不跳、退成走；
//      ② 进绕障就锁 DETOUR_HOLD_MS：期间直走再遇到同一堵墙 → 立刻交回绕障，不走老路撞墙；
//      ③ 连续绕障失败 ≥3 次 → 判定"这段地形真过不去" → 冷却期内站住不动（掉队喊话会开口叫人等我）。
const DETOUR_HOLD_MS = 4000;      // 绕障保持期
const DETOUR_RETRY_CD_MS = 8000;  // 连续失败后的冷却（站住不折腾，等玩家回头）
const DETOUR_MAX_FAILS = 3;       // 连续失败几次算"真过不去"
let detourHoldUntil = 0;
let detourFails = 0;
let detourRetryAt = 0;
const MAX_CHASE_DIST = 160; // 追赶距离上限：放宽到远超实体跟踪范围——玩家跑出视距也一直追
                           // （9/9 玩家实测反馈：60 格就原地等太出戏，真人朋友会追上来）
const FLY_LOOP_MS = 50; // 飞行跟随控制周期
// ── 拟人档位（到 followPoint 的水平距离 dh；玩家实测反馈"触发太远"，9/9 调近）──
const WALK_LIMIT = 2.5; // dh ≤2.5：正常走（玩家拉开约 6 格内）
const SPRINT_LIMIT = 5; // dh ≤5：疾跑
// ── 跑跳档（v21·按玩家要求改回【确定性规则】，不再依赖速度检测）──
//    生存/普通跟随都同一套：距离决定档位 —— 走 / 疾跑 / 跑跳
const HOP_ENTER = 7;    // dh > 7：起跑跳（跳着追）
const HOP_EXIT = 5;     // dh < 5：收跑跳退回疾跑（滞回 2 格）
// ── 掉队喊话档（到玩家的 3D 距离；玩家最初提 7/20，按"真人感"取中 12/22：
//    9/9 实测反馈"跑出视野才触发太远"，从 16/32 调近）──
const GAP1 = 12;        // 第一档：开始觉得被甩下
const GAP2 = 22;        // 第二档：很远还没停，升级再喊
const GAP_RESET = 9;    // 回到这个距离内 = 跟上了，重置喊话档
const GAP_HOLD1 = 2000; // 第一档持续时长（ms）
const GAP_HOLD2 = 1500; // 第二档持续时长（ms，已经很远，更快识别）

/** pathfinder 断言（mineflayer Bot 类型上未挂 pathfinder 属性） */
function pf(bot: mineflayer.Bot): {
  goto: (g: unknown) => Promise<unknown>;
  cancel: () => Promise<unknown>;
} {
  return (bot as unknown as { pathfinder: { goto: (g: unknown) => Promise<unknown>; cancel: () => Promise<unknown> } }).pathfinder;
}

/** 玩家实体结构（mineflayer 未导出 Entity 类型，本地收窄） */
interface PlayerEntLike { position: Vec3; yaw: number; username?: string }

/** 取玩家实体（含 position/yaw；太远/未加载时为 null） */
function findPlayerEntity(bot: mineflayer.Bot, name: string): PlayerEntLike | null {
  const p = bot.players[name];
  if (!p) return null;
  return (p.entity as unknown as PlayerEntLike | null) ?? null;
}

/** 是否创造模式：统一走 ctx.status()（与 get-state / creative-give / 图纸建房同一模式来源，
 *  避免各工具各自猜 bot.game 造成口径不一致） */
function isCreativeByStatus(ctx: ToolContext): boolean {
  try {
    return ctx.status().world.game_mode === 'creative';
  } catch {
    return false;
  }
}

/** 硬清控制键：防止 pathfinder abort 失败后 forward 等按键卡死导致 bot 直线狂奔 */
function hardClearControls(bot: mineflayer.Bot): void {
  try {
    (bot as unknown as { clearControlStates?: () => void }).clearControlStates?.();
  } catch { /* ignore */ }
}

/** 取消正在进行的追赶（若存在） */
function cancelPending(s: FollowState): void {
  s.loopId++; // 让正在跑的跟随循环立即失效退出（否则 s.pending 被清后上层会再起一个 → 双循环抢身体）
  if (!s.pending) return;
  try {
    void pf(s.bot).cancel();
  } catch { /* ignore */ }
  hardClearControls(s.bot);
  s.pending = null;
}

/** 停止跟随：清定时器 + 取消追赶/飞行循环 + 释放身体锁 */
function stopFollow(reason: string | null): void {
  const s = state;
  if (!s) return;
  state = null;
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
  cancelPending(s);
  if (s.release) {
    try {
      s.release();
    } catch { /* ignore */ }
    s.release = null;
  }
  if (reason) log('INFO', `⏹️ 跟随 ${s.targetName} 已停止：${reason}`);
}

/**
 * 期望站位点 = 玩家【侧后方】（真人朋友的位置）：玩家后方 stand 格 + 侧偏 off。
 * 玩家 yaw 面朝 = (-sin,-cos)；后方 back = (sin, cos)；玩家左侧 left = (-back.z, back.x)。
 * 实测（yaw=0 朝 -Z 北）：back=(0,1)，left=(-1,0)=西 = 朝北时的左手边 ✓
 */
function calcFollowPoint(pos: Vec3, yaw: number, range: number, side: Side): { x: number; z: number } {
  const stand = Math.max(1.5, range) + 0.5; // 站位比 range 略远半格，不贴背
  const backX = Math.sin(yaw);
  const backZ = Math.cos(yaw);
  const s = side === 'left' ? 1 : -1;
  const off = 1.1; // 侧偏量：斜后方站位，不堵正后方
  return {
    x: pos.x + backX * stand + (-backZ) * s * off,
    z: pos.z + backZ * stand + (backX) * s * off,
  };
}

/**
 * 期望站位点（缓存版，9/10 玩家反馈"原地转视角 bot 绕圈跑"修复）：
 * 真人朋友不会因为你原地转头就绕着你跑半圈 —— 玩家【累计位移 ≥1.2 格】才按
 * 当前朝向重算站位；原地转视角/小幅走动（一两格内）→ 沿用缓存站位，bot 站定不追。
 * 阈值取舍：太小 → 挪半步就换位像贴死；太大 → 跟随迟钝。1.2 格 ≈ 走一两步再挪。
 */
function followPointOf(
  s: FollowState,
  pe: { position: { x: number; z: number }; yaw: number }
): { x: number; z: number } {
  if (!s.fpCache) {
    s.fpCache = calcFollowPoint(pe.position as Vec3, pe.yaw, s.range, s.side);
    s.accX = pe.position.x;
    s.accZ = pe.position.z;
    return s.fpCache;
  }
  const ddx = pe.position.x - s.accX;
  const ddz = pe.position.z - s.accZ;
  if (Math.hypot(ddx, ddz) >= 1.2) {
    s.fpCache = calcFollowPoint(pe.position as Vec3, pe.yaw, s.range, s.side);
    s.accX = pe.position.x;
    s.accZ = pe.position.z;
  }
  return s.fpCache;
}

/** 3D 距离 → 模糊距离词（喂大脑用；真人只感觉得出"远近"，说不出精确格数） */
function gapFuzzy(dist: number): string {
  if (dist < 20) return '还没多远，就几步路';
  if (dist < 27) return '有点远了';
  if (dist < 38) return '挺远了';
  return '快看不见了';
}

/** 玩家移动速度 → 模糊状态词 */
function speedWord(ps: number): string {
  if (ps < 0.6) return '站在原地';
  if (ps < 3.5) return '在慢慢走';
  if (ps < 6.2) return '在快步走';
  return '跑得飞快（或飞走了）';
}

/** 玩家相对 bot 的方位（模糊四向，喂大脑措辞用） */
function relDirWord(me: Vec3, tp: Vec3, botYaw: number): string {
  const dx = tp.x - me.x;
  const dz = tp.z - me.z;
  if (Math.hypot(dx, dz) < 0.6) return '就在我身边';
  let ang = Math.atan2(-dx, -dz) - botYaw;
  while (ang > Math.PI) ang -= 2 * Math.PI;
  while (ang < -Math.PI) ang += 2 * Math.PI;
  const a = Math.abs(ang);
  if (a < Math.PI / 4) return '在我前方';
  if (a > (Math.PI * 3) / 4) return '在我身后方向';
  return ang > 0 ? '在我左边' : '在我右边';
}

export function registerFollowTools(mcp: McpServerManager, ctx: ToolContext): void {
  /**
   * 统一跟随循环（v15，9/11：机动方式由【距离】决定，不再由游戏模式决定）
   * ─────────────────────────────────────────────────────────
   * 玩家设计意见（采纳）：创造/生存不该当"跑跳还是飞行"的开关。真人朋友是这么干活的——
   *   · 距离近（跑跳追得上）→ 走/疾跑/跑跳追过去，够用就不飞；
   *   · 距离远（跑跳追不上）→ 起飞 → 飞到你身边 → 【降落到你旁边的方块上】；
   *   · 生存模式没有飞行能力 → 永远地面跑，追不上只喊话（原逻辑）。
   * 切换档位（带滞回，防边界抖动）：
   *   地面 → 飞行：dh > FLY_ENTER(14)
   *   飞行 → 地面：dh < LAND_RADIUS(7) 且你脚下 12 格内有实心地面；你若悬空在空中则不降落，同高悬停
   *   7~14 格之间保持当前方式不变
   * 其他要点：
   *   · 全程挂 physicsTick 驱动（每 tick 精确更新控制键），跑跳不再"一顿一顿"；
   *   · 飞行用速度-加速度积分 + 按真实 dt 积分 + 单次位移硬上限（防超速被服务器拉回）；
   *   · 起飞/巡航/降落的高度变化带速率限制（升 ≤0.20 格/tick、降 ≤0.12 格/tick），有明确的起飞降落感；
   *   · blockAt 世界查询一律降频（每 4~8 tick），避免同步查询拖住主线程。
   */
  const followLoop = async (s: FollowState): Promise<{ blocked?: boolean }> => {
    const bot = s.bot;
    // ★ v23：能不能飞必须【实时】看当前模式，不能缓存 —— 玩家中途从创造切生存后，
    //   缓存的 canFly 仍为 true，会去调 startFlying（把 gravity 设 0）→ bot 再次悬空/漂移
    const isCreativeNow = (): boolean => {
      try { return (bot.game as unknown as { gameMode?: string })?.gameMode === 'creative'; } catch { return false; }
    };
    const canFly = s.creative && isCreativeNow(); // 仅作"启动时是否具备飞行能力"的粗略参考，飞行判定一律用 isCreativeNow()
    const creative = (bot as unknown as { creative?: { startFlying?: () => void; stopFlying?: () => void } }).creative;
    const ent = bot.entity as unknown as { velocity?: { x: number; y: number; z: number }; onGround?: boolean };
    const setCtrl = (k: string, on: boolean) => { try { bot.setControlState(k as never, on); } catch { /* ignore */ } };
    const stopAllCtrl = () => { for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']) setCtrl(k, false); };
    const zeroVel = () => { try { if (ent.velocity) { ent.velocity.x = 0; ent.velocity.y = 0; ent.velocity.z = 0; } } catch { /* ignore */ } };
    const isSolid = (b: unknown): boolean => {
      const n = (b as { name?: string } | null)?.name ?? '';
      if (!n || n === 'air' || n === 'cave_air' || n === 'void_air' || n === 'water') return false;
      if (n.includes('lava') || n.includes('fire')) return false;
      return true;
    };
    /** 向下找地面方块顶面高度（12 格内），找不到返回 null（=玩家悬空在高处） */
    const groundTopY = (pos: { x: number; y: number; z: number }): number | null => {
      const bx = Math.floor(pos.x), bz = Math.floor(pos.z);
      for (let y = Math.floor(pos.y) + 1; y >= Math.floor(pos.y) - 12; y--) {
        if (isSolid(bot.blockAt(v3(bx, y, bz)))) return y + 1;
      }
      return null;
    };
    // ── 常量 ──
    const FLY_ENTER = 15;      // 超过这个水平距离「且持续 FLY_CONFIRM」：跑跳真追不上 → 起飞
    const FLY_CONFIRM = 1500;  // 起飞确认窗口(ms)：超阈值要持续这么久才起飞（防贴阈值抖动）
    const FLY_MIN_HOLD = 3500; // 起飞后至少飞这么久(ms)才允许【移动中】落地 → 防飞↔落横跳
    const STOP_LAND_DELAY = 1200; // 你停稳超过这么久(ms) → 立刻降落（不必再等 FLY_MIN_HOLD）
    const FLY_RE_CD = 4000;    // 落地后冷却(ms)：期间不再起飞
    const LAND_RADIUS = 7;     // 进到这个距离内：准备降落（你在地面附近的话）
    const SPEED_AIR = 1.09;    // 飞行满速 格/tick ≈21.8m/s（对齐玩家疾跑飞行 21.6）
    const SPEED_GROUND = 0.21; // 贴地跟随上限
    const DT_NOMINAL = 0.05;
    const ACCEL = 0.10;        // 飞行速度趋近系数：原版飞行惯性 0.892（冰面级摩擦）→ 时间常数≈10 tick≈0.5s，松手会滑行几格
    const RAMP = 7.5;          // 飞行收速区间（格）：剩 RAMP 格内按距离线性收速到 0 → 连续函数，速度永不跳变
    const HOVER_D = 2.5;       // 收速零点：距目标点 HOVER_D 格时速度归零（自然停在侧后方位上）
    const LEAD = 0.12;         // 预判提前量（仅远距追击，近距离不预判防目标点乱跳）
    const CRUISE_HEIGHT = 4;   // 远距巡航时在你上方几格飞
    const CLIMB_RATE = 0.20;   // 爬升速率上限（格/tick）→ 起飞有过程
    const DESCEND_RATE = 0.12; // 下降速率上限（格/tick）→ 降落平缓（≈2.4m/s）
    // ── 状态 ──
    const result: { blocked?: boolean } = {};
    let mode: 'ground' | 'fly' | 'swim' = 'ground';
    let flying = false;
    let lift = 0;              // 当前相对玩家高度（飞行）
    let vx = 0, vy = 0, vz = 0; // 当前速度（格/tick，飞行）
    let gear: 'walk' | 'sprint' | 'hop' = 'walk';
    let gearUntil = 0;
    let jumpPress = 0;
    let ticks = 0;
    let lastPos = bot.entity.position.clone();
    let stuckSamples = 0;
    let selfJumped = false;
    let hasLast = false;
    let lastX = 0, lastY = 0, lastZ = 0;
    let pvx = 0, pvy = 0, pvz = 0;
    let lastTs = 0;
    let groundYCache: number | null = null;
    let farSince = 0;            // 首次超过 FLY_ENTER 的时刻（起飞确认窗口用）
    let flyHoldUntil = 0;        // 起飞后最早可降落时刻
    let flyCooldownUntil = 0;    // 落地后最早可再起飞时刻
    let stopSince = 0;           // 你「停稳」的起始时刻（0=还在动）
    // ── A：游泳（生存模式下海/过河，陪伴型刚需）──
    let swimForAir = false;      // 正在"上浮换气"（氧气不足优先保命，暂不朝目标游）
    // ── 生存模式「追不上」时征询玩家 → 自切创造（B：陪伴型，生存下海/追飞玩家都得能跟上）──
    // 阶段机：idle(未问) → asked(已问待回复) → agreed(同意→发命令切创造) / denied(拒绝→地面跑)
    let gmStage: 'idle' | 'asked' | 'agreed' | 'denied' = 'idle';
    let gmAskAt = 0;             // 发问时刻（用于超时 + 从 chatHistory 里筛"问出之后"的回复）
    let gmTryAt = 0;             // 上次尝试发 /gamemode creative 的时刻（防每 tick 狂发）
    let gmTryCount = 0;          // 已尝试切模式次数（超 N 次仍失败 = 无权限，不再骚扰）
    let gmAskCooldownUntil = 0;  // 拒绝/超时后冷却，期间不再重复问
    const GM_ASK_TIMEOUT = 12000; // 问出后等玩家回复的上限
    const GM_TRY_CD = 6000;       // 两次发命令最小间隔
    const GM_TRY_MAX = 2;         // 单次跟随最多尝试切模式次数
    const GM_RETRY_CD = 60000;    // 被拒/超时后，冷却 1 分钟再考虑问
    // 同意/拒绝关键词（玩家口头回复，中文口语为主）
    const AGREE_WORDS = ['好', '可以', '行', 'ok', 'okay', '准', '同意', '没问题', '来', '开', '能', '嗯嗯', '好呀', '好嘞', '当然', '随便'];
    const DENY_WORDS = ['不', '别', '不用', '拒绝', '算了', '不要', 'no', '不行', '别开', '不要开'];
    // 玩家速度滑窗（格/tick）：直接拿「~1.3s 内的位移 / 时间」算平均，比瞬时 EMA 稳得多
    // （瞬时 EMA 会被实体位置包的间隔抖动放大到 1.34 这种假值 → 档位判定直接失效）
    const histT: number[] = [], histX: number[] = [], histZ: number[] = [];
    let pSpeedAvg = 0;
    let myFootCache: number | null = null; // 我自己脚下最近的方块顶面（=能不能落脚）
    let landingLogged = false;
    let spdRefX: number | null = null; let spdRefZ = 0; // 自查用
    let pausedForOthers = false; // 身体被保命动作接管时，暂停驱身（处理完自动继续）
    let guardianSince = 0;       // 保命占用起始时间（容忍短时让位，超时则退出跟随）

    // ── 重力显式管理（v22·本轮真凶）──────────────────────────────
    // mineflayer 的 creative.startFlying 只是把 bot.physics.gravity 改成 0，而 stopFlying 只在它
    // 自己认为'仍在飞'时才恢复 —— 状态一旦错位，重力就永久停在 0：bot 零重力漂浮、onGround 永远
    // false（跳不起来）、脚下也永远没地（落地判定不过）。所以这里自己接管 gravity，不再依赖那套。
    const GRAVITY_NORMAL = 0.08; // prismarine-physics 默认重力（格/tick²）
    const setGravity = (g: number) => {
      try { (bot.physics as unknown as { gravity: number }).gravity = g; } catch { /* ignore */ }
    };
    const gravityNow = (): number => {
      try { return (bot.physics as unknown as { gravity: number }).gravity; } catch { return GRAVITY_NORMAL; }
    };

    // ── B：生存模式追不上 → 征询玩家 → 自切创造飞 ─────────────────────────────
    // 阶段机：idle → asked(发问等回复) → agreed(发 /gamemode creative) → 切成功后 enterFly
    //         ↘ denied / 超时 → 冷却后被拒，保持地面跑（不再骚扰）
    /** 征询玩家：能否切创造跟。经 companion.sayGap 让大脑组织自然问句（不背模板）。 */
    const askCreative = () => {
      gmStage = 'asked';
      gmAskAt = Date.now();
      const comp = ctx.companion?.();
      if (comp) {
        comp.sayGap(
          `我正在生存模式下跟随玩家 ${s.targetName}，但对方飞出去/跑得太快，我地面跑跳追不上。` +
          `请以真人朋友的口吻，开口问一下他：同不同意我临时切到创造模式飞着跟上他？` +
          `自然地说一句询问（比如"你飞太快啦，我能开创造飞着追你吗"这种，别背固定话术），等他回答。`
        );
        log('INFO', `🙋 生存模式追不上 ${s.targetName} → 已征询是否切创造`);
      } else {
        // 无 companion 出口也照旧推进：视为没人可问 → 直接按无权限处理，保持地面跑
        gmStage = 'denied';
        gmAskCooldownUntil = Date.now() + GM_RETRY_CD;
      }
    };

    /** 从 chatHistory 里读「问出之后」目标玩家的一句话，判断同意/拒绝。返回 'agree'|'deny'|'wait' */
    const pollConsent = (): 'agree' | 'deny' | 'wait' => {
      if (gmAskAt === 0) return 'wait';
      try {
        const hist = ctx.chatHistory();
        // 找目标玩家在发问之后的最新消息
        const msgs = hist.filter((c) => c.username === s.targetName && c.t >= gmAskAt);
        if (msgs.length === 0) return 'wait';
        const text = msgs.map((c) => c.message.toLowerCase()).join(' ');
        const hasDeny = DENY_WORDS.some((w) => text.includes(w));
        const hasAgree = AGREE_WORDS.some((w) => text.includes(w));
        if (hasDeny && !hasAgree) return 'deny';
        if (hasAgree) return 'agree';
        return 'wait';
      } catch {
        return 'wait';
      }
    };

    /** 发 /gamemode creative 切创造（服务器有权限才生效；失败保持地面跑） */
    const switchCreative = () => {
      try {
        bot.chat('/gamemode creative');
        gmTryAt = Date.now();
        gmTryCount++;
        log('INFO', `⚡ 已发 /gamemode creative 切创造（第 ${gmTryCount}/${GM_TRY_MAX} 次）`);
      } catch (e) {
        log('WARN', `发 /gamemode creative 失败: ${e}`);
        gmStage = 'denied';
        gmAskCooldownUntil = Date.now() + GM_RETRY_CD;
      }
    };

    const enterFly = () => {
      // ★ 非创造模式禁止起飞（模式中途被切时兜底）：否则 startFlying 会把重力设 0 → 悬空漂移
      if (!isCreativeNow()) {
        farSince = 0;
        log('WARN', '⚠️ 当前不是创造模式（无法飞行）→ 继续地面跑跳追赶');
        return;
      }
      stopAllCtrl();
      try { creative?.startFlying?.(); } catch { /* ignore */ }
      setGravity(0); // 悬停靠重力 0 + 速度控制
      setCtrl('sprint', true); // 让服务器按"疾跑飞行"档（flyingSpeed 0.1）认这个速度
      flying = true;
      mode = 'fly';
      lift = 0; vx = 0; vy = 0; vz = 0;
      farSince = 0; stopSince = 0;
      flyHoldUntil = Date.now() + FLY_MIN_HOLD; // 起飞后至少飞 FLY_MIN_HOLD 才考虑【移动中】落地
      log('INFO', `🕊️ ${s.targetName} 拉开太远（跑跳追不上）→ 起飞（${FLY_MIN_HOLD / 1000}s 内不落地，你停稳 1.2s 除外）`);
    };
    const enterGround = () => {
      stopAllCtrl();
      try { creative?.stopFlying?.(); } catch { /* ignore */ }
      setGravity(GRAVITY_NORMAL); // ★ 真正让重力回来 —— 关飞行不够，必须显式恢复
      zeroVel();
      flying = false;
      mode = 'ground';
      vx = 0; vy = 0; vz = 0; lift = 0;
      gear = 'walk'; gearUntil = 0; jumpPress = 0;
      stuckSamples = 0; selfJumped = false;
      lastPos = bot.entity.position.clone();
      stopSince = 0;
      landingLogged = false;
      flyCooldownUntil = Date.now() + FLY_RE_CD; // 落地后冷却，期间不重复起飞
      log('INFO', `🥾 ${s.targetName} 附近 → 落地改用跑跳跟随（${FLY_RE_CD / 1000}s 内不再起飞）`);
    };

    /** 地面机动（走 → 疾跑 → 跑跳；直线被挡 → 交上层 pathfinder 绕障） */
    const groundStep = (pe: PlayerEntLike, me: Vec3, dP3: number, near: boolean, dh: number, dx: number, dz: number) => {
      const now = Date.now();
      // ★ 自愈（v22）：地面模式重力必须是正常的。任何工具/上一轮跟随把 gravity 留在 0 → 强制拉回，
      //   否则 bot 会零重力漂浮：落不下来、onGround 恒 false、跳也跳不起来（跑跳档只能干看着）
      if (gravityNow() !== GRAVITY_NORMAL) {
        setGravity(GRAVITY_NORMAL);
        log('WARN', `⚠️ 检测到重力异常（gravity=${gravityNow()}）→ 已恢复 ${GRAVITY_NORMAL}`);
      }
      const pSpd = pSpeedAvg; // 你的水平速度（滑窗平均，格/tick）→ 学你的动作（你跑跳我也跑跳）
      // ── 远到追不上（dh > FLY_ENTER 且持续确认窗口）时的分支 ──
      // 创造模式：确认后直接 enterFly 飞着跟
      // 生存模式：走 B 征询流程 —— 先问玩家能否切创造，同意→发命令切→飞；拒绝/无权限→地面跑
      if (dh > FLY_ENTER && now >= flyCooldownUntil) {
        if (farSince === 0) farSince = now;
        const confirmed = now - farSince >= FLY_CONFIRM;
        if (isCreativeNow()) {
          if (confirmed) { enterFly(); return; }
        } else {
          // 生存模式：追不上 → 征询切创造（只在「待征询/已问待答」里推进，拒绝/超时进入冷却）
          if (confirmed && gmStage === 'idle' && now >= gmAskCooldownUntil) {
            askCreative();
          } else if (gmStage === 'asked') {
            // 等玩家回复
            const ans = pollConsent();
            if (ans === 'agree') {
              gmStage = 'agreed';
              switchCreative();
            } else if (ans === 'deny') {
              gmStage = 'denied';
              gmAskCooldownUntil = now + GM_RETRY_CD;
              log('INFO', `❌ ${s.targetName} 不同意切创造 → 保持生存地面跑，${GM_RETRY_CD / 1000}s 内不再问`);
            } else if (now - gmAskAt >= GM_ASK_TIMEOUT) {
              gmStage = 'denied';
              gmAskCooldownUntil = now + GM_RETRY_CD;
              log('INFO', `⏰ 征询超时未回复 → 保持地面跑，${GM_RETRY_CD / 1000}s 内不再问`);
            }
          } else if (gmStage === 'agreed') {
            // 已发命令：等服务器把模式切过来（isCreativeNow 变 true），或超时/超次放弃
            if (isCreativeNow()) {
              log('INFO', `✅ 已切创造 → 起飞跟随 ${s.targetName}`);
              enterFly();
              return;
            }
            if (now - gmTryAt > 4000) {
              // 4s 内没切过来 → 再试一次（未超次数上限）
              if (gmTryCount < GM_TRY_MAX) {
                switchCreative();
              } else {
                gmStage = 'denied';
                gmAskCooldownUntil = now + GM_RETRY_CD;
                log('WARN', `⚠️ /gamemode creative 无效果（无 OP 权限？）→ 放弃，保持地面跑`);
              }
            }
          }
        }
      } else {
        farSince = 0;
        // 回到近距：重置征询阶段（下次再追不上重新问）
        if (gmStage === 'asked' || gmStage === 'agreed') {
          gmStage = 'idle';
        }
      }
      // 就位：站定 + 盯人
      if (near && dh <= 4.5) {
        stopAllCtrl();
        jumpPress = 0;
        bot.entity.yaw = Math.atan2(-(pe.position.x - me.x), -(pe.position.z - me.z));
        bot.entity.pitch = Math.atan2((pe.position.y + 1.6) - (me.y + 1.62), Math.max(dh, 0.01));
        return;
      }
      // ── 【v24 移除 pathfinder 常驻追赶】──
      // 上一版（v23）在 dh ≥ 8 时把身体交给 pathfinder 走"最短路径"，实测出两个致命问题：
      //   1) pathfinder 的移动速度上限 ≈5.6 m/s（不会 bunny hop），追不上跑跳的玩家（7.1 m/s）
      //      → 越追越远，正好和"跟人"的目标相反；
      //   2) dynamic goal 的路径不会随玩家转向实时重算，它会闷头把旧路径跑完
      //      → 玩家看到的就是"它朝一个方向使劲跑，跑完才发现我在旁边，再突然过来"。
      // 现在恢复【逐帧直走】：远距时目标点本来就是玩家本人（见上方 near ? fp : 玩家本人）→
      // 两点连线的直线就是最短路径，且全程可用跑跳档 7.1 m/s，不会被带偏。
      // pathfinder 只在真被地形挡住时兜底一次（见 tick 里的 🚧 分支），绕完立刻回到直走。
      bot.entity.yaw = Math.atan2(-dx, -dz); // 面向移动方向（看路）
      bot.entity.pitch = 0;
      // 档位（滞回 + 最小保持，杜绝贴阈值时档位抖动）
      const canRun = bot.food == null || bot.food > 7;
      if (!canRun && gear !== 'walk') { gear = 'walk'; gearUntil = now + 350; }
      if (now >= gearUntil) {
        // 档位（v21·确定性规则）：距离为主 + 你说得对，速度只做"明显跑跳"的补充
        // 你滑窗速度 >0.32 只可能是跑跳（疾跑上限 0.28）→ 也上跑跳；否则纯按距离
        const wantHop = dh > HOP_ENTER || pSpd > 0.32;
        const wantRun = dh > WALK_LIMIT + 0.8 || pSpd > 0.24;
        const next: 'walk' | 'sprint' | 'hop' =
          gear === 'walk'
            ? wantHop ? 'hop' : wantRun ? 'sprint' : 'walk'
            : gear === 'sprint'
              ? wantHop ? 'hop' : !wantRun ? 'walk' : 'sprint'
              : dh < HOP_EXIT && pSpd < 0.30
                ? (dh > WALK_LIMIT - 0.6 ? 'sprint' : 'walk')
                : 'hop';
        if (next !== gear) {
          log('INFO', `🏃 跟随档位 ${gear} → ${next}（距目标 ${dh.toFixed(1)} 格，dP3 ${dP3.toFixed(1)}，你速度 ${pSpd.toFixed(2)} 格/tick）`);
          gear = next; gearUntil = now + 400;
        }
      }
      // ── v25 真墙判定：脚前方 + 头前方都实心 = 跳也上不去的墙（1 格台阶不算，那种照跳）──
      const bf0 = me.floored();
      const stepX = Math.abs(dx) > Math.abs(dz) ? Math.sign(dx) : 0;
      const stepZ = Math.abs(dz) >= Math.abs(dx) ? Math.sign(dz) : 0;
      const frontWall = (stepX !== 0 || stepZ !== 0)
        && isSolid(bot.blockAt(v3(bf0.x + stepX, bf0.y, bf0.z + stepZ)))
        && isSolid(bot.blockAt(v3(bf0.x + stepX, bf0.y + 1, bf0.z + stepZ)));
      // ── v28 跑酷地形护栏：统一调 helpers.parkourAhead（跟随 / move-to / walk-path 共用一套，别再各写各的）
      //   实证 9/12：直线追 → 掉进关间虚空 → 连死 4 次；但光有"虚空不迈"又会在缺口前站死 ✗
      //   → 'jump' 短缺口疾跑起跳跨过去；'stop' 宽缺口/虚空才站住（交上层绕障，绕不通由掉队喊话叫玩家）
      {
        const pk = parkourAhead(bot);
        if (pk === 'jump') {
          setCtrl('sprint', true);
          // ★ v29：跨缺口也改单次点按，不持续按住 jump（否则跳起后仍按着 → 空中/落地连跳感）
          setCtrl('jump', jumpPress > 0);
          if (jumpPress > 0) jumpPress--;
          if (bot.entity.onGround && jumpPress === 0) jumpPress = 2;
          setCtrl('forward', true);
          if ((ticks % 20) === 0) log('INFO', '🦘 前方短缺口 → 跳过去（跑酷图上就不绕路了）');
          return; // 空中不判卡死、不切档
        }
        if (pk === 'stop') {
          setCtrl('forward', false);
          setCtrl('jump', false);
          setCtrl('sprint', false);
          if ((ticks % 20) === 0) log('WARN', '⛔ 前方是宽缺口/虚空 → 不迈这一步（等 pathfinder 绕或原地等玩家回来）');
          result.blocked = true;
          finishRef();
          return;
        }
      }
      if (gear === 'hop') {
        if (frontWall) {
          // 真墙：别再蹦了（原来无脑连跳 = 玩家看到的"对着墙跳来跳去"）→ 退成走，
          // 让卡死检测（1.5s 无位移）去触发上面的绕障分支；
          // 绕障保持期内则直接交回上层绕障，不再重复"直走撞墙"。
          setCtrl('jump', false);
          setCtrl('sprint', false);
          gear = 'walk'; gearUntil = now + 400;
          if (now < detourHoldUntil) { result.blocked = true; finishRef(); return; }
        } else {
        setCtrl('sprint', true);
        // ★ v29·浮空被踢治理（玩家 9/21 实测：跟随走"跑跳档"会被服务器踢，"会浮空"）——
        //   真凶是"按住 jump + 手动改 velocity.y=0.42"这套连跳：
        //   1) setCtrl('jump', true) 持续按住 → 服务器端连跳，物理状态与客户端脱节；
        //   2) velocity.y 直接改速度 → 绕过物理引擎，落地判定(isSolid && vy<=0.001)在半空也偶发成立
        //      → bot 悬空被反复"补跳" → 长时间滞空 → 服务器 anti-cheat 判定浮空踢出。
        //   治法：彻底去掉手动篡改速度；跳跃改为【确认 onGround 才点按一次、下 tick 立即松开】，
        //   让原版物理自己决定起跳 + 落地，服务器与客户端状态永远一致。
        setCtrl('jump', jumpPress > 0);
        if (jumpPress > 0) jumpPress--;
        // 只在确认落地（onGround）且竖直速度已稳定时，才给一次短促跳跃脉冲
        if (bot.entity.onGround && jumpPress === 0 && Math.abs(bot.entity.velocity?.y ?? 0) < 0.01) {
          jumpPress = 2; // 点按 2 tick 后松开 → 单次跳跃，不连跳、不悬空补跳
        }
        }
      } else {
        setCtrl('sprint', gear === 'sprint');
        setCtrl('jump', jumpPress > 0);
        if (jumpPress > 0) jumpPress--;
        // 1 格台阶自动跳：每 4 tick 检测一次（世界查询降频）
        if ((ticks & 3) === 0 && jumpPress === 0 && bot.entity.onGround) {
          const bf = me.floored();
          const stepX = Math.abs(dx) > Math.abs(dz) ? Math.sign(dx) : 0;
          const stepZ = Math.abs(dz) >= Math.abs(dx) ? Math.sign(dz) : 0;
          const frontLvl = bot.blockAt(v3(bf.x + stepX, bf.y, bf.z + stepZ));
          const frontUp = bot.blockAt(v3(bf.x + stepX, bf.y + 1, bf.z + stepZ));
          if (isSolid(frontLvl) && !isSolid(frontUp)) jumpPress = 2;
        }
      }
      setCtrl('forward', true);
      // 自查日志（临时）：每秒一条，把"我到底在不在跳/在不在飞/脚下有没有地"全打出来
      if ((ticks % 20) === 0) {
        if (spdRefX != null) {
          const spd = Math.hypot(me.x - spdRefX, me.z - spdRefZ);
          const vyNow = bot.entity.velocity?.y ?? 0;
          const onB = isSolid(bot.blockAt(me.offset(0, -0.15, 0)));
          const flyFlag = !!(creative as unknown as { flying?: boolean } | undefined)?.flying;
          log('INFO', `🏃 [自查] ${mode}/${gear}：我实测 ${spd.toFixed(2)} m/s | vy=${vyNow.toFixed(2)} onGround=${bot.entity.onGround} 脚下有地=${onB} flying=${flyFlag} 你速度=${pSpeedAvg.toFixed(2)}`);
        }
        spdRefX = me.x; spdRefZ = me.z;
      }
      // 卡死检测（每 10 tick 采样 ≈0.5s）：跳一次自救，仍不动 → blocked 交上层绕障
      if ((ticks % 10) === 0) {
        if (me.distanceTo(lastPos) > 0.35) {
          stuckSamples = 0; selfJumped = false; lastPos = me.clone();
        } else if (selfJumped) {
          result.blocked = true;
          finishRef();
          return;
        } else {
          stuckSamples++;
          if (stuckSamples >= 3) { jumpPress = Math.max(jumpPress, 3); selfJumped = true; }
        }
      }
    };

    // ── A：游泳（生存模式下水游向/跟着目标）────────────────────────────────────
    /** 判断某方块（或其名）是不是水。name 可能是 'water' / 'flowing_water' / 带命名空间 */
    const isWaterBlock = (b: unknown): boolean => {
      const n = (b as { name?: string } | null)?.name ?? '';
      return n === 'water' || n === 'flowing_water' || n.endsWith(':water') || n.endsWith(':flowing_water');
    };
    /** 身体是否泡在水里：脚下 0.2 格、或躯干/头部位置是水 */
    const isInWater = (me: Vec3): boolean => {
      return isWaterBlock(bot.blockAt(me.offset(0, 0.2, 0)))
        || isWaterBlock(bot.blockAt(me.offset(0, 0.9, 0)));
    };
    /** 脚下是否踩到水面附近（0.3 格内是水）——用于"该不该下水"的进水判定 */
    const waterAtFeet = (me: Vec3): boolean => {
      return isWaterBlock(bot.blockAt(me.offset(0, -0.3, 0)));
    };

    const enterSwim = () => {
      stopAllCtrl();
      mode = 'swim';
      swimForAir = false;
      log('INFO', `🏊 ${s.targetName} 前方/脚下是水 → 下水游泳跟过去`);
    };
    const exitSwim = () => {
      stopAllCtrl();
      mode = 'ground';
      gear = 'walk'; gearUntil = 0;
      swimForAir = false;
      log('INFO', '🏞️ 已出水 → 回到地面跑跳跟随');
    };

    /** 游泳机动：朝目标方向 forward + sprint，周期性 jump 上浮（防沉底+换气）；氧气不足优先垂直上浮 */
    const swimStep = (pe: PlayerEntLike, me: Vec3, dP3: number, near: boolean, dh: number, dx: number, dz: number) => {
      // 出水了（身体不在水里、脚下也不是水）→ 回地面
      if (!isInWater(me) && !waterAtFeet(me)) { exitSwim(); return; }
      // 氧气检测：mineflayer 的 bot.oxygen（气泡剩余，0~20）>0 说明在水下憋气，越低越危险
      const oxygen = (bot as unknown as { oxygen?: number }).oxygen ?? 20;
      // 缺氧（<7，约剩 7/20 气泡）→ 强制上浮换气；直到氧气恢复 >14 才继续朝目标游
      if (oxygen < 7) swimForAir = true;
      else if (oxygen > 14) swimForAir = false;

      // 面向：水下朝目标（或换气时垂直朝上）
      if (swimForAir) {
        bot.entity.pitch = -Math.PI / 2; // 抬头朝天游
      } else {
        bot.entity.yaw = Math.atan2(-dx, -dz);
        bot.entity.pitch = -0.35; // 略抬头，保持向水面方向前进，不易沉
      }
      // 前进 + 疾跑（疾跑=快游）
      setCtrl('forward', true);
      setCtrl('sprint', true);
      // 上浮：游泳的核心是"按住跳跃键持续上浮"。缺氧时每 tick 连跳；正常时周期性跳保持在水面附近
      if (swimForAir) {
        setCtrl('jump', true);               // 持续上浮去换气
      } else {
        // 正常游：交替跳跃上浮（约每 12 tick 短促一跳），保持不沉底又不停在垂直扑腾
        setCtrl('jump', (ticks % 12) < 5);
      }
      if ((ticks % 20) === 0) {
        log('INFO', `🏊 [游泳] 距目标 ${dh.toFixed(1)} 格 氧气=${oxygen}${swimForAir ? ' ↑换气中' : ''} 深度=${(0).toFixed(0)}`);
      }
    };

    /** 飞行机动（速度积分；远距高空巡航，近距降落到玩家旁边方块上） */
    const flyStep = (pe: PlayerEntLike, me: Vec3, dP3: number, near: boolean, dh: number, dx: number, dz: number) => {
      if (!canFly || !isCreativeNow()) {
        // ★ 飞行途中模式被切回生存（或本来就不能飞）→ 立刻回地面模式并把重力恢复正常
        if (flying) log('WARN', '⚠️ 飞行中检测到已非创造模式 → 立即切回地面并恢复重力');
        enterGround();
        return;
      }
      // 高度规划：只调"相对玩家高度"lift，且限速升降（升 ≤0.20、降 ≤0.12 格/tick）
      // 这样高度变化一定平缓（≈2.4m/s 降落），不会以 21m/s 垂直砸下来
      const now = Date.now();
      const pSpd = pSpeedAvg;
      // 停稳计时：你水平速度 <0.12 视为站定（真人在旁边站住了）
      if (pSpd < 0.12) { if (stopSince === 0) stopSince = now; } else stopSince = 0;
      const still = stopSince !== 0 && now - stopSince >= STOP_LAND_DELAY;
      let landing = false;
      let liftTarget: number;
      if (dh < LAND_RADIUS) {
        if ((ticks % 8) === 0) {
          groundYCache = groundTopY(pe.position); // 你脚下的地面
          myFootCache = groundTopY(me);           // 我脚下有没有能落脚的方块（null=悬空/虚空）
        }
        const gy = groundYCache;
        const youOnGround = gy != null && Math.abs(pe.position.y - gy) <= 2.5;
        // 落地判定（v20）：① 你站定 ≥1.2s ② 你脚下有地 ③ 我脚下（站位点）也有方块可落脚
        // 满足就把我降到【我脚下方块的顶面】（不是相对你高度的 0.2 悬空高度 → 不再站空气）
        // 我脚下是空的（悬崖/虚空）→ 继续浮空悬停，绝不硬落
        if (youOnGround && still && now >= flyHoldUntil && myFootCache != null) {
          // v21：落地 = 【取消飞行，交物理重力】——不再由我操控上下飞（你明确要求）
          // 我离落脚方块 ≤3.5 格（原版掉落不摔伤）→ 直接 enterGround()，剩下交给重力自己掉下去
          const drop = me.y - myFootCache;
          if (drop <= 3.5) {
            log('INFO', `🥾 落脚判定：我脚下方块顶面 y=${myFootCache.toFixed(1)}（离 ${drop.toFixed(1)} 格）→ 取消飞行，重力落地`);
            enterGround();
            return;
          }
          landing = true;                  // 还太高（巡航）：先快速压到 3.5 格内，再交物理
          liftTarget = myFootCache - pe.position.y;
        } else {
          liftTarget = 0.2;          // 你还在动 / 你悬空 / 我脚下没地 → 同高平飞悬停
        }
      } else {
        landingLogged = false;
        liftTarget = CRUISE_HEIGHT;  // 远距：爬到你上方 4 格高空巡航
      }
      // 降落（你已站定、我还太高）用更快下压速率 → 尽快交回重力；巡航用平滑速率
      const dRate = landing ? 0.35 : DESCEND_RATE;
      lift += Math.max(-dRate, Math.min(CLIMB_RATE, liftTarget - lift));
      const tgtY = pe.position.y + lift;
      const dy = tgtY - me.y;
      const d3 = Math.hypot(dx, dy, dz);
      // 降落完成（高度已贴近地面 + 水平也不远）→ 交地面模式，物理接管自然踩到方块上
      if (landing && Math.abs(dy) < 0.45 && dh < 6.5) { enterGround(); return; }
      // 悬停就位（你悬空且已经很近）：站定盯人
      if (!landing && dh <= 2.2 && Math.abs(me.y - pe.position.y) <= 1.6) {
        const f = 0.85; // 惯性滑停（原版飞行松手会滑行几格，不是瞬间刹住）
        vx *= f; vy *= f; vz *= f;
        if (Math.hypot(vx, vy, vz) < 0.05) { vx = 0; vy = 0; vz = 0; }
        if (d3 < 0.6) me.add(v3(dx * 0.35, dy * 0.35, dz * 0.35));
        zeroVel();
        bot.entity.yaw = Math.atan2(-(pe.position.x - me.x), -(pe.position.z - me.z));
        bot.entity.pitch = Math.atan2((pe.position.y + 1.6) - (me.y + 1.62), Math.max(dh, 0.01));
        return;
      }
      if (d3 <= 1e-3) { vx = vy = vz = 0; zeroVel(); return; }
      // 匀速跟随（v18）：desired 是 dh 的连续函数 → 速度永不跳变（旧版在 dh=10 处按玩家速度切上限，
      // 导致"突然加速跟上、再突然减速"）。远于 RAMP+HOVER_D 格满速巡航，近处线性收速，2.5 格归零。
      // 追跑跳的你时自动平衡在 ~5 格、速度≈你的速度（位置比例控制天然给出），不会冲到你面前再急停
      const desired = SPEED_AIR * Math.max(0, Math.min(1, (dh - HOVER_D) / RAMP));
      const ux = dx / d3, uy = dy / d3, uz = dz / d3;
      vx += (ux * desired - vx) * ACCEL;
      vy += (uy * desired - vy) * ACCEL;
      vz += (uz * desired - vz) * ACCEL;
      const sp = Math.hypot(vx, vy, vz);
      if (sp > SPEED_AIR) { const f = SPEED_AIR / sp; vx *= f; vy *= f; vz *= f; }
      // 朝向移动方向（挖矿式看路）；落地/悬停时才转头看人
      bot.entity.yaw = Math.atan2(-vx, -vz);
      bot.entity.pitch = Math.max(-1.2, Math.min(1.2, Math.atan2(vy, Math.max(Math.hypot(vx, vz), 0.01))));
      zeroVel();
      // 按真实 dt 积分 + 单次发包位移硬上限（超 1.09 格/tick 会被服务器拉回 = 真瞬移）
      const k = Math.max(0.2, Math.min(dtRef, 2.5));
      const mx = vx * k, my = vy * k, mz = vz * k;
      const ml = Math.hypot(mx, my, mz);
      const mv = ml > SPEED_AIR ? SPEED_AIR / ml : 1;
      me.add(v3(mx * mv, my * mv, mz * mv));
    };

    let dtRef = 1;
    let finishRef = () => { /* 由下方赋值 */ };
    const myId = ++s.loopId; // 领号：cancelPending / 重新启动时会 +1 → 本循环自动退出

    try {
      // 物理基线（v17）：创造模式若此前有工具把 gravity 留在 0（creativeFlyTo 悬停残留），
      // 直接以地面模式起步会"飘着走"（贴不到地、跑跳物理异常）→ 起步前显式恢复重力
      if (creative) { try { creative?.stopFlying?.(); } catch { /* ignore */ } }
      if (canFly) { /* 是否起飞由距离决定，进循环时按当前距离判定 */ }
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          try { bot.removeListener('physicsTick', onTick); } catch { /* ignore */ }
          clearInterval(checker);
          resolve();
        };
        finishRef = finish;
        const onTick = () => {
          if (done || s.loopId !== myId) { finish(); return; }
          try {
            if (!bot.entity || !bot.players[s.targetName]) { finish(); return; }
            // 让位（v17）：身体被保命动作(guardian 逃跑/进食/战斗)或其他客户端抢走时，
            // 暂停驱身（清一次残留控制键后就撒手），别再和它两套控制键互相覆盖；交还后自动继续跟随。
            if (!ctx.body().isOwner('player')) {
              if (!pausedForOthers) {
                stopAllCtrl();
                pausedForOthers = true;
                log('INFO', '⏸️ 跟随暂停：身体被保命/其他动作接管，处理完自动继续');
              }
              return;
            }
            if (pausedForOthers) {
              pausedForOthers = false;
              log('INFO', '▶️ 跟随继续（身体已交还）');
            }
            const me = bot.entity.position;
            const pe = findPlayerEntity(bot, s.targetName);
            if (!pe) { finish(); return; }
            const dP3 = me.distanceTo(pe.position);
            if (dP3 > MAX_CHASE_DIST) { stopAllCtrl(); zeroVel(); return; } // 太远：原地等
            // 真实经过时间（catch-up 连调多 tick 时每次 dt 很小 → 位移自动摊薄）
            const now = Date.now();
            let dt = lastTs > 0 ? (now - lastTs) / 1000 : DT_NOMINAL;
            lastTs = now;
            if (!(dt > 0)) dt = DT_NOMINAL;
            dt = Math.max(0.005, Math.min(dt, 0.2));
            dtRef = Math.max(0.2, Math.min(dt / DT_NOMINAL, 2.5));
            // 玩家速度估计（EMA，供远距预判用）
            if (hasLast) {
              pvx += ((pe.position.x - lastX) / DT_NOMINAL - pvx) * 0.25;
              pvy += ((pe.position.y - lastY) / DT_NOMINAL - pvy) * 0.25;
              pvz += ((pe.position.z - lastZ) / DT_NOMINAL - pvz) * 0.25;
            }
            lastX = pe.position.x; lastY = pe.position.y; lastZ = pe.position.z; hasLast = true;
            // 玩家速度（滑窗平均，格/tick）：每 3 tick 采样一次，取 ~1.3s 窗口的 位移/时间。
            // 这是档位判定的唯一依据 —— 乱抖的瞬时 EMA 不算数
            if ((ticks % 3) === 0) {
              histT.push(now); histX.push(pe.position.x); histZ.push(pe.position.z);
              if (histT.length > 9) { histT.shift(); histX.shift(); histZ.shift(); }
            }
            if (histT.length >= 4) {
              const dtS = (now - histT[0]) / 1000;
              if (dtS > 0.3) {
                pSpeedAvg = Math.hypot(pe.position.x - histX[0], pe.position.z - histZ[0]) / dtS / 20;
              }
            }
            // 目标水平点：远 = 玩家本人；近 = 侧后站位；预判只用于远距追击
            const near = dP3 <= s.range + 1.5;
            const fp = near ? followPointOf(s, pe) : { x: pe.position.x, z: pe.position.z };
            const lead = dP3 > 8 ? LEAD : 0;
            const tx = (near ? fp.x : pe.position.x) + pvx * lead;
            const tz = (near ? fp.z : pe.position.z) + pvz * lead;
            const dx = tx - me.x, dz = tz - me.z;
            const dh = Math.hypot(dx, dz);
            if (mode === 'ground') {
              // ★ A·进水检测：生存地面跑时，脚下踩到水/身体泡进水里 → 切游泳（创造飞行不走这里）
              if (!isCreativeNow() && (isInWater(me) || waterAtFeet(me))) { enterSwim(); }
              else groundStep(pe, me, dP3, near, dh, dx, dz);
            } else if (mode === 'swim') {
              swimStep(pe, me, dP3, near, dh, dx, dz);
            } else {
              flyStep(pe, me, dP3, near, dh, dx, dz);
            }
            ticks++;
          } catch { finish(); }
        };
        const checker = setInterval(() => {
          if (state !== s || s.loopId !== myId) { finish(); return; }
          // ★ 玩家插话 → 中断跟随，原地停下（大脑优先回应玩家）
          if (isInterrupted()) {
            log('INFO', '⏹️ 玩家插话 → 跟随原地停下');
            finish();
            return;
          }
          try {
            if (!bot.entity || !bot.players[s.targetName]) { finish(); return; }
          } catch { finish(); return; }
          const cur = ctx.body().current();
          // 锁彻底没了（stop-follow / 释放）→ 退出
          if (cur.owner === null) { finish(); return; }
          // 被别的玩家任务接管（同优先级互斥，label 不同；displaced 恢复时 label 为空，不算）
          if (cur.owner === 'player' && cur.label !== '' && cur.label !== 'follow-player') {
            log('INFO', `⏭️ 跟随让位：身体被 ${cur.label} 接管`);
            finish();
            return;
          }
          // 有玩家任务在排队等身体（比如你让它挖矿/放置）→ 主动让位，别让它空等 20s 超时
          if (ctx.body().hasWaiter('player') && !pausedForOthers) {
            log('INFO', '⏭️ 跟随让位：有玩家指令在等身体（想继续跟就再喊我一声）');
            finish();
            return;
          }
          // 保命动作只容忍短时占用（逃跑/进食/苦力怕拉锯），超 10s 视为异常 → 退出跟随
          if (cur.owner === 'guardian') {
            if (guardianSince === 0) guardianSince = Date.now();
            else if (Date.now() - guardianSince > 10000) {
              log('WARN', '⚠️ 保命动作占用身体超 10s，跟随退出');
              finish();
              return;
            }
          } else {
            guardianSince = 0;
          }
        }, 250);
        bot.on('physicsTick', onTick);
      });
    } finally {
      stopAllCtrl();
      zeroVel();
      if (flying) {
        try { creative?.stopFlying?.(); } catch { /* ignore */ }
        flying = false;
      }
    }
    return result;
  };

  /**
   * 掉队喊话：身体只做检测 → 模糊情境喂大脑（companion.sayGap 现编台词，禁预设）。
   * 距离档：>GAP1 持续 GAP_HOLD1 → 喊一次；>GAP2 持续 GAP_HOLD2 → 升级再喊；
   * 回到 <GAP_RESET 重置。绝不喂精确格数（真人说不出"40格开外"，只会说"你跑哪去了"）。
   */
  const fireGapIfNeeded = (s: FollowState): void => {
    const now = Date.now();
    const me = s.bot.entity.position;
    const pe = findPlayerEntity(s.bot, s.targetName);
    if (!pe) return;
    const d3 = me.distanceTo(pe.position);
    // 玩家移动速度（位移 / tick 间隔）
    let ps = 0;
    if (s.prevPos) ps = s.prevPos.distanceTo(pe.position) / (TICK_MS / 1000);
    s.prevPos = pe.position.clone();
    if (d3 < GAP_RESET) { s.gapStage = 0; s.gapSince = 0; return; } // 跟上了 → 重置
    if (d3 < GAP1) { s.gapSince = 0; return; }
    const want = d3 >= GAP2 ? 2 : 1;
    if (s.gapStage >= want) { s.gapSince = 0; return; } // 本档已喊过（档位只增不减，直到 reset）
    if (s.gapSince === 0) { s.gapSince = now; return; }
    if (now - s.gapSince < (want === 2 ? GAP_HOLD2 : GAP_HOLD1)) return;
    const comp = ctx.companion?.();
    if (comp) {
      const fuzzy = gapFuzzy(d3);
      const status = speedWord(ps);
      const where = relDirWord(me, pe.position, s.bot.entity.yaw);
      const extra = want === 2 ? '（我前面已经喊过一次让他等我，他还在跑没停，这次可以更着急一点）' : '';
      const prompt =
        `我正在跟随玩家 ${s.targetName}，他一口气跑出去把我甩在了后面——现在他${where}，${fuzzy}，而且还在${status}。` +
        `以真人玩家的口吻喊他一句让他等等我，自然地说 1~2 句口语${extra}。` +
        `注意用模糊的日常说法（比如"你跑哪去了""等等我呀"），不要报具体距离数字。`;
      log('INFO', `🗣️ 掉队触发(d3=${Math.round(d3)}格, 档${want}) → companion.sayGap`);
      comp.sayGap(prompt);
    }
    s.gapStage = want;
    s.gapSince = 0;
  };

  mcp.registerTool(
    'follow-player',
    '拟人化持续跟随指定玩家（不传则跟随最近的玩家）：站你【侧后方】像真人朋友一样走，拉开距离会自动切档追赶（走→疾跑→跑跳），被甩远了（超过十几格持续一会儿）会开口喊你等等——台词经大脑现编不是固定话。目标消失/掉线自动停止；用 stop-follow 手动停止。range 传 0 或负数 = 纯追视模式：身体原地不动，视线每 50ms 实时锁定目标（机械循环，不经大脑逐次刷新）',
    {
      player: z.string().optional().describe('要跟随的玩家名，默认跟随最近的玩家'),
      range: z.number().optional().describe('跟随距离（格），默认 3（实际在其左右浮动，不精确贴死）'),
      side: z.enum(['left', 'right', 'auto']).optional().describe('站玩家哪一侧后方：left=左后 / right=右后 / auto=自动挑一侧，默认 auto'),
    },
    async (args) => {
      const bot = getBot(ctx);
      const creative = isCreativeByStatus(ctx);

      // 1. 确定跟随目标
      let targetName: string;
      if (args.player) {
        targetName = String(args.player);
        if (!bot.players[targetName]) return fail(`找不到玩家 ${targetName}（可能不在线）`);
      } else {
        const others = Object.keys(bot.players).filter((n) => n !== bot.username);
        if (others.length === 0) return fail('附近没有其他玩家可跟随');
        const nearest = others
          .map((n) => {
            const e = bot.players[n].entity;
            return { n, d: e ? bot.entity.position.distanceTo(e.position) : Infinity };
          })
          .sort((a, b) => a.d - b.d)[0];
        targetName = nearest.n;
      }
      const rawRange = Number(args.range ?? 3);
      const gazeMode = !(rawRange >= 1); // range<1 → 纯追视模式
      const range = Math.max(1, Math.round(rawRange));
      const side: Side = args.side === 'left' ? 'left' : args.side === 'right' ? 'right' : (Math.random() < 0.5 ? 'left' : 'right');

      // 2. 身体锁：跟随期间独占移动（其他移动指令会等待，需先 stop-follow）
      const release = ctx.body().tryAcquire('player', 'follow-player');
      if (!release) return fail('身体正被占用（保命/其他任务），暂时无法跟随，稍后再试');

      // 3. 停掉旧跟随，起新的
      stopFollow('切换目标');

      const ent = findPlayerEntity(bot, targetName);
      if (!ent) {
        release();
        return fail(`玩家 ${targetName} 的实体还没加载（太远或刚上线），稍后再试`);
      }

      // 创造模式且若正处于飞行中：清残留控制键，直接以飞行方式开始
      if (creative) {
        hardClearControls(bot);
      }

      const s: FollowState = {
        bot, targetName, range, side,
        timer: null, pending: null, release, creative, loopId: 0,
        gapStage: 0, gapSince: 0, prevPos: null, lostSince: 0,
        fpCache: null, accX: 0, accZ: 0,
      };
      state = s;

      const tick = async (): Promise<void> => {
        if (state !== s) return; // 已被停止/切换
        try {
          if (!ctx.bot()) {
            stopFollow('bot 已断开');
            return;
          }
          const target = findPlayerEntity(s.bot, s.targetName);
          if (!target) {
            // 目标暂时不在实体表：4s 缓冲（防瞬断/出视距边缘误停），期间保持原位等恢复
            const now = Date.now();
            if (s.lostSince === 0) {
              s.lostSince = now;
            } else if (now - s.lostSince > 4000) {
              stopFollow('目标消失或掉线');
            }
            return;
          }
          s.lostSince = 0;
          // 锁被 guardian 等抢走（如保命）→ 暂停追赶，等锁还回来再继续
          if (!ctx.body().isOwner('player')) {
            cancelPending(s);
            return;
          }
          // ── 掉队喊话检测（身体检测 → companion 大脑台词；与追赶并行）──
          fireGapIfNeeded(s);
          const dist = s.bot.entity.position.distanceTo(target.position);
          if (dist <= s.range && s.pending) {
            // 已经够近且在跑循环 → 交给循环自己就位盯人（不杀循环，否则就没人看着玩家了）
            return;
          }
          // 玩家超远（>160 格，超出实体跟踪后由 lostSince 缓冲接管）：原地等玩家靠近
          if (dist > MAX_CHASE_DIST) {
            cancelPending(s);
            return;
          }
          if (s.pending) return; // 正在追赶/就位盯人中，等它自己收敛

          // 统一跟随循环：近距跑跳（走→疾跑→跑跳）、远距起飞，接近后降落到玩家旁边方块上。
          // 创造/生存的区别只在于"有没有飞行能力"，不再用作机动方式开关（9/11 玩家设计意见）。
          log('INFO', `🏃 跟随 ${s.targetName}（距 ${Math.round(dist)} 格，侧后 ${s.side}，${s.creative ? '可飞' : '地面'}）`);
          const p = (async () => {
            const res = await followLoop(s);
            if (!res.blocked) return;
            // 直线被挡 → pathfinder 绕障一次（moveSettings 已关疾跑），绕完自动回到直走循环
            const t2 = findPlayerEntity(s.bot, s.targetName);
            if (!t2) return;
            // ★ v25 绕障节流：连续失败 ≥3 次 → 这段地形/虚空真过不去 → 冷却期内【站住不动】
            //   （不蹦不撞墙），掉队喊话（>12 格持续 2s）会开口叫玩家等我 —— 比原地跳来跳去像人得多。
            if (detourFails >= DETOUR_MAX_FAILS) {
              if (Date.now() < detourRetryAt) { hardClearControls(s.bot); return; }
              detourFails = 0; // 冷却结束，再试一轮
            }
            detourHoldUntil = Date.now() + DETOUR_HOLD_MS; // 绕障期间不回"直走撞墙"的老路
            log('INFO', `🚧 直走被挡，pathfinder 绕障追赶 ${s.targetName}${detourFails > 0 ? `（连续第 ${detourFails + 1} 次）` : ''}`);
            // 用"玩家当时坐标的静态 GoalNear"而不是 dynamic GoalFollowEntity：
            // dynamic 目标在玩家转向后不会实时重算，会闷头把旧路径跑完（= 玩家看到的"朝一个方向使劲跑"）；
            // 静态目标 + 12s 上限 → 绕一小段立刻回到直走循环，由直走接管（直走才是实时最短直线）。
            const gp = t2.position;
            const goal = new goals.GoalNear(gp.x, gp.y, gp.z, Math.max(1, s.range));
            try {
              await withTimeout(pf(s.bot).goto(goal), OBSTACLE_TIMEOUT_MS, '跟随绕障');
              detourFails = 0; // 绕过去了 → 计数清零
            } catch (err) {
              try { void pf(s.bot).cancel(); } catch { /* ignore */ }
              hardClearControls(s.bot);
              detourFails++;
              if (detourFails >= DETOUR_MAX_FAILS) {
                detourRetryAt = Date.now() + DETOUR_RETRY_CD_MS;
                detourHoldUntil = Math.max(detourHoldUntil, detourRetryAt); // 冷却期也别再撞墙，站住
              }
              log('WARN', `⚠️ 绕障追赶 ${s.targetName} 中断：${String(err)}（${detourFails >= DETOUR_MAX_FAILS ? `连续 ${detourFails} 次失败 → ${DETOUR_RETRY_CD_MS / 1000}s 内站住等你回来` : '下个周期重试直走'}）`);
            }
          })().catch((err) => {
            log('WARN', `⚠️ 步行跟随 ${s.targetName} 中断：${String(err)}（下个周期自动重试）`);
          }).finally(() => {
            if (s.pending === p) s.pending = null;
          });
          s.pending = p;
        } catch (e) {
          log('ERROR', `跟随 tick 异常：${String(e)}`);
        }
      };

      // 纯追视模式：身体不动，50ms 机械循环把视线对准目标（本地直接驱动 yaw/pitch，
      // 服务器按 3rad/s 限速收敛 → 玩家看到的是平滑转头实时跟随，不经大脑逐次刷新）
      if (gazeMode) {
        let lostSince = 0;
        s.timer = setInterval(() => {
          if (state !== s) { if (s.timer) clearInterval(s.timer); s.timer = null; return; }
          try {
            if (!ctx.bot()) { stopFollow('bot 已断开'); return; }
            const t = findPlayerEntity(s.bot, s.targetName);
            if (!t) {
              // 目标暂时不在实体表：计数，连续 2.5s 找不到才停（防瞬断误停）
              if (lostSince === 0) lostSince = Date.now();
              else if (Date.now() - lostSince > 2500) stopFollow('目标消失或掉线');
              return;
            }
            lostSince = 0;
            const me = s.bot.entity.position;
            const p = t.position;
            const eyeY = (p.y + 1.6);
            s.bot.entity.yaw = Math.atan2(-(p.x - me.x), -(p.z - me.z));
            const dy = eyeY - (me.y + 1.62);
            s.bot.entity.pitch = Math.atan2(dy, Math.hypot(p.x - me.x, p.z - me.z));
          } catch (e) {
            log('ERROR', `追视循环异常：${String(e)}`);
          }
        }, 50);
        log('INFO', `👀 追视模式：视线实时锁定 ${targetName}（身体不动，50ms 刷新）`);
        return ok(`追视模式已开启：身体原地不动，视线每 50ms 实时锁定 ${targetName}，平滑跟随你移动。停止用 stop-follow`);
      }

      // 起始状态强制回到「地面模式」（v21）：清掉上一次跟随可能残留的创造飞行状态
      // ——flying=true 时 jump 键不产生跳跃、重力也不生效，会让跑跳档"只看得到档位、看不到跳"
      try { (s.bot as unknown as { creative?: { stopFlying?: () => void } }).creative?.stopFlying?.(); } catch { /* ignore */ }
      // ★ v22：不止关飞行，必须把 gravity 显式恢复（否则零重力漂浮：落不下、跳不起、onGround 恒 false）
      try { (s.bot.physics as unknown as { gravity: number }).gravity = 0.08; } catch { /* ignore */ }
      s.timer = setInterval(() => { void tick(); }, TICK_MS);
      void tick();
      const flyableNow = !!creative && (() => { try { return (s.bot.game as unknown as { gameMode?: string })?.gameMode === 'creative'; } catch { return false; } })();
      log('INFO', `🕊️ 开始跟随 ${targetName}（${flyableNow ? '可飞行' : '纯地面模式（生存）'}，侧后 ${side}，距离约 ${range} 格）`);
      return ok(`开始跟随 ${targetName}（${flyableNow ? '可飞行' : '纯地面模式'}），我站你侧后方保持约 ${range} 格；你拉开我会走/跑/跑跳追，甩太远会喊你等等。停止用 stop-follow；跟随期间其他移动指令会等待，需先停止`);
    }
  );

  mcp.registerTool(
    'stop-follow',
    '停止跟随玩家（取消跟随并释放身体控制权）',
    {},
    async () => {
      const s = state;
      if (!s) return ok('当前没有在跟随');
      stopFollow('手动停止');
      return ok(`已停止跟随 ${s.targetName}`);
    }
  );
}
