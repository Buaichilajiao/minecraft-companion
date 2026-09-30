/**
 * 聊天上下文组装器（P2-3 落地 · 蓝图 ChatContextBuilder）
 * ─────────────────────────────────────────────
 * 每次大脑收到消息/自主触发时，把完整上下文组装成一封信喂给大脑：
 *   world / self / player / recent_events / chat_history /
 *   shared_memories / player_observations / avoid_topics (+emotion 语气)
 *
 * 同时承载 P2-2 双轨制的"状态轨"：danger 不是等事件才被大脑知道，
 * 而是每次上下文构建都持续注入「周围有 X 在 Y 格」——事件层只负责第一次喊。
 *
 * 数据来源全部走 getter（不缓存跨重连实例），与 main.ts 装配解耦：
 *  - status:    StatusCollector 快照（lifestyle tick 里事件扫描复用的同一份数据）
 *  - memoryV2:  记忆层 v2（shared/观察/避免话题）
 *  - chat:      brain 的原始对话历史（玩家消息）
 *  - events:    EventBus.recent（最近发生，不消费）—— 未读事件另由 brain hook 消费
 *  - emotion:   情绪摘要（语气参考，不干预决策）
 */

import type { StatusData } from './status';
import type { MemoryV2 } from './memory-v2';
import type { EmotionSystem } from './emotion';
import type { GameEvent } from './events';
import type { LandmarkStore } from './landmark';

export interface ChatContextSource {
  status: () => StatusData | null;
  memoryV2?: MemoryV2 | null;
  /** 游戏记忆点（Landmark Memory）：注入最相关的几条，大脑可自然引用"家在哪" */
  landmark?: () => LandmarkStore | null;
  /** 原始对话历史（brain 侧最近 N 条玩家消息） */
  chatHistory: () => Array<{ username: string; message: string; t: number }>;
  /** 最近事件（EventBus.recent，不消费） */
  recentEvents: () => GameEvent[];
  emotion?: () => EmotionSystem | null;
}

const PHASE_TEXT: Record<string, string> = {
  day: '白天', dusk: '傍晚', night: '夜晚', dawn: '黎明',
};

export class ChatContextBuilder {
  private src: ChatContextSource;

  constructor(src: ChatContextSource) {
    this.src = src;
  }

