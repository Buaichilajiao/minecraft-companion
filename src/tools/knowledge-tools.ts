import { z } from 'zod';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { ok, fail } from './helpers';
import {
  BLOCKS, addPendingKnowledge, listPending, clearPending, readBlock, writeBlock,
  type KnowledgeBlock,
} from '../knowledge';

/**
 * 知识库工具（知识管道 v1）
 * ──────────────────────────────────────────────
 * knowledge-add     ：把一条可迁移规律暂存进待整理池（离线整理时再归入板块）
 * knowledge-read    ：读某板块当前攻略全文，让大脑执行前先查"这板块该怎么做"
 * knowledge-pending ：看待整理池里攒了几条待归类知识点
 * knowledge-summary ：触发离线整理：待整理 → 按板块归类去重 → 重写进 .md → 清空
 *
 * 大脑侧分流标准（喊"记下来"时用）：
 *   可复用规律/识别规律/行为规则/机制解法 → knowledge-add（知识库）
 *   绑定具体时空/对象的事实（某地是某人的家、某处有某物）→ memory-write / landmarks
 */

export function registerKnowledgeTools(mcp: McpServerManager, ctx: ToolContext): void {
  // —— 暂存一条待归类知识点 ——
  mcp.registerTool(
    'knowledge-add',
    '在对话/观察中遇到「该记下来」的内容时，由你（大脑）先做语义判断再调用。判定标准：\n■ 可复用规律/识别规律/行为规则/机制解法（如"树=树叶在上木头在下"）→ 知识，走本工具，暂存待整理池。\n■ 绑定具体时空/对象的事实（如"这个坐标是某某的家"）→ 记忆，改调 memory-write，别走这里。\n■ 一段话同时含两者（杂糅）→ 拆成多条：知识那条走本工具，记忆那条走 memory-write，分别调。\nblock 可预设板块(生存/创造/建造/跑酷/PVP)，kind 标注类型(rule行为规则/mechanism机制/knowhow玩法经验)。',
    {
      content: z.string().describe('规律内容，一句话，如：树=树叶在上木头在下；玩家房子不能挖'),
      block: z.enum(BLOCKS as unknown as [string, ...string[]]).optional().describe('归属板块：生存/创造/建造/跑酷/PVP，留给离线整理判断可略'),
      kind: z.enum(['rule', 'mechanism', 'knowhow']).optional().describe('规律类型：rule=行为/识别规则 mechanism=机制解法 knowhow=玩法经验'),
      source: z.string().optional().describe('来源，如玩家名，默认"玩家"'),
      raw: z.string().optional().describe('玩家原话（离线整理理解语境用）'),
    },
    async (args) => {
      try {
        addPendingKnowledge({
          content: String(args.content),
          block: (args.block as KnowledgeBlock) || undefined,
          kind: (args.kind as 'rule' | 'mechanism' | 'knowhow') || undefined,
          source: String(args.source ?? '玩家'),
          raw: (args.raw as string) || undefined,
        });
        const n = listPending().length;
        return ok(`已记进知识库待整理池（当前共 ${n} 条），我会在下次空闲时归入对应板块。${args.block ? `初判归「${args.block}」。` : ''}`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // —— 读某个板块攻略 ——
  mcp.registerTool(
    'knowledge-read',
    '读知识库某板块的当前攻略全文（生存/创造/建造/跑酷/PVP）。做该类型行动前先查一下"这板块该怎么做、该注意什么"，避免踩坑。',
    { block: z.enum(BLOCKS as unknown as [string, ...string[]]).describe('板块名：生存/创造/建造/跑酷/PVP') },
    async (args) => {
      try {
        const b = args.block as KnowledgeBlock;
        const txt = readBlock(b);
        if (!txt) return ok(`「${b}」板块还没有沉淀知识。`);
        return ok(txt);
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // —— 待整理池概览 ——
  mcp.registerTool(
    'knowledge-pending',
    '查看知识库待整理池现有条目（玩家下线后会触发离线整理归入板块）。',
    {},
    async () => {
      try {
        const list = listPending();
        if (list.length === 0) return ok('待整理池是空的。');
        return ok(JSON.stringify(list.map((x) => ({ content: x.content, block: x.block, kind: x.kind, source: x.source })), null, 2));
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // —— 触发离线整理 ——
  mcp.registerTool(
    'knowledge-summary',
    '触发知识库离线整理：把待整理池里的知识点按板块归类去重，归纳重写进对应 .md 攻略，并清空待整理。一般由"玩家下线"自动触发；玩家在线时也可手动调一次。',
    {},
    async () => {
      try {
        if (listPending().length === 0) return ok('待整理池是空的，无需整理。');
        const result = await runOfflineSummary();
        return ok(result);
      } catch (e) {
        return fail(String(e));
      }
    }
  );
}

/**
 * 默认离线归纳器（非大脑版，可靠可复现）：
 * 按板块分桶 → 累积到该板块现有 md 的小节下 → 覆盖写回。
 */
export async function runOfflineSummary(): Promise<string> {
  const items = listPending();
  if (items.length === 0) return '待整理池是空的，无需整理。';

  // 按板块分桶
  const buckets = new Map<KnowledgeBlock, typeof items>();
  for (const it of items) {
    const b = it.block ?? guessBlock(it);
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b)!.push(it);
  }

  let added = 0;
  for (const [block, list] of buckets) {
    let body = readBlock(block).trimEnd();
    const lines = body.split('\n');
    for (const it of list) {
      const line = `- ${it.content}${it.source ? `（来源：${it.source}）` : ''}${it.kind ? `［${kindLabel(it.kind)}］` : ''}`;
      if (lines.includes(line)) continue; // 去重：已存在不重复写
      body += '\n' + line;
      lines.push(line);
      added++;
    }
    writeBlock(block, body + '\n');
  }
  const detail = [...buckets.entries()].map(([b, l]) => `${b}×${l.length}`).join('、');
  clearPending();
  return `离线整理完成：${items.length} 条待整理知识点 → ${detail}（新增 ${added} 条），待整理池已清空。`;
}

function kindLabel(k?: 'rule' | 'mechanism' | 'knowhow'): string {
  return k === 'rule' ? '规则' : k === 'mechanism' ? '机制' : k === 'knowhow' ? '经验' : '';
}

/** 简易兜底归类：按关键词判断该进哪块 */
function guessBlock(it: { content: string }): KnowledgeBlock {
  const c = it.content;
  const map: Array<[RegExp, KnowledgeBlock]> = [
    [/吃|饿|食物|包菜|苹果|牛排|熟|饱食|饥饿/, '生存'],
    [/血|伤害|打|打怪|击杀|僵尸|骷髅|苦力怕|末影|走位|闪避|对打|pvp/i, 'PVP'],
    [/跑|跳|冲刺|疾跑|跳台|跑酷|速度/, '跑酷'],
    [/放|建|搭|砌|房|屋子|墙|地板|天花板|箱|围/, '建造'],
    [/创造|give|指令|模式|飞|飞行/, '创造'],
  ];
  for (const [re, b] of map) if (re.test(c)) return b;
  return '生存';
}
