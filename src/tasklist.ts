import * as fs from 'fs';
import * as path from 'path';
import { safeJsonParse, atomicWriteJson, log } from './utils';

/**
 * 长期任务表（mc-task-flow SKILL 配套）
 * ─────────────────────────────────────────────────────────────
 * 位置：data/tasklist/<id>.json（每任务一个文件）
 * 结构见 skills/mc-task-flow/references/tasklist-schema.md
 *
 * 之前的断裂点：brain.ts 只「读」任务表摘要，但没有任何工具能「写」——
 * AstrBot 侧 computer 工具已关闭，大脑只能调 Minecraft MCP 工具，
 * 导致长期任务无法落盘。此模块补齐读写，供 tasklist-tools 暴露给大脑。
 */

export type TaskStatus = 'pending' | 'running' | 'paused' | 'done';

/**
 * 任务步「自动完成条件」（借鉴 Maicraft TaskTracker.checkCompletion）。
 * 可选字段，缺省则仍靠大脑手动调 tasklist-step 标记。
 * 一条 completion 满足即视为该步完成，系统会自动推进（无需大脑手动标记）。
 */
export interface StepCompletion {
  /** 背包里至少有 count 个名为 item 的物品 */
  item?: { item: string; count: number };
  /** 背包里曾经拥有的任一物品达到 count（不限于 item，用于"收集任意木头"类）*/
  any_item?: { count: number };
  /** 附近（周围 8 格采样）出现指定方块 */
  near_block?: string;
  /** 周围是否处于安全状态（无敌对生物）*/
  no_hostile?: boolean;
}

export interface TaskStep {
  desc: string;
  tools: string[];
  done: boolean;
  /** 可选：自动完成检测条件（借鉴 Maicraft TaskTracker）*/
  completion?: StepCompletion;
}

export interface TaskList {
  id: string;
  title: string;
  status: TaskStatus;
  current_step: number;
  created: number;
  updated: number;
  steps: TaskStep[];
}

/** 任务历史条目（借鉴 Maicraft TaskHistory：记录执行结果，避免重复踩坑）*/
export interface TaskHistoryEntry {
  id: string;         // 任务 id
  title: string;
  result: 'done' | 'replanned' | 'abandoned';
  /** 完成时停留在第几步（当前 step_index）*/
  ended_at_step: number;
  total_steps: number;
  /** 失败/放弃时的原因或卡点描述 */
  note?: string;
  t: number;
}

function taskDir(): string {
  return path.join(__dirname, '..', 'data', 'tasklist');
}

function taskFile(id: string): string {
  return path.join(taskDir(), `${id}.json`);
}

/** 规范化 id：转小写、非 [a-z0-9-] 换成连字符、去首尾连字符 */
function slugify(id: string): string {
  const s = String(id).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || `task-${Date.now()}`;
}

/** 读取单个任务（不存在返回 null） */
export function readTask(id: string): TaskList | null {
  const f = taskFile(slugify(id));
  if (!fs.existsSync(f)) return null;
  const raw = fs.readFileSync(f, 'utf-8');
  const t = safeJsonParse<TaskList | null>(raw, null);
  if (!t || typeof t !== 'object') return null;
  // 容错：steps 缺失时补空数组
  if (!Array.isArray(t.steps)) t.steps = [];
  return t as TaskList;
}

/** 列出全部任务（按 updated 降序） */
export function listTasks(): TaskList[] {
  const dir = taskDir();
  if (!fs.existsSync(dir)) return [];
  const out: TaskList[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.endsWith('.example.json')) continue;
    const id = f.slice(0, -'.json'.length);
    const t = readTask(id);
    if (t) out.push(t);
  }
  return out.sort((a, b) => b.updated - a.updated);
}

/** 创建任务表（已存在则拒绝，返回 null） */
export function createTask(input: {
  id: string;
  title: string;
  steps: Array<{ desc: string; tools?: string[]; completion?: StepCompletion }>;
  status?: TaskStatus;
}): TaskList | null {
  const id = slugify(input.id);
  const f = taskFile(id);
  if (fs.existsSync(f)) return null;
  const now = Date.now();
  const task: TaskList = {
    id,
    title: String(input.title || id),
    status: input.status ?? 'pending',
    current_step: 0,
    created: now,
    updated: now,
    steps: (input.steps ?? []).map((s) => ({ desc: String(s.desc), tools: s.tools ?? [], done: false, completion: s.completion })),
  };
  atomicWriteJson(f, task);
  return task;
}

/**
 * 更新任务表（部分字段或完整替换）。
 * patch 里可含任意字段：title / status / current_step / steps（整体替换，含 done 标记）。
 */
export function updateTask(id: string, patch: Partial<TaskList>): TaskList | null {
  const cur = readTask(id);
  if (!cur) return null;
  const next: TaskList = {
    ...cur,
    ...patch,
    id: cur.id, // id 不允许改
    updated: Date.now(),
  };
  atomicWriteJson(taskFile(cur.id), next);
  return next;
}

/**
 * 标记某一步完成 + 前移 current_step（外部只关心「这一步做完了」）。
 * stepIndex 从 0 起；自动把该步 done=true、current_step 推进到第一个未完成步。
 */
