# 竞品参考 & 升级方案(UPGRADE_TRACK.md)

> 为完善 minecraft-companion,已把两个成熟 NC 项目 clone 到本地做参考研究。
> 本文档记录调研结论 + 待实施升级清单(按优先级排序)。
>
> 参考代码位置(不进主仓库): `D:\下载\ref-projects\`
> - `awesome-mineflayer-mcp/` — MIT,~127 工具 / 27 模块
> - `Minecraft-Agent/` (Kevin-Liu-01) — LAN MCP 栈,结构化世界记忆

---

## 一、竞品亮点 → 我方差距

### A. awesome-mineflayer-mcp(127 工具)
我们的明确短板在 **视觉** 与 **路径点**。

| 能力 | 它怎么做的 | 我方现状 | 差距 |
|---|---|---|---|
| **真·第一人称截图** | `prismarine-viewer` 起 WebGL 渲染 + Playwright 无头浏览器截 canvas,回 PNG | 只有顶视图 ASCII/简化 PNG | 🔴 大 |
| **顶视图像素图** | `render.ts` 精确实色映射(60+ 精准色、KEYWORDS 正则兜底)+ 实体标记 | 简化 ASCII(20+色) | 🟡 中 |
| **持久化路径点** | `waypoints.ts`: set/list/delete + goto,JSON 存 configHome,含 dimension/note | 有 landmark 但 API 不规范 | 🟡 中 |
| 工具规模 | 127(state-inspect17/movement13/inventory9...) | 68 | 🟡 中 |
| **可选依赖懒加载** | `import()` 动态 require,无 deps 时给友好报错,不影响重启 | 硬依赖 | 🟢 小(但值得学) |

### B. Minecraft-Agent(Kevin-Liu-01)
结构化空间记忆是它最值得吸收的点。

| 能力 | 它的做法 | 我方现状 | 价值 |
|---|---|---|---|
| **结构化空间记忆** | `world_memory.py` 用 pydantic 建模三类: `LocationEntry`(命名坐标+tags+notes) / `ResourceDeposit`(矿藏坐标+估量) / `StructureRecord`(自建建筑尺寸) | 开放式 memory/keyword 存档,无类型化 | 🟡 中 |
| 技能库 | `skills/store.py` 可插拔技能 | 有 skills/mc-task-flow | 🟢 已覆盖 |
| 规划器 | `planning/planner.py` | 有 tasklist + 引擎 | 🟢 已覆盖 |
| 模式 | `modes/creative|survival` | 我方 engine/solo|coop|nether | 🟢 已覆盖 |
| 错误恢复 | `recovery/retry.py` | 我有 retry 机制 | 🟢 已覆盖 |

---

## 二、升级方案(按优先级)

### P0 — 真·第一人称截图(最大差距,最想要)
仿 awesome 的双轨视觉:
1. **新增 `src/tools/screenshot.ts`**:
   - 依赖 `prismarine-viewer`(已在 package.json!)+ `playwright-core`(新增,可选)
   - 用 `import()` 动态加载:未装 → 返回清晰 UNSUPPORTED+安装指引,不影响启动
   - 管道:`prismarine-viewer` 起 WebGL → Playwright 驱动系统 Chrome/Edge 截 canvas → PNG
   - 需要:把 `prismarine-viewer` 的 console.log 重定向 stderr(避免污染 MCP stdout 通道)
2. **升级 `vision.ts` 顶视图**:吸收 `render.ts` 的 60+ 精确色块 + KEYWORDS 正则兜底,替换现有简化色。

### P1 — 规范化路径点系统
仿 awesome 的 4 个 API,对齐我方已有 landmark:
- `set_waypoint`(可省略坐标取当前位置+dimension+note)
- `list_waypoints`
- `delete_waypoint`
- `goto_waypoint`(对接我方 pathfinder)
- JSON 持久化到 configHome,`mode 0o600`

### P2 — 结构化空间记忆
把 Kevin 的 `ResourceDeposit`(矿藏) / `StructureRecord`(自建建筑) 概念吸收进我方 `cross-memory` 或独立模块,让 bot 记得"附近有钻石矿""我盖了那座房子":
- 挖矿后自动记录矿脉坐标(结合现有 `mining-check`)
- 建图纸/建筑后记录 StructureRecord

### P3 — 可选依赖懒加载改造
把我方所有硬依赖(gif/截图/视频)改成 dynamic import + 优雅降级,降低部署门槛。

---

## 三、落地顺序建议
1. P0 双轨视觉(截图 + 顶视图像素化)→ 立即创造价值
2. P1 路径点系统(工程量小,收益高)
3. P2 结构化空间记忆
4. P3 懒加载工程化

每个完成后:更新 README 工具数、CHANGELOG,同步 Gitee/GitHub。

> 参考代码版权:awesome=MIT,引借鉴思想/架构,不复刻源码(需尊重许可证)。Kevin 项目含其私有实现,仅参考思路。