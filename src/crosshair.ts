import type mineflayer from 'mineflayer';
import { v3 } from './utils';

/**
 * 仿客户端准星（crosshair）核心模块
 * ────────────────────────────────────────────────────
 * 玩家屏幕正中央有个准星：你「看」到的是准星沿视线方向第一个碰到的方块或实体。
 * 本模块复刻这套判定 —— 从眼睛位置沿当前 yaw/pitch 视线方向发一条射线，
 * 同时检测【方块】和【实体】，取距离更近的那个作为「准星命中」，
 * 再按当前游戏模式的交互距离（reach）判断：够得着吗？视线被挡了吗？
 *
 * 用途：放置 / 破坏 / 交互 / 攻击前先问一句「准星指到哪了、能不能够着」，
 * 而不是拿到一个坐标就盲目走过去硬怼（生存模式手短，4.5 格外放不了方块、
 * 3 格外打不到怪）。
 */

export type InteractionKind = 'block' | 'entity';

export interface ReachLimits {
  /** 方块交互距离（放置 / 挖掘 / 使用方块） */
  block: number;
  /** 实体攻击距离 */
  entity: number;
}

/** MC 玩家默认眼睛高度（脚底上方，不潜行） */
export const EYE_HEIGHT = 1.62;

/**
 * 当前游戏模式的交互距离（MC 1.21 口径）：
 *   生存：方块 4.5 格，实体攻击 3.0 格
 *   创造：统一 5.0 格
 */
export function getReach(bot: mineflayer.Bot): ReachLimits {
  const gm = (bot.game as unknown as { gameMode?: string } | null)?.gameMode;
  const creative = gm === 'creative';
  return creative
    ? { block: 5.0, entity: 5.0 }
    : { block: 4.5, entity: 3.0 };
}

/** 眼睛坐标（含脚底 + 眼睛高度） */
export function eyePosition(bot: mineflayer.Bot): { x: number; y: number; z: number } {
  const p = bot.entity.position;
  return { x: p.x, y: p.y + EYE_HEIGHT, z: p.z };
}

/** 视线单位方向向量（由 yaw/pitch 推出，与 faceToward 反解一致） */
export function lookDirection(bot: mineflayer.Bot): { x: number; y: number; z: number } {
  const yaw = bot.entity.yaw;
  const pitch = bot.entity.pitch;
  const cp = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp,
  };
}

export interface BlockHit {
  kind: 'block';
  block: { name: string; x: number; y: number; z: number };
  distance: number;
}

export interface EntityHit {
  kind: 'entity';
  entity: {
    name: string;
    type: string;
    x: number;
    y: number;
    z: number;
    height: number;
    width: number;
  };
  distance: number;
}

export interface CrosshairResult {
  eye: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
  gameMode: string;
  reach: ReachLimits;
  hit: BlockHit | EntityHit | null;
  /** 实体被更近的方块挡住（视线不通） */
  blocked: boolean;
  /** 命中目标在对应 reach 距离内 */
  withinReach: boolean;
  /** 综合可达：有命中 && 在距离内 && 视线没被挡 */
  reachable: boolean;
  note: string;
}

/** 方块射线（prismarine-world raycast，返回命中方块坐标 + 名称 + 距离） */
async function raycastBlock(
  bot: mineflayer.Bot,
  eye: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  maxDist: number
): Promise<BlockHit | null> {
  try {
    const hit = (await bot.world.raycast(v3(eye.x, eye.y, eye.z), v3(dir.x, dir.y, dir.z), maxDist)) as unknown as {
      position?: { x: number; y: number; z: number };
    } | null;
    if (!hit || !hit.position) return null;
    const b = bot.blockAt(v3(hit.position.x, hit.position.y, hit.position.z)) as unknown as { name?: string } | null;
    const name = b?.name ?? 'unknown';
    if (name === 'air' || name === 'cave_air' || name === 'void_air') return null;
    const dist = Math.hypot(
      hit.position.x + 0.5 - eye.x,
      hit.position.y + 0.5 - eye.y,
      hit.position.z + 0.5 - eye.z
    );
    return {
      kind: 'block',
      block: { name, x: hit.position.x, y: hit.position.y, z: hit.position.z },
      distance: dist,
    };
  } catch {
    return null;
  }
}

