import { z } from 'zod';
import { PNG } from 'pngjs';
import * as fs from 'fs';
import * as path from 'path';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { getBot, ok, fail } from './helpers';
import { v3 } from '../utils';
import { humanBlockName } from '../blocknames';

// 方块简化：单字符 + 顶视图颜色
const SIMPLIFY: Record<string, { c: string; color: [number, number, number] }> = {
  air: { c: '_', color: [255, 255, 255] },
  cave_air: { c: '_', color: [255, 255, 255] },
  void_air: { c: '_', color: [255, 255, 255] },
  grass_block: { c: 'g', color: [106, 170, 64] },
  dirt: { c: 'd', color: [134, 96, 67] },
  stone: { c: 's', color: [125, 125, 125] },
  cobblestone: { c: 's', color: [110, 110, 110] },
  oak_planks: { c: 'p', color: [176, 140, 90] },
  oak_log: { c: 'L', color: [102, 76, 44] },
  water: { c: 'w', color: [63, 118, 228] },
  sand: { c: 'S', color: [219, 207, 163] },
  gravel: { c: 'v', color: [130, 122, 116] },
  chest: { c: 'C', color: [196, 152, 60] },
  crafting_table: { c: 'T', color: [150, 110, 60] },
  furnace: { c: 'F', color: [90, 90, 90] },
  bed: { c: 'B', color: [200, 60, 60] },
  torch: { c: 't', color: [255, 200, 40] },
  oak_sapling: { c: 'o', color: [90, 160, 60] },
  tall_grass: { c: 'h', color: [140, 190, 90] },
  glass: { c: 'G', color: [200, 230, 240] },
  bookshelf: { c: 'b', color: [160, 110, 60] },
  flower_pot: { c: 'f', color: [180, 120, 80] },
};

function simp(name: string): { c: string; color: [number, number, number] } {
  const hit = SIMPLIFY[name];
  if (hit) return hit;
  // 颜色系方块（1.13+ 带颜色前缀，如 red_bed / white_wool）：按基底渲染
  if (name.endsWith('_bed')) return { c: 'B', color: [200, 60, 60] };
  if (name.endsWith('_wool')) return { c: 'W', color: [235, 235, 235] };
  return { c: '?', color: [180, 120, 220] };
}

/** 值得在观察结果里点名的功能方块（含任意颜色床） */
const INTERESTING = new Set([
  'chest', 'trapped_chest', 'ender_chest', 'barrel', 'crafting_table', 'furnace',
  'blast_furnace', 'smoker', 'anvil', 'enchanting_table', 'brewing_stand', 'torch',
  'lantern', 'campfire', 'soul_torch', 'soul_lantern', 'note_block', 'jukebox',
  'lectern', 'bookshelf', 'hopper', 'cauldron', 'composter', 'grindstone',
  'beehive', 'bee_nest', 'loom', 'stonecutter', 'cartography_table', 'smithing_table', 'fletching_table',
]);
function isInteresting(name: string): boolean {
  if (INTERESTING.has(name)) return true;
  return name.endsWith('_bed'); // 任意颜色床
}

