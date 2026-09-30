# MCP 断连自救 · 交付说明 (2026-09-05)

## 问题根因(实测确认)
后台「MCP 服务器已连接」是**假阳性**——AstrBot 只检查 runtime 对象在不在,不检查
SSE session 是否真的活着。bot(companion)重启后 session 悄悄变 None,后台仍显示
"已连接",但所有工具调用都报:
`MCP session is not available for MCP function tools.`

更糟的是 AstrBot 源码里 `_call_with_retry()` 只在 `ClosedResourceError` 时才重连;
session 一旦变 None,后续每次调用直接抛 ValueError,**永不自动重连** → 只能手动去
后台重新保存一次。

## 三处改动

### 1. AstrBot 自愈补丁(治本)
文件: `AstrBot/astrbot/core/agent/mcp_client.py`(已备份 .bak-20260905)
`_call_with_retry()` 里 session 丢失时不再直接放弃,先尝试 `_reconnect()` 一次,
成功则本次调用直接可用。**需要重启 AstrBot 才生效。**

### 2. companion 故障直报(玩家侧说人话)
文件: `minecraft-companion/src/brain.ts`(已编译到 dist)
流解析中检测到 tool_call_result 含 `MCP session is not available` 时,最终回复
硬替换为:
> 我跟大脑的连接断了,动不了,需要主人去AstrBot后台把MCP重新连接一下

不再让 LLM 脑补"卡了/缓一下马上好"。**需要重启 companion 进程才生效。**

### 3. watchdog 自动重连脚本(双保险)
文件: `minecraft-companion/mcp-watchdog.ps1`
- 轮询 bot 端口 :3001;检测到 bot 重启边沿 / dashboard 显示 disconnected / 0 工具
  → 自动调 `PATCH /api/v1/mcp/servers/enabled` 触发 AstrBot 重连(等价手动重存)
- 已实测跑通:日志 `PATCH enabled=true OK -> reconnect triggered`
- 用法: `.\mcp-watchdog.ps1` 常驻循环(默认 15s);`-Once` 单次(配计划任务)
- 用 cmd_config.json 的 jwt_secret 自签令牌,不依赖登录密码

## 部署步骤
1. 重启 AstrBot(使 mcp_client.py 补丁生效)
2. 重启 companion(使 brain.ts 直报生效,`restart-with-rotate.ps1` 或外部重启)
3. watchdog 选一种方式跑起来:
   - 常驻: `powershell -NoProfile -ExecutionPolicy Bypass -File mcp-watchdog.ps1`
   - 计划任务(每 30s): `schtasks /Create /TN "MCPWatchdog" /TR "powershell -NoProfile -ExecutionPolicy Bypass -File <绝对路径>mcp-watchdog.ps1 -Once" /SC MINUTE /MO 1` (配 /RI 30 需 /SC MINUTE)

---

## 实测补充 (2026-09-12 复现记录，接手必读)

**症状矩阵**——同一个报错有三种不同底层状态，处理方式完全不同：

| 现象 | 真实状态 | 处理 |
|---|---|---|
| 报错 + `tools>0` | session 刚断，runtime 还在 | `PATCH enabled=true` 一般能救 |
| 报错 + `tools=0` 且 `connected=True` | runtime 对象还在但 SSE session 已死（**假阳性**）| 直接 PATCH 可能返回 400；此时 disable 也会超时 → 只能重启 AstrBot（加载 `mcp_client.py` 补丁）或重启 companion 让 AstrBot 侧先进入 disconnected |
| 报错 + `connected=False` | runtime 已清理 | PATCH 一定成功（正常路径）|

**本次复现细节**（供后人少走弯路）：
- `GET /api/v1/mcp/servers` → `connected: true, active: true, tools: 0`（工具数为 0 = 会话已死，别信 connected）
- 直接 `PATCH /api/v1/mcp/servers/enabled {server_name, enabled:true}` → 曾返回 `400`
  （日志里会写 `PATCH enabled=true OK` 但其实没救活，因为 API 只是"更新配置"，不会强杀死 session）
- 走面板"重新保存"等价路径 `PUT /api/v1/mcp/servers/by-name`（带完整 config + `active:true`）→
  `400 Timed out while disabling MCP server: MCP 服务关闭超时（10 秒）` ← **死 session 连 disable 都卡住**
- 结论：**只有重启 AstrBot（或用补丁让它自己重连）能治这一种**。所以 §1 的 `mcp_client.py` 补丁不是可选项，
  是必需品；watchdog 只是它没生效时的兜底，兜不住"假阳性 + disable 超时"这个组合。

**watchdog 本次改进**：`Invoke-McpReconnect()` 现在把 400 的响应体写进日志（`$_.ErrorDetails.Message`），
并在直连 PATCH 失败时自动回退 `disable → enable` 再试一次（部分 AstrBot 版本对"已启用再置启用"直接 400）。

**排查三条命令**（复制即用，token 用 cmd_config.json 的 `dashboard.jwt_secret` 自签 HS256，claims 只需 `username/iat/exp`）：

```powershell
# 1) 看真实状态：重点看 tools 数量，connected 不可信
Invoke-RestMethod -Uri "http://127.0.0.1:6185/api/v1/mcp/servers" -Headers @{Authorization="Bearer $tok"}
# 2) 试着重连
Invoke-RestMethod -Uri "http://127.0.0.1:6185/api/v1/mcp/servers/enabled" -Method PATCH -Headers $h -Body '{"server_name":"minecraft-companion","enabled":true}'
# 3) 兜底：重启 AstrBot（补丁生效）→ 再重启 companion
```
