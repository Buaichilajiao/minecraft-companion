# 🤖 AGENT_DEPLOY.md — 给 AI Agent 的部署指南

> **这份文档是写给 AI（LLM agent）看的，不是给人看的。**
> 用户可能只丢给你一句话："把这个 MCP 项目部署好，这个可以让你玩我的世界"。
> 你按本文档执行即可。全部命令为 Windows PowerShell 兼容。

---

## 0. 这个项目是什么（30 秒理解）

`minecraft-companion` 是一个 **Minecraft AI 机器人（MCP 服务器）**：

```
mineflayer 身体（能走/挖/放/打/聊） + LLM 大脑（DeepSeek 等）+ MCP SSE 接口(:3001)
```

- 它自己连进 Minecraft 服务器当一个小人
- 任何 MCP 客户端（包括你自己所在的主机，如 AstrBot / Claude Desktop）连上 `:3001/mcp` 就能指挥它
- 你部署完成后，你（agent）就是它的"老板"——通过 MCP 工具调用让它帮你玩游戏

---

## 1. 部署目标

最终状态：`node dist/main.js` 能跑起来，日志出现：
```
✅ 已进入游戏！位置: (x, y, z)
🛰 MCP SSE 服务: http://127.0.0.1:3001/mcp
```

## 2. 一键部署（推荐：setup.js 智能引导）

```powershell
# 假设压缩包已解压到当前目录（内含 package.json / dist / config / schematic）
cd <解压后的目录>

# 全自动部署：自动装依赖、自动检测 AstrBot、自动生成最小配置
node setup.js --auto

# 如果大脑需要直连 LLM（不在 AstrBot 环境），带上你的 key：
# node setup.js --auto --brain=llm --baseUrl=https://api.deepseek.com/v1 --apiKey=sk-xxx --model=deepseek-chat

# 启动
node dist/main.js
```

`setup.js` 会替你完成：
- ✅ 检查 Node ≥ 18
- ✅ 缺依赖自动 `npm install`
- ✅ 已有 config.json 则备份为 `.bak`
- ✅ **自动探测本机 AstrBot(127.0.0.1:6185)** → 大脑自动选 `astrbot` 桥模式（**不需要 apiKey**）
- ✅ offline 模式自动生成随机机器人名
- ✅ 生成 `config/config.json` 并打印摘要

> 交互模式：`node setup.js`（每个字段 Enter 用默认值）。agent 建议用 `--auto`。

## 3. 必须问用户的字段（agent 决策表）

| 字段 | 能不能自动 | 怎么处理 |
|---|---|---|
| 服务器地址/端口 | 🟡 默认 `localhost:25565` | 单机开服最常见；远程服才需要问 |
| 游戏版本 | 🟢 默认 `auto` | 自动协商，不用问 |
| 账号 | 🟡 offline 可自动随机名 | **正版/外置登录必须问用户要账号密码** |
| 大脑模式 | 🟡 见下方"大脑模式决策" | 关键决策 |
| LLM apiKey | 🟡 视大脑模式 | astrbot 桥不需要；llm 直连必须问 |

### 🧠 大脑模式决策（最重要）
```
本机能访问 127.0.0.1:6185（AstrBot 在跑）？
  ├─ 是 → brain.mode = "astrbot"（复用 AstrBot 的 LLM，零配置，无需 key）✅ 首选
  └─ 否 → 问用户要 OpenAI 兼容 API key（DeepSeek 等）
         ├─ 给 → brain.mode = "llm"，填 baseUrl/apiKey/model
         └─ 不给 → brain.mode = "none"（纯工具模式，机器人不会自主说话）
```
setup.js `--auto` 会自动完成这个决策。

## 4. 手动配置（setup 失败时才需要）

```powershell
copy config\config.example.json config\config.json
# 编辑 config.json，最少要改：
#   mc.username / mc.password / mc.auth   ← 服务器账号
#   brain.mode / brain.baseUrl / brain.apiKey / brain.model  ← 大脑
```

## 5. 验证部署成功

```powershell
# 1) 进程在跑
Get-Process node | Select-Object Id, ProcessName, StartTime

# 2) MCP 端口在监听
Test-NetConnection 127.0.0.1 -Port 3001 -WarningAction SilentlyContinue | Select TcpTestSucceeded

# 3) 列出全部工具（应输出 tools/list 及 49 个工具名）
node tools/test-mcp.js list-inventory    # 或任意工具名，看是否返回结果
```

## 6. 部署完成后：接入你自己（MCP 客户端）

你作为 agent 要指挥机器人，需要把 `http://127.0.0.1:3001/mcp` 注册成你的 MCP 服务器。

### 如果在 AstrBot 环境
AstrBot 的 MCP 服务器配置里添加（SSE 类型）：
```
URL: http://127.0.0.1:3001/mcp
```
之后你的工具列表里会出现 `get-state / move-to / place-block / build-schem ...` 等工具。

