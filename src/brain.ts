import type mineflayer from 'mineflayer';
import type { BrainConfig } from './config';
import type { ChatContextBuilder } from './chat-context';
import type { CrossMemory } from './cross-memory';
import { log } from './utils';
import { requestInterrupt } from './interrupt';
import { activeTaskSummary } from './tasklist';

export interface ChatEntry {
  username: string;
  message: string;
  t: number;
}

export interface BrainReply {
  text: string;
  raw: string;
  /** 已通过工具完成动作（如 send-chat 已发言，无文本也无需兜底） */
  acted?: boolean;
}

/** 不应承的工具：交流/感知/记忆类。其余(移动/挖掘/建造/战斗/睡觉等)视为执行动作 */
const NON_ACTION_TOOLS = new Set([
  'get-state', 'observe', 'look', 'find-blocks', 'find-entity', 'get-block-info', 'look-at',
  'send-chat', 'read-chat', 'find-item',
  'memory-read', 'memory-write', 'get-goals', 'self-check',
]);

/** 首个动作工具 → 引擎代发的应承语（玩家消息触发的任务流） */
const ACK_BY_TOOL: Record<string, string> = {
  'move-to': '好嘞，我这就过去！',
  'move-direction': '好嘞，我这就过去！',
  'fly-to': '好嘞，我这就飞过去！',
  'follow-player': '好嘞，我跟上你！',
  'sleep': '好，我去睡会儿。',
};
const DEFAULT_ACK = '收到！这就去办，办完跟你说。';

/** A 方案：应承延迟兜底窗口（ms）。大脑通常 1~2s 内会自己说话；超时仍无自然回复才代发 */
const ACK_DELAY_MS = 3000;

/**
 * MCP 通道断连时向玩家直报的文案（代替 LLM 脑补"卡了/缓一下"等虚假安抚）。
 * 走代码硬替换：只要流中出现 MCP session 不可用错误，最终回复强制换成这句实话。
 */
const MCP_DOWN_DIRECT_REPLY = '我跟大脑的连接刚断了一下，会自己重连，等我几秒～要是一直没反应，再喊我一次';

/**
 * 大脑桥：游戏聊天 ↔ 大脑。
 * bot 本身没有脑子，脑子在 AstrBot 侧：走 AstrBot /api/v1/chat。
 * AstrBot 侧已接入本项目的 MCP 工具并关闭 computer 工具（shell/fs/python），
 * 大脑只会用 Minecraft 工具。这里不直连任何大模型。
 */
export class BrainBridge {
  private cfg: BrainConfig;
  /** MC 名 -> QQ User ID 映射（身份认人层）。命中则游戏消息挂到对应 QQ 用户，记忆同源 */
  private identityMapping: Record<string, string>;
  /** 跨端记忆桥（QQ↔游戏共享），可能为空 */
  private crossMemory: CrossMemory | null;
  private botGetter: () => mineflayer.Bot | null;
  private history: ChatEntry[] = [];
  private queue: ChatEntry[] = [];
  private busy = false;
  private lastTrigger = 0;
  private minIntervalMs: number;
  /** P2-3 上下文组装器（完整上下文统一入口） */
  private chatCtx: ChatContextBuilder | null;

  /** 大脑回复就绪回调（文本） */
  onReply?: (reply: string, entry: ChatEntry) => void;
  /** 大脑开始处理回调（可用于置 busy 状态） */
  onThinking?: (entry: ChatEntry) => void;
  /** 情绪上下文（蓝图接线：只作语气参考，不干预决策） */
  onEmotionContext?: () => string;
  /** 未读事件上下文（蓝图接线：事件型"喊一嗓子"，消费后清空） */
  onEventsContext?: () => string;
  /** 记忆层上下文（蓝图六/9.2 接线：短期印象/熟悉地点/玩家画像/话题避免） */
  onMemoryContext?: () => string;

  constructor(
    cfg: BrainConfig,
    botGetter: () => mineflayer.Bot | null,
    minIntervalMs = 3000,
    /** P2-3 聊天上下文组装器（可选）：完整组装 world/self/player/事件/记忆喂给大脑 */
    chatCtx?: ChatContextBuilder,
    /** 身份映射（MC名 -> QQ User ID）。缺省用时 {} = 全部走默认 session */
    identityMapping?: Record<string, string>,
    /** 跨端记忆桥（QQ↔游戏共享）。注入游戏上下文，解决进游戏失忆 */
    crossMemory?: CrossMemory
  ) {
    this.cfg = cfg;
    this.identityMapping = identityMapping ?? {}
    this.crossMemory = crossMemory ?? null;
    this.botGetter = botGetter;
    this.minIntervalMs = minIntervalMs;
    this.chatCtx = chatCtx ?? null;
  }

