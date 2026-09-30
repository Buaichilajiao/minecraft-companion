# A1 下界链设计（v0.1 待审）

> 定位：目标链纵深 A 的第一段。验收标准（用户定）：**成功进入下界 → 找到下界要塞 → 打到烈焰粉 → 安全返回主世界**。
> 凋灵骷髅/下界合金/堡垒/猪灵交易 → A1.5，不在本设计内。
> 模式：延续 P1.5 —— 复合动作提成技能函数，MCP 工具与技能共用同一实现，目标链注册进 solo-engine（前置条件+冷却+失败计数）。

---

## 0. 现状与四个硬约束的落实

现有 solo-engine 链尾是 `settled`（铁器+农场+家）→ 之后只剩 leisure（鱼/探索）。下界链插在 settled 之后。

| 硬约束 | 设计落实 |
|---|---|
| 1. 死亡回捡是 A1 前置门槛 | M0 里程碑。**主世界死亡演练通过（捡回包成功）→ 解锁 `death_recovery` tech → 之后所有下界动作才可触发**。没演练过不让进下界。 |
| 2. 前置守卫贯穿 | 每个里程碑 decide 前查前置，缺材料回退到补材料子任务，**绝不在缺前置时执行主动作**（表格见 §2）。 |
| 3. 失败回退明确 | 每步失败都有回退路径（§3），核心：残血→回传送门→回主世界；迷路→原地庇护所等死回主世界 + 死亡回捡兜底；打不过→撤退不送。 |
| 4. 不做完所有下界内容 | A1 止于烈焰粉安全返回。nether_done 后引擎回 leisure/等待玩家推进 A1.5。 |

---

## 1. 关键架构改动（先于任何下界技能）

### 1.1 维度感知（Guardian 不做会疯）
Guardian 防走丢 leash / flee 方向目前用**主世界 home 坐标**。下界坐标数值独立，bot 在下界会被 leash 判定"离家太远"瞎 pathfind，flee 也朝错方向。

- StatusData 增加 `dimension: 'overworld' | 'nether' | 'end'`（读 `bot.game.dimension`），工具层同步。
- Guardian 锚点按维度取：主世界 → `identity.home`；下界 → `identity.nether_portal`（每次进下界时记录）。
- Guardian flee：下界残血 → 朝 nether_portal 坐标方向退，不是出生点。
- lifestyle `pickDecision` 的生存门槛不变，但下界由 Guardian 撤退到传送门而非原地乱跑。

### 1.2 下界链中间状态落记忆（防重启丢半截）
- `identity.portal`：主世界传送门坐标（M3 建好即写）
- `identity.nether_portal`：下界侧传送门坐标（每次进入 M5 更新）
- `stats`：`nether_attempts` / `nether_deaths` / `fortress_dir`（扫 X 轴方向记忆，重启续扫）

### 1.3 solo-engine 扩展点
- COOLDOWN 表追加（§5）
- decide() 在 settled 链尾后插 `decideNether(s)`
- per-skill 失败计数：同一里程碑失败 ≥3 次 → 该里程碑挂起（返回 none + reason），链降级 leisure，冷却 10min 后重试；下界内连续死 2 次 → 整链挂起等玩家（不反复送）。

---

## 2. 里程碑与前置守卫

前置链：`M0 death_recovery → M1 diamond_pickaxe → M2 obsidian → M3 portal → M4 nether_ready → M5 enter_nether → M6 find_fortress → M7 blaze_rod → M8 return`

