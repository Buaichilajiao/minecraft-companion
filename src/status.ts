import type mineflayer from 'mineflayer';
import { log, v3 } from './utils';

export interface StatusData {
  world: {
    server_version: string;
    difficulty: string;
    level_type: string;
    dimension: string;
    game_mode: string;
    mode_advice: string;
    time: { time_of_day: number; phase: string };
    weather: string;
    players: Array<{ name: string; game_mode: string; position: [number, number, number] | null }>;
    player_count: number;
  };
  self: {
    health: number;
    max_health: number;
    food: number;
    saturation: number;
    level: number;
    position: [number, number, number];
    biome: string;
    equipment: Record<string, string>;
    inventory: Array<{ name: string; count: number; slot: number }>;
    effects: Array<{ name: string; amplifier: number; duration_s: number }>;
  };
  surroundings: {
    nearby_blocks: string[];
    nearby_entities: Array<{ name: string; kind: string; distance: number; hostile: boolean; x?: number; y?: number; z?: number }>;
  };
  progress: {
    tech_unlocked: string[];
    current_goal: string;
    last_activity: string;
  };
}

const HOSTILE_MOBS = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned',
  'skeleton', 'stray', 'creeper', 'spider', 'cave_spider',
  'enderman', 'witch', 'slime', 'magma_cube', 'phantom',
  'blaze', 'ghast', 'wither_skeleton', 'zombified_piglin', 'piglin',
  'pillager', 'vindicator', 'evoker', 'ravager', 'vex', 'guardian', 'elder_guardian',
]);

function timePhase(t: number): string {
  // MC 时间 0=黎明, 6000=正午, 13000=日落, 18000=午夜
  if (t < 12000) return 'day';
  if (t < 13000) return 'dusk';
  if (t < 23000) return 'night';
  return 'dawn';
}

/** 状态系统：聚合世界/自身/环境/进度，供大脑决策与工具使用 */
export class StatusCollector {
  private bot: mineflayer.Bot;
  private progressGetter: () => { tech_unlocked: string[]; current_goal: string; last_activity: string };

  constructor(
    bot: mineflayer.Bot,
    progressGetter: () => { tech_unlocked: string[]; current_goal: string; last_activity: string }
  ) {
    this.bot = bot;
    this.progressGetter = progressGetter;
  }

