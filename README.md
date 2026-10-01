# ⛏️ minecraft-companion — Minecraft AI 伴侣（MCP 服务器）

一个跑在 Minecraft 里的 AI 机器人：**mineflayer 当身体，大模型当大脑，MCP 当接口**。
任何支持 MCP 的客户端（AstrBot / Claude / Cursor / 自写脚本）都能通过 SSE 连上来，指挥机器人做游戏内操作。

---

## ✨ 特性

- 🧠 **大脑桥（默认接 AstrBot）**：机器人不直连 LLM，统一走 AstrBot `/api/v1/chat` —— **同一个脑子**：QQ 和游戏里是同一个 AI，共享人格+记忆，零 API key 配置
- 🎒 **创造模式工具**：`creative-give` 协议级发放任意物品，不需要 `/give` 权限
- 🪃 **跟随玩家**：`follow-player` 持续跟随（动态寻路、掉线自愈、可指定玩家）
- 🔒 **身体控制权锁**：guardian 保命 > 玩家任务 > 自主生活，动作类工具统一走 `withBody`，多客户端不会抢身体
- ⚔️ **战斗 / 生存 / 采集**：自动寻路打怪、生存守护（残血撤退、自动进食）
- 📊 **49 个 MCP 工具**（13 分类）：感知、移动、建造、采集、合成、熔炼、农业、战斗、仓库、创造、技能、记忆、社交，全协议实现

---

## 🤖 AI Agent 部署？（一句话部署）

如果你是 AI agent（LLM），用户丢给你压缩包说"部署好让我玩我的世界"：

> 📖 看 **`AGENT_DEPLOY.md`** —— 专为 AI 写的部署指南（一键命令 + 配置决策表 + 排查清单）
> 一句话方案：解压 → `node setup.js --auto` → `node dist/main.js` → 接入 MCP `:3001/mcp`

### 智能配置引导（人和 AI 通用）
```powershell
node setup.js          # 交互式，Enter 用默认值
node setup.js --auto   # 全自动：装依赖 + 检测 AstrBot + 生成配置
```
- 自动探测本机 AstrBot(6185) → 大脑走 **astrbot 桥模式，无需 API key**
- 不在 AstrBot 环境 → 需提供 OpenAI 兼容 API key（或 `brain.mode=none` 纯工具模式）
- 已有配置自动备份 `.bak`

## 🚀 快速开始

### 1. 环境要求
- Node.js **18+**
- 一个 Minecraft **Java 版服务器**（1.20 ~ 1.21.1，`1.21.1` 实测）
- 正版 / **离线 / Yggdrasil（LittleSkin 等外置登录）** 账号

### 2. 安装
```bash
npm install
```

