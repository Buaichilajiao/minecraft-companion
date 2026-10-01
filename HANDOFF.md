# minecraft-companion — 交接 / 外包说明（HANDOFF）

> 一个把 **Minecraft 里的 AI 同伴**拆成"身体 + 工具 + 大脑"三层的开源项目。
> 身体用 mineflayer（真连服务器、真走路真挖矿），能力以 **68 个 MCP 工具**暴露，
> 大脑是外部 LLM（当前实现接 AstrBot，可替换）。
>
> - 版本：**1.6.0**（package.json）
> - 运行环境：Windows / PowerShell 5.1+ 已验证；Node.js **v24.20.0** + npm 11.19.0（Node ≥ 18 即可）
> - 目标服务器：Minecraft Java **1.21.1**（mineflayer 4.x）

---

## 1. 五分钟跑起来

```powershell
# ① 装依赖（注意：mineflayer-schem 走 GitHub tarball，网络不通就用随包 vendor/ 里的副本，见 §4）
npm install

# ② 配置：复制模板后填自己的
Copy-Item config\config.example.json config\config.json
#   必填：mc.host / mc.port / mc.username / mc.password(或 auth 方式)
#   选填：brain.baseUrl(AstrBot 地址) / brain.apiKey

# ③ 编译 + 启动
npm run build
npm start
#   或带日志轮转地启动（推荐，日志写 logs/restart.log，自动切 .1/.2/.3）：
.\restart-with-rotate.ps1
```

启动成功会打印 MCP 服务端口（默认 **3001**，SSE 端点 `http://127.0.0.1:3001/sse`）。
自检脚本：

```powershell
node tools/test-mcp.js               # 列工具 / 冒烟调用
node -e "require('./dist/selfcheck')"     # 系统自检（游戏连接/状态/移动/背包/方块/记忆/MCP）
# 或直接让大脑调 self-check 工具
```

## 2. 接大脑（两种用法）

| 用法 | 说明 |
|---|---|
| **独立跑** | 只 `npm start`，然后任何 MCP 客户端（Claude Desktop、自研 agent…）连 `:3001/sse` 直接调 68 个工具 |
| **配 AstrBot** | AstrBot 里注册 MCP server（名称随意，SSE 地址同上）。`config.brain.mode="astrbot"` + `baseUrl` 指向 AstrBot 的 HTTP 接口 → bot 会把"该说什么/该做什么"交给 AstrBot 的大模型决定 |

⚠️ **本项目不改 AstrBot 本体**：只通过 MCP 协议对接。`patches/astrbot-mcp-autoreconnect.patch` 是可选的
上游补丁（修 AstrBot 的 MCP 会话重连），**要不要打、怎么打，由你评估**。

### MCP 掉线自愈（必读，否则你会以为"工具全坏了"）
mineflayer 进程重启后，AstrBot 侧的 MCP 会话会**静默失效**（面板还显示已连接，但每次调用都报
`MCP session is not available`）。本仓库自带看门狗：`mcp-watchdog.ps1`
（参数全部可配、无硬编码本机路径）：

```powershell
# 单次检查（配合计划任务每 30s 跑一次）
.\mcp-watchdog.ps1 -CmdConfig "C:\AstrBot\data\cmd_config.json" -Once
# 常驻循环
.\mcp-watchdog.ps1 -CmdConfig "C:\AstrBot\data\cmd_config.json" -IntervalSec 15
```
watchdog 监听 bot 端口（默认 3001），发现 bot 重启或 AstrBot 报断连 → 自动 PATCH
`/api/v1/mcp/servers/enabled` 触发重连（直连 PATCH 失败会自动回退 disable→enable 再试）。
原理与排障见 `MCP_RECONNECT_FIX.md`。

⚠️ **别信面板的"已连接"**：判断依据是**工具数**。`connected:true 但 tools:0` = 与会话已死的假阳性，
这种情况连 disable 都会超时（实测 2026-09-12），watchdog 也救不回来 → 只能重启 AstrBot 让
`mcp_client.py` 补丁自己在下次调用时重连。三种状态的对照表在 `MCP_RECONNECT_FIX.md` 末尾"实测补充"。

## 3. 目录结构

```
src/            源码（TypeScript）
  tools/        68 个 MCP 工具的实现（movement/building/combat/items/skills…）
  skills/       技能脚本（挖铁/挖钻石/黑曜石/下界门/回主世界…）
  engine/       任务引擎（solo / coop / nether-chain）
  bot-connection.ts  连线、事件、头身朝向
  guardian.ts   护卫/战斗/撤退
  memory-v2.ts  记忆层（身份/偏好/事件/地标/目标）
  companion.ts  陪伴层（跟随、闲聊、事件播报、生活感）
dist/           已编译产物（开箱即跑；改 src 后 npm run build）
config/         config.example.json（模板）｜config.json（你的，**别提交**）
schematic/      示例图纸 .schem（maze / test_house / obsidian_floor_64）
vendor/         mineflayer-schem 离线副本（GitHub 装不上时用）
tools/          开发期脚本（迷宫生成/移动测速/轨迹抓取等，Python + Node）
patches/        可选的上游补丁
docs(根目录)    README / README_EN / PROJECT_DOC（内部开发日志）/ AGENT_DEPLOY / DESIGN_A1_NETHER
```

