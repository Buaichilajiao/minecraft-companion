# 参考 MCP 项目调研：如何落实「陪伴 / 拟人 / 生活 / 朋友」

> 调研日期：2026-09-30
> 目标：在 minecraft-companion 现有 76 工具 + 8 技能链基础上，参考同类项目，
> 让 AI 从"被命令的工具"变成"有生命的朋友"。

## 一、参考项目与核心亮点

### 1. awesome-mineflayer-mcp（G0Osey99）—— 功能最全
- 123 个强类型工具，26 组；工具结果同时带 human text + structuredContent。
- **视觉**：真实第一人称截图（prismarine-viewer + headless browser）；
  另有零依赖 schematic 彩色地图（内置 PNG 编码器，可俯视/剖面）。
- **持久化路径点**（跨重启）；建造/挖掘宏（dig_tunnel、dig_staircase、fill_region，可取消）。
- **双模式事件流**：pull 环形缓冲（get_events + nextSince）+ push 资源订阅。
- **引导式 prompts**：getting_started、gather_wood、mine_to_diamonds、build_shelter 等多工具工作流。
- **动作锁**：长动作互斥、可取消（新动作取代旧动作）。
- 安全护栏：命令 allow/deny、host allow-list、read-only、发言限流。

### 2. Minecraft Survival MCP（netherite-stack）—— Helix「心智/身体分离」
- **Mind（LLM）**：只给高层意图、战略、长期目标。
- **Body（服务器）**：处理 A* 寻路、几何、逐块建造等"事务"。
- 事务式高层工具：move_to_coordinates、mine_room、mine_stairs、place_wall、place_ceiling、
  put_item_in_chest、craft_item、smelt_item 等。
- 容器优先：可部署成多个"worker bees"，由一个大脑集中调度。
- 价值：LLM 不做坐标算术，延迟低、token 省、失败少。

### 3. cobble-mcp（brian-mwirigi）—— 最贴合「陪伴 / 朋友」
- 核心定位：**same chunk as you（和玩家在同一区块"生活"）**，a teammate，不是 silent autofill。
- **mc_play 陪伴循环**：agent brain 持续 live（常驻感知 + 思考）。
- **mc_pulse「脉搏」**：定期感知周围变化。
- **mc_hang「闲逛/陪伴」**：空闲时在玩家身边自然活动。
- **mc_autotalk / mc_wait_chat**：游戏内聊天自动、即时回应；come/kill/stop 是进程内即时反射（不等 agent）。
- **mc_design**：自己发明调色板 + ASCII 楼层，每次建造都不同（非模板盒子），有个性。
- mc_note（记录）、memory（记忆）；建造后台运行、poll status。
- 分层：即时反射（快）vs 高层规划/观点（慢）。

### 4. herobrine —— 人格 / 目标
- 每个 agent 设定角色、长期目标、即时任务；有自己的性格。
- 自然语言下达（"给我 5 个原木"）。

### 5. Kevin-Liu-01 Minecraft Agent
- 60+ 工具、多步规划、技能库、**持久世界记忆**、游戏内聊天控制。

### 6. MCP World / Remote Control
- 远程服务器、27 工具、Smithery 一键安装（较基础）。

## 二、对我们项目的具体建议（按四个关键词）

### 陪伴 Presence（常驻、在身边）
- 引入「陪伴循环」：bot 非命令时也保持在线，定期"脉搏"感知，
  主动注意到玩家的变化（玩家上线、受伤、建了东西、附近有怪）。
- 「闲逛/在身边」状态：空闲时在玩家附近自然活动，而不是呆立。
- 后台保活（与 QQ 侧、web 侧常驻一致）。

### 拟人 Persona（个性、不模板）
- 人格档案：名字、性格、口头禅、喜好/厌恶。
- 创造性行为：建造时自己设计（design），同一请求每次不同，而非固定模板。
- 记忆驱动：记住共同经历与对话，关系随时间变化。

### 朋友 Social（自然、主动）
- 游戏内聊天自然回应（不止 QQ 侧，游戏内也是"朋友"）。
- 主动表达：关心、建议、分享发现，而不是只答不问。
- 分层反应：危险/come/stop 即时反射；闲聊/规划/观点走慢思考。

### 生活 Living（有自己的节奏）
- 长期目标 + 日常任务：白天采集建造、晚上睡觉、储存物资、经营家园。
- 跨会话持久：世界记忆、路径点、关系、共同建造的"家"。

## 三、可优先落地的能力（结合现状）
1. 陪伴循环 + 脉搏 + 闲逛（常驻感知/自然活动）。
2. 人格档案 + 记忆驱动的关系。
3. 游戏内聊天自动回应 + 即时反射分层。
4. 创造性建造（design，非模板）。
5. 补强基础设施：真实第一人称截图、schematic 地图、持久路径点、
   事件环形缓冲、动作锁、高层事务工具（mine_room / place_wall / place_ceiling）。
