# 陪伴层 · 第一批增量设计（A1：陪伴循环 + 闲逛 + 本地反射 + 常驻记忆接线核对）

> 状态：设计稿 v1.0（对齐辣椒小号/2026-09-30）
> 锚定目标：在 **minecraft-companion v1.6.0 已有骨架上补「真缺口」**，不重写已验证底层。

---

## 〇、一句话结论

现状**远不止「被命令才动」**——`Companion`/`Lifestyle.auto`/`EventWatcher` 已实现大半陪伴层。
第一批不「从零搭陪伴」，只补 **3 个真缺口** + **1 项接线核对**：

| # | 项 | 性质 | 通道 |
|---|---|---|---|
| 1 | 闲逛／在身边（hang） | 行为缺口 | 纯本地（Lifestyle + body 锁） |
| 2 | 玩家指令本地反射旁路（come/stop/过来/危险） | 响应缺口 | 纯本地（guardian/helpers，毫秒级，不走 SSE） |
| 3 | 主动感知玩家活动（建物/挖矿/移动）并有心跳汇报 | 感知缺口 | 感知本地 → 决策走② brain.trigger → 动作走① MCP |
| 4 | 常驻记忆接线核对 | 核对项 | 已存在（Memory/MemoryV2/CrossMemory/Landmark），仅核对内聚，不新增系统 |

---

## 一、三个通道的最终锚点（竖旗，后续所有地方都照这个走）

```
AstrBot（大脑）
   │
   │ ② HTTPS POST {baseUrl}/api/v1/chat  →响应按 SSE 流读（callBrainAstrbot）
   │    用途：身体侧「有值得决策/分享的事」→ brain.trigger() 主动推给大脑
   ▼
┌─────────────────────────────────────┐
│  minecraft-companion（身体）          │
│  · L1 感知/原语（只读，无副作用）       │
│  · L3 ActionExecutor/helpers 动作     │
│  · Companion/Lifestyle/EventWatcher  │
│  · heartbeat 脉搏（本地周期）          │
└───────▲──────────────┬───────────────┘
        │① MCP SSE      │ 动作工具
        │ /mcp GET      │ callTool(name,args)
        │ /mcp/messages │ 身份='brain'
        │  POST         │ wrapAction→body.acquire('player')
        │               ▼
      AstrBot 经 MCP 回调本项目工具（大脑把语言→动作）
      （为清晰起见，这一条由大脑主动发起，见 main 的 registerAllTools）
```

**通道职责（永不串味）：**
- **①（AstrBot → 本项目）**：大脑把「决定」变成「动作」。入口 `McpServerManager.callTool(name,args)`，身份恒为 `'brain'`，走 `wrapAction` → `body.acquire('player')`。请求-响应、大脑主动。
- **②（本项目 → AstrBot）**：身体把「事件/想分享」变成「决策」。入口 `BrainBridge.trigger(text)`（内部 `callBrainAstrbot`）。事件-触发、身体侧主动。
- **本地反射（无通道）**：危险/come/stop/紧急躲避，`guardian` + `helpers` 进程内直通，几百毫秒内，**绝不进 ① 也不进 ②**。

**主动决策位置：感知/脉搏放本地 heartbeat，决策走②，动作执行走①，全复用现有路径，不新建通道。**

---

## 二、真缺口 1：闲逛／在身边（hang）

### 2.1 现状问题
`Lifestyle.auto` 态目前只有两条路：
- `goto_player`（coop 模式）：跑回玩家身边**站定**（`GoalNear(...,4)`），不是闲逛；
- 技能任务（`pickDecision` → `skills[...]`）：按任务表干活。

**缺「在玩家附近自然游走」的行为**。玩家在、没指令、又没正经事干时，bot 是呆立/站住，不像「朋友在身边」。

### 2.2 方案：在 `Lifestyle.doAutoActivity` 增加 `hang` 决策
在 `pickDecision` 返回 `none`（无事可做）**且玩家在附近**时，不再直接 return，而是进入 `hang()`：

