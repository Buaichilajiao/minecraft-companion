/**
 * 方块名工具（v1.8.1 颜色系方块修复）：
 * 1.13+ 之后带颜色的方块 id 是 <颜色>_<基底>（red_bed/white_wool...），
 * 代码/大脑直接按裸名 "bed"/"wool" 匹配永远找不到 → 统一做后缀通配 + 人类可读中文名。
 */

const COLOR_CN: Record<string, string> = {
  white: '白色', orange: '橙色', magenta: '品红色', light_blue: '淡蓝色', yellow: '黄色',
  lime: '黄绿色', pink: '粉红色', gray: '灰色', light_gray: '淡灰色', cyan: '青色',
  purple: '紫色', blue: '蓝色', brown: '棕色', green: '绿色', red: '红色', black: '黑色',
};

const BASE_CN: Record<string, string> = {
  bed: '床', wool: '羊毛', carpet: '地毯', concrete: '混凝土', concrete_powder: '混凝土粉末',
  terracotta: '陶瓦', glazed_terracotta: '带釉陶瓦', stained_glass: '染色玻璃', glass: '玻璃',
  stained_glass_pane: '染色玻璃板', glass_pane: '玻璃板', shulker_box: '潜影盒',
  candle: '蜡烛', banner: '旗帜', dye: '染料',
};

/** 无名后缀的中文（spruce_button → 云杉按钮，靠 suffix 表拼） */
const SUFFIX_CN: Record<string, string> = {
  button: '按钮', sign: '告示牌', wall_sign: '墙上告示牌', pressure_plate: '压力板',
  door: '门', trapdoor: '活板门', fence: '栅栏', fence_gate: '栅栏门', slab: '台阶',
  stairs: '楼梯', log: '原木', planks: '木板', sapling: '树苗', leaves: '树叶',
  torch: '火把', lantern: '灯笼', rail: '铁轨', boat: '船', anvil: '铁砧',
  flower_pot: '花盆',
};

const WOOD_CN: Record<string, string> = {
  oak: '橡木', spruce: '云杉', birch: '白桦', jungle: '丛林木', acacia: '金合欢',
  dark_oak: '深色橡木', mangrove: '红树', cherry: '樱花', bamboo: '竹', crimson: '绯红',
  warped: '诡异', polished_blackstone: '磨制黑石', stone: '石头',
};

/** 存在颜色变体的裸查询词：query=bed 应匹配任意 *_bed */
const COLOR_BASES = [
  'bed', 'wool', 'carpet', 'concrete', 'concrete_powder', 'terracotta', 'glazed_terracotta',
  'stained_glass', 'stained_glass_pane', 'shulker_box', 'candle', 'banner',
];

/**
 * 后缀族查询词（v1.8.2 修复）：
 * 裸词 'button' 在 1.13+ 里不存在——真实 id 是 spruce_button / stone_button / oak_wall_sign…
 * 之前精确匹配导致「三格外有按钮却报没找到」。这里给族名开后缀通配：query=button → 任意 *_button。
 */
const SUFFIX_FAMILIES = [
  'button', 'sign', 'wall_sign', 'pressure_plate', 'door', 'trapdoor', 'fence', 'fence_gate',
  'slab', 'stairs', 'log', 'planks', 'sapling', 'leaves', 'torch', 'lantern', 'rail',
  'glass_pane', 'boat', 'chest_boat', 'anvil', 'flower_pot', 'wall_hanging_sign',
];

/** find-blocks / observe 匹配：精确名（含 minecraft: 前缀）、颜色系后缀通配、族名后缀通配 */
export function matchesBlockName(name: string, query: string): boolean {
  const n = name.toLowerCase();
  const q = query.toLowerCase().replace(/^minecraft:/, '');
  if (!n || !q) return false;
  if (n === q) return true;
  if (n === `minecraft:${q}`) return true;
  // 裸名查询颜色系：'bed' → 'red_bed' / 'white_bed'
  if (COLOR_BASES.includes(q) && n.endsWith(`_${q}`)) return true;
  // 族名查询：'button' → 'spruce_button'；'sign' → 'oak_sign' + 'oak_wall_sign'
  if (SUFFIX_FAMILIES.includes(q) && n.endsWith(`_${q}`)) return true;
  return false;
}

/** 方块 id → 中文（red_bed → 红色床；spruce_button → 云杉按钮；wood 等普通方块原样返回） */
export function humanBlockName(name: string): string {
  const base = name.toLowerCase().split(':').pop() ?? name;
  // 颜色前缀 + 基底：red_bed / red_stained_glass / red_concrete_powder
  const seg = base.split('_');
  if (seg.length >= 2 && COLOR_CN[seg[0]]) {
    const rest = seg.slice(1).join('_');
    if (BASE_CN[rest]) return COLOR_CN[seg[0]] + BASE_CN[rest];
  }
  // 材质前缀 + 后缀族：spruce_button → 云杉按钮 / oak_wall_sign → 橡木墙上告示牌
  if (seg.length >= 2) {
    const isWallSign = seg.length >= 3 && seg[seg.length - 2] === 'wall' && seg[seg.length - 1] === 'sign';
    const suffix = isWallSign ? 'wall_sign' : seg[seg.length - 1];
    const cn = SUFFIX_CN[suffix];
    if (cn) {
      const head = seg.slice(0, seg.length - (isWallSign ? 2 : 1)).join('_');
      return head ? `${WOOD_CN[head] ?? head}${cn}` : cn;
    }
  }
  return BASE_CN[base] ?? base;
}
