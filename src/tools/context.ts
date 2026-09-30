import type mineflayer from 'mineflayer';
import type { MemoryManager } from '../memory';
import type { MemoryV2 } from '../memory-v2';
import type { StatusData } from '../status';
import type { BrainBridge } from '../brain';
import type { Lifestyle } from '../lifestyle';
import type { BodyController } from '../body-controller';
import type { EmotionSystem } from '../emotion';
import type { EventBus } from '../events';
import type { GazeController } from '../gaze';
import type { Guardian } from '../guardian';
import type { Companion } from '../companion';
import type { CrossMemory } from '../cross-memory';

/** 工具共享上下文 */
export interface ToolContext {
  bot: () => mineflayer.Bot | null;
  /** 重新登录（合成等窗口状态卡死、且无法本地恢复时用）；完成后 bot 已 spawn */
  reconnect?: () => Promise<void>;
  memory: MemoryManager;
  status: () => StatusData;
  brain?: BrainBridge;
  lifestyle?: Lifestyle;
  body: () => BodyController;
  chatHistory: () => Array<{ username: string; message: string; t: number }>;
  /** 情绪系统 getter（每次重连换新实例，必须经 getter 拿，别缓存引用） */
  emotion?: () => EmotionSystem | null;
  /** 事件总线 getter（同上，每轮 onSpawn 换新） */
  eventBus?: () => EventBus | null;
  /** 常驻注视系统 getter（同上，每轮 onSpawn 换新；动作要接管视角时 pause 它） */
  gaze?: () => GazeController | null;
  /** 守护层 getter（同上，每轮 onSpawn 换新；PVP 约定等 guardian 动作入口） */
  guardian?: () => Guardian | null;
  /** 陪伴层 getter（同上，每轮 onSpawn 换新；自主说话统一出口：身体检测→大脑生成台词） */
  companion?: () => Companion | null;
  /** 记忆层 v2（顶层单例，跨重连稳定，可直存） */
  memoryV2?: MemoryV2;
  /** 跨端记忆桥（顶层单例，QQ↔游戏共享） */
  crossMemory: CrossMemory;
}