/** AABB 与射线的 slab 相交检测，返回命中距离 t（起点沿 dir 的长度）或 null */
function rayAabb(
  origin: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  min: { x: number; y: number; z: number },
  max: { x: number; y: number; z: number }
): number | null {
  let tmin = -Infinity;
  let tmax = Infinity;
  const axes = ['x', 'y', 'z'] as const;
  for (const a of axes) {
    const o = origin[a];
    const d = dir[a];
    if (Math.abs(d) < 1e-9) {
      if (o < min[a] || o > max[a]) return null;
      continue;
    }
    let t1 = (min[a] - o) / d;
    let t2 = (max[a] - o) / d;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmin >= 0) return tmin;
  if (tmax >= 0) return tmax;
  return null;
}

/** 实体射线：遍历附近实体 AABB，取沿视线方向最近命中者（不含自己） */
function raycastEntity(
  bot: mineflayer.Bot,
  eye: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  maxDist: number
): EntityHit | null {
  let best: EntityHit | null = null;
  let bestDist = maxDist;
  const ents = Object.values(bot.entities) as Array<{
    name?: string;
    type?: string;
    kind?: string;
    id?: number;
    position: { x: number; y: number; z: number };
    height?: number;
    width?: number;
  }>;
  for (const e of ents) {
    if (e.id === bot.entity.id) continue;
    const pos = e.position;
    if (!pos) continue;
    const h = e.height ?? 1.8;
    const w = e.width ?? 0.6;
    const t = rayAabb(
      eye,
      dir,
      { x: pos.x - w / 2, y: pos.y, z: pos.z - w / 2 },
      { x: pos.x + w / 2, y: pos.y + h, z: pos.z + w / 2 }
    );
    if (t == null || t > maxDist) continue;
    if (t < bestDist) {
      bestDist = t;
      best = {
        kind: 'entity',
        entity: {
          name: e.name ?? 'unknown',
          type: e.type ?? e.kind ?? 'unknown',
          x: pos.x,
          y: pos.y,
          z: pos.z,
          height: h,
          width: w,
        },
        distance: t,
      };
    }
  }
  return best;
}

/**
 * 联合准星检测：方块 + 实体同时射线，取较近者为「准星命中」，
 * 输出 reach 判定（够得着 / 超距 / 被方块遮挡）。
 */
export async function crosshairCast(bot: mineflayer.Bot, maxDist = 6): Promise<CrosshairResult> {
  const eye = eyePosition(bot);
  const dir = lookDirection(bot);
  const gm = (bot.game as unknown as { gameMode?: string } | null)?.gameMode ?? 'survival';
  const reach = getReach(bot);

  const blockHit = await raycastBlock(bot, eye, dir, maxDist);
  const entityHit = raycastEntity(bot, eye, dir, maxDist);

  let hit: BlockHit | EntityHit | null = null;
  if (blockHit && entityHit) hit = blockHit.distance <= entityHit.distance ? blockHit : entityHit;
  else if (blockHit) hit = blockHit;
  else if (entityHit) hit = entityHit;

  let blocked = false;
  let withinReach = false;
  let note = '';

  if (hit) {
    if (hit.kind === 'block') {
      withinReach = hit.distance <= reach.block;
      note = withinReach
        ? '方块在交互距离内'
        : `方块距离 ${hit.distance.toFixed(1)} 格，超过方块交互距离 ${reach.block} 格`;
    } else {
      if (blockHit && blockHit.distance < hit.distance - 0.1) blocked = true;
      withinReach = hit.distance <= reach.entity;
      if (blocked) {
        note = `实体前有方块遮挡（${blockHit!.block.name} 在 ${blockHit!.distance.toFixed(1)} 格）`;
      } else {
        note = withinReach
          ? '实体在攻击距离内'
          : `实体距离 ${hit.distance.toFixed(1)} 格，超过攻击距离 ${reach.entity} 格`;
      }
    }
  } else {
    note = `准星 ${maxDist} 格内没有可交互目标`;
  }

  return {
    eye,
    direction: dir,
    gameMode: gm,
    reach,
    hit,
    blocked,
    withinReach,
    reachable: !!hit && withinReach && !blocked,
    note,
  };
}

