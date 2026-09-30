import type mineflayer from 'mineflayer';
import type { McpServerManager } from './mcp-server';
import type { MemoryManager } from './memory';
import type { StatusCollector } from './status';
import type { BrainBridge } from './brain';
import type { AppConfig } from './config';
import { ok, fail } from './tools/helpers';
import { sleep, log, v3 } from './utils';

/** 自检单项结果 */
export interface CheckItem {
  name: string;
  status: '正常' | '跳过' | '禁止' | '错误';
  detail?: string;
}

/**
 * 系统自检：游戏内输入"自检"（或调用 self-check 工具），
 * 逐项测试各子系统，每项结果发到游戏聊天栏。
 */
export class SelfCheck {
  private bot: mineflayer.Bot;
  private memory: MemoryManager;
  private status: StatusCollector;
  private brain?: BrainBridge | null;
  private cfg: AppConfig;
  private guardianAttached: () => boolean;

  constructor(
    bot: mineflayer.Bot,
    memory: MemoryManager,
    status: StatusCollector,
    cfg: AppConfig,
    brain?: BrainBridge | null,
    guardianAttached?: () => boolean
  ) {
    this.bot = bot;
    this.memory = memory;
    this.status = status;
    this.cfg = cfg;
    this.brain = brain;
    this.guardianAttached = guardianAttached ?? (() => true);
  }

  async run(): Promise<CheckItem[]> {
    const results: CheckItem[] = [];
    const bot = this.bot;

    // 1. 游戏连接
    try {
      if (bot.entity && bot.entity.position) results.push({ name: '游戏连接', status: '正常', detail: `(${Math.round(bot.entity.position.x)}, ${Math.round(bot.entity.position.y)}, ${Math.round(bot.entity.position.z)})` });
      else results.push({ name: '游戏连接', status: '错误', detail: '无实体' });
    } catch (e) {
      results.push({ name: '游戏连接', status: '错误', detail: String(e) });
    }

    // 2. 状态系统
    try {
      const s = this.status.getStatus();
      results.push({ name: '状态系统', status: '正常', detail: `${s.world.dimension} ${s.world.game_mode}` });
    } catch (e) {
      results.push({ name: '状态系统', status: '错误', detail: String(e) });
    }

    // v17：自检的跳跃/移动测试会直接按键动身体 —— 若身体正被跟随/保命动作占用，
    // 两套控制打架（自检按一下、跟随又改回来），这里直接跳过并在结果里说明。
    const bodyRef = (bot as unknown as { __bodyController?: { current(): { owner: string | null; label: string } } }).__bodyController;
    const busyOwner = bodyRef?.current() ?? { owner: null, label: '' };

    // 3. 跳跃
    if (busyOwner.owner !== null) {
      results.push({ name: '跳跃工具', status: '跳过', detail: `身体被 ${busyOwner.owner}（${busyOwner.label || '任务'}）占用，不抢身体测试` });
    } else {
      try {
        bot.setControlState('jump', true);
        await sleep(500);
        bot.setControlState('jump', false);
        results.push({ name: '跳跃工具', status: '正常' });
      } catch (e) {
        results.push({ name: '跳跃工具', status: '错误', detail: String(e) });
      }
    }

    // 4. 移动
    if (busyOwner.owner !== null) {
      results.push({ name: '移动工具', status: '跳过', detail: `身体被 ${busyOwner.owner}（${busyOwner.label || '任务'}）占用，不抢身体测试` });
    } else {
      try {
        bot.setControlState('forward', true);
        await sleep(500);
        bot.setControlState('forward', false);
        results.push({ name: '移动工具', status: '正常' });
      } catch (e) {
        results.push({ name: '移动工具', status: '错误', detail: String(e) });
      }
    }

    // 5. 聊天发送
    try {
      bot.chat('（自检：聊天链路正常 ✅）');
      results.push({ name: '聊天工具', status: '正常' });
    } catch (e) {
      results.push({ name: '聊天工具', status: '错误', detail: String(e) });
    }
    await sleep(400);

    // 6. 背包读取
    try {
      const items = bot.inventory.items() as unknown as Array<{ name: string; count: number }>;
      results.push({ name: '背包工具', status: '正常', detail: `${items.length} 种物品` });
    } catch (e) {
      results.push({ name: '背包工具', status: '错误', detail: String(e) });
    }

    // 7. 方块读取
    try {
      const p = bot.entity.position;
      const b = bot.blockAt(v3(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z))) as unknown as { name?: string } | null;
      results.push({ name: '方块工具', status: '正常', detail: `脚下 ${b?.name ?? '?'}` });
    } catch (e) {
      results.push({ name: '方块工具', status: '错误', detail: String(e) });
    }

