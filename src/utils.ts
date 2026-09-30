import fs from 'fs';
import path from 'path';
import { Vec3 } from 'vec3';
import type mineflayer from 'mineflayer';

/** 快速创建 Vec3（mineflayer 需要 Vec3 类型而非普通对象） */
export const v3 = (x: number, y: number, z: number): Vec3 => new Vec3(x, y, z);

const LOG_DIR = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'app.log');
/** P2-5 日志轮转：单文件超过该阈值即轮转（保留最近 3 份） */
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_KEEP = 3;

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

/** size-based 轮转：app.log 超过阈值 → 依次后移为 .1/.2/.3，最旧删除 */
function rotateLogFile(): void {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    if (fs.statSync(LOG_FILE).size < LOG_MAX_BYTES) return;
    // 清掉最旧一份，把 .2→.3、.1→.2 逐级后移
    fs.rmSync(`${LOG_FILE}.${LOG_KEEP}`, { force: true });
    for (let i = LOG_KEEP - 1; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${LOG_FILE}.${i + 1}`);
    }
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    log('INFO', `app.log 已达 ${Math.round(LOG_MAX_BYTES / 1024 / 1024)}MB，已轮转`);
  } catch {
    /* 轮转失败不影响主流程 */
  }
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export function log(level: LogLevel, msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  // eslint-disable-next-line no-console
  console.log(line);
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf-8');
  } catch {
    /* 日志失败不影响主流程 */
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function safeJsonParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** 原子写 JSON：先写临时文件再 rename，防止损坏 */
export function atomicWriteJson(file: string, data: unknown): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

/** 用 indexOf 判断数组是否包含字符串（供去重） */
export function containsIgnoreCase(list: string[], target: string): boolean {
  const t = target.toLowerCase();
  return list.some((x) => x.toLowerCase() === t);
}

/** 坐标距离（忽略 Y 轴，供平面距离计算） */
export function flatDistance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
}

/** bot 当前维度短名：minecraft:the_nether → nether，minecraft:the_end → end，其余 overworld */
export function dimOf(bot: mineflayer.Bot | { game?: unknown } | null): 'overworld' | 'nether' | 'end' | 'unknown' {
  try {
    const raw = String((bot?.game as { dimension?: string } | undefined)?.dimension ?? 'minecraft:overworld');
    if (raw.includes('nether')) return 'nether';
    if (raw.includes('the_end')) return 'end';
    if (raw.includes('overworld')) return 'overworld';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