| # | 里程碑 | 触发条件（守卫，全满足才做） | 动作 | 成功解锁 tech |
|---|---|---|---|---|
| M0 | 死亡回捡（硬门槛） | 机制就绪但未演练过；或死亡点有记录 | **演练**：主动演练不便 → 以真实死亡驱动。实现：death 事件记录死亡点 [dim,x,y,z] → 重生后 `death_recover` 技能：gotoSmart 回死亡点 → 环视找掉落物（object/item 实体）→ pickup。**演练成功（捡回≥1 组关键物品）→ addTech('death_recovery')** | `death_recovery` |
| M1 | 钻石镐 | 无前置；判定：无 `diamond_pickaxe` 物品 | `mine_diamond`：装备 iron_pickaxe → findBlock diamond_ore（y≤15）→ 挖（digBfs 小规模）→ 合成 diamond_pickaxe（3 diamond+2 stick，crafting_table）。守卫：没铁镐→先 mine_iron | `diamond_pickaxe` |
| M2 | 黑曜石 ≥14（冗余 4） | `diamond_pickaxe` 已装备 + 桶（bucket 取水/岩浆） | `mine_obsidian`：找 lava 源 → 倒水成黑曜石 → 钻石镐挖。守卫：无钻石镐 → **返回 M1**；无桶/铁 → 补铁 | `obsidian` |
| M3 | 传送门（4×5 框 10 块+点火） | obsidian≥10 + flint_and_steel | `build_portal`：挑平地（家附近/地表 lava 边）→ 摆 4×5 obsidian 框（净空检查）→ 点火（flint_steel activate frame 底块）→ 激活动画确认 → 写 `identity.portal`。守卫：材料缺 → 回 M1/M2 补 | `portal` |
| M4 | 下界装备齐 | 全满足：剑（iron_sword 或更好）+ 铁甲 4 件套 + 食物≥24 格饱食（面包/熟肉） | 非技能，是 gate 函数 `ensureNetherReady()`：缺啥 → decide 给对应子任务（挖铁/合成铁甲，crafting_table）。金装备/抗火 → **A1.5**，本段只记录不硬卡 | `nether_ready` |
| M5 | 进入下界 | **`death_recovery` + `nether_ready` + `portal` 全解锁**（硬门槛在此落闸） | `enter_nether`：gotoSmart 到 portal → 站入框 → 等传送（维度变 nether）→ 落地即记 `identity.nether_portal`（nether 侧坐标）+ 找安全落脚点。守卫失败：落地岩浆/悬崖 → 立即回穿 | `nether` |
| M6 | 找下界要塞 | `nether` | `find_fortress`：沿记忆方向（默认 +X）扫 netherrack 地表走，每 40 格环视 findBlock nether_bricks（maxDistance 64）；单程上限 800 格 → 换 -X 二轮 → 再找不到挂起（leisure，冷却 15min）。行进规则：贴地表、避开岩浆湖、ghast 火球来了走位躲 | `nether_fortress` |
| M7 | 烈焰粉 | `nether_fortress` + 血量>12 + 食物足 | `kill_blaze`：沿要塞走廊找落单 blaze（不硬冲 spawner 房）→ 近战铁剑连击（复用 defendPlayer 攻击循环模式）→ 集 1-2 根 blaze_rod → 熔炉烧成 blaze_powder。守卫：无抗火 → 只打落单、残血即撤（不追进岩浆） | `blaze_powder` |
| M8 | 安全返回（验收关） | blaze_powder≥1 | `return_home`：gotoSmart 回 nether_portal → 站框回主世界 → 回家。成功 → `nether_done` + pride 情绪 + timeline + brain 汇报 | `nether_done` |

> **守卫实现原则（对齐 P1.5 根因）**：每步 decide 前检查前置，缺哪步只返回那一步的子任务，**主动作技能函数入口本身也自带守卫**（MCP 层有人直接调 skill_build_portal 而没 obsidian → 返回"缺材料，先挖黑曜石"，不硬搭）。

---

## 3. 失败回退总表

| 场景 | 回退行为 | 备注 |
|---|---|---|
| 主世界被打残（M0-M4 阶段） | Guardian flee 回出生点方向（现状已有） | 无改动 |
| 下界残血/被怪围攻 | Guardian flee → **朝 nether_portal 退** → 传送门回主世界补给 | 依赖 §1.1 维度感知 |
| 下界迷路找不到 portal | **不硬跑**（不浪费食物）→ 就地挖 2×2 坑/搭 cobble 小庇护所 → 等死回主世界 | 死亡回捡兜底，装备不丢（M0 已演练） |
| 烈焰人打不过 | 撤退到安全走廊 → 回 portal → 主世界补给 → 冷却后再进；连续 2 次 → 链挂起 | 不反复送 |
| 落地即岩浆/悬崖 | enter_nether 后 2s 内检查，危险立即回穿 | 每次进下界都查 |
| 找不到要塞 | +X 800 格 → -X 800 格 → 挂起 leisure 15min → 从 portal 回主世界休整再试 | 记忆 fortress_dir 防同向空扫 |
| 下界连续死亡 2 次 | 整链挂起，等玩家介入（chat 求助） | 防"带钻石装备送" |
| 同一里程碑失败 ≥3 次 | 该里程碑挂起 10min，转其他事（leisure/补料） | 冷却避免横跳 |
| 死亡回捡时掉落物消失（超 5min） | 放弃该次捡包，不纠缠，重打装备 | 记录 stats 供后续优化 |

---

## 4. 实现批次（映射 P1.5 验证模式：编译+冒烟 → 真机单步 → 关单）

每批次产物 = 技能函数（skills 表）+ MCP 工具（共用实现）+ advanceTech 映射 + COOLDOWN + 维度/记忆字段。

| 批次 | 内容 | 真机验证项（服务器就绪后） |
|---|---|---|
| B1 | §1.1 维度感知 + §1.2 记忆字段 + M0 死亡回捡（death 记录点 → death_recover 技能） | 死一次（跳岩浆）→ 自动复活回捡成功 → 解锁 death_recovery |
| B2 | M1-M4：mine_diamond / mine_obsidian / build_portal / flint&steel + ensureNetherReady gate | 挖到钻石 → 合成镐 → 浇出黑曜石 → 搭门点火成功 |
| B3 | M5-M8：enter_nether / find_fortress / kill_blaze / return_home + 失败回退全路径 | **一趟完整下界跑**：进门 → 找要塞 → 烈焰粉 → 回主世界 |
| B4 | 收尾：nether_done 后链回归 leisure、A1.5 占位、边界（守护者在门框旁不打断点火等） | 跑完验收关单 |