export function advanceTask(id: string, stepIndex: number): TaskList | null {
  const cur = readTask(id);
  if (!cur) return null;
  const steps = cur.steps.map((s, i) => (i === stepIndex ? { ...s, done: true } : s));
  // 找到第一个未完成步作为 current_step；全部完成则指向末尾并把状态置 done
  const nextIdx = steps.findIndex((s) => !s.done);
  const allDone = nextIdx === -1;
  const patch: Partial<TaskList> = {
    steps,
    current_step: allDone ? steps.length : nextIdx,
    status: allDone ? ('done' as TaskStatus) : cur.status,
  };
  const updated = updateTask(id, patch);
  // 任务完成时自动记一条历史（借鉴 Maicraft TaskHistory）
  if (updated && allDone) {
    recordTaskHistory({
      id: updated.id,
      title: updated.title,
      result: 'done',
      ended_at_step: updated.steps.length,
      total_steps: updated.steps.length,
    });
  }
  return updated;
}

/** 生成 brain.ts 上下文用的进行中/已暂停任务摘要（空串表示无） */
export function activeTaskSummary(): string {
  const active = listTasks().filter((t) => t.status === 'running' || t.status === 'paused');
  if (active.length === 0) return '';
  const lines = active.map((t) => {
    const total = t.steps.length;
    const idx = Math.min(t.current_step, Math.max(total - 1, 0));
    const cur = t.steps[idx]?.desc ?? '';
    const tag = t.status === 'paused' ? '已暂停' : '进行中';
    return `- [${tag}] ${t.title ?? t.id}${total > 0 ? `（第 ${Math.min(idx + 1, total)}/${total} 步${cur ? `：${cur}` : ''}）` : ''}`;
  });
  return `【进行中的任务】（来自 data/tasklist/，按 mc-task-flow 规则分步执行；玩家插话先回应玩家）\n${lines.join('\n')}`;
}

// ─────────── 任务历史（借鉴 Maicraft TaskHistory） ───────────

function historyFile(): string {
  return path.join(taskDir(), 'history.json');
}

/** 记录一条任务历史（任务 done/重规划/放弃时调用） */
export function recordTaskHistory(entry: Omit<TaskHistoryEntry, 't'>): void {
  const f = historyFile();
  const list: TaskHistoryEntry[] = safeJsonParse(fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : '', []);
  const item: TaskHistoryEntry = { t: Date.now(), ...entry };
  list.push(item);
  // 容量兜底：只留最近 100 条
  atomicWriteJson(f, list.slice(-100));
}

/** 读取某任务的历史（最近执行记录，供大脑"上次卡在哪"参考） */
export function readTaskHistory(id: string): TaskHistoryEntry[] {
  const f = historyFile();
  if (!fs.existsSync(f)) return [];
  const list: TaskHistoryEntry[] = safeJsonParse(fs.readFileSync(f, 'utf-8'), []);
  return list.filter((h) => h.id === slugify(id));
}

// ─────────── 任务步自动完成检测（借鉴 Maicraft TaskTracker.checkCompletion） ───────────

/**
 * 判断某一步是否满足「自动完成条件」。
 * 传入 StatusData 快照（lifecycle tick 里现成的那份），纯函数、无副作用。
 * 无 completion 条件的步返回 false（仍靠手动 tasklist-step）。
 */
export function checkStepCompletion(step: TaskStep, status: {
  self: { inventory: Array<{ name: string; count: number }> };
  surroundings: { nearby_blocks: string[]; nearby_entities: Array<{ hostile: boolean }> };
}): boolean {
  const c = step.completion;
  if (!c) return false;

  // 1. 指定物品达到数量
  if (c.item) {
    const owned = status.self.inventory.find((it) => it.name === c.item!.item)?.count ?? 0;
    if (owned < c.item.count) return false;
  }
  // 2. 任一物品达到数量（总拥有量口径）
  if (c.any_item) {
    const total = status.self.inventory.reduce((sum, it) => sum + it.count, 0);
    if (total < c.any_item.count) return false;
  }
  // 3. 附近出现指定方块
  if (c.near_block) {
    if (!status.surroundings.nearby_blocks.includes(c.near_block)) return false;
  }
  // 4. 周围无敌对生物
  if (c.no_hostile) {
    if (status.surroundings.nearby_entities.some((e) => e.hostile)) return false;
  }
  return true;
}

/**
 * 对一张 running 状态的任务表，检查当前步是否满足自动完成条件。
 * 满足则自动 advanceTask 推进（并可能间接置 done）。返回是否推进过。
 */
export function autoAdvanceRunningTask(task: TaskList, status: Parameters<typeof checkStepCompletion>[1]): boolean {
  if (task.status !== 'running') return false;
  const idx = Math.min(task.current_step, Math.max(task.steps.length - 1, 0));
  const step = task.steps[idx];
  if (!step || step.done) return false;
  if (!checkStepCompletion(step, status)) return false;
  advanceTask(task.id, idx);
  log('INFO', `任务 "${task.title}" 第 ${idx + 1} 步满足自动完成条件，已自动推进`);
  return true;
}
