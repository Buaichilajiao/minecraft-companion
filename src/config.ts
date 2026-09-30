import fs from 'fs';
import path from 'path';
import { DEFAULT_LANDMARK_CONFIG, type LandmarkConfig } from './landmark';

export interface MCConfig {
  host: string;
  port: number;
  version?: string;
  username: string;
  auth: 'offline' | 'yggdrasil' | 'microsoft' | 'mojang';
  password?: string;
  authServer?: string;
}

export interface BrainConfig {
  mode: 'astrbot';          // 只走 AstrBot 桥（bot 本身不带脑子，脑子在 AstrBot 侧）
  baseUrl: string;
  apiKey: string;
  sessionId: string;
  model?: string;
  timeoutMs: number;
}

/**
 * 身份体系（主人权限层 + 身份映射认人层，两条正交的轴）。
 *
 * 主人（master）= 一个"人"，对 bot 拥有最高操作权限（指令优先级最高，可覆盖其他人）。
 *   一个人可以有多个 QQ（qqIds）和多个 MC 账号（mcNames），都归这一个主人。
 * 认人层（identityMapping）= MC 名 -> QQ User ID，让游戏内外识别为同一人、记忆同源。
 * 未绑定的 MC 名 = 非主人（游戏里的其他人），能一起玩但指令让位给主人，走临时记忆（阶段3）。
 */
export interface IdentityConfig {
  /** 主人（权限层）：一个人的多个 QQ + 多个 MC 账号 */
  master: {
    qqIds: string[];
    mcNames: string[];
  };
  /** MC 玩家名 -> QQ User ID（认人层，一对一映射） */
  identityMapping: Record<string, string>;
}

/** 本地反射旁路（玩家指令毫秒级响应，不走 LLM） */
export interface ReflectConfig {
  enabled: boolean;
  /** 触发词正则 → 动作标签。命中标签需在硬编码映射里存在，否则返回 false 照常进大脑 */
  approach: Record<string, ReflectAction>;
}
export type ReflectAction = 'avoid' | 'danger_heed' | 'stop' | 'come' | 'follow';

/** 闲逛／在身边行为 */
export interface CompanionHangConfig {
  hangEnabled: boolean;
  hangRadius: number;      // 玩家在此格数内才触发闲逛
  hangSegmentSec: [number, number];
  hangTotalSec: [number, number];
  hangPauseSec: [number, number];
}

/** 主动感知玩家活动 + 心跳汇报（感知本地 → 决策走 brain.trigger → 动作走 MCP） */
export interface HeartbeatConfig {
  enabled: boolean;
  activitySpeakCooldownSec: number;   // 汇报玩家活动的最小间隔
  playerMoveThreshold: number;        // 玩家位移多少格算一次"活动"
  maxActivityPerScan: number;         // 每 tick 最多汇报条数
}

