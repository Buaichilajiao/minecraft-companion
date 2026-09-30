/**
 * 情绪系统（蓝图第十节 · EmotionSystem）
 * ─────────────────────────────────────────────
 * valence  -100(正面) ←→ +100(负面)
 * arousal  -100(平静) ←→ +100(激动)
 * 情绪由事件触发 → 自然衰减 → 影响说话风格与行为倾向。
 * 纯状态类，不依赖 bot，事件由外部（EventBus / Guardian / 工具）喂入 react()。
 */

export interface EmotionTrigger {
  valence: number;
  arousal: number;
  label: string;
}

/** 情绪触发规则表（沿用蓝图定义） */
export const EMOTION_TRIGGERS: Record<string, EmotionTrigger> = {
  // ── 正面 ──
  found_diamond:    { valence: -60, arousal: 50, label: '兴奋' },
  built_house:      { valence: -40, arousal: 20, label: '满足' },
  player_helped_me: { valence: -50, arousal: 30, label: '感动' },
  killed_mob:       { valence: -20, arousal: 40, label: '爽快' },
  fished_rare:      { valence: -50, arousal: 60, label: '惊喜' },
  sunset:           { valence: -30, arousal: -20, label: '宁静' },
  got_gift:         { valence: -55, arousal: 40, label: '开心' },
  recovered_items:  { valence: -30, arousal: -20, label: '失而复得' },
  // ── 负面 ──
  almost_died:      { valence: 60, arousal: 70, label: '后怕' },
  lost_items:       { valence: 70, arousal: 40, label: '沮丧' },
  player_died:      { valence: 40, arousal: 30, label: '担心' },
  mob_nearby:       { valence: 30, arousal: 60, label: '紧张' },
  protect_done:     { valence: -40, arousal: 20, label: '安心' },   // 护住身旁玩家后释然（不邀功的落点）
  // 被玩家打的递进（困惑→委屈→难过，等级越高越往负面沉）
  hit_by_player_1:  { valence: 30, arousal: 50, label: '困惑' },
  hit_by_player_2:  { valence: 55, arousal: 40, label: '委屈' },
  hit_by_player_3:  { valence: 80, arousal: 30, label: '难过' },
  // PVP/脱战情绪
  pvp_agreed:       { valence: -40, arousal: 60, label: '兴奋' },
  escaped:          { valence: -30, arousal: -30, label: '庆幸' },
  stuck:            { valence: 50, arousal: 20, label: '烦躁' },
  bored:            { valence: 20, arousal: -40, label: '无聊' },
};

export interface EmotionState {
  valence: number;
  arousal: number;
  label: string;
}

/** 情绪对行为的修正系数 */
export interface BehaviorModifier {
  /** 心情好→>1 更敢冒险；心情差→<1 更保守（基准 1.0±，含性格冒险/胆小底色） */
  risk_tolerance: number;
  /** 激动→>1 话多；平静→<1 话少 */
  chat_frequency: number;
  /** 情绪平稳→更愿探索；极端→只想做熟悉的事 */
  exploration_drive: number;
  /** 捡掉落物倾向（性格收集癖，0~1） */
  lootGrabbing: number;
  /** 对怪物的攻击积极性（基准 1.0±，性格攻击性 + 情绪激动加成） */
  aggressionLevel: number;
  /** 当前情绪标签 */
  currentMoodLabel: string;
}

/** 静态性格特质（性格底色，构造时固定；战斗/生活层据此调制行为） */
export interface PersonalityTraits {
  adventurous: number; // 冒险倾向 0~1 → risk_tolerance 基线
  chatty: number;      // 话痨 0~1 → chat_frequency 基线
  cowardly: number;    // 胆小 0~1 → risk_tolerance 基线（降低）
  collector: number;   // 收集癖 0~1 → lootGrabbing
  aggressive: number;  // 对怪物攻击性 0~1 → aggressionLevel
  clumsy: number;      // 笨拙 0~1 → 预留行为扰动器
}

