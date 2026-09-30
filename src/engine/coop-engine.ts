/**
 * CoopEngine（蓝图九节 · 双人陪伴引擎，玩家陪伴版）
 *
 * 职责：玩家在身边时的行为模式（裁决 3.2：陪伴语义 = 玩家在场）。
 *   - 玩家远离 → 跑回身边（returnRadius）
 *   - 玩家移动 → 保持跟住（followRadius 内跟着走，不掉队）
 *   - 玩家站桩 → 在他附近做点就近的活（钓鱼/补种），或安静待命
 *   - 聊天/问候不在此重复：由 Companion 事件 + 大脑主动对话负责（裁决去重）
 *
 * 纯决策引擎：不持有 bot/监听器；用两次 tick 的玩家位置差判断「在移动」。
 */
import type { MemoryManager } from '../memory';
import type { StatusData } from '../status';
import { EngineDecision, flatDist, hasItem, nearestPlayer } from './engine-types';

export interface CoopEngineOptions {
  /** 玩家超此距离 → 跑回身边 */
  returnRadius?: number;
  /** 玩家移动中且超出此距离 → 跟上去 */
  followRadius?: number;
  /** 玩家静止且在此距离内 → 可以就近活动/待命 */
  holdRadius?: number;
}

export class CoopEngine {
  private memory?: MemoryManager;
  private returnRadius: number;
  private followRadius: number;
  private holdRadius: number;
  /** 上轮各玩家位置（判断是否在移动） */
  private lastPos: Record<string, [number, number, number]> = {};
  private lastNearbyTaskAt = 0;

  constructor(memory?: MemoryManager, opts: CoopEngineOptions = {}) {
    this.memory = memory;
    this.returnRadius = opts.returnRadius ?? 60;
    this.followRadius = opts.followRadius ?? 10;
    this.holdRadius = opts.holdRadius ?? 5;
  }

  /** 玩家全部离开时调用，清缓存 */
  onPlayerGone(): void {
    this.lastPos = {};
  }

  decide(s: StatusData): EngineDecision {
    const p = nearestPlayer(s);
    if (!p) return { kind: 'none', reason: 'coop 模式但没有可见玩家' };

    const self = s.self.position;
    const d = flatDist(self, p.position);
    const prev = this.lastPos[p.name];
    const moving = prev
      ? flatDist(prev, p.position) > 1.5
      : false;
    this.lastPos[p.name] = p.position;

    // 0) 玩家身边有敌对生物 → 帮打（战斗支援优先于跟随/待命；P1.5）
    //    双距离判定：怪离 bot 近(≤12) 会主动收拾；或怪离玩家近(≤8) 即使离 bot 稍远，
    //    只要 bot 够得着(≤24) 也得冲过去护玩家 —— 别只顾自己脚边，玩家在挨打却不管。
    const BOT_R = 12, PLAYER_R = 8, REACH_R = 24;
    const threat =
      s.surroundings.nearby_entities.find((e) => {
        if (!e.hostile) return false;
        if (e.distance <= BOT_R) return true;                       // 离 bot 近
        if (e.x != null && e.y != null && e.z != null) {
          const dx = e.x - p.position[0], dy = e.y - p.position[1], dz = e.z - p.position[2];
          const dPlayer = Math.hypot(dx, dy, dz);
          if (dPlayer <= PLAYER_R && e.distance <= REACH_R) return true; // 离玩家近且 bot 够得着
        }
        return false;
      });
    if (threat) {
      return { kind: 'skill', skill: 'defend_player', reason: `${threat.name} 威胁到 ${p.name}（附近 ${Math.round(threat.distance)} 格），我去护住他/收拾它` };
    }
    // 1) 玩家走远 → 跑回身边（陪伴兜底：别把玩家弄丢）
    if (d > this.returnRadius) {
      return { kind: 'goto_player', pos: p.position, reason: `玩家走远了（${Math.round(d)} 格），跟过去` };
    }
    // 2) 玩家在移动 → 保持跟住
    if (moving && d > this.followRadius) {
      return { kind: 'goto_player', pos: p.position, reason: '玩家在走动，保持跟住' };
    }
    // 3) 玩家静止且贴得很近 → 就近找点事做，或安静陪着
    if (d <= this.holdRadius) {
      const now = Date.now();
      if (now - this.lastNearbyTaskAt > 120_000) {
        // 玩家在钓鱼/发呆时，bot 也在旁边做点近活更像陪伴
        const hasWater = s.surroundings.nearby_blocks.some((b) => b.includes('water'));
        if (hasItem(s, 'fishing_rod') && hasWater) {
          this.lastNearbyTaskAt = now;
          return { kind: 'skill', skill: 'fish', reason: '在玩家旁边钓会儿鱼' };
        }
        const hasSeed = s.self.inventory.some(
          (i) => i.name === 'wheat_seeds' || i.name === 'carrot' || i.name === 'potato'
        );
        if (hasSeed && s.surroundings.nearby_blocks.includes('farmland')) {
          this.lastNearbyTaskAt = now;
          return { kind: 'skill', skill: 'plant_farm', reason: '在玩家旁边补种' };
        }
      }
      return { kind: 'none', reason: '安静地陪在玩家身边' };
    }
    // 4) 距离适中且玩家没动 → 看着玩家，待命
    return { kind: 'none', reason: `待在玩家附近（${Math.round(d)} 格）` };
  }
}