export function registerVisionTools(mcp: McpServerManager, ctx: ToolContext): void {
  // 简化观察：以 bot 为中心扫周围方块，输出文本网格（LLM 直接读）
  mcp.registerTool(
    'observe',
    '视觉观察：以 bot 为中心扫描周围方块，输出三层文本网格图（地面层/一层/二层）+ 周围实体 + 特殊方块（箱子/工作台等）。像眼睛一样看周围环境',
    { radius: z.number().optional().describe('扫描半径，默认 8'), layers: z.number().optional().describe('扫描层数，默认 3') },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const R = Math.max(2, Math.min(24, Number(args.radius ?? 8)));
        const L = Math.max(1, Math.min(5, Number(args.layers ?? 3)));
        const p = bot.entity.position;
        const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);

        const layers: string[] = [];
        const specials = new Set<string>();
        for (let l = 0; l < L; l++) {
          let grid = `层${l}（y=${by + l}）:\n`;
          for (let dx = -R; dx <= R; dx++) {
            let row = '';
            for (let dz = -R; dz <= R; dz++) {
              const b = bot.blockAt(v3(bx + dx, by + l, bz + dz)) as unknown as { name?: string } | null;
              const nm = b?.name ?? '';
              if (nm && nm !== 'air' && isInteresting(nm)) {
                const h = humanBlockName(nm);
                specials.add(`${h}(${nm})@(${bx + dx},${by + l},${bz + dz})`);
              }
              const isSelf = dx === 0 && dz === 0 && l === 0;
              row += isSelf ? '@' : simp(nm || 'unknown').c;
            }
            grid += row + '\n';
          }
          layers.push(grid);
        }

        // 实体
        const entities: string[] = [];
        for (const e of Object.values(bot.entities)) {
          if (!e || !e.position || e === bot.entity) continue;
          const en = (e as unknown as { name?: string }).name ?? 'unknown';
          const t = (e as unknown as { type?: string }).type ?? '';
          const d = Math.round(e.position.distanceTo(bot.entity.position));
          if (d <= R + 4) entities.push(`${t === 'player' ? '玩家' : en}(${en}) 距离${d}格 @(${Math.floor(e.position.x)}, ${Math.floor(e.position.y)}, ${Math.floor(e.position.z)})`);
        }


        const out = [
          `位置: (${bx}, ${by}, ${bz}) 朝向yaw=${(bot.entity.yaw * 180 / Math.PI).toFixed(0)}°`,
          `图例: @=自己 _=空气 g=草方块 d=泥土 p=木板 L=原木 s=石头 w=水 C=箱子 T=工作台 F=熔炉 B=床(任意颜色) W=羊毛`,
          layers.join('\n'),
          entities.length ? `实体: ${entities.join('; ')}` : '实体: 无',
          specials.size ? `功能方块: ${[...specials].slice(0, 10).join('; ')}` : '',
        ].filter(Boolean);
        return ok(out.join('\n'));
      } catch (e) {
        return fail(String(e));
      }
    }
  );

  // 顶视截图：画成 PNG 存到工作区，供视觉模型查看
  mcp.registerTool(
    'look',
    '顶视图截图：以 bot 为中心俯视扫描周围方块，渲染成 PNG 图片并保存（含实体红点、敌对生物黑点）。配合视觉模型查看',
    { radius: z.number().optional().describe('扫描半径，默认 16'), save: z.boolean().optional().describe('是否保存文件，默认 true') },
    async (args) => {
      try {
        const bot = getBot(ctx);
        const R = Math.max(4, Math.min(32, Number(args.radius ?? 16)));
        const scale = 10;
        const size = R * 2 + 1;
        const png = new PNG({ width: size * scale, height: size * scale });
        const p = bot.entity.position;
        const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);

        // 顶视图：取每列最高非空气方块
        for (let dx = -R; dx <= R; dx++) {
          for (let dz = -R; dz <= R; dz++) {
            let color: [number, number, number] = [255, 255, 255];
            for (let dy = by + 8; dy >= by - 2; dy--) {
              const b = bot.blockAt(v3(bx + dx, dy, bz + dz)) as unknown as { name?: string } | null;
              if (!b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') continue;
              color = simp(b.name ?? 'unknown').color;
              break;
            }
            if (dx === 0 && dz === 0) color = [255, 0, 0]; // 自己=红
            for (let px = 0; px < scale; px++) {
              for (let pz = 0; pz < scale; pz++) {
                const ix = ((dx + R) * scale + px) * size * scale + (dz + R) * scale + pz;
                png.data[ix * 4] = color[0];
                png.data[ix * 4 + 1] = color[1];
                png.data[ix * 4 + 2] = color[2];
                png.data[ix * 4 + 3] = 255;
              }
            }
          }
        }

        // 实体点
        for (const e of Object.values(bot.entities)) {
          if (!e || !e.position || e === bot.entity) continue;
          const d = e.position.distanceTo(bot.entity.position);
          if (d > R) continue;
          const ex = Math.floor(e.position.x) - bx, ez = Math.floor(e.position.z) - bz;
          const en = (e as unknown as { name?: string }).name ?? '';
          const hostile = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'slime'].includes(en);
          const color = hostile ? [0, 0, 0] : [0, 0, 255];
          const cx = (ex + R) * scale + Math.floor(scale / 2);
          const cz = (ez + R) * scale + Math.floor(scale / 2);
          for (let px = -2; px <= 2; px++) {
            for (let pz = -2; pz <= 2; pz++) {
              if (Math.abs(px) + Math.abs(pz) > 3) continue;
              const ix2 = (cx + px) * size * scale + (cz + pz);
              if (ix2 >= 0 && ix2 < size * scale * size * scale) {
                png.data[ix2 * 4] = color[0];
                png.data[ix2 * 4 + 1] = color[1];
                png.data[ix2 * 4 + 2] = color[2];
                png.data[ix2 * 4 + 3] = 255;
              }
            }
          }
        }

        const dir = path.join(process.cwd(), 'screenshots');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `top_${bx}_${bz}_${Date.now()}.png`);
        fs.writeFileSync(file, PNG.sync.write(png));
        return ok(`顶视图已保存: ${file}\n红色=自己 蓝色=玩家/友好生物 黑色=敌对生物\n图例: g=草 d=泥 p=木板 L=原木 s=石 w=水 C=箱 T=工作台`);
      } catch (e) {
        return fail(String(e));
      }
    }
  );
}
