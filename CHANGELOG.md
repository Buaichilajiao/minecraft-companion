# 改动说明（CHANGELOG）

> 本项目没有 git 历史，此文件人工维护，记录关键代码变动。
> 时间均为中国标准时间（UTC+8）。

---

## 2026-10-01 · 发布收尾：推送到 Gitee，仓库规范化

- 初始化 git 并推送完整代码到远端 `buaichilajiao/minecraft-companion`（`main` 分支）
- 远端默认分支由空 `master` 切至 `main`，并删除残留的空 `master` 分支
- 补充 `.gitignore`：忽略 `*.bak-*` 开发备份文件
- 入库 `knowledge/pending.json`（空态占位，规范化 knowledge 目录结构）
- 敏感扫描：确认 `config/config.json` 未入库，仓库内无硬编码密码 / API key
- 统一行结束符为 LF（`.gitattributes` + `core.autocrlf`）

## 2026-10-01 · A1 陪伴第一批：反射 / 闲逛 / 心跳 / 护人四边界压测通过

### 背景
给 XiaoBai 补齐"陪伴型"核心：快速反射响应、自主闲逛心跳、以及护住玩家的战斗安全。
重点重构了护人战斗（`src/guardian.ts`）从"串行单目标"改为"多威胁穿插处理"。

### 陪伴能力（已实机压测通过）
- **反射（`src/reflect.ts`）**：玩家语音/动作指令毫秒级响应（`tools/test-reflect.js`）。
- **闲逛 / 心跳（`companion.ts` / `lifestyle.ts` / `emotion.ts`）**：空闲时自主走动、定时心跳反应、情绪化回应，不挂机呆滞。
- **护人战斗（`src/guardian.ts`）**：守护"被怪物逼近的玩家"。

### 护人边界：四条全通（含关键修复）
| 边界 | 场景 | 结果 |
| ---- | ---- | ---- |
| ① | 单苦力怕贴玩家 | 锁目标到底（id 直取防重扫丢目标）、引离持续执行，creeper 被带离消失，玩家满血 |
| ② | 锁/目标链（drop 后抢回、回退重扫仅兜底） | 目标一路传到底，引离不再中途断链 |
| ③ | 混合团战（creeper+zombie 同贴） | **关键修复**：从"串行引离 creeper 11s 导致门被 zombie 群殴死"改为**引离与清硬刚怪穿插执行**，17.8s 清场，玩家全程满血 |
| ④ | 末影人贴玩家 | 走 `NO_PROVOKE` 引离分支，瞬移特性下也牵制成功，玩家无伤 |

### 代码改动
- `src/guardian.ts`：重构护人逻辑 —— 加 `nearestHardHostileNearPlayer`（可硬刚怪）与穿插补刀步骤，引离循环每轮先砍贴玩家的僵尸/骷髅再继续引离苦力怕；
  修正拉离日志文案：`gotoSmart` label 由硬编码「引离苦力怕」改为动态按目标名（`引离enderman`/`引离苦力怕`）；
  新增 `cheapPos` 安全读坐标工具。
- `src/reflect.ts` / `companion.ts` / `main.ts` / `emotion.ts` / `config.ts` / `lifestyle.ts`：陪伴与心跳相关联动。
- 测试脚本：`tools/test-creeper.js` / `test-mixed.js` / `test-ender.js` / `test-reflect.js`（新增），
  并新增 `tools/companion-suite.js` 一站式跑完四条压测。

### 实测结论
本地 1.21.1 服（HMCL 可复验）：四条边界 Tester 全程满血无伤，团战穿插处理 17.8s 清场。

---

## 2026-09-29 · 跨端记忆桥（cross-memory）：解决 QQ↔游戏两边失忆

### 背景 / 断裂点

历史遗留问题"记忆同步"：小白在 QQ 里认识玩家、进了 Minecraft 就失忆。
调研确认 AstrBot 按 (platform_id, user_id) 分账记忆，QQ 平台（`default`）与游戏回传
（OpenAPI 硬编码 `webchat`）是完全独立的 conversation 行；OpenAPI 也没有按 umo 拉历史的端点。

### 方案（沿用《接手指引》既定方向：另开跨端记忆文件，而非啃 AstrBot 内部插件）

- 新建 `src/cross-memory.ts`：`CrossMemory` 类，独立落盘 `data/cross-memory.json`，
  按 person 组织（主键优先 QQ 号，未命中映射退回 MC 名），每人 facts 最多 40 条、
  单条 200 字、注入取最近 12 条，source 区分 qq/game。
- 新建 `src/tools/cross-memory-tools.ts`：暴露 `cross-memory-write` / `cross-memory-read`。
- 改 `src/tools/context.ts`、`src/tools/index.ts`（注册，模块 20→21）、`src/main.ts`
  （顶层实例化并接入 ctx 与 BrainBridge）。