```
条件放宽版 doAutoActivity 的伪代码：
  decision = pickDecision(s)
  if decision 且 kind != 'none'：照旧执行（跑回/干活）
  else if 玩家在线（s.world.players 有非自己玩家）且玩家在 hangRadius 内：
        → hang()                       // 新增
  else：保持现状（安静/等任务/发呆）

hang()：
  owner='auto'，label='在身边闲逛'
  release = body.tryAcquire('auto', '在身边闲逛')   // 让位给玩家/守护
  if (!release) 静默让路（玩家在下指令 → 不抢）
  loop（每段 8~15 秒，总时长随机 20~60 秒）：
    target = 玩家位置 + 随机水平偏移（半径 3~10 格，且尽量贴着玩家可见范围）
    gotoSmart(bot, GoalNear(target, 2), 分段超时)   // 复用 helpers
    faceToward(bot, 玩家)                            // 面向玩家，像在陪
    每走过一段随机 pause 1~4s（东张西望感）
  release()
```

**规则（不越界）：**
- 身体锁 `owner='auto'`，与 guardian/player 互斥；玩家一下命令（`onPlayerCommand` 会置 working），`tryAcquire` 立刻失败但**不排队硬争**（与现有 `doAutoActivity` 让路逻辑一致）。
- **绝不触发 ② brain.trigger**——闲逛是纯行为，不需要大脑叙事，避免为「走路」烧 LLM。
- 范围以玩家为锚，不脱离身边；`hangRadius` 走 config 兼容旧键 `guardian.maxDist`（已兼容，见 loadConfig）。
- 不碰危险：低血/低饱食/夜晚交给 guardian 和 sleep 分支（现有 tick 已优先处理）。

### 2.3 配置新增（config.chat 平级，新块 `companion`）
```jsonc
"companion": {
  "hangEnabled": true,
  "hangRadius": 12,        // 玩家在多少格内才触发闲逛
  "hangSegmentSec": [8, 15],
  "hangTotalSec": [20, 60],
  "hangPauseSec": [1, 4]
}
```
`loadConfig` 加深度合并默认值（照 `guardian` 的兼容套路）。

---

## 三、真缺口 2：玩家指令本地反射旁路（come/stop/过来/危险）

### 3.1 现状缺口
现在 `come/stop/过来/停下` 这类玩家指令**多数走 brain（LLM）**，会经 ② 再回来，延迟几百毫秒~秒级，且被 `busy` 互斥/队列排队拖住；`危险` 靠 `guardian` 反射但**不认「玩家喊我躲开」**。缺一个**统一的关键字→本地动作直通层**，让常用指令毫秒级响应且不抢 LLM。

### 3.2 方案：新增 `src/reflect.ts`（本地反射旁路）+
在 `main.ts` 的 `bot.on('chat')` **最前面**（命中自检/记忆点之前、进 brain 之前）插入一根短路过墙：

```
新增文件 src/reflect.ts
  Class PixieReflect   // 取名贴近现命名（Guardian/Lifestyle/Companion 风格）
  configure(bot, memory, body, guardian, cfg.reflect)

  handle(username, rawMessage) → boolean   // true=已本地代答，不再进 engage()
```

**路由优先级（自上而下，命中即返回 true，毫秒级）：**

| 级别 | 触发词（正则，中文为主） | 动作 | 复用 |
|---|---|---|---|
| S0 紧急躲避 | `躲开|快躲|闪开|别过来(那怪)` + 附近有威胁 | 朝威胁反方向短退几格（复用 guardian 的 `retreatFromThreat` 思路/`flee` 前段） | guardian |
| S1 危险求助 | `危险|救命|快跑|有怪`（玩家提醒） | 若 `guardian.inAgreedPvp()` 则 `stopAgreedPvp()`；面向最近威胁 + 口头反馈 | guardian |
| S2 停下 | `停下|站住|别动|停` | `body.displaceCurrentAuto()`？→ 实际上：释放/抢占 `body.acquire('player','玩家叫停')` + 取消当前寻路（pathfinder `stop`），口头确认 | BodyController + pathfinder.stop |
| S3 过来 | `过来|快来|来我这|过来一下` | 记入「临时跟随锚点」（玩家坐标），或直接查 `bot.players[玩家].entity` 走过去；请求 `body.acquire('player')` | gotoSmart + GoalNear |
| S4 跟着我 | `跟着我|跟我走|陪着我` | 置 Lifestyle 为跟随玩家模式（复用 coop `goto_player` 逻辑的锚点跟随） | Lifestyle/coop |

