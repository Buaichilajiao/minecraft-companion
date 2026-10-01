# minecraft-companion 进度总览（截至 2026-09-12）

- 版本：**1.6.0** ｜ MCP 工具：**68 个** ｜ 技能脚本：**8 条** ｜ 代码：`src/` 约 9.5k 行 TS（+ 已编译 `dist/`）
- 目标环境：Minecraft Java **1.21.1**（纯净/插件服均试过）｜运行：Node ≥18（本机 v24.20.0）
- 一句话定位：**不是"自动挂机脚本"，是"住在服务器里的 AI 同伴"** —— 会跟着你走、跟你说话、
  帮你挖矿盖房、受伤会喊、掉队会等你，也能自主完成"挖钻石→进下界"这类长任务。

---

## 1. 分层架构

```
┌ 大脑（外部，可替换）── AstrBot / 任意 LLM  ｜ 决定"说什么、做什么"
├ MCP 工具层（本项目，:3001 SSE）── 68 个工具 + 8 条技能链，LLM 只能通过这些"手"作用于世界
└ 身体（mineflayer）── 真连服务器：移动/挖掘/放置/交互/战斗/背包/钓鱼/睡觉/看图
```

| 模块 | 文件 | 状态 |
|---|---|---|
| 连线与重连 | `bot-connection.ts` (260) | ✅ 断线自动重连、跨版本、头身朝向解耦（直写 yaw + 解除发包限速）|
| 身体控制 | `body-controller.ts` | ✅ 独占/让位仲裁（跟随、注视、寻路不会互相抢手）|
| 大脑桥 | `brain.ts` | ✅ HTTP 调 AstrBot；工具调用由大脑驱动 |
| 陪伴层 | `companion.ts` (623) | ✅ 跟随、站定闲聊、受伤/天气/昼夜/维度口播、生活感 |
| 护卫 | `guardian.ts` (721) | ✅ 威胁感知、自动战斗、低血撤退、回血进食、警戒范围 |
| 记忆 v2 | `memory-v2.ts` (338) | ✅ 身份/偏好/事件时间线/地标/目标，JSON 持久化，跨重启保留 |
| 情绪 | `emotion.ts` | ✅ 心情状态影响口播 |
| 地标 | `landmark.ts` | ✅ 记住"家/矿洞/传送门"等坐标 |
| 生活作息 | `lifestyle.ts` | ✅ 昼夜/天气/饥饿驱动行为 |
| 注视与头身 | `gaze.ts` / `head-follow.ts` | ✅ 后台 50ms 平滑追视、移动即注视、不与执行器抢朝向 |
| 任务引擎 | `engine/*` | ✅ solo 主线 / coop 协作 / 下界链（挖钻→黑曜石→门→往返）|
| 自检 | `selfcheck.ts` | ✅ 逐项测游戏连接/状态/移动/背包/方块/记忆/MCP |
| 视觉 | `vision.ts` (180) | ✅ 顶视图扫描渲染 PNG（方块网格 + 实体点）|

## 2. 68 个 MCP 工具（能力清单）

| 分类 | 工具 |
|---|---|
| 基础状态 | `get-state` `pos-raw` `find-blocks` `find-entity` `get-block-info` `observe` `look` `self-check` |
| 移动 | `move-to` `move-direction` `jump` `walk-path`(投影式走廊执行器) `fly-to` |
| 跟随与注视 | `follow-player` `stop-follow` `look-at` `track-entity` `gaze-at` `stop-gaze` |
| 采集 | `dig-block` `collect-tree` `mine-ore` `pickup-item` `harvest` `fish` |
| 建造 | `place-block` `build-shelter` `fill-region`(需 OP) `build-schem`(.schem 新格式) `press-block` |
| 物品与制作 | `find-item` `equip-item` `craft-item` `smelt-batch` `chest-deposit` `chest-withdraw` `drop-item` `creative-give`(创造) |
| 农业 | `till-land` `plant-seed` `use-bone-meal` `breed-animal` |
| 战斗 | `attack-entity` `pvp-start` `pvp-stop` |
| 社交 | `send-chat` `read-chat` |
| 生存 | `eat` `sleep` |
| 记忆 | `memory-read` `memory-write` `get-goals` |
| 技能链 | `skill-setup-base` `skill-mine-iron` `skill-mine-diamond` `skill-mine-obsidian` `skill-build-portal` `skill-enter-nether` `skill-return-home` `skill-gear-up` |

## 3. 移动系统（这块改动最多，接手重点看）

档位（拟人化，不是"贴脸急停"）：