  /** 记录一条游戏聊天（来自 bot.on('chat')） */
  addChat(username: string, message: string): void {
    this.history.push({ username, message, t: Date.now() });
    if (this.history.length > 100) this.history = this.history.slice(-100);
  }

  getHistory(): ChatEntry[] {
    return this.history;
  }

  /** 玩家消息入队并触发大脑 */
  enqueuePlayerMessage(username: string, message: string): void {
    this.queue.push({ username, message, t: Date.now() });
    // 积压保护：队列超过 5 条丢最老（防止玩家互聊/刷屏把回复拖到几分钟后）
    while (this.queue.length > 5) this.queue.shift();
    // ★ 玩家插话 → 请求中断当前正在执行的长动作（move-to/follow/寻路等会在下一检查点原地停下）
    //   大脑醒来后按 mc-task-flow 规则「先回应玩家、不再主动发起新动作」。
    requestInterrupt('玩家插话');
    void this.pump();
  }

  /** 主动触发大脑（自主行为/陪伴分享用），返回回复 */
  async trigger(text: string): Promise<string | null> {
    // 玩家消息正在处理时不抢 LLM（诊断 9.1 根因：trigger 绕过队列并发调用）
    if (this.busy) return null;
    const now = Date.now();
    if (now - this.lastTrigger < this.minIntervalMs) {
      await new Promise((r) => setTimeout(r, this.minIntervalMs - (now - this.lastTrigger)));
    }
    this.lastTrigger = Date.now();
    try {
      // P2-3：自主触发也走完整上下文（附当前世界/威胁/记忆，大脑才知道要不要开口/行动）
      const bot = this.botGetter();
      const ctxText = this.chatCtx?.build({ username: bot?.username ?? '系统', message: text, internal: true });
      const reply = await this.callBrain(ctxText ?? text);
      return reply?.text ?? null;
    } catch (e) {
      log('ERROR', `大脑调用失败: ${e}`);
      return null;
    }
  }

  private async pump(): Promise<void> {
    if (this.busy || this.queue.length === 0) return;
    const entry = this.queue.shift()!;
    this.busy = true;
    this.onThinking?.(entry);
    try {
      const bot = this.botGetter();
      const playerName = entry.username || (bot ? bot.username : '玩家');
      const context = this.buildContext(entry);
      log('INFO', `→ 大脑收到 [${playerName}]: ${entry.message}`);
      // 玩家消息：允许引擎在首个"执行动作"前代发应承（体验：先答应再干活）
      const reply = await this.callBrain(context, { playerName, allowAutoAck: true });
      if (reply?.text) {
        log('INFO', `← 大脑回复: ${reply.text}`);
        this.onReply?.(reply.text, entry);
      } else if (reply?.acted) {
        // 大脑已通过工具动作回复（如 send-chat 已把话发给玩家），无需兜底
        log('INFO', `← 大脑已通过工具回复（无文本），跳过兜底`);
      } else {
        // 玩家要求"不要预设对话"：大脑空输出时不再代发任何模板句，保持安静
        //（AC_K 应承机制也已停用）。避免玩家听到背稿式应答。
        log('WARN', `← 大脑无回复（超时/模型空输出），按玩家要求静默不背稿`);
      }
    } catch (e) {
      log('ERROR', `大脑处理失败: ${e}`);
      const bot = this.botGetter();
      bot?.chat('（我脑子卡了一下，你再说一遍？）');
    } finally {
      this.busy = false;
      if (this.queue.length > 0) void this.pump();
    }
  }

    /** 组装给大脑的上下文：P2-3 ChatContextBuilder 优先（完整 world/self/player/事件/记忆），未装配时回退旧拼接 */
  private buildContext(entry: ChatEntry): string {
    const full = this.chatCtx?.build(entry);
    const tasks = this.taskSummary();
    if (full) return tasks ? `${full}\n${tasks}` : full;
    // ── 旧路径（无 ChatContextBuilder 装配时兜底）──
    const bot = this.botGetter();
    const parts = [`[游戏内 ${entry.username} 对我说: "${entry.message}"]`];
    if (bot && bot.entity?.position) {
      const pos = bot.entity.position;
      parts.push(`我当前位于 (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)})。可用工具查看周围环境。`);
    }
    // 位置 → 记忆 → 情绪（语气参考）→ 未读事件（刚发生的世界动态）
    const mem = this.onMemoryContext?.();
    if (mem) parts.push(mem);
    const emo = this.onEmotionContext?.();
    if (emo) parts.push(emo);
    const evts = this.onEventsContext?.();
    if (evts) parts.push(evts);
    if (tasks) parts.push(tasks);
    return parts.join('\n');
  }