**行为原则：**
- **只做「让身体动 / 一句话确认」**，不组织叙事文案；简单确认可用预设短句（这是反射，非拟人对话；拟人对话仍走 ②）。
- 抢身体用 `body.acquire('player', ...)`（玩家级，压过 auto 闲逛/自主任务；guardian 仍最高）。
- **不写进对话历史、不触发大脑**（避免 LLM 再答一遍）。走 `memory.pushTimeline` 记录动作即可。
- 若玩家指令含「去 XX 干活」这类**需要规划**的 → 返回 false 照旧进 brain。

### 3.3 配置新增（`config.reflect`）
```jsonc
"reflect": {
  "enabled": true,
  "approach": {
    "躲开|快躲|闪开": "avoid",
    "危险|救命|快跑": "danger_heed",
    "停下|站住|别动": "stop",
    "过来|快来|来我这": "come",
    "跟着我|跟我走": "follow"
  }
}
```
正则表可配置扩展；命中标签 → 硬编码动作映射，找不到标签则返回 false。

---

## 四、真缺口 3：主动感知玩家活动 + 心跳汇报

### 4.1 现状缺口
`EventWatcher`（events.ts）已做 **danger/environment/social/achievement** 四类，其中 social 只覆盖「玩家上线/离开」。**缺「玩家做了什么」**：玩家放了方块/建了东西/挖了矿/大幅移动，bot 现在「看不见也说不出口」——这是「朋友会注意到你做什么」的核心。

### 4.2 方案
**A. 感知（本地 heartbeat，放 EventWatcher 的 scan 里扩展）**
新增 `PlayerActivityWatcher` 或并入 `EventWatcher.scanSocial`：
- 每 tick（Lifestyle 5s 复用同一状态快照）比对：
  - **玩家位置位移**：连续 tick 位移 > 阈值（如 ≥20 格）→ 「玩家 装饰 走远了/跑去那边了」
  - **玩家在 bot 视野内放/挖方块**：靠 mineflayer 的 `blockUpdate` 事件监听，过滤 `cause` 与玩家 UUID（mineflayer 提供 `blockUpdate` 第二个参数为 player）；同源去重。
  - 阈值+冷却防止刷屏（复用现有 `canFire(type,cooldownMs)`）。
- 产出 `GameEvent`（category='social' 或新 `'activity'`，urgency=low/medium），push 进 `EventBus`。

**B. 决策（心跳层级，走② trigger）**
在 `Lifestyle.tick` 里增加「**心跳汇报闸门**」：低频（受 `brainCooldownMs` 控制，默认 30s）且玩家在线时，若 `EventBus.getUnread()` 里出现「值得分享的玩家活动事件」，组装一句自然触发给 `brain.trigger()`：

```
心跳文 = `【玩家活动】我发现${玩家}${描述}（如：在我北边又盖了一层/把基地扩建了）。
          玩家在的话，用清醒自然的口吻轻描淡写地提一句这件事（像朋友随口说，
          别说成播报，别逐条陈列）。`
```
- 经 `brain.trigger`（`internal:true`，走完整上下文）。
- **内存保护：只对玩家活动类事件触发**；danger 类仍由 guardian/Companion 现路径处理，避免重复。
- **防刷屏**：`getUnread()` 消费式（现有语义），触发一次清一批；`busy` 时 `trigger` 自动放弃（不抢玩家对话），符合现有保障。

**C. 动作执行**
若大脑决定「过去看看/靠近玩家」，AstrBot 经现有 ① `callTool('move-to'/'follow-player')` → `body.acquire('player')` 执行。**本缺口不新增任何工具**。

### 4.3 配置新增
```jsonc
"heartbeat": {
  "enabled": true,
  "activitySpeakCooldownSec": 30,   // 汇报玩家活动的最小间隔
  "playerMoveThreshold": 20,        // 玩家位移多少格算"活动"（方块）
  "maxActivityPerScan": 1           // 每 tick 最多汇报 1 条，优先近的
}
```
并入 `lifestyle` 块或独立 `companion` 块，由实现时定；仅 heartbeat 汇报收紧到 `brainCooldownMs` 之上。

---

## 五、真缺口 4：常驻记忆接线核对（核对项，非新增）

**结论：常驻记忆已完整，且已正确内聚到我们要用的三条链路，无需新系统。** 核对结果：

