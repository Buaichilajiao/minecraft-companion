/**
 * 游戏记忆点系统（Landmark Memory）· 执行设计文档落地
 * ─────────────────────────────────────────────
 * 独立结构化记忆层：只存"重要地点/事件坐标"，与聊天上下文(v2)、
 * 主记忆(memory.json)完全隔离，单独落盘 landmarks.json。
 *
 * 核心约定：
 *  - 只增不删：除淘汰策略外只用 active=false 标记废弃
 *  - 去重：同类型+同维度+距离 < dedupDistance → 合并更新
 *  - 保护类型(home[active]/nether_portal/end_portal/boss/event)永不淘汰
 *  - note 尽量由 Brain 生成；自动触发侧无上下文时允许留空
 *
 * 模块级 registry（setGlobalLandmark）供 guardian/companion/skills 解耦取用，
 * 避免把 LandmarkStore 传穿构造函数链。
 */
import fs from 'fs';
import path from 'path';
import { atomicWriteJson, log } from './utils';

export type LandmarkType =
  | 'home' | 'base' | 'nether_portal' | 'end_portal' | 'village'
  | 'mine' | 'farm' | 'boss' | 'event' | 'death_spot' | 'poi';

export interface LandmarkPos { x: number; y: number; z: number }
export interface Landmark {
  id: string;
  type: LandmarkType;
  name: string;
  dimension: string;              // overworld / nether / end
  position: LandmarkPos;
  createdAt: string;              // ISO 8601
  updatedAt: string;
  note: string;                   // Brain 生成的一句话备注（自动侧可空）
  active: boolean;
  retrieved: boolean;             // 仅 death_spot 使用
}

export interface LandmarkConfig {
  enabled: boolean;
  autoRecord: { home: boolean; portal: boolean; village: boolean; death: boolean; boss: boolean };
  dedupDistance: number;          // 同类型去重半径，默认 50
  maxLandmarks: number;           // 上限，默认 200
  deathSpotRetireDistance: number;// 回收判定距离，默认 20
  contextInjectLimit: number;     // Brain 上下文注入上限，默认 10
  storageFile: string;            // 相对 data/ 的文件名
}

export const DEFAULT_LANDMARK_CONFIG: LandmarkConfig = {
  enabled: true,
  autoRecord: { home: true, portal: true, village: true, death: true, boss: true },
  dedupDistance: 50,
  maxLandmarks: 200,
  deathSpotRetireDistance: 20,
  contextInjectLimit: 10,
  storageFile: 'landmarks.json',
};

/** 永不淘汰类型：home 仅保护 active=true，其余四类无条件保护 */
const PROTECTED_TYPES: LandmarkType[] = ['nether_portal', 'end_portal', 'boss', 'event'];
const RETIRE_DAYS_MS = 7 * 24 * 3600 * 1000;

function dist2(a: LandmarkPos, b: LandmarkPos): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
function dimShort(dim: string): string {
  if (dim.includes('nether')) return 'nether';
  if (dim.includes('end') || dim === 'the_end') return 'end';
  return 'overworld';
}
const DIM_CN: Record<string, string> = { overworld: '主世界', nether: '下界', end: '末地' };

export class LandmarkStore {
  private file: string;
  private cfg: LandmarkConfig;
  private landmarks: Landmark[] = [];

  constructor(cfg?: Partial<LandmarkConfig>, file?: string) {
    this.cfg = { ...DEFAULT_LANDMARK_CONFIG, ...cfg, autoRecord: { ...DEFAULT_LANDMARK_CONFIG.autoRecord, ...(cfg?.autoRecord ?? {}) } };
    const storage = file ?? path.join(__dirname, '..', 'data', this.cfg.storageFile);
    this.file = path.resolve(storage);
    this.load();
  }

