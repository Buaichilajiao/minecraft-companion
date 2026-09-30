import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJson, safeJsonParse, log } from './utils';

/**
 * MC 知识库（知识管道 v1）
 * ─────────────────────────────────────────────────────
 * 定位：可迁移规律（识别规律 / 行为规则 / 机制解法 / 玩法攻略）的沉淀池，
 *       与 memory（发生了啥/偏好/目标）、landmarks（地点坐标）严格区分。
 *
 * 判定分流（大脑据此决定把东西记哪）：
 *   · 可复用规律 / 识别规律 / 行为规则 / 机制 → 知识库（knowledge-add 进待整理）
 *   · 绑定具体时空/对象的事实（某地是某人的家、某处有某物）→ memory / landmarks
 *
 * 板块（五大类）：
 *   生存 / 创造 / 建造 / 跑酷 / PVP
 *
 * 存储：
 *   knowledge/<板块>.md    —— 人类可读攻略正文（离线整理后重写进去）
 *   knowledge/pending.json —— 游玩中暂存的"待归类知识点"，等离线整理消化
 *
 * 动态调整闭环：
 *   玩家/游戏内容 → knowledge-add（进 pending.json）
 *   → 玩家下线（在线玩家 0）触发 knowledge-summary 离线整理
 *   → 读 pending → 按板块归类去重 → 归纳重写进对应 .md → 清空 pending
 */

export const KNOWLEDGE_DIR = path.join(__dirname, '..', 'knowledge');
export const PENDING_FILE = path.join(KNOWLEDGE_DIR, 'pending.json');
export const BLOCKS = ['生存', '创造', '建造', '跑酷', 'PVP'] as const;
export type KnowledgeBlock = (typeof BLOCKS)[number];

/** 一条待归类知识点 */
export interface PendingKnowledge {
  id: string;
  /** 内容（玩家原话或大脑归纳的一句话） */
  content: string;
  /** 归属板块候选（供离线整理参考，引擎也自动兜底） */
  block?: KnowledgeBlock;
  /** 来源：玩家名字 / 大脑观察 / 系统 */
  source: string;
  /** 原文（玩家聊天原话，便于总结阶段理解语境） */
  raw?: string;
  /** 类型提示：rule=行为/识别规则 mechanism=机制解法 knowhow=玩法经验 */
  kind?: 'rule' | 'mechanism' | 'knowhow';
  t: number;
}

/** 当前有多少待整理 */
export function pendingCount(): number {
  try {
    if (!fs.existsSync(PENDING_FILE)) return 0;
    return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8')).length ?? 0;
  } catch {
    return 0;
  }
}

function ensureDir(): void {
  if (!fs.existsSync(KNOWLEDGE_DIR)) fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
}

/** 追加一条待归类知识点到 pending.json */
export function addPendingKnowledge(p: Omit<PendingKnowledge, 'id' | 't'>): PendingKnowledge {
  ensureDir();
  const list: PendingKnowledge[] = safeJsonParse(
    fs.existsSync(PENDING_FILE) ? fs.readFileSync(PENDING_FILE, 'utf-8') : '',
    []
  );
  const item: PendingKnowledge = {
    id: `k_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    t: Date.now(),
    ...p,
  };
  // 相同内容去重（同样的话玩家反复强调只留一条）
  const dup = list.some((x) => x.content === item.content);
  if (!dup) list.push(item);
  atomicWriteJson(PENDING_FILE, list);
  return item;
}

/** 读取全部待整理知识点 */
export function listPending(): PendingKnowledge[] {
  try {
    if (!fs.existsSync(PENDING_FILE)) return [];
    return safeJsonParse(fs.readFileSync(PENDING_FILE, 'utf-8'), []);
  } catch {
    return [];
  }
}

/** 清空待整理（离线整理消化后调用） */
export function clearPending(): void {
  atomicWriteJson(PENDING_FILE, []);
}

/** 读取某个板块 md 全文 */
export function readBlock(block: KnowledgeBlock): string {
  const p = path.join(KNOWLEDGE_DIR, `${block}.md`);
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
  } catch (e) {
    log('WARN', `读取板块 ${block} 失败: ${e}`);
    return '';
  }
}

/** 把板块 md 重写成新内容（离线整理归纳后的产物） */
export function writeBlock(block: KnowledgeBlock, content: string): void {
  ensureDir();
  const p = path.join(KNOWLEDGE_DIR, `${block}.md`);
  // 先备份旧版一份，误写可回滚
  try {
    if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.bak`);
  } catch { /* 备份失败不影响 */ }
  fs.writeFileSync(p, content, 'utf-8');
  log('INFO', `知识库板块 ${block}.md 已更新 (${content.length} 字符)`);
}