### 如果自写脚本 / Claude Desktop
```json
{
  "mcpServers": {
    "minecraft-companion": {
      "url": "http://127.0.0.1:3001/mcp"
    }
  }
}
```
> 注：这是 **SSE transport**（不是 stdio），客户端需支持 SSE。

### 快速自测（不依赖任何客户端）
```powershell
node tools/test-mcp.js get-state
node tools/test-mcp.js move-to "x=10 y=64 z=10"
```

## 7. 故障排查（按频率排序）

| 症状 | 原因 / 处理 |
|---|---|
| `配置文件已生成，请填写后重启` | 首次运行自动生成模板——用 `node setup.js` 或手动填 `config/config.json` |
| 一直重连、`连接失败: connect ECONNREFUSED` | MC 服务器没开/地址端口错；单机要开"对局域网开放"或直接连 localhost |
| 连接后被踢 `Failed to verify username` | 服务器是正版服，离线账号进不去——换 offline 服或填正版账号 |
| `被踢出: You are not whitelisted` | 服务器开白名单，需要管理员把机器人名加白 |
| `MCP 客户端已连接` 但工具超时 | 机器人可能被围住/卡住，检查游戏内位置 |
| 日志一堆 `protodef` 编译栈 | 正常噪音，忽略 |
| 大脑不回话（llm 模式） | apiKey 无效/余额不足/模型名错 |
| brain 报 404 `/api/v1/chat` | AstrBot 版本接口不同，改用 llm 模式或升级 AstrBot |
| **AstrBot 侧 MCP 显示"未连接"/工具数 0** | bot 比 AstrBot 晚启动或 bot 重启过，注册没自动补：AstrBot MCP 服务器设置里重新保存一次（触发 PATCH 重连）；或按"先启动 bot 再启动 AstrBot"的顺序 |

## 8. 部署完成后的汇报模板（给用户）

```
✅ 部署完成！
- 机器人已连上 <服务器>，名字 <username>
- 大脑模式: <astrbot/llm/none>
- MCP 接口: http://127.0.0.1:3001/mcp
- 我可以调用 49 个工具帮你在游戏里移动/挖矿/盖房/聊天
- 快速体验: 在游戏里发消息 @机器人 聊天；或直接让我执行任务
```

---

## 9. 寻路升级记录（v1.2.0 批次 6，2026-08-30）

**背景**：寻路经常卡住/原地抽搐、聊天反应慢不回复。排查发现根因是
mineflayer-pathfinder@2.4.5（2021 年）配 minecraft-data@3.65（2024+）版本跨度太大，
老包按旧数据结构算碰撞/跳跃，直接乱套。

**处理**：
1. 换用官方维护新版 @nxg-org/mineflayer-pathfinder@0.0.26（破坏性升级，API 已适配）：
   - 加载：`bot.loadPlugin(createPlugin({ moveSettings: {...} }))`（原 loadPlugin(pathfinder) 已废）
   - 不再有 `setMovements(new Movements(bot))`，movements 内置，通过 moveSettings 调优
   - `bot.pathfinder.stop()` 改为 `cancel()`
   - moveSettings 开启了 canDig / canOpenDoors / canPlace / allow1by1towers /
     allowDiagonalBridging / movementTimeoutMs=8000 → 通过性大增，卡住概率大降
2. 所有 goto 统一走 `gotoSmart`（helpers.ts）：
   - 20~30s 总超时兜底 + 每 5s 位移检测（连续 10s 没动判定卡住，主动 cancel 报错）
   - `{ rescue: true }` 时卡住自动挖开面前 1~2 格挡路方块再重试一次（不挖基岩/岩浆/箱子/工作台）
3. move-to 完整自救链：挖方块 → tp（有权限时）→ 喊玩家救命；guardian 逃跑/回基地也走 gotoSmart
4. items.ts walkTo 漏网之鱼已换 gotoSmart；config guardian 兼容旧键名 retreatHp/maxDist

**注意**：
- 需要重新部署后生效（旧 bot 进程要重启）
- 旧包 mineflayer-pathfinder 已卸载，别再 import 它

---

## 10. 跟随玩家（v1.3.0 批次 7，2026-08-30）

**新增工具**：`follow-player`（跟随指定玩家/最近的玩家，保持 range 格内）、`stop-follow`（手动停止）。

**实现**（src/tools/follow.ts）：
- 后台定时器每 1.5s 检测一次目标距离：
  - 距离 > range → 发起一次动态追赶 `goals.GoalFollowEntity.fromEntity(entity, range, { dynamic: true })`
    （新版包的目标直接引用实体 Vec3，实体移动会自动重算路径，追到 range 内才完成）
  - 距离 <= range → cancel 停住别乱动
  - 单次追赶 30s 超时兜底（视为卡住，主动 cancel，下个 tick 自动重试）
- 自愈：目标消失/掉线、bot 断开 → 自动停止并释放身体锁
- 身体锁：跟随期间持有 player 锁（独占移动），其他移动指令会排队等待，需先 `stop-follow`；
  guardian 保命可抢占，锁被抢时跟随自动暂停、还回来自动继续

**注意**：需要重新部署后生效（旧 bot 进程要重启）。
