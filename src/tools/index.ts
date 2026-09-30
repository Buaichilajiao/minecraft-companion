import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { registerPerceptionTools } from './perception';
import { registerVisionTools } from './vision';
import { registerMovementTools } from './movement';
import { registerFollowTools } from './follow';
import { registerSocialTools } from './social';
import { registerItemsTools } from './items';
import { registerCreativeTools } from './creative';
import { registerGatheringTools } from './gathering';
import { registerMiningCheckTools } from './mining-check';
import { registerBuildingTools } from './building';
import { registerInteractTools } from './interact';
import { registerSchematicTools } from './schematic';
import { registerFarmingTools } from './farming';
import { registerSurvivalTools } from './survival';
import { registerCombatTools } from './combat';
import { registerMemoryTools } from './memory-tools';
import { registerKnowledgeTools } from './knowledge-tools';
import { registerGoalsTools } from './goals';
import { registerCrosshairTools } from './crosshair';
import { registerTasklistTools } from './tasklist-tools';
import { registerCrossMemoryTools } from './cross-memory-tools';
import { ActionExecutor } from '../actions/executor';

/**
 * 注册全部工具模块（17 个）。顺序 = LLM 看到的工具列表顺序，按使用频率/语义分组：
 * 感知(状态/查找) → 视觉(观察/截图) → 移动 → 跟随 → 社交 → 物品(查/装/合/熔/箱) → 创造供给
 * → 采集 → 建造 → 交互(按按钮/门/拉杆) → 图纸 → 农耕 → 生存(吃/睡) → 战斗 → 记忆 → 目标 → 量具(跑酷 M0)
 */
export function registerAllTools(mcp: McpServerManager, ctx: ToolContext): number {
  // L3 动作层单例：工具层只做薄声明，原子动作统一走 ActionExecutor 流水线（ARCHITECTURE.md）
  const executor = new ActionExecutor(ctx);
  registerPerceptionTools(mcp, ctx);  // get-state, find-blocks, find-entity, get-block-info
  registerVisionTools(mcp, ctx);      // observe, look
  registerMovementTools(mcp, ctx);    // move-to, move-direction, jump, look-at, fly-to
  registerFollowTools(mcp, ctx);      // follow-player, stop-follow
  registerSocialTools(mcp, ctx);      // send-chat, read-chat
  registerItemsTools(mcp, ctx);       // find-item, equip-item, craft-item, smelt-batch, chest-*, drop-item
  registerCreativeTools(mcp, ctx);    // creative-give
  registerGatheringTools(mcp, ctx, executor);  // dig-block（→ L3）, collect-tree, mine-ore, pickup-item
  registerMiningCheckTools(mcp, ctx);   // check-harvest（挖前测工具能否掉落）, check-drop（挖后核对掉落物归属）
  registerBuildingTools(mcp, ctx, executor);  // place-block（→ L3）, build-shelter
  registerInteractTools(mcp, ctx, executor);   // press-block（→ L3）
  registerSchematicTools(mcp, ctx);   // build-schem
  registerFarmingTools(mcp, ctx);     // till-land, plant-seed, harvest, fish, breed-animal
  registerSurvivalTools(mcp, ctx);    // eat, sleep
  registerCombatTools(mcp, ctx, executor);     // attack-entity（→ L3）, pvp-*
  registerMemoryTools(mcp, ctx);      // memory-read, memory-write
  registerKnowledgeTools(mcp, ctx);   // knowledge-add, knowledge-read, knowledge-pending, knowledge-summary（知识管道）
  registerGoalsTools(mcp, ctx);       // get-goals（set-goal 已并入 memory-write）
  registerCrosshairTools(mcp, ctx);   // crosshair, check-reach（仿客户端准星·动作前可达性预检）
  registerTasklistTools(mcp, ctx);    // tasklist-create/get/list/set/step（mc-task-flow 长期任务落盘）
  registerCrossMemoryTools(mcp, ctx); // cross-memory-write/read（QQ↔游戏跨端记忆桥）
  return 21;
}