- 改 `src/brain.ts`：callBrainAstrbot 解析身份后自动把该 person 的跨端记忆前置注入；
  改 `src/chat-context.ts`：加入游戏侧主动写回的引导。

### 实测结果（本地 1.21.1 服，HMCL 可复验）

- 工具读写正常；companion 重启后日志出现 `↳ 已注入跨端记忆（person=3693500901）`。
- 玩家在游戏里问"我是谁、喜欢把房子盖在哪"，小白当场答出
  **「当然记得！你叫辣椒，你喜欢把房子盖在山顶上」**——进游戏不再失忆。
- 已在 QQ 与小白同步四条使用规则，小白确认会主动按规则写/读。

MCP 工具数：74 → **76**。

---

## 2026-09-29 · 下界链路打通：nether_portal 方块名 + 服务器权威就位 + 两步传送

### 背景 / 断裂点

下界三技能（build-portal / enter-nether / return-home）此前反复失败：
build-portal 放框不稳、enter/return 站进 portal 不触发传送。

### 三个根因与修复

| # | 根因 | 修复 |
| - | ---- | ---- |
| ① | 1.21.1 传送门方块注册名是 **`nether_portal`**，旧代码用 `portal` 匹配，findBlock 永远找不到、点亮检查误判 | 全项目 4 处 `portal` → `nether_portal` |
| ② | 创造模式就位靠直接设位（creativeFlyTo），被门框/障碍挡住时服务器 position 包拉回，原地振荡 60–93s | 新增 `teleportCreative`：`abilities(flags=0x0f)` + 服务器权威 `/tp` + 轮询到位；smartPlace/moveAway/placeFromAbove 创造就位优先用它 |
| ③ | bot 在门附近处于"portal cooldown/边缘残留"脏状态时，单步 tp 进中心会被推出门、不传送 | **两步传送法**：先 tp 到 portal 法向外 5 格脱离残留，等 1.2s，再 tp 进中心 |

### 实测结果（本地 1.21.1 离线服，HMCL 可复验）

- build-portal：**9.4s**（14 块框架完整、内孔 2×3 全亮、无多余方块）
- enter-nether：**10.3s**（下界出口门 (14,74,3)）
- return-home：**7.3s**（从干净状态进 portal 0.5s 传回主世界）
- 连续往返 3 次全部成功。

### 关键技术事实

- portal 方块 `boundingBox=empty`（passable），`props.axis` 决定朝向；obsidian `boundingBox=block`。
- 底框必须是 obsidian（无底框点不亮）；点火站在门外上方俯视底框，bot 不被一同传送。
- prismarine-physics 无创造飞行分支、直接设位遇障振荡 → 服务器权威 /tp 最稳。

---



### 背景 / 断裂点

`skills/mc-task-flow/SKILL.md` 要求大脑「用文件读写工具」创建 `data/tasklist/<id>.json` 长期任务表，
但 AstrBot 侧的 computer 工具（shell / fs / python）已经关闭，大脑实际上只能调用 Minecraft 的 MCP 工具，
导致长期任务永远无法真正落盘——SKILL 承诺的能力与现实断开。

### 改了什么

| 文件 | 改动 |
| ---- | ---- |
| `src/tasklist.ts` | 新增任务表读写模块：`createTask / readTask / listTasks / updateTask / advanceTask`，落盘到 `data/tasklist/<id>.json`（原子写入，id 自动 slugify） |
| `src/tools/tasklist-tools.ts` | 把任务表 CRUD 暴露成 4 个 MCP 工具：`tasklist-create / tasklist-get / tasklist-list / tasklist-set`，兑现 SKILL 承诺，让大脑能真正落盘 |
| `src/lifestyle.ts` | 挂载任务表的自动推进（`autoAdvanceRunningTask`）：步骤带 `completion` 自动完成条件时，系统检测到满足即推进，无需大脑手动逐步骤标记 |

### 关键设计

- **步骤自动完成条件（StepCompletion）**：借鉴 Maicraft TaskTracker，一条 `completion` 满足即视为该步完成：
  - `item:{item,count}` —— 背包里至少 count 个指定物品
  - `any_item:{count}` —— 背包物品总数达 count
  - `near_block` —— 附近 8 格出现指定方块
  - `no_hostile` —— 周围无敌对生物
- **任务历史（TaskHistory**）——记录 result（done/replanned/abandoned）+ 卡点，避免重复踩坑。

### 为什么这样改

不新增「让大脑写文件」的通路（那等于重开 computer 工具），而是把任务表做成 MCP 工具——
与大脑「只能调 Minecraft MCP 工具」的实际约束对齐，最小且自洽。

---

## 更早的改动（归档略）

另有知识库离线整理（`src/knowledge.ts` + `knowledge/*.md`）、
准星/挖矿检测（`src/crosshair.ts`、`src/tools/mining-check.ts`）、
建筑/追赶/移动执行器等一批改动，记录见各文件头部注释块，此处不重复展开。