  /** 组装完整上下文；游戏未就绪返回 null（调用方回退） */
  build(entry: { username: string; message: string; internal?: boolean }): string | null {
    const s = this.src.status();
    if (!s) return null;
    const parts: string[] = [];
    parts.push(
      entry.internal
        ? `[自主决定时刻（不是玩家在说话，是我在想：要不要做点什么/要不要开口）: "${entry.message}"]`
        : `[游戏内 ${entry.username} 对我说: "${entry.message}" 这是玩家在游戏里直接对我说的话，我必须用一句简短自然的中文当场回应他，绝不能沉默、绝不能跳过。]`
    );

    // ── world ──
    parts.push(`【世界】${s.world.dimension.replace(/^minecraft:/, '')} · ${PHASE_TEXT[s.world.time.phase] ?? s.world.time.phase}（时间 ${Math.round(s.world.time.time_of_day % 24000)}）· ${s.world.weather === 'rain' ? '正在下雨' : '天气晴朗'} · 难度 ${s.world.difficulty}`);

    // ── self ──
    const me = s.self;
    const pos = me.position.map((n) => Math.round(n)).join(',');
    const eq = Object.entries(me.equipment).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ');
    parts.push(`【我】位置(${pos}) · ${me.biome} · 血量 ${me.health}/${me.max_health} · 饱食度 ${me.food}/20 · 等级 ${me.level}${eq ? ` · 装备: ${eq}` : ''}${s.progress.current_goal ? ` · 当前目标: ${s.progress.current_goal}` : ''}${s.progress.last_activity ? ` · 刚做完: ${s.progress.last_activity}` : ''}`);

    // ── danger 状态轨（P2-2：每次必带，事件层不重复刷）──
    const hostile = s.surroundings.nearby_entities
      .filter((e) => e.hostile)
      .sort((a, b) => a.distance - b.distance);
    parts.push(
      hostile.length > 0
        ? `【周围威胁】${hostile.slice(0, 4).map((e) => `${e.name}(${Math.round(e.distance)}格)`).join('、')}${hostile[0].distance <= 6 ? '——离我很近，优先保证安全！' : ''}`
        : '【周围威胁】暂未发现敌对生物'
    );

    // ── player ──
    const online = s.world.players.map((p) => p.name);
    if (online.length > 0) {
      const nearMe = s.surroundings.nearby_entities
        .filter((e) => e.kind === 'Player' || online.includes(e.name))
        .sort((a, b) => a.distance - b.distance);
      parts.push(`【玩家】在线: ${online.join('、')}${nearMe.length > 0 ? `；其中 ${nearMe.slice(0, 3).map((e) => `${e.name}在${Math.round(e.distance)}格${e.x != null ? '@(' + e.x + ',' + e.y + ',' + e.z + ')' : ''}`).join('、')}` : ''}`);
    } else {
      parts.push('【玩家】现在没有其他玩家在线');
    }

    // ── recent_events（最近动态，不消费；未读的由 brain hook 单独消费）──
    const recent = this.src.recentEvents().slice(-4);
    if (recent.length > 0) {
      parts.push(`【最近发生】${recent.map((e) => e.description).join('；')}`);
    }

    // ── chat_history：优先用 memoryV2 持久化对话（玩家+bot 双向、重连不丢）；
    //   回退 brain 内存 history（仅玩家单向、重连清空）。修复重连后【对话记录】失忆。
    const persisted = this.src.memoryV2 ? this.src.memoryV2.getRecentChat() : [];
    // 取最近 10 条：含几条 summary（更早脉络）+ recent 详情，长对话/被滚动后仍能回忆
    const chat = (persisted.length > 0 ? persisted : this.src.chatHistory()).slice(-10);
    if (chat.length > 0) {
      parts.push(`【对话记录】${chat.map((c) => `${c.username}: ${c.message.slice(0, 80)}`).join(' | ')}`);
    }

    // ── memory 层：shared_memories / player_observations / avoid_topics ──
    const mv = this.src.memoryV2;
    if (mv) {
      const shared: string[] = [];
      const short = mv.getShortRecent(3).filter((x) => x.importance >= 5);
      if (short.length > 0) shared.push(`最近记得: ${short.map((x) => x.content).join('；')}`);
      const places = mv.data.long.places.slice().sort((a, b) => b.last_visited - a.last_visited).slice(0, 2);
      if (places.length > 0) shared.push(`熟悉的地方: ${places.map((p) => `${p.name}（${p.description}${p.direction ? '，' + p.direction : ''}）`).join('；')}`);
      const memEvts = mv.data.long.events.slice(-2);
      if (memEvts.length > 0) shared.push(`难忘的往事: ${memEvts.map((e) => `${e.event}${e.emotion ? `（当时${e.emotion}）` : ''}`).join('；')}`);
      if (shared.length > 0) parts.push(`【我的记忆】${shared.join('；')}`);

      const obs = mv.getObservations().slice(-3);
      if (obs.length > 0) parts.push(`【对玩家的观察】${obs.map((o) => o.content).join('；')}`);

      const avoid = mv.getAvoidTopics();
      if (avoid.length > 0) parts.push(`【刚聊过的话题（尽量别重复提）】${avoid.join('、')}`);
    }

    // ── 游戏记忆点（Landmark Memory：独立 landmarks.json，问答"家在哪/之前死哪"的根据）──
    const lm = this.src.landmark?.();
    if (lm && s.world.dimension) {
      const marks = lm.summaryForContext(s.world.dimension);
      if (marks.length > 0) parts.push(`【记忆点】\n${marks.join('\n')}`)  }

    // ── emotion 语气（只作语气参考）──
    const emo = this.src.emotion?.();
    if (emo) {
      parts.push(`【当前情绪】${emo.getMoodDesc()}（语气参考，不影响决策判断）`);
    }

    // ── 跨端记忆规则（QQ↔游戏共同记忆，避免两边各记各的）──
    parts.push(
      '【跨端记忆】你在 QQ 上和玩家的共同经历已经自动注入，进游戏不会失忆，不用再主动读。' +
      '当玩家在游戏里告诉你他的称呼、喜好、约定，或发生了重要的事（一起盖了房子、定了计划、认识了彼此），请主动调用 cross-memory-write（source 填 game、person 优先用玩家 QQ 号，不知道就用玩家名，可附 mc_name），一句话记下来，这样你在 QQ 上也能想起。'
    );

    // ── 身体锁 / 移动并发规则（避免大脑并行下发移动动作被锁拒绝而懵掉）──
    parts.push(
      '【身体锁规则】我的身体同一时间只能做一个动作：正在持续跟随玩家（follow-player）时，不能再并行发 move-to / fly-to / move-direction / jump 等移动或位移类动作（会被身体锁拒绝）。' +
      '想从跟随切换去干别的事，先调 stop-follow 再动；已经在走路/飞行/挖矿途中也一样，等当前动作结束或先停，不要同时发两条移动指令。'
    );

    // ── 回复协议（通信铁律，避免把工具 JSON 发到聊天）──
    parts.push(
      '【回复协议】你回复别人说的每句话 = 你直接输出的纯文本，游戏端会自动原样发到游戏聊天里让对方看到。' +
      '因此：回答玩家/开口说话永远直接输出文本，绝对禁止调用 send-chat 工具来发言（send-chat 是给外部管理端用的广播口，你不用碰）。' +
      '若你出于习惯调用了 send-chat，就不要再输出任何文本复述同一句话，避免重复。'
    );

    // ── 行动触发规则（玩家让你干活的指令 → 先应声、再动、不背稿）──
    parts.push(
      '【行动触发规则】玩家的话若是在「让我做事」（移动/采集/建造/战斗/查看等），必须真的调用对应工具去执行，不能只回话不干活。' +
      '执行时务必【先应声、再动手】：先自然地说一句你当场想出来的回应（比如他说"过来"，你先回一句"来啦来啦，我这就过去"之类的话，这句话由你现场组织、绝不背模板），紧接着就调工具行动。' +
      '不要闷头先做完动作、最后才说话（玩家会觉得你没理他）；也不要反问"你在哪/要我做什么"，玩家名字和坐标都在【玩家】栏里，直接查直接动。' +
      '高频指令对应关系：' +
      '「过来/来找我/到我身边/跟上/跟着我」→ 先 get-state 拿该玩家坐标再 move-to 走过去；' +
      '「跟着我走」→ follow-player；「停/别跟了」→ stop-follow；' +
      '「挖XX/砍树/采矿/收庄稼」→ dig-block/collect-tree/mine-ore/harvest；' +
      '「给我XX/拿XX/造XX」→ find-item/craft-item 等；' +
      '「看看周围/你在哪/附近有什么」→ get-state 或 observe 看清再答。' +
      '只有纯闲聊（问候/打招呼/讲无关话题）才只说话不动手。'
    );

    return parts.join('\n');
  }
}