const DEFAULT_TRAITS: PersonalityTraits = {
  adventurous: 0.65, // 白白：偏敢探索
  chatty: 0.7,       // 偏话多
  cowardly: 0.3,
  collector: 0.4,
  aggressive: 0.55,
  clumsy: 0.15,
};

export class EmotionSystem {
  private valence = 0;
  private arousal = 0;
  private label = '平静';
  /** 静态性格特质（底色，跨情绪稳定存在） */
  private traits: PersonalityTraits;
  /** 最近情绪变化（含时间戳），供画像/记忆用 */
  private history: Array<{ t: number; label: string; valence: number; arousal: number }> = [];
  /** 情绪自然衰减率：每次 decay() 衰减的比例 */
  private decayRate: number;

  constructor(decayRate = 0.5, traits: Partial<PersonalityTraits> = {}) {
    this.decayRate = decayRate;
    this.traits = { ...DEFAULT_TRAITS, ...traits };
  }

  /** 对事件产生情绪反应 */
  react(event: string): void {
    const t = EMOTION_TRIGGERS[event];
    if (!t) return;
    this.valence = clamp(this.valence + t.valence, -100, 100);
    this.arousal = clamp(this.arousal + t.arousal, -100, 100);
    this.label = t.label;
    this.history.push({ t: Date.now(), label: t.label, valence: this.valence, arousal: this.arousal });
    if (this.history.length > 50) this.history = this.history.slice(-50);
  }

  /** 情绪自然衰减，回归平静 */
  decay(): void {
    this.valence *= 1 - this.decayRate / 100;
    this.arousal *= 1 - this.decayRate / 100;
    if (Math.abs(this.valence) < 10 && Math.abs(this.arousal) < 10) this.label = '平静';
  }

  /** 当前情绪状态（数值 + 标签） */
  getState(): EmotionState {
    return { valence: Math.round(this.valence), arousal: Math.round(this.arousal), label: this.label };
  }

  /** 情绪的自然语言描述（供大脑上下文） */
  getMoodDesc(): string {
    const s = this.getState();
    if (s.label !== '平静') return s.label;
    if (s.valence < -30) return '心情很好';
    if (s.valence > 30) return '心情不太好';
    if (s.arousal < -30) return '有点慵懒';
    return '平静';
  }

  /** 情绪对行为的影响系数（供 Lifestyle / Coop / Guardian 参考） */
  getBehaviorModifier(): BehaviorModifier {
    const { valence, arousal } = this;
    const t = this.traits;
    // 基准 1.0± 体系：性格底色 + 动态情绪叠加（adventurous 拉高敢冒险，cowardly 压低）
    const riskTolerance = 1.0 - valence / 200 + (t.adventurous - 0.5) * 0.4 - (t.cowardly - 0.3) * 0.3;
    const chatFrequency = 1.0 + arousal / 100 + (t.chatty - 0.5) * 0.3;
    return {
      risk_tolerance: riskTolerance,
      chat_frequency: chatFrequency,
      exploration_drive: 1.0 - Math.abs(valence) / 200,
      lootGrabbing: t.collector,
      // 对怪物攻击性：默认约 1.02，性格攻击 + 情绪激动时更主动追击
      aggressionLevel: 1.0 + arousal / 200 + (t.aggressive - 0.5) * 0.4,
      currentMoodLabel: this.label,
    };
  }

  /** 犯傻概率（笨拙性格 + 情绪激动加成），行为扰动器用 */
  getClumsiness(): number {
    return clamp(this.traits.clumsy + Math.abs(this.arousal) / 400, 0, 0.5);
  }

  /** 给大脑的一句话情绪总结 */
  summarize(): string {
    return `当前情绪：${this.getMoodDesc()}${this.label !== '平静' ? `（最近因为某件事${this.label}了）` : ''}`;
  }

  /** 最近情绪历史（供记忆/画像持久化） */
  getHistory(): Array<{ t: number; label: string; valence: number; arousal: number }> {
    return this.history;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