  // ── 持久化（优雅降级：读不了当空，写失败只告警） ──
  private load(): void {
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as { landmarks?: Landmark[] };
        if (Array.isArray(raw.landmarks)) {
          this.landmarks = raw.landmarks.filter(
            (l) => l && typeof l.id === 'string' && l.position && typeof l.type === 'string'
          );
        }
      }
    } catch (e) {
      log('WARN', `记忆点文件读取失败，重建: ${e}`);
      this.landmarks = [];
    }
  }
  save(): void {
    try {
      atomicWriteJson(this.file, { landmarks: this.landmarks });
    } catch (e) {
      log('ERROR', `记忆点保存失败: ${e}`);
    }
  }

  // ── id：per-type 自增序号（home_001 只数 home） ──
  private nextId(type: LandmarkType): string {
    let max = 0;
    for (const l of this.landmarks) {
      if (l.type === type) {
        const m = /(\d+)$/.exec(l.id);
        if (m) max = Math.max(max, Number(m[1]));
      }
    }
    return `${type}_${String(max + 1).padStart(3, '0')}`;
  }

  // ── 去重：同类型+同维度+< dedupDistance → 返回已有（待合并） ──
  private findDup(type: LandmarkType, pos: LandmarkPos, dimension: string): Landmark | null {
    for (const l of this.landmarks) {
      if (l.type !== type || l.dimension !== dimension) continue;
      if (dist2(l.position, pos) < this.cfg.dedupDistance) return l;
    }
    return null;
  }

  // ── 淘汰策略（超上限时按文档优先级移除，绝不删保护类型） ──
  private evictIfNeeded(): void {
    if (this.landmarks.length <= this.cfg.maxLandmarks) return;
    const now = Date.now();
    const removable = this.landmarks.filter((l) => {
      if (l.type === 'home' && l.active) return false;
      if (PROTECTED_TYPES.includes(l.type)) return false;
      return true;
    });
    // 优先级：已回收死亡点 → 超 7 天死亡点 → poi → 其余废弃(active=false)
    const score = (l: Landmark): number => {
      if (l.type === 'death_spot' && l.retrieved) return 0;
      if (l.type === 'death_spot' && now - Date.parse(l.createdAt) > RETIRE_DAYS_MS) return 1;
      if (l.type === 'poi') return 2;
      if (!l.active) return 3;
      return 4;
    };
    removable.sort((a, b) => score(a) - score(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
    while (this.landmarks.length > this.cfg.maxLandmarks && removable.length > 0) {
      const victim = removable.shift();
      if (!victim) break;
      this.landmarks = this.landmarks.filter((l) => l.id !== victim.id);
    }
    this.save();
  }

  // ── 查询 API（引擎/上下文共用） ──
  getByType(type: LandmarkType, dimension?: string): Landmark[] {
    return this.landmarks.filter((l) => l.type === type && l.active && (!dimension || l.dimension === dimension));
  }
  getById(id: string): Landmark | null {
    return this.landmarks.find((l) => l.id === id) ?? null;
  }
  getNearest(type: LandmarkType, from: LandmarkPos, dimension?: string): Landmark | null {
    let best: Landmark | null = null;
    let bd = Infinity;
    for (const l of this.getByType(type, dimension)) {
      const d = dist2(l.position, from);
      if (d < bd) { bd = d; best = l; }
    }
    return best;
  }
  getHome(): Landmark | null {
    return this.landmarks.find((l) => l.type === 'home' && l.active) ?? null;
  }
  getUnretrievedDeathSpot(): Landmark | null {
    return this.landmarks.find((l) => l.type === 'death_spot' && l.active && !l.retrieved) ?? null;
  }
  all(): Landmark[] { return this.landmarks.slice(); }

  // ── 写入 API ──
  /** 新增/合并一个记忆点（返回 id）。note 为空且命中旧点 → 保留旧 note */
  addLandmark(type: LandmarkType, name: string, pos: LandmarkPos, dimension: string, note = ''): string {
    const dim = dimShort(dimension);
    const dup = this.findDup(type, pos, dim);
    const now = new Date().toISOString();
    if (dup) {
      if (note) dup.note = note;
      dup.updatedAt = now;
      this.save();
      return dup.id;
    }
    const lm: Landmark = {
      id: this.nextId(type),
      type, name, dimension: dim, position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
      createdAt: now, updatedAt: now, note, active: true, retrieved: false,
    };
    this.landmarks.push(lm);
    this.evictIfNeeded();
    this.save();
    return lm.id;
  }

  updateLandmark(id: string, updates: Partial<Omit<Landmark, 'id'>>): void {
    const l = this.getById(id);
    if (!l) return;
    Object.assign(l, updates, { updatedAt: new Date().toISOString() });
    this.save();
  }

  /** 废弃（不物理删除），note 追"（已废弃）" */
  deactivate(id: string): void {
    const l = this.getById(id);
    if (!l || !l.active) return;
    l.active = false;
    if (!l.note.includes('已废弃')) l.note = `${l.note}（已废弃）`.trim();
    l.updatedAt = new Date().toISOString();
    this.save();
  }

  /** 死亡点回收标记：把死亡点附近 radius 内未回收的标为已回收（death_recover 捡净后调） */
  markRetrievedNear(pos: LandmarkPos, radius = this.cfg.deathSpotRetireDistance): boolean {
    let hit = false;
    for (const l of this.landmarks) {
      if (l.type !== 'death_spot' || l.retrieved) continue;
      if (dist2(l.position, pos) <= radius) { l.retrieved = true; l.updatedAt = new Date().toISOString(); hit = true; }
    }
    if (hit) this.save();
    return hit;
  }

  // ── 场景封装 ──
  /** 安家/搬家：旧 active home 全废弃 → 新增 home。守卫：autoRecord.home 关闭时不自动写 */
  setHome(dim: string, pos: LandmarkPos, note = ''): string {
    for (const l of this.landmarks) {
      if (l.type === 'home' && l.active) this.deactivate(l.id);
    }
    return this.addLandmark('home', '家', pos, dim, note);
  }
  /** 死亡自动记录（guardian death 事件调） */
  recordDeath(dim: string, pos: LandmarkPos, note = ''): string | null {
    if (!this.cfg.autoRecord.death) return null;
    return this.addLandmark('death_spot', '死亡地点', pos, dim, note);
  }
  /** 进入新维度的第一个落脚点 → base（幂等：该维度已有 base 就不重复记） */
  recordBaseIfFirst(dim: string, pos: LandmarkPos): string | null {
    if (!this.cfg.autoRecord.portal) return null;
    const d = dimShort(dim);
    if (d === 'overworld' || this.getByType('base', d).length > 0) return null;
    return this.addLandmark('base', d === 'nether' ? '下界基地' : '末地基地', pos, d, '');
  }

  // ── Brain 上下文注入：最多 contextInjectLimit 条；当前维度优先、活跃优先、已回收标注 ──
  summaryForContext(currentDimension: string, limit?: number): string[] {
    const cap = limit ?? this.cfg.contextInjectLimit;
    const cur = dimShort(currentDimension);
    const lines: Landmark[] = [];
    const home = this.getHome();
    if (home) lines.push(home);
    for (const l of this.landmarks) {
      if (!l.active || l.type === 'home') continue;
      if (l.type === 'death_spot' && l.retrieved) continue; // 已回收的死亡点不注入
      lines.push(l);
    }
    const score = (l: Landmark): number => (l.dimension === cur ? 0 : 1) - (l.type === 'death_spot' ? 0.4 : 0);
    lines.sort((a, b) => score(a) - score(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const text = lines.slice(0, cap).map((l) => {
      const tag = l.type === 'death_spot' && l.retrieved ? '（已回收）' : '';
      const d = DIM_CN[l.dimension] ?? l.dimension;
      return `- ${l.name}在 (${l.position.x}, ${l.position.y}, ${l.position.z})，${d}${l.note ? `，${l.note}` : ''}${tag}`;
    });
    if (text.length === 0) return [];
    return text;
  }
}

// ── 模块级 registry（跨模块解耦取用，main 启动时 setGlobalLandmark） ──
let _global: LandmarkStore | null = null;
export function setGlobalLandmark(ls: LandmarkStore | null): void { _global = ls; }
export function getGlobalLandmark(): LandmarkStore | null { return _global; }