| 记忆体 | 文件 | 落盘 | 接入位置 |
|---|---|---|---|
| 时间线+关系 | `memory.ts`（`MemoryManager`） | `data/` | `main.ts` 全局；`Companion`/`Guardian`/`Lifestyle`/`heartbeat` 都 pushTimeline |
| 短期印象/情绪/玩家画像 | `memory-v2.ts`（`MemoryV2`） | `memory2.json` | `brainRef.onMemoryContext` 注入 → ② trigger/pump 都带出 |
| 跨 QQ/游戏 | `cross-memory.ts`（`CrossMemory`） | `cross-memory.json` | `callBrainAstrbot` 注入 `crossCtx`（进游戏不失忆） |
| 地点记忆点 | `landmark.ts`（`LandmarkStore`） | `landmarks.json` | `ctx.landmark` + guardian/companion recordBaseIfFirst |
| 对话记录 | `brain.ts` `history` | 内存 | pump/trigger 上下文 |

**提醒一条**：`heartbeat`（缺口3）若触发大脑说话，走 `brain.trigger` **不会自动 pushTimeline/记 v2**（那是 `onReply` 的职责，trigger 不经过 onReply）。所以心跳汇报后要手动 `memory.pushTimeline` + `memoryV2.addChatMessage`（记自己说过），否则「我记得刚才说了啥」会断裂——这条是接线时要补的点。

---

## 六、接线点（改动文件清单）

| 文件 | 改动 | 关联缺口 |
|---|---|---|
| `src/reflect.ts`（新增） | 本地反射旁路类 | 3 |
| `src/lifestyle.ts` | `doAutoActivity` 加 `hang()` 分支；tick 加心跳汇报闸门 | 1,3 |
| `src/events.ts` | `EventWatcher` 扩展玩家活动感知；可新增 PlayerActivityWatcher | 3 |
| `src/main.ts` | `bot.on('chat')` 最前插 `reflect.handle` 短路；装配 reflect/heartbeat；心跳后补记忆 | 2,3 |
| `src/config.ts` | 新增 `companion`/`reflect`/`heartbeat` 三块 + 深度合并默认值 | 1,2,3 |
| `src/companion.ts` | （可选）把 reflect 的简单确认与拟人说话分流说明写进注释；心跳说话复用 speakViaBrain 出口 | 2,3 |

**铁律（沿用 ARCHITECTURE.md）：**
1. 不重写已验证底层（body-controller/head-channel/gaze/pathfinder/smartPlace）。
2. 动作统一走 `body.acquire`（auto 闲逛用 `tryAcquire` 让路；反射用 `player` 级；guardian 最高）。
3. 工具层不内联动作逻辑（本批基本不新增工具，新增的若非工具则走 L3/helpers）。
4. reflect 的本地指令**不写对话历史、不触发大脑**，避免 LLM 再答一遍。
5. heartbeat 汇报**只对玩家活动类事件**触发，danger 不抢（Guardian/Companion 现路径处理）。
6. 每项改完 `npx tsc --noEmit` 通过 + 实机验证再进下一项。

---

## 七、落地顺序（每步可编译可测）

| 步骤 | 内容 | 验证 |
|---|---|---|
| 0 | 配置新增三块默认值 + 合并 | tsc 过 |
| 1 | `reflect.ts` 骨架 + S0~S4 路由，插 main 短路 | 游戏内喊「停下/过来/危险」毫秒级反应 |
| 2 | `lifestyle.hang()` 行为 | 玩家在不指令时 bot 会在身边游走 |
| 3 | events 玩家活动感知 + heartbeat 汇报（含结尾补记忆） | 玩家扩建时 bot 偶尔轻描淡写提一句，不刷屏 |
| 4 | 全链路回归：心跳→② trigger→大脑说话→① 工具动作 | 无冲突、无重复播报 |

---

## 八、风险与对策

- **闲逛与玩家指令抢身体**：闲逛一概 `tryAcquire('auto')`，失败即让路，不排队（已对齐现有让路逻辑）。
- **心跳刷屏 / 抢对话**：`getUnread` 消费式 + `trigger` 的 `busy` 放弃 + `brainCooldownMs` 节流 + globalCooldown。
- **reflect 误吞正经指令**：只对「运动类短指令」命中；含规划词的放行进 brain；正则表集中配置可调。
- **玩家活动去重**：`blockUpdate` 按方块坐标+玩家 UUID 去重 + 冷却；位移按 tick 差分，避免重复弹。
- **死亡/维度切换时**：guardian/Companion 已有维护便签防误述，heartbeat 需避开死亡静默期（复用 `deathMuteUntil` 语义或检查 respawn）。

---

*设计文档结束。等你 review，对完再动手改。*