| 档 | 触发 | 行为 |
|---|---|---|
| 走 | ≤2.5 格 | 慢走到位 |
| 疾跑 | 中距 | 跑，接近自动收成走（滞后区间防抖）|
| 跑跳 | >7 格 | 连跳赶路（原版按住跳跃键 = 落地即跳 + 速度保险）|

- **统一入口**：`pickGear/applyGear/startDistanceGear`（`tools/helpers.ts`）——
  **move-to、walk-path、跟随、直线走共用**，不再各写各的。
- **跑跳安全闸** `hopPathClear()`：前方 2 格要"三格净空 + 有地板"才跳（2 格高走廊不撞头、崖边不跳下去）。
- **跑酷地形感知** `parkourAhead()` → `ok / jump / stop`：
  - `ok`：前方有地板（落差 ≤3 格摔不着）→ 照走照跳
  - `jump`：2~3 格短缺口、对面同层有落脚面 + 头顶净空 → **疾跑起跳跨过去**
  - `stop`：宽缺口 / 虚空（前探 6 格无落脚点）→ **绝不迈这一步**，站住并汇报
- **接入点 4 处**：`follow.ts`(跟随) / `startDistanceGear`(move-to、寻路就位) /
  `walkStraightTo`(短距直线走) / `movement.ts` walk-path —— 一处改，全局一致。
- **卡死自救**：900ms 无进展 → 探正前方是不是 2 格实心墙 → 是就"垫方块爬上去"；
  寻路卡住的报错会附上「正前方是虚空/悬崖」，让大脑能解释"我过不去这缺口"。
- **走廊专用** `walk-path` v2：投影式推进（航向顺当前走廊段，越过节点才换段）、卡住自动跳跃、
  分批执行 + 轨迹 CSV 兜底（调参用）。

## 4. 已验证的行为（真实服务器实测）

- ✅ 跟随：站侧后方、走/疾跑/跑跳自动换档、被甩远会**开口喊玩家等等**（台词现编）
- ✅ 跑酷地图：短缺口起跳跨过、宽缺口/虚空前站住（此前会直接走进去摔死）
- ✅ 挖矿链：木镐 → 石镐 → 铁 → 钻石镐 → 黑曜石 → 下界门 → 进下界 → 走回门传回主世界
- ✅ 记忆：跨重启记得玩家偏好（如"喜欢石头房子"）、事件时间线、地标坐标
- ✅ 地形/视觉：顶视图渲染、逐格方块查询、实体定位
- ✅ 图纸建造：`.schem` 解析 + 创造模式自动补料 + 从地板逐层放置（老 `.schematic` 不支持）

## 5. 已知限制（诚实清单）

1. 跑酷只能跳 **≤3 格**缺口；4 格以上的大步跳不冒险 → 站住并喊人（不是 bug，是保守策略）
2. 大脑后端目前只接了 AstrBot 的 HTTP 接口（`config.brain.mode="astrbot"`），未解耦
3. 记忆是 JSON 文件（无并发保护、无跨世界隔离），量大后可换 SQLite/向量库
4. 没有单元测试/CI；只有脚本级验证（`tools/test-mcp.js`、`self-check`、开发期 `verify-*.cjs`）
5. 图纸只认 `.schem`（1.13+ 新格式），老 MCEdit `.schematic` 会直接报错（不静默变石头）
6. 部分工具需 OP/创造模式（`fill-region`、`creative-give`、`build-schem` 补料步骤）
7. 移动对"1 格宽走廊 + 拐角"是靠专用 `walk-path` 路点执行器，不是通用寻路（通用寻路在窄走廊会卡）

## 6. 版本与历史包

| 版本 | 状态 |
|---|---|
| v1.6.0 | **当前**（本包）：跑酷地形感知统一化、跟随 v28、press-block、移动档位距离感知、walk-path v2 |
| v1.3.0 / v1.2.0 / v1.1.0 / v1.0.0 | 历史归档 zip（见 `release/`，早期包只含 `dist/`，无 `src/`）|

（早期版本的逐条变更散落在根目录各文档：`MCP_RECONNECT_FIX.md`、`AGENT_DEPLOY.md`、
`DESIGN_A1_NETHER.md`、`PROJECT_DOC.md`——后者是内部开发日志，按日期记录需求与踩坑。）

## 7. 下一步建议

见 `HANDOFF.md` §6 的"适合外包/接手的任务清单"（测试与 CI、跑酷强化、大脑解耦、记忆升级、
建造队列、管理面板、多 bot 协同、文档与演示视频）。