  /** 读取 data/tasklist/*.json，提炼进行中/已暂停任务摘要，喂给大脑（mc-task-flow SKILL 配套，复用 tasklist.ts） */
  private taskSummary(): string {
    return activeTaskSummary();
  }

private async callBrain(text: string, opts?: { playerName?: string; allowAutoAck?: boolean }): Promise<BrainReply | null> {
    return this.callBrainAstrbot(text, opts);
  }

  // ─────────── 模式 A：AstrBot 桥（默认） ───────────
  private async callBrainAstrbot(text: string, opts?: { playerName?: string; allowAutoAck?: boolean }): Promise<BrainReply | null> {
    const url = `${this.cfg.baseUrl}/api/v1/chat`;
    // 身份解析：根据发言 MC 名查映射表 → 命中则绑定该 QQ 用户（记忆同源）；未命中走默认 session
    const mcName = opts?.playerName;
    const qqUser = mcName ? this.identityMapping[mcName] : undefined;
    const effUsername = qqUser ?? this.cfg.sessionId;
    const effSessionId = qqUser ? `mc-${qqUser}` : this.cfg.sessionId;
    // 跨端记忆注入：把该玩家在 QQ 侧的共同经历喂给大脑，进游戏不再失忆
    let effectiveText = text;
    if (this.crossMemory) {
      const personId = qqUser ?? mcName;
      if (personId) {
        const crossCtx = this.crossMemory.getContext(personId, mcName);
        if (crossCtx) {
          effectiveText = `${crossCtx}\n\n${text}`;
          log('INFO', `↳ 已注入跨端记忆（person=${personId}）`);
        }
      }
    }
    const body: Record<string, unknown> = {
      message: effectiveText,
      session_id: effSessionId,
      username: effUsername, // AstrBot API 要求的调用方用户名
    };
    if (qqUser) {
      log('INFO', `↳ 身份映射命中：MC「${mcName}」→ QQ「${qqUser}」（session=${effSessionId}）`);
    }
    if (this.cfg.model) {
      body.llm_settings = { model: this.cfg.model };
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;

    const controller = new AbortController();
    // 超时上限 90s（用户配置可能是 120s，太长会让人以为 bot 不回复）
    const timer = setTimeout(() => controller.abort(), Math.min(this.cfg.timeoutMs, 90000));
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
      }
      // 非 SSE 的 JSON 响应（通常是 {"status":"error","message":...}，
      // 如 username 命中管理员保留名 / session 归属冲突）：解析并抛出真实原因，
      // 否则下面按 SSE 读不到任何帧，只会含糊报"无回复"，问题被掩盖。
      const ctype = resp.headers.get('content-type') ?? '';
      if (ctype.includes('application/json') && !ctype.includes('event-stream')) {
        const j = (await resp.json().catch(() => null)) as { status?: string; message?: string } | null;
        if (j && j.status === 'error') throw new Error(j.message || 'AstrBot 返回错误');
        return null;
      }
      const reader = resp.body?.getReader();
      if (!reader) return null;
      const decoder = new TextDecoder();
      let buffer = '';
      let fullReply = '';
      let sawToolSay = false; // 流中是否出现过 send-chat 工具发言
      let autoAcked = false; // 本流是否已排定兜底应承（只排一次）
      let mcpDown = false; // 流中是否出现 MCP session 不可用错误
      // A 方案（9/9 玩家定）：应承从"即时代发"改为"延迟兜底"——
      // 大脑通常 1~2s 内会自己说话（send-chat 工具或流末正文），此时引擎闭嘴，玩家只听到大脑那一句；
      // 仅当大脑 >ACK_DELAY_MS 还一声不吭（卡住/直奔长动作）才代发模板应承，避免玩家干等。
      let ackTimer: ReturnType<typeof setTimeout> | null = null;
      const clearAck = () => {
        if (ackTimer) {
          clearTimeout(ackTimer);
          ackTimer = null;
        }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const obj = JSON.parse(payload) as {
              type?: string;
              chain_type?: string | null;
              data?: { content?: string; reply?: string } | string;
            };
            // 【诊断】打印每帧 type/chain_type/数据摘要，定位正文帧被丢弃的原因
            {
              const dbg = typeof obj.data === 'string'
                ? obj.data.slice(0, 120)
                : (obj.data && typeof obj.data === 'object' ? '<object>' : String(obj.data ?? ''));
              log('DEBUG', 'SSE帧 type=' + (obj.type ?? '∅') + ' chain_type=' + (obj.chain_type ?? '∅') + ' data=' + dbg.slice(0, 120));
            }
            // AstrBot agent 的工具调用帧（chain_type=tool_call / tool_call_result）：
            // 是工具执行记录，不是给玩家看的话术。工具本体已由 AstrBot 经 MCP 执行
            // （如 send-chat 已把话说出去）。若把它当聊天文本会发一串 JSON 到游戏里。
            if (obj.chain_type === 'tool_call' || obj.chain_type === 'tool_call_result') {
              if (obj.chain_type === 'tool_call' && typeof obj.data === 'string') {
                try {
                  const tc = JSON.parse(obj.data) as { name?: string };
                  const tname = tc.name ?? '';
                  if (tname === 'send-chat') {
                    sawToolSay = true;
                    clearAck(); // 大脑自己要先说话 → 取消兜底应承，避免双句
                  }
                  // 先应声、再动（玩家 9/9 反馈）：不再由引擎代发预设模板（那是背稿），
                  // 而是靠上下文【行动触发规则】里「先应声、再动」的引导，让大模型自己自然输出一句再调工具。
                  // 这里仅记录大脑直奔动作，供日志/排障，不做任何代发。
                  if (opts?.allowAutoAck && !autoAcked && !sawToolSay && tname && tname !== 'send-chat' && !NON_ACTION_TOOLS.has(tname)) {
                    autoAcked = true;
                    log('INFO', `↳ 大脑直奔动作 ${tname}（响应顺序由大模型按上下文引导决定，引擎不代发模板应承）`);
                  }
                } catch {
                  /* ignore */
                }
              }
              // tool_call_result：检测 MCP 通道故障（session 不可用），用于直报兜底
              if (obj.chain_type === 'tool_call_result' && typeof obj.data === 'string') {
                try {
                  const rc = JSON.parse(obj.data) as { result?: unknown };
                  const rtext = typeof rc.result === 'string' ? rc.result : '';
                  if (rtext.includes('MCP session is not available')) {
                    mcpDown = true;
                    log('WARN', `↳ 检测到 MCP session 不可用（工具调用失败）`);
                  }
                } catch {
                  /* ignore */
                }
              }
              continue;
            }
            if (obj.type === 'llm') {
              const content =
                typeof obj.data === 'string'
                  ? obj.data
                  : (obj.data?.content ?? obj.data?.reply ?? '');
              if (content) fullReply = content;
            } else if (obj.type === 'plain') {
              // AstrBot SSE 流式回复：分段拼接
              const content =
                typeof obj.data === 'string'
                  ? obj.data
                  : (obj.data?.content ?? obj.data?.reply ?? '');
              if (content) {
                // LLM 有时把工具调用以纯文本 JSON 帧形式发（非结构化 chain_type=tool_call），
                // 如 {"id":"call_...","name":"send-chat","args":{...}}。直接当正文发出去会让
                // 玩家在游戏聊天里看到一串 JSON（动作信息）。这里识别并剥离，不拼进正文。
                if (
                  (/\{"id"\s*:\s*"call_/.test(content) && /"args"\s*:/.test(content)) ||
                  (/^\s*\{/.test(content) && /"name"\s*:\s*"[A-Za-z0-9_]+"/.test(content) && /"args"\s*:/.test(content))
                ) {
                  try {
                    const tc = JSON.parse(content) as { name?: string };
                    if (tc.name === 'send-chat') {
                      sawToolSay = true;
                      clearAck();
                    }
                    // 工具调用不该作为聊天正文发给玩家（动作信息由工具执行本体体现）
                    continue;
                  } catch {
                    // 解析失败 → 保守不拼，避免 JSON 泄漏进聊天
                    continue;
                  }
                }
                fullReply += content;
              }
            }
          } catch {
            /* 忽略非 JSON 帧 */
          }
        }
      }
      clearAck(); // 流已结束：正文将经 onReply 发出（或大脑已用 send-chat 说过），兜底应承不再需要
      let clean = fullReply.trim();
      // MCP 通道故障直报：流中出现 MCP session 不可用错误时，LLM 拿到的只是技术报错，
      // 会脑补出"卡了/缓一下马上好"等虚假安抚。这里用代码硬替换成实话，不让玩家被糊弄。
      if (mcpDown) {
        log('WARN', `MCP 通道故障(session 不可用)，直报覆盖 LLM 文本`);
        clean = MCP_DOWN_DIRECT_REPLY;
      }
      // 兜底清洗：万一仍有 tool-call JSON 残留混入文本，剥掉（按 call_xx 开头的连续 JSON）
      if (clean.startsWith('{') || /\{"id"\s*:\s*"call_/.test(clean)) {
        clean = clean.replace(/\{"id"\s*:\s*"call_[0-9A-Za-z_-]+"[^}]*\}(?:\.?[^{]*\{[^}]*\})*/g, ' ').replace(/\s{2,}/g, ' ').trim();
      }
      if (clean) return { text: clean, raw: fullReply, acted: sawToolSay };
      if (sawToolSay) return { text: '', raw: fullReply, acted: true };
      return null;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error('大脑响应超时');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}