# 贡献指南 CONTRIBUTING

感谢你考虑为 **minecraft-companion** 贡献代码！本项目是一套「够用的可以一战的 MC 陪伴机器人」——用 mineflayer 当身体、AstrBot 当大脑、MCP 当神经。为了让大家协作顺畅、也为了不踩版权和质量的坑，请先读完这份指南。

---

## 1. 仓库结构速览

| 路径 | 说明 |
|---|---|
| `src/` | 核心 TypeScript 源码（身体、大脑桥、MCP 服务器、各种工具与技能） |
| `src/tools/` | 一个工具 = 一个 MCP 工具，`helpers.ts` 是公共工具库 |
| `src/skills/` | 复合技能/流程编排（大脑通过 MCP 触发） |
| `src/engine/` | 模式控制器等内部机制 |
| `tools/` | 自写 dev 脚本（`test-mcp.js` 等） |
| `vendor/mineflayer-schem/` | **第三方** mineflayer-schem 离线副本（PrismarineJS，MIT）——别改它，上游装不上时的降级依赖 |
| `patches/` | 对上游（AstrBot）的可选补丁 |
| `HANDOFF.md` / `PROGRESS.md` | 交接文档 / 开发日志与未来规划 |

## 2. 环境与构建

- Node.js ≥ 18，TypeScript 5.x
- 依赖：`npm install`（注意 `mineflayer-schem` 来自 GitHub tarball，若装不上用 `npm install ./vendor/mineflayer-schem`）
- 构建：`npm run build`（产出到 `dist/`）
- 本地 MCP 测试：`node tools/test-mcp.js <工具名> "参数=值"`

## 3. 代码风格与约定

- TypeScript，类型尽可能完整；新工具用 zod 定义输入 schema
- 文件头部**不加**第三方版权注释——所有 `src/` 代码必须是本项目原创
- 读文件用本项目 `utils/` 里的工具，别另起炉灶
- 工具名清晰、参数齐全（`include_in_chain_of_thought` 等），不暴露内部实现细节给 LLM 即可

## 4. 版权与许可（必读，红线）

本项目以 **MIT** 开源。但仓库里携带了两类第三方代码，**必须遵守它们各自的许可证**：

- `vendor/mineflayer-schem/`：**PrismarineJS，MIT**（© 2020）。是第三方库整体打包，请勿修改其源码，改动会导致与上游脱节、更会破坏其许可证声明。
- `patches/astrbot-mcp-autoreconnect.patch`：对 **AstrBot** 源码的补丁，**AstrBot 是 AGPL-3.0**。打这个补丁即受 AGPL 约束；提交新补丁时请在 PR 里说明补丁改了 AstrBot 哪个文件、为什么。

**写新代码时禁止**：
- 从 mineflayer / mindcraft / minecraft-mcp-server 等第三方直接 `ctrl-c/ctrl-v` 大段代码却不署名；
- 未声明来源就把第三方实现并进 `src/`；
- 改动 `vendor/` 里的离线副本。

所有版权 / 授权状态已在 `README.md`「致谢」一节如实分类，贡献新增或删除了第三方代码时，**必须同步更新致谢表**。

## 5. 提 PR 的流程

1. `git checkout -b feat/你的改动` 开分支
2. 小步提交，commit message 按 `type(scope): 中文描述`，如 `feat(tools): 新增 xxx 工具`、`fix(brain): 修复 MCP 重连泄漏`
3. 改动后跑一遍 `npm run build` + 用 `test-mcp.js` 冒烟测你碰过的工具
4. 开 PR 到 `main`，描述清楚：改了什么、为什么、动了哪个第三方（若有）
5. 等 review；涉及 `src/` 核心（body-controller / brain / mcp-server）的改动会重点看

## 6. 文档同步

改了功能记得同步：
- `README.md`（工具清单、架构、快捷指令）
- `PROGRESS.md`（追加到「未来规划」或开发日志）
- `HANDOFF.md`（如果你执行了主要交接内容）

基线数字（工具数、技能链等）变更时要**全局刷新**，别留过期数字。

---

再次感谢贡献！有问题先翻 `HANDOFF.md` 和 `PROGRESS.md`。祝玩得开心。