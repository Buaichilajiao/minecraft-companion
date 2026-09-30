import fs from 'fs';
import path from 'path';
import { atomicWriteJson, log } from './utils';

/**
 * 跨端记忆桥（Cross-Device Memory Bridge）
 * ─────────────────────────────────────────
 * 解决问题：AstrBot 按平台（QQ 的 default / 游戏回传的 webchat）分账对话记忆，
 * 玩家在 QQ 里和小白聊过、进游戏小白就"失忆"。
 *
 * 做法（接手指引既定方向）：不啃 AstrBot 内部记忆插件，另开一个独立的跨端记忆文件，
 * QQ 侧与游戏侧都通过 MCP 工具往里写、需要时读：
 *  - QQ 侧（小白）认识玩家 / 学到玩家偏好、约定时 → cross-memory-write
 *  - 游戏侧（brain.ts）建立会话时自动把该玩家的跨端记忆注入上下文
 *  - 游戏里发生的关键事也写回，QQ 侧 cross-memory-read 即可想起
 *
 * 人物主键 personId：优先用 QQ 号（最稳定）；未命中身份映射时退回 MC 名。
 * 依赖：仅 fs/path/utils，顶层可 new，跨重连存活。
 */

export interface CrossFact {
  text: string;
  /** 来源：qq=QQ 侧写入 / game=游戏侧写入 */
  source: 'qq' | 'game';
  t: number;
}

export interface CrossPerson {
  display_name?: string;
  /** 已知的 MC 角色名（便于反查） */
  mc_names: string[];
  facts: CrossFact[];
  updated: number;
}

export interface CrossMemoryData {
  version: 1;
  persons: Record<string, CrossPerson>;
}

/** 每人最多保留条数（超出丢最老） */
const MAX_FACTS = 40;
/** 单条文本最长（防超长撑爆上下文） */
const MAX_TEXT = 200;
/** 注入上下文时取最近 N 条 */
const CTX_FACTS = 12;

function defaultData(): CrossMemoryData {
  return { version: 1, persons: {} };
}

function normalize(raw: unknown): CrossMemoryData {
  const d = defaultData();
  if (!raw || typeof raw !== 'object') return d;
  const persons = (raw as Partial<CrossMemoryData>).persons;
  if (!persons || typeof persons !== 'object') return d;
  for (const [id, p] of Object.entries(persons)) {
    if (!p || typeof p !== 'object') continue;
    const facts = Array.isArray(p.facts)
      ? p.facts
          .filter((f) => f && typeof f.text === 'string')
          .map((f): CrossFact => ({
            text: String(f.text).slice(0, MAX_TEXT),
            source: f.source === 'game' ? 'game' : 'qq',
            t: Number(f.t) || Date.now(),
          }))
          .slice(-MAX_FACTS)
      : [];
    d.persons[id] = {
      display_name: typeof p.display_name === 'string' ? p.display_name : undefined,
      mc_names: Array.isArray(p.mc_names) ? p.mc_names.filter((x): x is string => typeof x === 'string').slice(-10) : [],
      facts,
      updated: Number(p.updated) || Date.now(),
    };
  }
  return d;
}

export class CrossMemory {
  data: CrossMemoryData;
  private file: string;

  constructor(file?: string) {
    this.file = file ?? path.join(__dirname, '..', 'data', 'cross-memory.json');
    this.data = this.load();
  }

  private load(): CrossMemoryData {
    try {
      if (fs.existsSync(this.file)) {
        return normalize(JSON.parse(fs.readFileSync(this.file, 'utf-8')));
      }
    } catch (e) {
      log('WARN', `跨端记忆读取失败，重建: ${e}`);
    }
    return defaultData();
  }

  save(): void {
    try {
      atomicWriteJson(this.file, this.data);
    } catch (e) {
      log('ERROR', `跨端记忆保存失败: ${e}`);
    }
  }

  /** 由 MC 名解析人物主键：命中身份映射用 QQ 号，否则用 MC 名本身 */
  resolvePersonId(mcName: string | undefined, identityMapping?: Record<string, string>): string {
    if (mcName && identityMapping && identityMapping[mcName]) return identityMapping[mcName];
    return mcName || 'unknown';
  }

  /** 写一条跨端记忆 */
  write(
    personId: string,
    text: string,
    source: 'qq' | 'game',
    opts?: { display_name?: string; mc_name?: string }
  ): void {
    const clean = String(text ?? '').trim().slice(0, MAX_TEXT);
    if (!clean || !personId) return;
    const now = Date.now();
    let p = this.data.persons[personId];
    if (!p) {
      p = { mc_names: [], facts: [], updated: now };
      this.data.persons[personId] = p;
    }
    if (opts?.display_name && !p.display_name) p.display_name = opts.display_name;
    if (opts?.mc_name && !p.mc_names.includes(opts.mc_name)) p.mc_names.push(opts.mc_name);
    // 同文本短时间内不重复记（去噪）
    const last = p.facts[p.facts.length - 1];
    if (last && last.text === clean && now - last.t < 60 * 1000) {
      p.updated = now;
      return;
    }
    p.facts.push({ text: clean, source, t: now });
    if (p.facts.length > MAX_FACTS) p.facts = p.facts.slice(-MAX_FACTS);
    p.updated = now;
    this.save();
  }

  /** 读取某人的全部跨端记忆（按时间正序） */
  read(personId: string): CrossPerson | null {
    return this.data.persons[personId] ?? null;
  }

  /**
 * 生成给大脑的跨端记忆上下文（人话，控制 token）。
 * personId 之外允许再传一个 mcName，用于在主名未命中时按 MC 名兜底。
 */
getContext(personId: string, mcName?: string): string {
    let p = this.data.persons[personId];
    if (!p && mcName) p = this.data.persons[mcName];
    if (!p || p.facts.length === 0) return '';
    const recent = p.facts.slice(-CTX_FACTS);
    const name = p.display_name || personId;
    const lines = recent.map((f) => {
      const d = new Date(f.t);
      const md = `${d.getMonth() + 1}/${d.getDate()}`;
      const where = f.source === 'qq' ? 'QQ' : '游戏';
      return `- [${md}·${where}] ${f.text}`;
    });
    return `关于 ${name} 的跨端记忆（我们在 QQ 和游戏里的共同经历，务必延续、别当陌生人）：
${lines.join('\n')}`;
  }
}
