import { z } from 'zod';
import type mineflayer from 'mineflayer';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { getBot, ok, fail } from './helpers';
import { v3 } from '../utils';

/** minecraft-data 方块/物品定义 shape（运行期从 bot.registry 读，避免硬编码） */
type BlockDef = {
  id: number;
  name: string;
  diggable?: boolean;
  hardness?: number;
  material?: string;
  /** 键 = 工具 item id（字符串），值 = true。有该字段 = 必须用这些工具挖才会掉落 */
  harvestTools?: Record<string, boolean>;
  /** 掉落物 item id 列表（空数组 = 正常挖不掉落，如玻璃） */
  drops?: number[];
};

type Registry = {
  blocksByName?: Record<string, BlockDef>;
  itemsByName?: Record<string, { id: number; stackSize?: number }>;
  items?: Record<number, { id: number; name: string }>;
};

function getRegistry(bot: mineflayer.Bot): Registry {
  return bot.registry as unknown as Registry;
}

/** 从 item entity 的 metadata 里读出掉落物内容（名称+数量）。
 * 兼容两种形态：prismarine-item 实例（有 name/count）或原始 notch slot（itemId/itemCount）。 */
function readItemStack(bot: mineflayer.Bot, metadata: unknown): { name: string; count: number } | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const items = getRegistry(bot).items;
  for (const v of Object.values(metadata as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const vv = v as Record<string, unknown>;
    if (typeof vv.name === 'string' && typeof vv.count === 'number') {
      return { name: vv.name, count: vv.count };
    }
    const id = (vv.itemId ?? vv.blockId ?? vv.id) as number | undefined;
    const count = (vv.itemCount ?? vv.count) as number | undefined;
    if (typeof id === 'number' && typeof count === 'number') {
      const nm = items?.[id]?.name;
      if (nm) return { name: nm, count };
    }
  }
  return null;
}

/** 掉落物 id 列表 → 物品名列表（未知 id 保留数字便于排查） */
function dropNamesOf(bot: mineflayer.Bot, def: BlockDef): string[] {
  const items = getRegistry(bot).items;
  return (def.drops ?? []).map((id) => items?.[id]?.name ?? `#${id}`);
}

/** 需要哪些工具（harvestTools 的 id → 工具名） */
function harvestToolNames(bot: mineflayer.Bot, def: BlockDef): string[] {
  const items = getRegistry(bot).items;
  return Object.keys(def.harvestTools ?? {})
    .map((id) => items?.[Number(id)]?.name)
    .filter((n): n is string => !!n);
}

