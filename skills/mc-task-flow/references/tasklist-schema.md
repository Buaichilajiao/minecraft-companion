# skill 任务表（任务流）JSON 结构约定

位置：`data/tasklist/<slug>.json`

## 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | 是 | 唯一标识，建议小写+连字符，如 `kill-ender-dragon` |
| `title` | string | 是 | 人类可读的任务名 |
| `status` | string | 是 | `pending` 待执行 / `running` 执行中 / `paused` 已暂停(被打断) / `done` 已完成 |
| `current_step` | number | 是 | 当前正在执行的 step 下标（0 起） |
| `created` | number | 是 | 创建时间戳(ms) |
| `updated` | number | 是 | 最近更新时间戳(ms) |
| `steps` | array | 是 | 步骤列表，见下 |

## step 对象

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `desc` | string | 是 | 这一步做什么（人类可读） |
| `tools` | string[] | 是 | 这一步要调用的工具名（skill-* 或基础工具），按顺序调用 |
| `done` | boolean | 是 | 该步是否已完成 |

## 状态流转

```
pending → running → done
            ↓
         paused（玩家插话/新任务打断）
            ↓
         running（继续）
```

- 被打断时：`status = paused`，`current_step` 停在当前未完成的 step 上。
- 继续时：`status = running`，从 `current_step` 接着走。
- 全完成：`status = done`。

## 注意

- `tools` 里的工具名必须真实存在（参考 AstrBot 侧暴露的 60+ 个 Minecraft 工具 + 8 个 `skill-*`）。
- 一个 step 可以列多个 tools，但通常是"这一步要么一口气做完的一个复合动作"。
- 步骤拆分的粒度：以"调用一次 skill 或一个明确目标"为界，不宜过碎（每步一两个工具即可）。