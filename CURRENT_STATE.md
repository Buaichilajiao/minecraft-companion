# CURRENT_STATE · minecraft-companion 当前主线状态

> 更新：2026-10-02 07:46（中国标准时间）
> 依据：契约_抽象动作层_v0.1.md(已改) / 客户端执行壳_ClientExecutionShell_v1.0.md / 整合包模组分析_v1.0.md / mods-bridge 源码现状

---

## 一、当前主线

**让 minecraft-companion 能进「模组加载器服务器」，走客户端桥接路线。**

核心三层（从决策到最底层）：
1. **抽象动作层（已定稿）**：AI 决策层只认一套统一动作原语，底层自动路由到「原版模式 = mineflayer」或「模组模式 = **自建桥接模组**」。AI 不感知后端。
   > ⚠️ 原文档曾写"模组=Numen 桥"——**Numen 已作废，不依赖 Numen**。统一为"自建桥接模组"。
2. **客户端执行壳（已定稿）**：实现 `mineflayer.Bot` 同款接口的替身 `ClientExecutionShell`，把 `helpers.ts/movement.ts/executor.ts` 里所有 `bot.xxx` 从"mineflayer 计算"翻译成**真实客户端玩家向服务器发包**。
3. **客户端桥接模组（代码起步）**：Java 侧 `mods-bridge` 工程，真正发包 + 读容器。

**mods-bridge 定位（钉死）**：**客户端模组**，装在玩家自己的客户端，**不装朋友的服，服务端不装任何东西**。职责：
- 控制真实客户端玩家（模拟右键、发包）
- 读 `containerMenu`
- 操作槽位

目标整合包：**NeoForge 1.21.1 机械动力整合包**（create 6.0.10 + 数十 addon），与已搭工程匹配，无需换加载器。

## 二、关键设计决策（已定死，勿回退）

| 决策 | 内容 |
|---|---|
| 读容器技术路线 | **窗口协议为主**：模拟右键打开容器 → 读 `Minecraft.getInstance().player.containerMenu` 的 slots → 返回 JSON。**不走 capability**（capability 需服务端装模组，已否决；窗口协议走原版数据包，客户端就能读） |
| 服务端依赖 | 一律不依赖朋友服装任何 mod/插件 |
| 加载器版本 | 单版本 1.21.1 + 单加载器 NeoForge 起步 |

## 三、当前卡点

**设计定稿但代码没从骨架走到"能用的桥"。** 现状：

| 环节 | 状态 | 缺什么 |
|---|---|---|
| 抽象动作层契约 | ✅ 文档定稿(需清 Numen 残留) | 尚未开路由/双后端分支 |
| 客户端执行壳 ClientExecutionShell | ❌ 一个文件都没写 | 需要实现 `mineflayer.Bot` 同款接口替身 + 发包通道 |
| 发包通道(TS→Java mod) | ❌ 未定(HTTP/WS 未落地) | 决定协议(拟 WebSocket)并实现 |
| Java mods-bridge | ⚠️ 只有骨架 | 目前只有 `/bridge_probe`(旧 capability 版)；**需重写为窗口协议版**，且没有移动/交互发包、没有容器窗口读取 |
| 读容器/机器 | ⚠️ 待重写 | 首版目标=窗口协议读 `containerMenu`，未实现 |

**一句话卡点**：`mods-bridge` 只有 `ModBridge.java`(注册命令) + `BridgeProbeCommand.java`(旧 capability probe)，**客户端桥核心——发包、窗口读容器、执行壳——全部未实现**。

## 四、下一步动作（按序）

### P0 · 最小能联调原型
1. `mods-bridge` 纳入 git 管理（当前未入库，孤立本地骨架）。
2. **重写 `/bridge_probe` 为窗口协议版**：模拟右键打开容器 → 读 `Minecraft.getInstance().player.containerMenu` 槽位 → 返回 JSON。最小闭环验证桥通信。
3. **定发包通道协议**：选 **WebSocket**（双向、低延迟），在 Java mod + TS 侧各建最小通道，先做 `/bridge_probe` 查询状态往返。
4. **实现第一个发包动作**：选**移动 `move_to`** —— 客户端执行壳发 `ServerboundMovePlayerPacket.PosRot`，验证"决策→TS→模组→服务器"全链路。

### P1 · 原语集铺开
- 移动：`move_to` / `lookAt` / 卡住跳自救。
- 交互：`dig` / `placeBlock` / `attack` / `openContainer`。
- 读容器：**窗口协议**读 `containerMenu`（create Crate + 原版箱），实现 `read_storage(pos)`。

### P2 · 真实整合包联调
- `companion-bridge.jar` + 整合包 mods 并发，实机验证 create Crate 读取、touhoulittlemaid 大型 GUI 特判。

---

## 备注
- 本文件位于项目根目录 `D:\下载\minecraft-companion\CURRENT_STATE.md`（已从 AstrBot workspace 迁来）。
- 设计文档：AstrBot workspace 下 `契约_抽象动作层_v0.1.md` / `客户端执行壳_ClientExecutionShell_v1.0.md` / `整合包模组分析_v1.0.md`。
- 仓库双 remote：Gitee=origin / GitHub=github，main 三端同步于 `f5b5913`。