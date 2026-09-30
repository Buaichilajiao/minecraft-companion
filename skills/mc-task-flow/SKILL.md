---
name: mc-task-flow
description: 处理 Minecraft 游戏聊天：判断玩家消息是纯闲聊、短期任务还是长期任务；短期任务直接答应并调工具执行，长期任务先回复玩家、再在后台创建 skill 任务表（任务流文件）并分步执行；执行中玩家插话优先回应。任何需要"判断是不是任务、建任务表、分步推进、被打断时处理闲聊/新任务"的场景都触发本技能。
---

# 游戏聊天 → 任务流（mc-task-flow）

目标：让 bot（脑在 AstrBot 侧）面对玩家任意聊天时，正确区分「闲聊 / 短期任务 / 长期任务」，并据此做出正确动作，全程用人格自由发挥回复、不用任何预设话术。

## 核心规则

### 1. 先判断消息类别（每次收到玩家消息第一件事）

| 类别 | 判据 | 怎么做 |
|------|------|--------|
| 纯闲聊 | 无明确可执行意图、寒暄、问好、八卦、问状态等 | 只回复，不动作 |
| 短期任务 | 一个（或极少几个）现有工具/技能就能立刻完成的指令 | 回复答应 → 立即调工具执行 |
| 长期任务 | 需要多阶段、多个 skill/工具的庞大目标，单工具搞不定 | 回复答应 → 后台建 skill 任务表 → 分步执行 |

判断依据：**能不能"现在就调一个工具开始做并且做一小段就能看到成效"**。能 = 短期；要拆成"先做什么、再做什么"的长链条 = 长期。

### 2. 回复玩家永远先行，且人格自由发挥

- 无论短期还是长期任务，**先回复玩家**表明自己会做（答应、跃跃欲试、欲拒还迎都行），**绝不预设固定话术**，语气由当前人格（傲娇/温柔/毒舌等）自行决定。
- 长期任务尤其不能一开始就闷头干；先给玩家一句回应，再在后台建表执行。
- "通关 MC / 打败末影龙"这类，可以表达"这可是个大工程，我试试看"之类的态度，但**不能拒绝**（除非有正当的客观理由，且用符合人格的方式说）。

### 3. 短期任务：直接调工具

玩家："跟着我跑图" → 回复同意 → 调 `follow-player`。
玩家："挖点铁" → 回复 → 调 `skill-mine-iron`。
玩家："建个房子" → 回复 → 查材料(`get-state`)→ 缺料走采集 → `build-shelter`。

可用的 skill 任务流工具（无需重新造，直接调用）：
`skill-setup-base`、`skill-mine-iron`、`skill-mine-diamond`、`skill-mine-obsidian`、`skill-gear-up`、`skill-build-portal`、`skill-enter-nether`、`skill-return-home`。

### 4. 长期任务：建 skill 任务表（任务流文件）

**任务表位置**：`data/tasklist/`，每任务一个 JSON 文件，文件名建议 `<slug>.json`（如 `kill-ender-dragon.json`）。

**结构约定**（见 `references/tasklist-schema.md`）：

```json
{
  "id": "kill-ender-dragon",
  "title": "通关MC打败末影龙",
  "status": "pending",            // pending | running | paused | done
  "current_step": 0,              // 正在执行的步骤下标
  "created": 1750000000000,
  "updated": 1750000000000,
  "steps": [
    { "desc": "采集木头做基础工具", "tools": ["skill-setup-base"], "done": false },
    { "desc": "挖矿做铁+钻石装备", "tools": ["skill-mine-iron","skill-mine-diamond"], "done": false },
    { "desc": "搭传送门进下界拿烈焰粉", "tools": ["skill-build-portal","skill-enter-nether","skill-gear-up"], "done": false },
    { "desc": "找末地传送门、拿末影珍珠", "tools": ["find-blocks","skill-gear-up"], "done": false },
    { "desc": "进末地打败末影龙", "tools": ["attack-entity"], "done": false }
  ]
}
```

**建表后执行**：按 `current_step` 顺序，逐个调用该步骤 `tools` 里的工具（用 `mcp.callTool` / 或直接在 AstrBot 侧调对应工具）。每一步完成后把该 step 的 `done` 置 true、`current_step` 前移、`updated` 刷新、落盘 JSON。

### 5. 执行中被打断（玩家插话 / 新任务）

- **玩家插话（闲聊或任何话）永远最高优先级**：立即停下当前步骤，先回复玩家，不让玩家的话落空。
- **原地不动**：停下时调用 `stop-follow`（若在跟随）、停止移动意图；当前动作若尚未有干净的 cancel 机制，至少**本轮不再主动发起新动作**，先处理玩家。
- **玩家给了新任务**：LLM 自行判断是「先做新任务」还是「继续旧任务」；判断不了时**直接问玩家**，不擅自决定。

### 6. 状态维护

- 任务表文件用 `data/tasklist/*.json` 落盘（用文件读写工具）。
- 任务开始/暂停/完成时，用 `memory-write`（type=event 或 goal）同步记忆，让 bot 记住"我有一个进行中的目标"。
- 长期任务完成后，把任务表 `status` 置 `done`，文件保留（可回看）。

## 分工

- **本 SKILL** 由 AstrBot 侧 agent 在收到游戏聊天时遵循，负责"判断类别 + 建表 + 分步派发工具 + 插话处理"。
- **brain.ts（bot 侧）** 负责把任务表摘要注入对话上下文（见 `integration.md`），让 agent 每次醒来都知道"当前有哪些进行中的任务、到第几步了"。