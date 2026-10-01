# 安全审计记录 & 同步机制备忘

> 本文档记录对仓库上传内容的敏感信息审计结论,以及 Gitee/GitHub 双端同步的自动化机制。供后续维护参考。

---

## 1. 敏感信息审计(2026-10-01 完成)

### 审计范围(4 层全覆盖)

| 检查项 | 方法 | 结果 |
|---|---|---|
| 当前文件内容 | 正则扫描 12 类密钥特征 + 精确 token 匹配(213 个已跟踪文件) | ✅ 无泄漏 |
| Git 全历史(diff) | `git log -p --all` 含已删除行暴力搜 token 特征 | ✅ 无泄漏 |
| Git 全历史(路径) | `git rev-list --all --objects` 扫描所有历史对象 | ✅ 无敏感路径 |
| 危险文件类型 | `.exe/.pem/.sql/.bak/.zip/.p12` 等 | ✅ 无 |

### 结论
- ❌ 未发现任何账号/密码/API key/私钥/token 泄漏
- ✅ 在本仓库所有文件与全部 git 历史中,均无 3 个已知 token(2×GitHub + 1×Gitee)出现
- ✅ git remote 配置无 token 明文
- ✅ 仓库可安全公开

### ⚠️ 注意(非仓库内泄漏)
两个 GitHub token 曾出现于**对话记录**及 **AstrBot 本地配置** `data/mcp_server.json`(该文件在 AstrBot data 目录,不在仓库内)。建议:
- 日常开发用完即吊销 token
- 后续推送优先用短时 token 或 SSH
- 若吊销,需同步更新 `mcp_server.json` 的 github MCP 配置

---

## 2. Gitee / GitHub 双端同步机制

### 双 remote
- `origin` → Gitee: `https://git.gitee.com/buaichilajiao/minecraft-companion.git`
- `github` → GitHub: `https://github.com/Buaichilajiao/minecraft-companion.git`

### 自动化定时任务
- **名称**: minecraft-companion 双端同步检查
- **频率**: 每 30 分钟(`*/30 * * * *`)
- **逻辑**: fetch 两端 → 比对 local/origin/github 三端 main SHA → 若有领先则补齐 → 推送到两端
- **约束**: 禁止 force push;遇到分叉不覆盖,报告差异

### 凭据与安全配置
- GitHub 凭据存于本机 `~/.git-credentials`(git credential store,**不入库**)
- 已针对 `github.com` 开启 TLS 证书校验(`http.https://github.com/.sslVerify=true`),避免中间人
- ⚠️ 本机全局 `http.sslVerify=false`(历史遗留,可能为内网场景),**仅**对 github.com 恢复了校验

---

## 3. 随仓库分发的第三方代码(致谢红线,勿动)
- `vendor/mineflayer-schem/`: **PrismarineJS, MIT**(离线副本,已随仓库分发)——勿修改源码
- `patches/astrbot-mcp-autoreconnect.patch`: 对 **AstrBot(AGPL-3.0)** 的补丁——改它受 AGPL 约束,新增补丁须在 PR 说明

详细见 `README.md`「致谢」与 `CONTRIBUTING.md`「版权与许可」。

> 本审计结论与同步机制,后续每次重要发布可复查刷新。