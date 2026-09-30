/**
 * A1 M4 传送门前最后守卫（DESIGN_A1_NETHER.md §2/附录 B3）
 * 用户验收口径：铁剑 + 铁甲全套 + 食物 ≥64 + 打火石 + 金锭 ≥4。
 * 独立成无依赖模块：engine（nether-chain 决策）与 skills（gear_up 补给）共用，避免引擎↔技能环依赖。
 * 判定来源：穿着的（equipment）+ 背包（inventory）都算；返回缺项清单，全部满足 → ok。
 */
import type { StatusData } from '../status';

export function ensureNetherReady(s: StatusData): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const invHas = (frag: string) => s.self.inventory.some((i) => i.name.includes(frag));
  const eqHas = (slot: 'head' | 'torso' | 'legs' | 'feet' | 'hand', frag: string) => (s.self.equipment[slot] ?? '').includes(frag);
  const metal = ['iron_', 'diamond_', 'netherite_', 'golden_']; // 铁及以上（金可接受，能防猪灵）

  // 1) 武器：≥ 铁剑
  const hasSword = metal.some((m) => invHas(`${m}sword`) || eqHas('hand', `${m}sword`));
  if (!hasSword) missing.push('铁剑');

  // 2) 铁甲全套：头盔/胸甲/护腿/靴 四槽位（穿着或背包有铁级以上）
  const armorSlot: Array<['head' | 'torso' | 'legs' | 'feet', string]> = [
    ['head', 'helmet'], ['torso', 'chestplate'], ['legs', 'leggings'], ['feet', 'boots'],
  ];
  for (const [slot, piece] of armorSlot) {
    const have = metal.some((m) => invHas(`${m}${piece}`) || eqHas(slot, `${m}${piece}`));
    if (!have) missing.push(`铁${slot === 'head' ? '头盔' : slot === 'torso' ? '胸甲' : slot === 'legs' ? '护腿' : '靴子'}`);
  }

  // 3) 食物 ≥64（面包/熟肉/烤土豆等，按数量累计）
  const foodItems = ['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_cod', 'cooked_salmon', 'baked_potato', 'cooked_rabbit', 'apple', 'golden_apple'];
  const foodCount = s.self.inventory.filter((i) => foodItems.some((f) => i.name === f)).reduce((a, i) => a + i.count, 0);
  if (foodCount < 64) missing.push(`食物（现 ${foodCount}/64）`);

  // 4) 打火石（出门点火/回程点燃，必备）
  if (!invHas('flint_and_steel')) missing.push('打火石');

  // 5) 金锭若干（防猪灵 + 以物易物备用，下界安全感来源）
  const gold = s.self.inventory.filter((i) => i.name === 'gold_ingot').reduce((a, i) => a + i.count, 0);
  if (gold < 4) missing.push(`金锭（现 ${gold}/4）`);

  return { ok: missing.length === 0, missing };
}
