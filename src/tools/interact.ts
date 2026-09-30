import { z } from 'zod';
import type { McpServerManager } from '../mcp-server';
import type { ToolContext } from './context';
import { ok, fail } from './helpers';
import type { ActionExecutor } from '../actions/executor';

/**
 * 交互类工具（v25 · 玩家 9/12 提"我摁完按钮，你也摁嘛"）
 * 原子动作「按按钮/拉杆/开门」已收敛到 L3 ActionExecutor.press（ARCHITECTURE.md Phase 1），
 * 本文件只做薄声明：解析入参 → 调 executor → 包装 ok/fail。
 */
export function registerInteractTools(mcp: McpServerManager, ctx: ToolContext, executor: ActionExecutor): void {
  mcp.registerTool(
    'press-block',
    '走到指定坐标的方块旁并"右键使用"它：按钮(button)、拉杆(lever)、门(door)、活板门(trapdoor)、栅栏门(fence_gate)、压力板、唱片机、以及其他需要右键交互的方块。距离太远会先自己走过去再按',
    {
      x: z.number().describe('目标方块 X'),
      y: z.number().describe('目标方块 Y'),
      z: z.number().describe('目标方块 Z'),
    },
    async (args) => {
      const r = await executor.press({ x: Number(args.x), y: Number(args.y), z: Number(args.z) });
      return r.ok ? ok(r.message) : fail(r.message);
    }
  );
}