MCP 新增工具（AstrBot/大脑可一键触发，与技能同实现）：`skill_death_recover` `skill_mine_diamond` `skill_mine_obsidian` `skill_build_portal` `skill_enter_nether` `skill_find_fortress` `skill_kill_blaze` `skill_nether_status`（进度+维度汇报）。

---

## 5. 常量/冷却（MAX_STEPS 扩展）

- COOLDOWN：mine_diamond 120s / mine_obsidian 180s / build_portal 180s / find_fortress 300s / kill_blaze 240s / enter_nether 60s
- MAX_STEPS：obsidian 14 块上限 / fortress 单程 800 格 / 回捡等待 60s / 下界死亡上限 2 次

## 6. 情绪/事件接线

成就事件轨：first_diamond → first_obsidian → first_nether（首次踏入，惊+喜）→ first_blaze_rod → nether_done（pride）。死亡事件轨：death_in_nether（沮丧+回退说明）。情绪统一走 emotion.react，事件推送走既有 bus（canFire 节流）。

## 7. 风险登记（真机阶段逐项验证）

1. pathfinder 在下界岩浆地形卡死 → gotoSmart 自带 rescue + 20s 超时报错回退；find_fortress 贴地表走降低风险
2. mineflayer 无结构定位 API → 要塞只能沿轴扫（设计已接受成功率非 100%，失败走回退表）
3. 传送门激活检测（frame 是否 lit）→ 用 bot blockAt obsidian 旁 `portal` 方块类型判定，点火后轮询 10s
4. blaze 掉 rod 概率 50% → kill_blaze 目标 1-2 根，2 根就够烧粉（防脸黑刷次数）
5. 抗火缺失 → 设计上绕开 spawner 房硬冲，只打落单，风险可控；金甲/抗火留给 A1.5

## 8. A1.5 占位（不做，仅留口）
凋灵骷髅头颅、下界堡垒结构探索、猪灵以物易物、下界合金升级、抗火 potion 链。

---

## 9. 批次落地附录

### B2（已收）：mine_obsidian + build_portal
- 里程碑：M2 obsidian、M3 portal 点亮；nether-chain decideNether 增加 M2/M3 分支 + 失败计数挂起 10min（挂起回日常不拦截）。
- 用户验收口径修正：M4 gate 为**硬卡**：铁剑 + 铁甲全套（iron_ 及以上）+ 食物累计 ≥64 + 打火石 + 金锭 ≥4（防猪灵）。与 §2 表"金留 A1.5"冲突 → 以用户口径为准，金锭补料走 B3 gear_up。
- 细节：mine_obsidian 单源倒水放置失败重试 ≤3；空桶自动去水源装回；build_portal 选址 5 检（平整/净空/无易燃/无岩浆/脚下实体），半径 2→9→16→23→30 递增换位，不原地死磕；点火 3 次 + findBlock portal 确认；坐标双写 `identity.portal` + Landmark `nether_portal`。

### B3（本文档批）：M5 enter_nether + 回程安全网 return_home + 补给闭环 gear_up
- **落地状态（2026-09-05）：已实现并收关**。技能层：`skills.enter_nether / return_home / gear_up` + MCP `skill-enter-nether / skill-return-home / skill-gear-up`；决策层：nether-chain decideNether 重写（下界维度分支自动派 return_home / M4 gate 不过→派 gear_up / gate 过→M5 派 enter_nether，`IMPLEMENTED` 点亮 gear_up/enter_nether/return_home，find_fortress/kill_blaze 留 B4）；工具层：helpers 增 `smeltBatch`（放料+轮询出炉+withdraw 取回背包），`ensureNetherReady` 抽到 engine/nether-gate.ts 供 engine 与技能共用。重构了重复的 craftDiamondPickaxe → 通用 `craftItemAtTable(bot, itemName)`，并顺手把 3 处重复 walkTo 收敛到 helpers.gotoSmart（smeltNearby 修复了引用未定义 walkTo 的隐性 bug）。
- M5 `enter_nether`：gate ok（decide 侧补 `nether_ready` tech）→ 走到 `identity.portal` → 站入 portal 块等传送（轮询 dimension）→ 落地 3s 后记 `identity.nether_portal`（下界侧，Guardian 撤退锚点）→ `addTech('nether')`。
  - 防呆：15s 没传 → 洞内前后挪 1 格重试 ≤3；落地岩浆/悬空 → 立即 return_home。
- M8 雏形 `return_home`（B3 当安全网，B4 才接 blaze 验收）：nether 维度下 decide 自动派发（冷却 60s）→ 走回 `nether_portal` → 未亮则打火石点火 → 站框传回 overworld。
  - 防呆：`nether` tech 解锁后 B3 不自动二次进入（防进出空转）；B4 点亮 find_fortress 后改为持续推进。
- M4 补给 `gear_up`：缺铁剑/铁甲 → 查 iron_ingot，够则用 crafting_table 逐件合成；缺锭 → 回 mine_iron 挖。缺金锭 → 找 gold_ore 挖 + 熔炉熔炼。缺食物 → 交主链日常（fish/plant 兜底）不插话。
- 维度感知：decideNether 主世界分支 M1-M5；nether 分支 B3 只回程，B4 才放 M6/M7。
