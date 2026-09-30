# ARCHITECTURE — minecraft-companion 重构蓝图

> 本文档是后续所有重构的**锚点**。每个 Phase 都对照本文档的「目标架构」与「迁移路径」推进，
> 改完一处，回本文档核对该层职责是否清晰、有无越层调用。

## 一、为什么要重构（现状病根）

1. **逻辑三处重复**：走位/采集/交互逻辑在 `tools/gathering.ts`、`skills/index.ts`、`tools/helpers.ts`
   各写一份（`skills` 有私有 `walkTo`/`digBfs`，`tools/gathering.ts` 也有 `walkTo`，`helpers` 还有
   `gotoSmart`/`walkStraightTo`）。改一处漏两处。
2. **动作无统一抽象**：放/挖/按/攻击各写各的「预检 + 走位 + 对准 + 执行」，新功能（如仿客户端准星）
   只能逐个工具塞补丁。
3. **朝向三套抢**：`gaze`（盯玩家）/ `head-follow`（移动即注视）/ 动作工具都写 `yaw/pitch`，
   已引入 `withAimLock` 原语统一让位。

## 二、目标架构（5 层，自下而上）

```
L5 决策层   brain · companion · lifestyle · guardian · engine(mode/solo/coop)   【保留，不动】
L4 技能层   skills/*   复合动作编排（挖矿=挖→熔炼→合成→装备）                      【改用 L3，删私有逻辑】
L3 动作层   ActionExecutor ★核心新增★  统一原子动作流水线                        【本次重构核心】
L2 感知层   crosshair · checkReach · find-* · get-state · observe                【纯查询，无副作用】
L1 原语层   body(锁) · head-channel(朝向) · pathfinder(移动) · inventory          【保留，不动】
```

### 各层职责与依赖规则

- **L1 原语层**：身体锁、朝向通道、寻路、背包。不感知「动作」，只提供资源与能力。
- **L2 感知层**：只读世界状态/判可达性，**绝无副作用**（不移动、不转向、不改背包）。
  - 现有：`crosshair`（视线射线命中）、`checkReach`（距离+视线判定）、`getReach`（生存/创造 reach）。
  - 未来把 `find-*` / `get-state` / `observe` 一并归入此层的语义。
- **L3 动作层**：`ActionExecutor` 统一原子动作（place/dig/press/attack/use/equip/…），
  每个动作 = 一份「目标 + 参数 + 策略」，内部走同一条流水线（见下）。**工具层与技能层都调用它，不直接碰 L1**。
- **L4 技能层**：复合动作编排（多步原子动作串成目标导向流程），只允许调 L3，不直接调 L1/L2。
- **L5 决策层**：想做什么（LLM 回路 / 自主行为 / 模式引擎），通过 MCP 工具（L3/L4 暴露）或 L3 直接驱动。

## 三、ActionExecutor 流水线（L3 核心）

每个原子动作统一走：

```
resolve   → 解析目标（坐标→方块对象 / 实体名→实体），目标无效即失败
precheck  → checkReach / crosshair：距离 + 视线是否可交互（生存 reach 短，够不着先别硬怼）
approach  → 不可达才走位（走 / 飞 / 垫脚，按目标类型与模式选策略）
aim       → withAimLock 独占视线 + faceToward/lookAt 对准 + 等发包朝向收敛
execute   → 执行原子动作（bot.dig / activateBlock / bot.attack / placeBlock / …）
verify    → 结果确认 + 记忆（可选）
```

**差异点抽成三个钩子**（每个动作只填差异）：

| 动作 | reach | approach 策略 | execute |
|---|---|---|---|
| dig    | block | 走近 | `bot.dig(block)` |
| press  | block | 走近 | `bot.activateBlock(block)` |
| attack | entity | 走近 | `bot.attack(entity)` |
| place  | block | **smartPlace 专属**（参考面/垫脚/飞行/让位） | `bot.placeBlock` |

## 四、文件组织（目标）

```
src/
  actions/            # L3 动作层
    executor.ts       # ActionExecutor 类 + 统一流水线
    strategies.ts     # 各动作的 approach/execute 策略（Phase 1 可先合并进 executor）
  perception/         # L2 感知层（Phase 1 起步：先归拢 crosshair）
    crosshair.ts      # 视线射线 + checkReach + getReach（从 src/crosshair.ts 迁入）
  tools/              # MCP 工具层（薄声明：解析 zod 入参 → 调 L3/L2 → 包装 ok/fail）
  skills/             # L4 技能层（改调 L3）
  ... 原语/决策层文件位置不变
```

> Phase 1 不强行搬迁所有文件；`src/crosshair.ts` 暂留原位，到对应 Phase 再迁入 `perception/`。

## 五、迁移路径（每阶段可编译可测）

| Phase | 内容 | 风险 |
|---|---|---|
| 0 | ✅ 完成：`crosshair` 感知层 + `withAimLock` 原语 | 零 |
| 1 | `ActionExecutor` 骨架 + 收敛 `dig` / `press` / `attack` 三动作，工具层改薄 | 低 |
| 2 | 把 `smartPlace` 挂成 `place` 的 approach 策略，`place-block` 改调 L3 | 中 |
| 3 | `skills/index.ts` 删私有 `walkTo`/`digBfs`，改调 L3 | 中 |
| 4 | 清理 `helpers.ts` 重复函数 | 低 |

## 六、不变铁律

1. **不重写已验证的底层原语**：`body-controller`、`head-channel`、`head-follow`、`gaze`、`pathfinder`、`smartPlace` 全部保留，只是被 L3 挂载调用。
2. **工具层只做「入参解析 + 调 L3/L2 + 包装返回」**，不再内联动作逻辑。
3. **动作期间的视线独占**统一走 `withAimLock`，gaze 靠 body owner 自动让位，动作完恢复。
4. **reach 判断统一走 `getReach()`**（生存方块 4.5 / 实体 3.0；创造 5.0），不得再硬编码 `4.5`。
5. 每个 Phase 完成后 `npx tsc --noEmit` 通过 + 实机验证，再进下一 Phase。