export interface AppConfig {
  mcpPort: number;
  mc: MCConfig;
  brain: BrainConfig;
  identity: IdentityConfig;
  companion: CompanionHangConfig;
  reflect: ReflectConfig;
  heartbeat: HeartbeatConfig;
  lifestyle: {
    enabled: boolean;          // 生活循环总开关（自主行动）
    commandWaitMs: number;      // 命令后等待窗口（默认 2 分钟）
    statusRefreshMs: number;    // 状态刷新间隔
    brainCooldownMs: number;    // 大脑决策冷却
  };
  /** 游戏记忆点系统（Landmark Memory）：独立 landmarks.json，与记忆/聊天上下文隔离 */
  landmarks: LandmarkConfig;
  /** 对话触发策略（v1.7.0 多人服防"逢聊必应"）：auto=≤1名其他玩家自动触发，≥2需点名；always=全部触发；name_only=永远需点名 */
  chat: {
    /** 自主说话总闸（陪伴层仿真聊天：天气/昼夜事件、受伤分阶段、战斗说话 全走 speakViaBrain 出口）。false=玩家不搭话就绝不自主调 LLM 说话 */
    autoSpeak: boolean;
    triggerMode: 'auto' | 'always' | 'name_only';
    triggerNames: string[];      // 点名别名（如 白白/小白），bot.username 恒参与匹配
    /** 点名后的对话上下文窗口秒数（v1.7.1）：窗口期内该玩家后续消息自动续聊无需再点名。0=关闭（每次都要点名） */
    contextWindowSec: number;
    /** 仿真受伤聊天（v1.8 分阶段+概率+边沿触发+三层冷却，替代固定预设复读） */
    injuryChat: {
      enabled: boolean;
      /** 血量阶段（above=该档血量下限%，判定按 pct≥above 从高到低取第一档；死亡重生固定 100%） */
      stages: {
        none: { above: number; chance: number };      // 无感 >80%：极偶尔嘟囔
        light: { above: number; chance: number };     // 轻伤 50-80%：随口一句
        heavy: { above: number; chance: number };     // 重伤 20-50%：明显反应
        critical: { above: number; chance: number };  // 濒死 <20%：紧张求助
      };
      /** 三层冷却（秒） */
      cooldowns: {
        globalSec: number;   // 全局：受伤语音 30s 内只触发一次
        stageSec: number;    // 阶段：同阶段触发后 10s 内不重复
        deathSec: number;    // 死亡：重生后 60s 内受伤不发声
      };
      /** 注入 Brain 的上下文模板，占位符 {subject}{stage}{hp}{cause}{teammates}{time}{dim}（仅事件描述，说话规则由出口统一拼接） */
      contextTemplate: string;
    };
    /** 仿真聊天 · 游戏事件系统（仿真聊天系统设计文档 §3：天气/昼夜/维度/饥饿） */
    eventChat: {
      enabled: boolean;
      weather: {
        rain: { probability: number; cooldownSec: number };      // 晴→雨
        thunder: { probability: number; cooldownSec: number };   // 雷暴(打雷)
        rainStop: { probability: number; cooldownSec: number };  // 雨→晴
      };
      dayNight: {
        night: { probability: number; cooldownSec: number };     // 天黑了（一整夜一次）
        day: { probability: number; cooldownSec: number };       // 天亮了（一整天一次）
      };
      dimension: {
        enterNether: { probability: number; cooldownSec: number };
        enterEnd: { probability: number; cooldownSec: number };
        leaveNether: { probability: number; cooldownSec: number };
        leaveEnd: { probability: number; cooldownSec: number };
      };
      hunger: {
        low: { probability: number; cooldownSec: number };       // 饥饿值<12(<6鸡腿)
        critical: { probability: number; cooldownSec: number };  // 饥饿值<4(<2鸡腿)
      };
      globalCooldownSec: number;  // 所有事件聊天共用（与受伤同源）
      maxReplyLength: number;     // 兼容字段（不再硬截断，出口按句拆多条发）
    };
  };
  /** P1 模式控制器/双引擎参数（loadConfig 自动补默认） */
  mode: {
    coopRadius: number;         // 玩家在此半径内 → 陪伴模式
    coopReturnRadius: number;   // 陪伴中玩家超此距离 → 跑回身边
    coopFollowRadius: number;   // 陪伴中玩家移动且超此距离 → 跟住
    modeHysteresisTicks: number; // 玩家出现需连续 N tick 确认切 coop（防抖）
    soloBoredomThreshold: number; // 单人无聊阈值
  };
  guardian: {
    leashRadius: number;        // 防走丢半径
    fleeHealth: number;         // 血量低于此值逃跑
    autoCombat: boolean;        // PVE 战斗反应层开关：受击/被敌对贴脸时自动进入战斗（默认 true）
    combatRange: number;        // 敌对生物进入多少格视为贴身威胁 → 主动迎击（默认 3.5）
    playerProtection: boolean;  // 玩家即时保护反射（默认 true）：玩家被怪打/怪逼近玩家时毫秒级去护，独立于 autoCombat
  };
  clientWhitelist?: string[];   // MCP 客户端白名单（v1.3.0 多方控制）；空数组 = 全部放行
}

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'config.json');

