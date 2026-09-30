# brain.ts 集成说明（任务表上下文注入）

目标：让 AstrBot 侧 agent 每次因玩家消息被唤醒时，都能在上下文中看到「当前有哪些进行中的任务、到第几步了」，从而正确执行 mc-task-flow SKILL。

## 改动位置

`src/brain.ts` 的 `buildContext()`（以及 `chat-context.ts` 若已接管）。

## 要注入的内容

在喂给大脑的上下文字符串中，追加一段「进行中的任务表摘要」，格式：

```
【进行中的任务】（来自 data/tasklist/）
- [进行中] 通关MC打败末影龙（第 3/5 步：搭传送门进下界拿烈焰粉）
- [已暂停] 建一座海景房（第 1/4 步：平整地面）
```

只列 `status === 'running'` 或 `'paused'` 的任务（`pending` 尚未开始、`done` 已完成的默认不列，除非刚完成需报喜）。

## 实现要点

1. 一个 `readTasklistSummary(): string` 函数：读 `data/tasklist/*.json`（排除 `*.example.json`），返回上面格式的摘要。
2. 在 `buildContext()` 末尾 `parts.push(summary)`（摘要非空时才 push）。
3. 用 `fs.readdirSync` + `fs.readFileSync`（bot 侧已有 fs，Node 环境）。

## 插话打断（暂停）

- 当前工具执行是同步的，暂无干净 cancel 钩子。第一版先保证：玩家新消息入队 → `enqueuePlayerMessage` → 大脑醒来先看到「任务表摘要」，按 SKILL 规则「插话优先回复、不再主动发起新动作」。
- 若需真正"原地停下正在跑的动作"，需给 `ActionExecutor` 加 `cancel()`（后续单独做，见 ARCHITECTURE 演进）。