  getStatus(): StatusData {
    const bot = this.bot;
    const mcData = (bot as unknown as { registry?: { effects?: Array<{ id: number; name: string }>; biomes?: Array<{ id: number; name: string }> } }).registry;
    try {
      // ---- world ----
      const game = bot.game || ({} as never);
      const gameAny = game as unknown as {
        levelType?: string; gameMode?: string; dimension?: string;
      };
      const players: StatusData['world']['players'] = [];
      for (const [name, p] of Object.entries(bot.players || {})) {
        if (name === bot.username) continue;
        const pe = p as { gameMode?: { gameMode?: string }; entity?: { position?: { x: number; y: number; z: number } } };
        players.push({
          name,
          game_mode: pe.gameMode?.gameMode ?? gameAny.gameMode ?? 'unknown',
          position: pe.entity?.position ? [pe.entity.position.x, pe.entity.position.y, pe.entity.position.z] : null,
        });
      }
      const timeOfDay = bot.time?.timeOfDay ?? bot.time?.day ?? 0;
      const difficultyNum = (game as unknown as { difficulty?: number | string }).difficulty;
      const DIFF_NAMES: Record<number, string> = { 0: 'peaceful(和平)', 1: 'easy(简单)', 2: 'normal(普通)', 3: 'hard(困难)' };
      const difficulty = typeof difficultyNum === 'number' ? (DIFF_NAMES[difficultyNum] ?? `未知(${difficultyNum})`) : String(difficultyNum ?? 'unknown');
      const gameMode = gameAny.gameMode ?? 'survival';
      const mode_advice = gameMode === 'creative'
        ? '创造模式：可直接用 creative-give 从创造物品库直取物品（协议实现，非命令），无需采集/合成'
        : '生存模式：需通过采集(dig/collect-tree/mine-ore)、合成(craft-item)、种植获取资源';
      const world: StatusData['world'] = {
        server_version: bot.version ?? 'unknown',
        difficulty,
        level_type: gameAny.levelType ?? 'unknown',
        dimension: ((bot.game as unknown as { dimension?: string }).dimension ?? 'overworld') as string,
        game_mode: gameMode,
        mode_advice,
        time: { time_of_day: Math.round(timeOfDay), phase: timePhase(timeOfDay % 24000) },
        weather: bot.isRaining ? 'rain' : 'clear',
        players,
        player_count: players.length + 1,
      };

      // ---- self ----
      const effects: StatusData['self']['effects'] = [];
      const effRaw = (bot.entity?.effects ?? {}) as unknown;
      const entries: Array<[string, unknown]> = effRaw instanceof Map
        ? Array.from(effRaw.entries()).map(([k, v]) => [String(k), v])
        : Array.isArray(effRaw)
          ? (effRaw as Array<{ id: number; amplifier?: number; duration?: number }>).map((e) => [String(e.id), e])
          : Object.entries(effRaw as Record<string, unknown>);
      for (const [id, eff] of entries) {
        const effAny = eff as { amplifier?: number; duration?: number };
        const name = mcData?.effects?.find((e) => e.id === Number(id))?.name ?? `effect_${id}`;
        effects.push({ name, amplifier: effAny.amplifier ?? 0, duration_s: Math.round((effAny.duration ?? 0) / 20) });
      }
      const equipment: Record<string, string> = {};
      const equipSlots = ['hand', 'offhand', 'head', 'torso', 'legs', 'feet'] as const;
      const equipArr = bot.entity?.equipment ?? [];
      equipSlots.forEach((slot, i) => {
        const item = equipArr[i] as { name?: string } | undefined;
        equipment[slot] = item?.name ?? '';
      });
      const invItems = bot.inventory?.items?.() ?? [];
      const biomeRaw = (bot.entity as unknown as { biome?: unknown })?.biome;
      const biomeName = typeof biomeRaw === 'string'
        ? biomeRaw
        : mcData?.biomes?.find((b) => b.id === biomeRaw)?.name ?? 'unknown';
      const self: StatusData['self'] = {
        health: Math.round(bot.health ?? 20),
        max_health: 20,
        food: Math.round(bot.food ?? 20),
        saturation: Math.round((bot.foodSaturation ?? 20) * 10) / 10,
        level: Math.round(bot.experience?.level ?? 0),
        position: bot.entity?.position
          ? [Math.round(bot.entity.position.x), Math.round(bot.entity.position.y), Math.round(bot.entity.position.z)]
          : [0, 0, 0],
        biome: biomeName,
        equipment,
        inventory: invItems.map((it) => ({ name: (it as { name?: string }).name ?? 'unknown', count: (it as { count?: number }).count ?? 0, slot: (it as { slot?: number }).slot ?? -1 })),
        effects,
      };

      // ---- surroundings ----
      const nearbyBlocks: string[] = [];
      try {
        const pos = bot.entity.position;
        const samples = [
          [0, -1, 0], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1],
          [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
        ];
        for (const [dx, dy, dz] of samples) {
          const b = bot.blockAt(v3(pos.x + dx, pos.y + dy, pos.z + dz));
          if (b?.name && !nearbyBlocks.includes(b.name)) nearbyBlocks.push(b.name);
          if (nearbyBlocks.length >= 8) break;
        }
      } catch {
        /* ignore */
      }
      const nearbyEntities: StatusData['surroundings']['nearby_entities'] = [];
      try {
        const pos = bot.entity.position;
        for (const [id, ent] of Object.entries(bot.entities || {})) {
          if (Number(id) === bot.entity.id) continue;
          const e = ent as { name?: string; kind?: string; position?: { x: number; y: number; z: number }; type?: string };
          const dist = e.position ? Math.round(Math.hypot(e.position.x - pos.x, e.position.y - pos.y, e.position.z - pos.z)) : 9999;
          if (dist > 32) continue;
          const name = e.name ?? e.type ?? 'unknown';
          nearbyEntities.push({
            name,
            kind: e.kind ?? 'unknown',
            distance: dist,
            hostile: HOSTILE_MOBS.has(name),
            x: e.position ? Math.round(e.position.x) : undefined,
            y: e.position ? Math.round(e.position.y) : undefined,
            z: e.position ? Math.round(e.position.z) : undefined,
          });
        }
        nearbyEntities.sort((a, b) => a.distance - b.distance);
      } catch {
        /* ignore */
      }

      const progress = this.progressGetter();
      return { world, self, surroundings: { nearby_blocks: nearbyBlocks, nearby_entities: nearbyEntities }, progress };
    } catch (e) {
      log('ERROR', `状态收集失败: ${e}`);
      return {
        world: { server_version: bot.version ?? 'unknown', difficulty: 'unknown', level_type: 'unknown', dimension: 'unknown', game_mode: 'unknown', mode_advice: '', time: { time_of_day: 0, phase: 'unknown' }, weather: 'unknown', players: [], player_count: 1 },
        self: { health: 20, max_health: 20, food: 20, saturation: 20, level: 0, position: [0, 0, 0], biome: 'unknown', equipment: {}, inventory: [], effects: [] },
        surroundings: { nearby_blocks: [], nearby_entities: [] },
        progress: this.progressGetter(),
      };
    }
  }
}