## 4. 依赖与坑

- `mineflayer-schem` 在 package.json 里是 **GitHub tarball 地址**：公司网络/大陆网络可能装不上。
  改用本地副本：
  ```powershell
  npm install .\vendor\mineflayer-schem
  ```
- **Node ≥ 18**（用了 fetch/AbortController 等）；本机验证于 v24.20.0。
- 服务器要开 `online-mode` 对应你的认证方式：模板里默认走 **littleskin(yggdrasil)**
  （`mc.authServer`），正版服请改成 `auth: "mojang"` / 皮肤站自己的地址，或直接填 `password`。
- 部分工具要权限：`fill-region`、`creative-give`、`build-schem` 需要创造模式/OP；沙盒服里请给 bot 足够权限。
- 图像类工具（`look` 顶视图渲染）依赖 `pngjs` + `prismarine-viewer`，首次渲染稍慢。

## 5. 目前完成度（详见 `PROGRESS.md`）

- ✅ 身体层：连线/断线重连、跨版本(1.21.1)、头身朝向解耦（直写 yaw + 解除发包限速）、
  走/疾跑/跑跳三档拟人移动（距离感知、自动收步）、寻路 + 卡死自救（挖挡路块/垫脚爬上）
- ✅ 工具层：**68 个 MCP 工具**（移动/建造/战斗/物品/农业/钓鱼/记忆/社交/视觉/图纸/技能链）
- ✅ 地形感知（跑酷）：`parkourAhead()` 统一判 `ok / jump / stop` ——
  短缺口（2~3 格）疾跑起跳跨过去，宽缺口/虚空**绝不迈**；跟随、move-to、walk-path、直线走**共用同一套**
- ✅ 记忆层 v2：身份/偏好/事件时间线/地标/目标，落 JSON，跨重启保留
- ✅ 陪伴层：跟随、站定闲聊、受伤/天气/昼夜/维度事件口播、生活感行为
- ✅ 引擎：单人主线、协作、下界链（挖钻→黑曜石→传送门→进出下界）里程碑
- ⚠️ 未做：单元测试/CI、大脑后端解耦、GUI 面板、多 bot 协同（见 §6）

## 6. 适合外包/接手的任务清单（按性价比排序）

1. **跑酷地图能力强化**：更宽缺口的多段跳、边缘精确起跳、落点预测（当前只敢跳 ≤3 格）
2. **测试与 CI**：把开发期的 `verify-*.cjs` 脚本整理成 vitest/jest 测试 + GitHub Actions
3. **大脑解耦**：除 AstrBot 外，支持任意 OpenAI 兼容接口 / 本地模型（`config.brain` 已留位）
4. **记忆层升级**：JSON → SQLite/向量检索；多世界/多服务器记忆隔离
5. **建造系统**：图纸任务队列、分区块断点续建、进度可视化
6. **管理面板**：CLI/TUI 或 Web 面板（启停、实时日志、地图缩略图、工具调用统计）
7. **多人协同**：多 bot 分工（一个挖矿一个跟人）、互相喊话
8. **文档/演示**：英文文档润色、录一段"从零到挖到钻石"的视频

## 7. 开发约定（改代码前先看）

- 新增工具：在 `src/tools/<域>.ts` 里 `mcp.registerTool(name, description, zodInputSchema, handler)`，
  描述里写清**什么时候用**（大脑是按描述选工具的），注册处加进 `src/tools/index.ts`。
- 移动相关**不要各写各的**：档位用 `pickGear/applyGear`、地形用 `parkourAhead/hopPathClear`，
  都在 `src/tools/helpers.ts`（跟随/寻路/直线走共用；改一处全局生效）。
- 日志：`log('INFO'|'WARN'|'ERROR', msg)` → 写 `logs/`；排查先看 `logs/restart.log`。
- 自检：改完跑 `self-check`（MCP 工具或 `node -e "require('./dist/selfcheck')"`）逐项过一遍。
- **不要提交** `config/config.json`（含密码/密钥）、`logs/`、`data/`（含运行记忆）。
  `.gitignore` 已挡住。

## 8. 包里没有的东西（有意排除）

`node_modules/`、`logs/`、`data/`（运行记忆与地标，含真实玩家数据）、`config/config.json`（**含真实密码与 API key**）、
`state.json`、调试期脚本与轨迹 CSV、历史 zip。`config/config.example.json` 是脱敏模板，直接用。

---
有任何地方对不上（版本、依赖、跑不通的步骤），直接在 issue/文档里标出来——接手时最大的成本就是"文档与代码不一致"。