### 3. 配置
```bash
# 首次使用：把模板复制成正式配置，然后填自己的服务器和账号
copy config\config.example.json config\config.json
```
编辑 `config/config.json`（字段含义见 [配置说明](#-配置说明)）。

### 4. 启动
```bash
npm start          # 或 node dist/main.js
```
看到以下日志即成功：
```
✅ 已进入游戏！位置: (x, y, z)
🛡️ 生存守护已启动
🛰 MCP SSE 服务: http://127.0.0.1:3001/mcp
```

### 5. 接入 MCP 客户端
SSE 地址：**`http://127.0.0.1:3001/mcp`**
- **AstrBot**：MCP 服务器添加 SSE 类型，填上面的地址（支持多客户端，可带 `?clientId=名字` 区分）
- **Claude Desktop / 其他**：用 SSE transport 指向同一地址
- 自写脚本：参考 `tools/test-mcp.js`（`node tools/test-mcp.js <工具名> "参数=值"`）

---

## ⚙️ 配置说明

| 字段 | 说明 |
|---|---|
| `mcpPort` | MCP SSE 服务端口（默认 3001） |
| `mc.host` / `mc.port` | Minecraft 服务器地址 / 端口 |
| `mc.username` / `mc.password` | 机器人账号 |
| `mc.auth` | 登录方式：`offline` / `microsoft` / `yggdrasil`（外置登录） |
| `mc.authServer` | 外置登录认证服务器（LittleSkin 等填自己的地址） |
| `brain.mode` | `astrbot` 走 AstrBot 大脑桥（默认，无需 key）/ `llm` 直连大模型 / `none` 关闭大脑（仅工具） |
| `brain.baseUrl` / `apiKey` / `model` | OpenAI 兼容 API 地址 / 密钥 / 模型名（`astrbot` 模式只填 `baseUrl`） |
| `brain.sessionId` | 记忆会话 ID |
| `guardian.enabled` | 生存守护：残血（`retreatHp`）撤退、饥饿（`eatHp`）进食 |
| `lifestyle.enabled` | 生活模式（自动探索/学习，默认开） |

---

## 🧰 工具清单（MCP tools，共 49 个）

| 分类 | 工具 |
|---|---|
| 感知 (9) | `get-state` `find-blocks` `find-entity` `get-block-info` `observe` `look` `read-chat` `list-inventory` `find-item` |
| 移动 (7) | `move-to` `move-direction` `jump` `look-at` `fly-to` `follow-player` `stop-follow` |
| 建造 (2) | `place-block` `build-shelter` |
| 采集 (4) | `dig-block` `collect-tree` `mine-ore` `pickup-item` |
| 合成/熔炼 (2) | `craft-item` `smelt-item` |
| 仓库 (3) | `chest-deposit` `chest-withdraw` `drop-item` |
| 战斗 (2) | `attack-nearest-hostile` `attack-entity` |
| 生存 (3) | `eat` `sleep` `equip-item` |
| 农业 (5) | `till-land` `plant-seed` `harvest` `fish` `breed-animal` |
| 创造 (1) | `creative-give` ★协议发物品 |
| 技能 (5) | `skill-setup-base` 新手起步 `skill-mine-iron` 挖铁 `skill-plant-farm` 种田 `skill-explore` 探索 `skill-surprise` 惊喜动作 |
| 记忆/目标 (4) | `memory-read` `memory-write` `set-goal` `get-goals` |
| 社交/系统 (2) | `send-chat` `self-check` |

---

## 🔁 MCP 断连自愈与日志（排查指南）

**问题**：AstrBot ↔ 本 bot 的 MCP 连接是**一次性 SSE**。bot 重启 / AstrBot 后启动时，
连接会静默失效——AstrBot 后台甚至可能仍显示"已连接"（它只检查运行时对象，
不检查真实 session），但每次工具调用都报
`MCP session is not available for MCP function tools.`

**三层自愈（按推荐顺序，A 必须有，B/C 可选）**：

**A. 游戏内直报（本仓库内置，无需配置）**
`src/brain.ts` 检测到工具调用因 session 不可用而失败时，不再把 LLM 编的假话发给玩家，
而是直报"我跟大脑的连接断了"，并在 `logs/app.log` 留 WARN。玩家看到后去后台重存一次即可恢复。

**B. watchdog 自动重连（推荐，开源可用，无硬编码路径）**
`mcp-watchdog.ps1`：轮询 bot 端口(:3001)，检测到 **down→up 重启边沿**或
AstrBot 后台报 disconnected / 0 工具时，自动调 AstrBot 管理 API
`PATCH /api/v1/mcp/servers/enabled` 触发重连。零 token、纯本地 HTTP。

```powershell
# 常驻模式
.\mcp-watchdog.ps1 -CmdConfig <你的AstrBot>/data/cmd_config.json
# 单次检查（适合计划任务，每 30s 跑一次）
.\mcp-watchdog.ps1 -CmdConfig <你的AstrBot>/data/cmd_config.json -Once
# 或设环境变量，参数可省
$env:ASTRBOT_CMD_CONFIG = '<你的AstrBot>/data/cmd_config.json'
.\mcp-watchdog.ps1 -Once
```

> watchdog 从 `cmd_config.json` 的 `dashboard.jwt_secret` 自签 JWT 调管理 API，
> 仅需**后台管理账号密码在 cmd_config 里有 jwt_secret**（默认有），不依赖外置密码。
> 状态存 `logs/mcp-watchdog.state`，脚本重启不会误判"重启边沿"。

**C. AstrBot 源码补丁（可选增强，治"后台假连接"）**
`patches/astrbot-mcp-autoreconnect.patch`：给 AstrBot 的 `mcp_client.py` 打补丁后，
session 丢失时**调用前自动重连一次**，玩家无感恢复。属可选：
AstrBot 升级会覆盖，需重打。

```powershell
# 备份原文件后应用（补丁内路径相对 AstrBot 安装根目录）
cd <你的AstrBot根目录>
git apply --no-index 或 patch -p1 < minecraft-companion/patches/astrbot-mcp-autoreconnect.patch
# Windows 无 patch 命令时：用文件对比工具手动照补丁改，或重新打
```

**🔍 出问题先查日志（都在本仓库 `logs/` 下，自动轮转）**：

| 日志 | 内容 | 什么时候看 |
|---|---|---|
| `logs/app.log` | bot 全生命周期：连接/掉线/重连、MCP 客户端连上/断开、大脑调用、MCP down 直报、自检 | 默认排障入口 |
| `logs/restart.log` | 启动脚本 stdout/stderr（`restart-with-rotate.ps1` 启动时） | bot 崩溃/启动失败 |
| `logs/mcp-watchdog.log` | watchdog 每次探测结果、PATCH 触发原因 | MCP 莫名断连 |

快速搜关键行：
```powershell
Select-String -Path logs\app.log -Pattern "ERROR|WARN|断开|重连|session|直报" | Select-Object -Last 30
```

---

## 🛠️ 常见问题

**Q：AstrBot 侧 MCP 显示"未连接"或工具数 0？**
A：先启动 bot、后启动 AstrBot（或 bot 重启过）时注册不会自动补。去 AstrBot MCP 服务器设置里**重新保存/编辑一次该服务器**（触发 PATCH）即可重连；或按"先 bot 后 AstrBot"的顺序启动。

**Q：建房卡住一直刷 "No available actions"？**
A：图纸起点悬空或 chunk 未加载。已自动处理（自动走位加载 chunk + 45s 停滞取消）；手动调用旧版时请让 bot 先走到建造区。

**Q：creative-give 发了物品但背包没有？**
A：快捷栏槽位（0-8）部分服务器保护，已自动跳过；若全被拒，检查 `mc.auth` 是否有权限 / 是否创造模式。

**Q：连不上 MCP？**
A：确认 `mcpPort` 没被占用，`http://127.0.0.1:3001/mcp` 浏览器能返回 SSE 响应。

**Q：机器人不动 / 动作冲突？**
A：身体控制权锁机制下，观察类工具不占用身体，动作类同一时刻只允许一个会话执行（guardian 保命可抢占）。等 2 分钟无动作自动让出。

---

## 🔧 开发说明

- `src/` 是**唯一源码**（TypeScript），改功能请改 `src/`，然后 `npm run build` 产出 `dist/`，重启生效
- `dist/` 是 tsc 编译产物，**不要手改 dist**（会被下次 build 覆盖）；早期 v1.0/1.1 时代的"dist 手改"说明已废弃
- `npm run build` 编译检查 + 产出；`tsc --noEmit` 仅类型检查
- `tools/test-mcp.js`：免客户端调用工具，调试神器
- 新增工具：在 `src/tools/xxx.ts` 里 `mcp.registerTool(...)`，并在 `src/tools/index.ts` 注册
- 动作类工具会自动走身体锁（`mcp-server.ts` 的 ACTION_TOOLS 白名单）；技能侧复合动作在 `src/skills/index.ts`

## 📄 免责声明
- 机器人使用你的账号登录，**请遵守服务器规则**，勿用于作弊/破坏
- 配置文件含账号密码与 API Key，**请勿提交到公开仓库**
- 项目仅作学习交流，作者不对滥用行为负责

---

## 📦 版本记录

## 📦 版本记录

### v1.6.0 (2026-09-05) · P2
- 🎣 **真实钓鱼流程（P2-1）**：旧版"8s 硬收杆"（activateBlock 假抛竿、不检测咬钩）→ 新 `src/tools/fishing.ts` 共用核心 `fishOnce`：找水→就位→抛竿→等咬钩（mineflayer 粒子检测自动收杆）→背包快照 diff 判定鱼获。MCP `fish` 工具与 lifestyle `fish` 技能同一实现（同 buildShelterCore 思路，杜绝工具/技能逻辑分裂）；稀有鱼获（bow/enchanted_book/name_tag/nautilus_shell/saddle）触发 `fished_rare` 情绪 + 短期记忆
- ⚡ **事件双轨制落地（P2-2）**：危险类改**状态型 + 事件双轨** —— `events.ts` scanDanger 改边沿触发（威胁**首次进入警戒 / 等级升级**才发事件并触发情绪；离开警戒范围复位，恢复后新威胁可再提醒），"周围持续有谁"改由每次上下文构建的状态轨注入，事件层不再 60s 重复刷屏（同样根治"不满足前置条件不硬上"）
- 🧩 **聊天上下文组装器（P2-3）**：新增 `src/chat-context.ts` ChatContextBuilder，统一组装 `world / self / danger状态轨 / player / recent_events / chat_history / shared_memories / player_observations / avoid_topics / 情绪语气` 喂给大脑；玩家消息与自主 trigger 共用；`brain.ts` 保留旧拼接作未装配时兜底
- 📉 **情绪衰减接入确认（P2-4）**：核验 lifestyle tick 每 5s 已调 `emotion.decay()`（v1.4 已接），本轮技能 ctx 增加可选 emotion getter，自主钓鱼等技能路径同样能触发情绪
- 📜 **日志轮转（P2-5）**：`utils.ts` app.log 超 2MB 自动 size 轮转（保留 3 份）；新增 `restart-with-rotate.ps1` 启动脚本（stdout/stderr 重定向 + 启动前 size 轮转），替代外部裸 `> restartN.log` 无限增长的重定向方式
- 🎯 版本 bump → 1.6.0

### v1.5.0 (2026-09-05)
### v1.5.0 (2026-09-05)
- 🧠 **记忆层 v2（蓝图第六节落地）**：新增 `memory-v2.ts` + 独立 `memory2.json` —— 短期记忆（session 内 importance 淘汰）、长期记忆（地点/带情感事件/人物/成就/失败）、对话记忆（话题冷却 300s / 玩家画像 / 滚动摘要）。**v1 memory.json 结构与写入零改动**，两层并存。大脑上下文自动注入「记忆段」（短期印象/熟悉地点/难忘往事/画像/话题避免）
- 🎬 **事件源接情绪补齐（P0-2）**：guardian 濒死撤退 → 后怕(almost_died)、死亡 → 沮丧(lost_items)；挖到钻石 → 兴奋+成就事件+长期记忆；建成小屋 → 满足+长期事件
- 🧩 工具上下文新增 emotion/eventBus/memoryV2 注入通道（getter 形式，断线重连安全）
- 🧪 验证：`verify-memory-v2.cjs` 10 项断言全过（含畸形文件/损坏 json 防御）
- 🎯 版本 bump → 1.5.0

### v1.4.0 (2026-09-05)
- 🧩 **情绪+事件接线 v1（蓝图"注入不干预"落地）**：`emotion.ts` / `events.ts` 正式启用——lifestyle 每 5s tick **复用状态快照**做世界事件扫描（危险/环境/社交/成就，60s 去重），触发情绪（紧张/后怕/宁静…）并自然衰减（3%/tick）；大脑上下文注入「当前情绪 + 刚发生的事」——只作语气参考，不干预决策
- ⚡ **性能**：EventWatcher 扫描从 4 次全量 `getStatus()` 收敛为 1 次（复用 lifestyle 快照）
- 🎯 版本 bump → 1.4.0（v1.3.2 = ① 重连泄漏修复快照）

### v1.3.2 (2026-09-05)
- 🐛 **修复断线重连泄漏**：Guardian/Lifestyle/Companion 统一优雅 detach（定时器+监听器全清），断线/重连不再残留后台定时器抢身体——模拟 5 轮重连实测零泄漏（`verify-reconnect.cjs` 自检通过）
- 🛡️ **防崩溃**：陪伴层延迟问候/关心补 try/catch，断线后触发不再可能炸进程
- 🧩 **新增基础模块**：`emotion.ts`（情绪系统 valence/arousal，13 事件触发+衰减）与 `events.ts`（事件层 EventBus/EventWatcher，危险/环境/社交/成就检测）——为"人类视角感知 + 世界主动推送"铺路（本版未启用，接线见后续版本）
- 🎯 版本号正式 bump 1.3.0 → 1.3.2

### v1.3.0 (2026-08-31)
- 🪃 **跟随玩家**：新增 `follow-player` / `stop-follow`（动态寻路、1.5s 检测、掉线自愈、身体锁独占）
- 🔒 **身体锁补全**：`jump` / `fly-to` 等动作工具统一走 `withBody`，与 body-controller 白名单对齐，杜绝抢身体
- 🧠 **大脑桥纯转发版**：brain 不再内置人设/直连 LLM，统一转发 AstrBot `/api/v1/chat`（人设与记忆归 AstrBot 管，bot 只当"传话筒+执行手"）
- 🔗 **MCP 多客户端**：SSE 支持 `?clientId=名字` 区分多方控制
- 📊 **49 个工具**（13 分类）全量可用
- 🐛 修复：建房期间大脑不再重复指挥（工具互斥）、欢迎语跨进程持久化不重复刷
- 🗑️ 清理：移除已停用的 `build-schem` 工具引用与示例图纸（开源合规检查）

### v1.2.0 (2026-08-30)
- 🤖 **AI 一键部署**：新增 `AGENT_DEPLOY.md`（给 AI agent 的部署指南）+ `setup.js` 智能配置引导（`node setup.js --auto` 全自动：装依赖/检测 AstrBot/生成配置/已有配置保护）
- 🧠 **大脑免配置**：自动探测本机 AstrBot(6185) → 自动选 astrbot 桥模式，无需 API key
- 🔗 **寻路大升级**：换用 `@nxg-org/mineflayer-pathfinder@0.0.26`，gotoSmart 卡住自救链（挖方块→tp→喊救命）
- 🛡️ **配置校验增强**：启动时明确报出缺失字段，并提示用 setup.js 引导
- 📖 README 新增"AI Agent 部署"快速入口

### v1.1.0 (2026-08-30)
- 📘 新增 **PROJECT_DOC.md** 项目总文档（初心实录/架构/计划/踩坑记录）
- 🧠 **大脑记忆注入**：每次回复前把「当前目标 / 历史目标 / 玩家偏好 / 最近经历」拼进上下文，机器人不再"失忆"
- 🔒 **单活跃控制者锁**：动作类工具同一时刻只允许一个会话执行，其他会话提示"bot 正被另一个会话控制"，2 分钟无动作自动让出
- ⏱️ **建房停滞检测**：build-schem 45 秒无实际进度自动取消并播报
- ✂️ **修复双句回复**：send-chat 直接发话后 5 秒内大脑不再重复转发
- 📣 **欢迎语只发一次**：跨进程/断线重连不再重复刷欢迎语

### v1.0.0 (2026-08-29)
- 首个可运行版本：mineflayer 身体 + AstrBot/LLM 大脑 + MCP SSE 接口
- 40+ MCP 工具：感知 / 移动 / 放置 / 合成 / 熔炼 / 钓鱼 / 繁殖 / 种田 / 战斗 / 图纸建房 / 创造模式发物品

---

## 🙏 Acknowledgements / 致谢

本项目功能的设计与实现思路，参考并受以下开源项目启发，在此致谢
（本项目代码均为**独立实现**，与下列项目无代码复用关系；各项目版权归原作者所有）：

| 项目 | 许可证 | 启发点 |
|---|---|---|
| [yuniko-software/minecraft-mcp-server](https://github.com/yuniko-software/minecraft-mcp-server) | Apache-2.0 | 用 MCP 协议控制 mineflayer 机器人的整体思路 |
| [mindcraft-bots/mindcraft](https://github.com/mindcraft-bots/mindcraft) | MIT | LLM 驱动 mineflayer 玩 Minecraft 的玩法 |
| [PrismarineJS/mineflayer](https://github.com/PrismarineJS/mineflayer)（及 minecraft-data / pathfinder 等生态） | MIT | 机器人的身体（mineflayer 及其生态依赖库） |

本项目以 **MIT** 协议开源。