    // 8. 记忆系统
    try {
      const m = this.memory.data;
      results.push({ name: '记忆系统', status: '正常', detail: `${m.timeline.length} 条事件` });
    } catch (e) {
      results.push({ name: '记忆系统', status: '错误', detail: String(e) });
    }

    // 9. MCP 服务（本地 HTTP 探测）
    try {
      const resp = await fetch('http://127.0.0.1:3001/mcp', { method: 'GET' });
      results.push({ name: 'MCP 服务', status: '正常', detail: `HTTP ${resp.status}` });
    } catch (e) {
      results.push({ name: 'MCP 服务', status: '错误', detail: String(e) });
    }

    // 10. 大脑桥
    if (this.brain) {
      results.push({ name: '大脑桥', status: '正常', detail: `模式 ${this.cfg.brain.mode}` });
    } else {
      results.push({ name: '大脑桥', status: '跳过', detail: '未初始化' });
    }

    // 11. 生存守护
    if (this.guardianAttached()) {
      results.push({ name: '生存守护', status: '正常' });
    } else {
      results.push({ name: '生存守护', status: '跳过' });
    }

    // 12. 生活循环
    if (this.cfg.lifestyle.enabled) {
      results.push({ name: '生活循环', status: '正常', detail: '自主玩耍已开启' });
    } else {
      results.push({ name: '生活循环', status: '禁止', detail: 'config 未启用' });
    }

    return results;
  }

  /** 逐项发到游戏聊天栏 */
  async reportToChat(): Promise<void> {
    try {
      this.bot.chat('🔧 收到，开始自检！');
      await sleep(600);
      const results = await this.run();
      for (const r of results) {
        this.bot.chat(`· ${r.name} ${r.status}${r.detail ? `（${r.detail}）` : ''}`);
        await sleep(450);
      }
      const okCount = results.filter((r) => r.status === '正常').length;
      const skipCount = results.filter((r) => r.status === '跳过' || r.status === '禁止').length;
      const errCount = results.filter((r) => r.status === '错误').length;
      this.bot.chat(`✅ 自检完成：${okCount} 正常 / ${skipCount} 跳过 / ${errCount} 错误`);
      log('INFO', `自检完成: ${okCount} 正常 / ${skipCount} 跳过 / ${errCount} 错误`);
    } catch (e) {
      this.bot.chat('❌ 自检执行出错：' + String(e));
      log('ERROR', `自检失败: ${e}`);
    }
  }
}

/** 注册 self-check MCP 工具（AstrBot / 外部也能触发自检） */
export function registerSelfCheckTool(
  mcp: McpServerManager,
  getRunner: () => SelfCheck | null
): void {
  mcp.registerTool(
    'self-check',
    '运行系统自检：逐项测试游戏连接/状态/移动/背包/方块/记忆/MCP/大脑等子系统，返回每项结果',
    {},
    async () => {
      const sc = getRunner();
      if (!sc) return fail('自检器未就绪（bot 还没进游戏）');
      const results = await sc.run();
      const lines = results.map((r) => `· ${r.name} ${r.status}${r.detail ? `（${r.detail}）` : ''}`);
      return ok(lines.join('\n'));
    }
  );
}
