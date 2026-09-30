import type mineflayer from 'mineflayer';

/**
 * 【转向通道 v1 · 9/12】所有"看人/看目标"类转向的唯一出口
 * ─────────────────────────────────────────────────────────────
 * 背景（玩家实机反馈："他还在疯狂转头"）：
 *   §6.9 当天给 walk-path 治好了"弯道疯狂摆头"（头身解耦 + 300°/s + 2° 死区），
 *   但 gaze.ts / head-follow.ts 这两处 yaw 写入点没跟上，仍是
 *   **每 physicsTick(20Hz) 无死区、无限速地直写 entity.yaw**，
 *   再叠加 physics.yawSpeed=200 的即时发包 → 目标(玩家)自己那点位置抖动
 *   被 1:1 放大成 20Hz 的甩头（1 格处 0.1 格位移 ≈ 6°）。
 *
 * 本模块把三类写入统一成一条真人速率的通道：
 *   ① 物理朝向 entity.yaw 照旧"即时对准"（移动原语吃它，平滑会让身子斜切戳墙）
 *   ② 玩家看到的发包朝向走 __netStat.headYaw（notchian 度，见 bot-connection.ts）
 *      —— 300°/s 匀速转 + 2° 死区滤微抖 + 目标位置 EMA 低通
 *   ③ 交还（release）时按 300°/s 把头部收敛回身体朝向再撤覆盖，禁止瞬断猛甩
 *
 * ⚠️ 单位陷阱（§6.9 当天踩过）：发包 yaw 是 **notchian 度数**（toDegrees(π - yaw)），
 *    不是内部弧度。直接写弧度 → 服务器按"3.14 度"读，头歪 90~180°。
 * ⚠️ 所有权：headYaw 覆盖是共享通道，谁写谁负责在让位时 release，别把别人的覆盖清掉。
 */

export type HeadOwner = 'gaze' | 'head-follow';

interface NetStat {
  sentYaw: number | null;
  sentAt: number;
  headYaw: number | null;
}

interface HeadState {
  owner: HeadOwner | null;
  /** 平滑后的内部弧度朝向（-π..π） */
  yaw: number;
  pitch: number;
  /** 目标位置 EMA（消"目标自己抖"） */
  tx: number;
  ty: number;
  tz: number;
  hasTarget: boolean;
  lastAt: number;
}

const RATE = 5.2; // rad/s ≈ 300°/s（90° 拐弯 ≈0.3s，真人快扫量级，与 walk-path 同参）
const DEAD = 0.035; // ≈2° 死区：小于此的偏差不追（滤目标微抖 / 采样噪声）
const PITCH_RATE = 3.5; // rad/s ≈ 200°/s（俯仰慢一点，更像人）
const POS_EMA = 0.3; // 目标位置低通系数（越小越稳）
const NEAR_BLOCK = 0.35; // 水平距离小于此 = 贴脸/重叠，方向无意义 → 不动头（防 180° 狂甩）
const RESEED_MS = 300; // 距上次调用超过此毫秒 → 说明自己不是当前朝向主人，重新对齐 entity 再算

/** 内部弧度 → 发包用 notchian 度数 */
export const toNotchianDeg = (r: number): number => (((Math.PI - r) * 180) / Math.PI + 720) % 360;
/** notchian 度数 → 内部弧度 */
export const fromNotchianDeg = (d: number): number => Math.PI - (d * Math.PI) / 180;

function normAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function getNetStat(bot: mineflayer.Bot): NetStat | undefined {
  return (bot as unknown as { __netStat?: NetStat }).__netStat;
}

const states = new WeakMap<mineflayer.Bot, HeadState>();

function state(bot: mineflayer.Bot, owner: HeadOwner): HeadState {
  let st = states.get(bot);
  if (!st) {
    st = { owner: null, yaw: bot.entity?.yaw ?? 0, pitch: bot.entity?.pitch ?? 0, tx: 0, ty: 0, tz: 0, hasTarget: false, lastAt: 0 };
    states.set(bot, st);
  }
  st.owner = owner;
  return st;
}

/**
 * 平滑转向到"某个世界坐标点"（看人/看路点都用它）。
 * @param smoothPos 目标点是否走 EMA 低通（看玩家 = true；看点漂移 = false）
 */