export const DEFAULT_CONFIG: AppConfig = {
  mcpPort: 3001,
  mc: {
    host: 'localhost',
    port: 25565,
    version: '1.21.1',
    username: '',
    auth: 'yggdrasil',
    authServer: 'https://littleskin.cn/api/yggdrasil',
    password: '',
  },
  brain: {
    mode: 'astrbot',
    baseUrl: 'http://127.0.0.1:6185',
    apiKey: '',
    sessionId: 'mc-companion',
    model: '',
    timeoutMs: 120000,
  },
  identity: {
    master: {
      qqIds: [],
      mcNames: [],
    },
    identityMapping: {},
  },
  companion: {
    hangEnabled: true,
    hangRadius: 12,
    hangSegmentSec: [8, 15],
    hangTotalSec: [20, 60],
    hangPauseSec: [1, 4],
  },
  reflect: {
    enabled: true,
    approach: {
      '躲开|快躲|闪开': 'avoid',
      '危险|救命|快跑': 'danger_heed',
      '停下|站住|别动|停一下': 'stop',
      '过来|快来|来我这|过来一下': 'come',
      '跟着我|跟我走|陪着我': 'follow',
    },
  },
  heartbeat: {
    enabled: true,
    activitySpeakCooldownSec: 30,
    playerMoveThreshold: 20,
    maxActivityPerScan: 1,
  },
  lifestyle: {
    enabled: true,
    commandWaitMs: 120000,
    statusRefreshMs: 5000,
    brainCooldownMs: 30000,
  },
  landmarks: DEFAULT_LANDMARK_CONFIG,
  chat: {
    autoSpeak: true,
    triggerMode: 'auto',
    triggerNames: ['白白', '小白'],
    contextWindowSec: 60,
    injuryChat: {
      enabled: true,
      stages: {
        none: { above: 80, chance: 0.03 },      // 无感：几乎沉默
        light: { above: 50, chance: 0.25 },     // 轻伤：偶尔随口一句
        heavy: { above: 20, chance: 0.6 },      // 重伤：明显反应
        critical: { above: 0, chance: 0.85 },   // 濒死：紧张求助
      },
      cooldowns: {
        globalSec: 90,
        stageSec: 20,
        deathSec: 60,
      },
      contextTemplate: '{subject}受伤了，当前阶段：{stage}（血量剩 {hp}%），伤害来源：{cause}。{teammates}，现在是{time}，在{dim}。',
    },
    eventChat: {
      enabled: true,
      weather: {
        rain: { probability: 0.12, cooldownSec: 600 },
        thunder: { probability: 0.18, cooldownSec: 600 },
        rainStop: { probability: 0.08, cooldownSec: 600 },
      },
      dayNight: {
        night: { probability: 0.25, cooldownSec: 900 },
        day: { probability: 0.2, cooldownSec: 900 },
      },
      dimension: {
        enterNether: { probability: 0.8, cooldownSec: 600 },
        enterEnd: { probability: 0.8, cooldownSec: 600 },
        leaveNether: { probability: 0.6, cooldownSec: 600 },
        leaveEnd: { probability: 0.6, cooldownSec: 600 },
      },
      hunger: {
        low: { probability: 0.12, cooldownSec: 900 },
        critical: { probability: 0.6, cooldownSec: 300 },
      },
      globalCooldownSec: 180,
      maxReplyLength: 15,
    },
  },
  mode: {
    coopRadius: 80,
    coopReturnRadius: 60,
    coopFollowRadius: 10,
    modeHysteresisTicks: 2,
    soloBoredomThreshold: 60,
  },
  guardian: {
    leashRadius: 120,
    fleeHealth: 6,
    autoCombat: true,
    combatRange: 3.5,
    playerProtection: true,
  },
  clientWhitelist: [],
};