export interface ReachCheckResult {
  target: { kind: 'block' | 'entity'; name: string; x: number; y: number; z: number };
  /** 眼睛到目标中心的距离（格） */
  distance: number;
  /** 对应交互距离 */
  reach: number;
  withinReach: boolean;
  /** 视线是否通畅（中间没被别的方块挡住） */
  lineOfSight: boolean;
  blockedBy?: string;
  reachable: boolean;
  note: string;
}

/**
 * 给定目标（方块坐标或实体），判断从【当前位置】能否合理交互：
 * 距离是否在对应 reach 内 + 视线是否通畅。不移动、不转向，纯判定。
 * 方块目标传方块整数坐标；实体目标传实体脚底坐标（kind='entity'）。
 */
export async function checkReach(
  bot: mineflayer.Bot,
  target: { x: number; y: number; z: number },
  kind: 'block' | 'entity' = 'block'
): Promise<ReachCheckResult> {
  const eye = eyePosition(bot);
  const reach = getReach(bot);
  const limit = kind === 'block' ? reach.block : reach.entity;

  // 目标中心：方块取格中心，实体取躯干（脚底 + 1.0）
  const cx = kind === 'block' ? Math.floor(target.x) + 0.5 : target.x;
  const cy = kind === 'block' ? Math.floor(target.y) + 0.5 : target.y + 1.0;
  const cz = kind === 'block' ? Math.floor(target.z) + 0.5 : target.z;

  const dx = cx - eye.x;
  const dy = cy - eye.y;
  const dz = cz - eye.z;
  const dist = Math.hypot(dx, dy, dz);
  const withinReach = dist <= limit;

  // 视线通畅：从眼睛沿目标方向 raycast，命中的方块是否就是目标本身（或其更近的挡路方块）
  let lineOfSight = true;
  let blockedBy: string | undefined;
  try {
    const len = Math.hypot(dx, dy, dz) || 1;
    const dir = { x: dx / len, y: dy / len, z: dz / len };
    const hit = (await bot.world.raycast(v3(eye.x, eye.y, eye.z), v3(dir.x, dir.y, dir.z), Math.max(dist, 1))) as unknown as {
      position?: { x: number; y: number; z: number };
    } | null;
    if (hit && hit.position) {
      const isTarget =
        kind === 'block' &&
        hit.position.x === Math.floor(target.x) &&
        hit.position.y === Math.floor(target.y) &&
        hit.position.z === Math.floor(target.z);
      if (!isTarget) {
        // 实体目标：raycast 命中方块距离（用格中心）若明显小于实体距离 → 被挡
        const b = bot.blockAt(v3(hit.position.x, hit.position.y, hit.position.z)) as unknown as { name?: string } | null;
        const bDist = Math.hypot(
          hit.position.x + 0.5 - eye.x,
          hit.position.y + 0.5 - eye.y,
          hit.position.z + 0.5 - eye.z
        );
        if (kind === 'entity' && bDist < dist - 0.3) {
          lineOfSight = false;
          blockedBy = b?.name ?? 'unknown';
        } else if (kind === 'block' && !isTarget) {
          lineOfSight = false;
          blockedBy = b?.name ?? 'unknown';
        }
      }
    }
  } catch {
    /* 视线检测失败按通畅处理（不误杀） */
  }

  const reachable = withinReach && lineOfSight;
  let note: string;
  if (!withinReach) {
    note = `距离 ${dist.toFixed(1)} 格，超过${kind === 'block' ? '方块交互' : '攻击'}距离 ${limit} 格（还差 ${(dist - limit).toFixed(1)} 格）`;
  } else if (!lineOfSight) {
    note = `距离够（${dist.toFixed(1)} 格）但视线被 ${blockedBy} 挡住`;
  } else {
    note = '可交互';
  }

  return {
    target: {
      kind,
      name: kind === 'block'
        ? ((bot.blockAt(v3(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z))) as unknown as { name?: string } | null)?.name ?? 'block')
        : 'entity',
      x: Math.floor(target.x),
      y: Math.floor(target.y),
      z: Math.floor(target.z),
    },
    distance: dist,
    reach: limit,
    withinReach,
    lineOfSight,
    blockedBy,
    reachable,
    note,
  };
}