export function aimAt(
  bot: mineflayer.Bot,
  owner: HeadOwner,
  tx: number,
  ty: number,
  tz: number,
  opts: { smoothPos?: boolean; eyeHeight?: number } = {}
): void {
  const st = state(bot, owner);
  const e = bot.entity;
  if (!e) return;
  const smoothPos = opts.smoothPos !== false;
  if (smoothPos) {
    if (!st.hasTarget) {
      st.tx = tx; st.ty = ty; st.tz = tz; st.hasTarget = true;
    } else {
      st.tx += (tx - st.tx) * POS_EMA;
      st.ty += (ty - st.ty) * POS_EMA;
      st.tz += (tz - st.tz) * POS_EMA;
    }
  } else {
    st.tx = tx; st.ty = ty; st.tz = tz; st.hasTarget = true;
  }
  const eye = opts.eyeHeight ?? 1.62;
  const dx = st.tx - e.position.x;
  const dz = st.tz - e.position.z;
  const horiz = Math.hypot(dx, dz);
  if (horiz < NEAR_BLOCK) return; // 贴脸/重叠：方向无意义，别甩头
  const yaw = Math.atan2(-dx, -dz); // 与 mineflayer lookAt 保持一致
  const pitch = Math.atan2(st.ty - (e.position.y + eye), horiz);
  aimDir(bot, owner, yaw, pitch);
}

/** 平滑转向到指定朝向（弧度）。物理 entity.yaw 即时，观感走 headYaw 覆盖匀速转 */
export function aimDir(bot: mineflayer.Bot, owner: HeadOwner, yaw: number, pitch = 0): void {
  const st = state(bot, owner);
  const e = bot.entity;
  if (!e) return;
  const now = Date.now();
  const dt = Math.min(0.25, Math.max(0.01, (now - st.lastAt) / 1000 || 0.05));
  if (now - st.lastAt > RESEED_MS) {
    // 期间别人（look-at / walk-path / 寻路）动过朝向 → 先跟当前实体对齐，别硬拽回去
    st.yaw = e.yaw;
    st.pitch = e.pitch;
  }
  st.lastAt = now;

  // —— 物理朝向：即时（移动原语吃这个值；平滑会让身子斜切戳墙）——
  e.yaw = yaw;
  // —— 观感朝向：2° 死区 + 300°/s 匀速 ——
  let dY = normAngle(yaw - st.yaw);
  if (Math.abs(dY) < DEAD) dY = 0;
  const stepY = RATE * dt;
  st.yaw = normAngle(st.yaw + Math.max(-stepY, Math.min(stepY, dY)));

  // —— 俯仰：直接吃平滑值（pitch 不参与移动，不存在物理冲突）——
  let dP = pitch - st.pitch;
  if (Math.abs(dP) < DEAD) dP = 0;
  const stepP = PITCH_RATE * dt;
  st.pitch = st.pitch + Math.max(-stepP, Math.min(stepP, dP));
  e.pitch = st.pitch;

  // —— 发包覆盖：notchian 度数！——
  const net = getNetStat(bot);
  if (net) net.headYaw = toNotchianDeg(st.yaw);
}

/**
 * 交还视线：按 300°/s 把头部收敛回身体朝向，收敛完撤覆盖（禁止瞬断猛甩）。
 * 让位/挂起/注视结束都必须调，否则上一段覆盖会粘在头上。
 */
export function releaseHead(bot: mineflayer.Bot, owner: HeadOwner): void {
  const st = states.get(bot);
  if (st && st.owner !== owner) return; // 不是自己的覆盖，别清
  const net = getNetStat(bot);
  if (net && net.headYaw === null) {
    if (st) { st.owner = null; st.hasTarget = false; }
    return;
  }
  const t0 = Date.now();
  const timer = setInterval(() => {
    try {
      const e = bot.entity;
      const n = getNetStat(bot);
      if (!e || !n || n.headYaw === null) { clearInterval(timer); return; }
      const d = normAngle(e.yaw - fromNotchianDeg(n.headYaw));
      const deg = Math.abs(d) * (180 / Math.PI);
      if (deg <= 15 || Date.now() - t0 > 1500) {
        n.headYaw = null; // 已收敛 → 撤覆盖，无感
        clearInterval(timer);
        return;
      }
      const cur = fromNotchianDeg(n.headYaw);
      const step = (RATE * 0.05) * Math.sign(d);
      n.headYaw = toNotchianDeg(normAngle(cur + step));
    } catch {
      try { const n = getNetStat(bot); if (n) n.headYaw = null; } catch { /* ignore */ }
      clearInterval(timer);
    }
  }, 50);
  if (st) { st.owner = null; st.hasTarget = false; }
}