export function loadConfig(): AppConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
    throw new Error(`配置文件已生成，请填写后重启: ${CONFIG_PATH}`);
  }
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const user = JSON.parse(raw) as Partial<AppConfig>;
  const cfg: AppConfig = {
    ...DEFAULT_CONFIG,
    ...user,
    mc: { ...DEFAULT_CONFIG.mc, ...(user.mc || {}) },
    brain: { ...DEFAULT_CONFIG.brain, ...(user.brain || {}) },
    identity: {
      master: {
        qqIds: [...(DEFAULT_CONFIG.identity.master?.qqIds ?? []), ...((user.identity || {}).master?.qqIds ?? [])],
        mcNames: [...(DEFAULT_CONFIG.identity.master?.mcNames ?? []), ...((user.identity || {}).master?.mcNames ?? [])],
      },
      identityMapping: {
        ...(DEFAULT_CONFIG.identity.identityMapping ?? {}),
        ...((user.identity || {}).identityMapping ?? {}),
      },
    },
    companion: {
      ...DEFAULT_CONFIG.companion,
      ...(user.companion || {}),
      hangSegmentSec: [...(DEFAULT_CONFIG.companion.hangSegmentSec as [number, number]), ...((user.companion || {}).hangSegmentSec || [])] as [number, number],
      hangTotalSec: [...(DEFAULT_CONFIG.companion.hangTotalSec as [number, number]), ...((user.companion || {}).hangTotalSec || [])] as [number, number],
      hangPauseSec: [...(DEFAULT_CONFIG.companion.hangPauseSec as [number, number]), ...((user.companion || {}).hangPauseSec || [])] as [number, number],
    },
    reflect: {
      ...DEFAULT_CONFIG.reflect,
      ...(user.reflect || {}),
      approach: { ...DEFAULT_CONFIG.reflect.approach, ...(((user.reflect || {}).approach) || {}) },
    },
    heartbeat: {
      ...DEFAULT_CONFIG.heartbeat,
      ...(user.heartbeat || {}),
    },
    lifestyle: { ...DEFAULT_CONFIG.lifestyle, ...(user.lifestyle || {}) },
    landmarks: {
      ...DEFAULT_LANDMARK_CONFIG,
      ...(user.landmarks || {}),
      autoRecord: { ...DEFAULT_LANDMARK_CONFIG.autoRecord, ...(((user.landmarks || {}).autoRecord) || {}) },
    },
    chat: {
      ...DEFAULT_CONFIG.chat,
      ...(user.chat || {}),
      injuryChat: {
        ...DEFAULT_CONFIG.chat.injuryChat,
        ...((user.chat || {}).injuryChat || {}),
        stages: {
          ...DEFAULT_CONFIG.chat.injuryChat.stages,
          ...(((user.chat || {}).injuryChat || {}).stages || {}),
        },
        cooldowns: {
          ...DEFAULT_CONFIG.chat.injuryChat.cooldowns,
          ...(((user.chat || {}).injuryChat || {}).cooldowns || {}),
        },
      },
      eventChat: {
        ...DEFAULT_CONFIG.chat.eventChat,
        ...(((user.chat || {}).eventChat || {}) as Partial<AppConfig['chat']['eventChat']>),
        weather: { ...DEFAULT_CONFIG.chat.eventChat.weather, ...(((user.chat || {}).eventChat || {}).weather || {}) },
        dayNight: { ...DEFAULT_CONFIG.chat.eventChat.dayNight, ...(((user.chat || {}).eventChat || {}).dayNight || {}) },
        dimension: { ...DEFAULT_CONFIG.chat.eventChat.dimension, ...(((user.chat || {}).eventChat || {}).dimension || {}) },
        hunger: { ...DEFAULT_CONFIG.chat.eventChat.hunger, ...(((user.chat || {}).eventChat || {}).hunger || {}) },
      },
    },
    mode: { ...(DEFAULT_CONFIG.mode || {}), ...(user.mode || {}) } as AppConfig['mode'],
    guardian: {
      ...DEFAULT_CONFIG.guardian,
      ...(user.guardian || {}),
      // 兼容旧键名（用户配置文件可能写 retreatHp/eatHp/maxDist/wanderRadius）
      ...(((user.guardian || {}) as Record<string, unknown>).retreatHp != null
        ? { fleeHealth: Number(((user.guardian || {}) as Record<string, unknown>).retreatHp) }
        : {}),
      ...(((user.guardian || {}) as Record<string, unknown>).maxDist != null
        ? { leashRadius: Number(((user.guardian || {}) as Record<string, unknown>).maxDist) }
        : {}),
    },
  };
  const missing: string[] = [];
  if (!cfg.mc.username || cfg.mc.username.includes('REPLACE')) missing.push('mc.username');
  if (!cfg.mc.auth || cfg.mc.auth !== 'offline' && !cfg.mc.password) missing.push('mc.password');
  if (missing.length) {
    throw new Error(`config/config.json 缺少字段: ${missing.join(', ')} — 可用 "node setup.js" 引导配置`);
  }
  return cfg;
}