export function registerMiningCheckTools(mcp: McpServerManager, ctx: ToolContext): void {
  // ── 检测 1：挖前判断「当前手持工具能否挖掉该方块并产生掉落物」 ──
  mcp.registerTool(
    'check-harvest',
    '挖方块【前】检测：当前手持工具（或空手）能不能挖掉指定方块、挖掉后会不会掉落物品。石头/各种矿石必须用镐子，空手或用错工具挖掉了也不掉东西（这就是"挖了石头没掉落"的原因）。',
    { x: z.number().describe('目标方块 X'), y: z.number().describe('目标方块 Y'), z: z.number().describe('目标方块 Z') },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const reg = getRegistry(bot);
        const block = bot.blockAt(v3(Number(args.x), Number(args.y), Number(args.z)));
        if (!block) return fail('读不到该坐标的方块（可能未加载，重试或换位置）');
        const name = (block as unknown as { name?: string }).name ?? '';
        const def = reg.blocksByName?.[name];
        if (!def) return fail(`registry 里没有方块 ${name}，无法判断`);

        const held = bot.heldItem as unknown as { name?: string } | null;
        const heldName = held?.name ?? '';
        const heldId = heldName ? reg.itemsByName?.[heldName]?.id : null;

        const drops = dropNamesOf(bot, def);
        const tools = harvestToolNames(bot, def);
        const needTool = tools.length > 0;

        let verdict: string;
        let detail: string;
        if (drops.length === 0) {
          verdict = '不掉落';
          detail = `${name} 正常挖掘本身不掉落任何物品（如玻璃；树叶/冰等需特殊方式另论）`;
        } else if (!needTool) {
          verdict = '会掉落';
          detail = `${name} 不需要特定工具，空手挖就会掉：${drops.join('、')}`;
        } else if (heldId != null && def.harvestTools?.[String(heldId)]) {
          verdict = '会掉落';
          detail = `手持 ${heldName} 满足挖掘要求，会掉：${drops.join('、')}`;
        } else {
          verdict = '不掉落';
          detail = heldId == null
            ? `空手挖 ${name} 不会掉落（需要 ${tools.join('/')}）`
            : `手持 ${heldName} 不是正确工具，挖掉 ${name} 不会掉落（需要 ${tools.join('/')}）`;
        }

        const lines = [
          `方块: ${name}${def.material ? ` (${def.material})` : ''}`,
          `手持: ${heldName || '（空手）'}`,
          `需要工具: ${needTool ? tools.join(' / ') : '无（空手即可）'}`,
          `结论: ${verdict}`,
          detail,
        ];
        return ok(lines.join('\n'));
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // ── 检测 2：挖后核对「附近掉落物是不是我刚挖的那块方块的」 ──
  mcp.registerTool(
    'check-drop',
    '挖方块【后】核对掉落物归属：传入刚挖的方块名+坐标，扫描附近掉落物，判断哪个是这块方块的掉落、哪个是别人挖的（别误捡）。',
    {
      block_type: z.string().describe('刚挖的方块名，如 stone / dirt / iron_ore'),
      x: z.number().describe('刚挖的方块 X（用于定位搜索范围）'),
      y: z.number().describe('刚挖的方块 Y'),
      z: z.number().describe('刚挖的方块 Z'),
      radius: z.number().optional().describe('搜索半径，默认 8 格'),
    },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const reg = getRegistry(bot);
        const name = String(args.block_type);
        const def = reg.blocksByName?.[name];
        if (!def) return fail(`registry 里没有方块 ${name}`);

        const expect = new Set(dropNamesOf(bot, def));
        const radius = Math.max(1, Math.min(Number(args.radius ?? 8), 32));
        const cx = Number(args.x), cy = Number(args.y), cz = Number(args.z);

        const found: Array<{ name: string; count: number; dist: number; pos: string; mine: boolean }> = [];
        for (const e of Object.values(bot.entities)) {
          if (e === bot.entity) continue;
          if ((e as unknown as { name?: string }).name?.toLowerCase() !== 'item') continue;
          const pos = e.position as unknown as { x: number; y: number; z: number };
          if (!pos) continue;
          const d = Math.hypot(pos.x - cx, pos.y - cy, pos.z - cz);
          if (d > radius) continue;
          const stack = readItemStack(bot, (e as unknown as { metadata?: unknown }).metadata);
          if (!stack) continue;
          found.push({
            name: stack.name,
            count: stack.count,
            dist: Math.round(d * 10) / 10,
            pos: `(${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})`,
            mine: expect.has(stack.name),
          });
        }

        if (found.length === 0) {
          return ok(`附近 ${radius} 格内没有任何掉落物。${name} 的预期掉落：${[...expect].join('、') || '（本身不掉落）'}`);
        }

        found.sort((a, b) => a.dist - b.dist);
        const lines: string[] = [`${name} 预期掉落: ${[...expect].join('、') || '（本身不掉落）'}`];
        lines.push(`附近掉落物（按距离）:`);
        for (const f of found) {
          lines.push(`${f.mine ? '✅' : '❌'} ${f.name} x${f.count} @${f.pos}（${f.dist} 格）${f.mine ? '' : ' ← 不是这块的，别捡'}`);
        }
        const mineCount = found.filter((f) => f.mine).length;
        if (mineCount === 0 && expect.size > 0) {
          lines.push(`⚠️ 没看到 ${name} 该掉的掉落物（可能是被提前捡走 / 掉落物消失 / 工具不对没掉）。`);
        }
        return ok(lines.join('\n'));
      } catch (e) {
        return fail(String(e));
      }
    }
  );
}
