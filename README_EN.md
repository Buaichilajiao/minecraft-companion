# ⛏️ minecraft-companion — Minecraft AI Companion (MCP Server)

An AI bot that lives inside Minecraft: **mineflayer as the body, LLM as the brain, MCP as the interface**.
Any MCP-capable client (AstrBot / Claude / Cursor / custom scripts) can connect over SSE and command the bot to act inside the game.

---

## ✨ Features

- 🧠 **Brain bridge (AstrBot by default)**: the bot does NOT talk to an LLM directly — it forwards everything to AstrBot `/api/v1/chat`. Same brain in QQ and in-game, shared persona + memory, zero API key setup
- 🎒 **Creative tools**: `creative-give` puts any item into your inventory via protocol (no `/give` permission needed)
- 🪃 **Follow player**: `follow-player` keeps following you (dynamic pathfinding, self-heal on disconnect, optional target player)
- 🔒 **Body control lock**: guardian survival > player tasks > autonomous lifestyle; all action tools go through `withBody`, so multiple clients can't fight over the body
- ⚔️ **Combat / survival / gathering**: auto pathfinding combat, survival guardian (retreat at low HP, auto eat)
- 📊 **49 MCP tools** (13 categories): perception, movement, building, gathering, crafting, smelting, farming, combat, storage, creative, skills, memory, social — all protocol-level

---

## 🤖 AI Agent Deployment? (One-line summary)

> 📖 Read **`AGENT_DEPLOY.md`** — written for AI agents (one-liner commands + config decision table + troubleshooting).
> TL;DR: unzip → `node setup.js --auto` → `node dist/main.js` → connect MCP `:3001/mcp`

### Smart config wizard (for humans and AI)
```powershell
node setup.js          # interactive, Enter = defaults
node setup.js --auto   # fully automatic: install deps + detect AstrBot + generate config
```
- Auto-detects a local AstrBot(6185) → brain switches to **astrbot bridge mode, no API key needed**
- No AstrBot → provide an OpenAI-compatible API key (or `brain.mode=none` tools-only mode)
- Existing config is backed up as `.bak`

## 🚀 Quick Start

### 1. Requirements
- Node.js **18+**
- A Minecraft **Java Edition server** (1.20 ~ 1.21.1, tested on `1.21.1`)
- Premium / **offline / Yggdrasil (LittleSkin etc.)** account

### 2. Install
```bash
npm install
```

### 3. Configure
```bash
# First run: copy the template, then fill in your server & account
copy config\config.example.json config\config.json
```
Edit `config/config.json` (see [Configuration](#-configuration)).

### 4. Start
```bash
npm start          # or node dist/main.js
```
Success looks like:
```
✅ 已进入游戏！位置: (x, y, z)        (Entered the game)
🛡️ 生存守护已启动                     (Guardian started)
🛰 MCP SSE 服务: http://127.0.0.1:3001/mcp
```

### 5. Connect an MCP client
SSE endpoint: **`http://127.0.0.1:3001/mcp`**
- **AstrBot**: add an MCP server (SSE type) pointing to that URL (multi-client supported, use `?clientId=name` to distinguish)
- **Claude Desktop / others**: use SSE transport with the same URL
- **Custom scripts**: see `test-mcp.js` (`node test-mcp.js <tool> "arg=value"`)

---

## ⚙️ Configuration

| Field | Meaning |
|---|---|
| `mcpPort` | MCP SSE port (default 3001) |
| `mc.host` / `mc.port` | Minecraft server address / port |
| `mc.username` / `mc.password` | Bot account |
| `mc.auth` | `offline` / `microsoft` / `yggdrasil` |
| `mc.authServer` | External auth server URL (LittleSkin etc.) |
| `brain.mode` | `astrbot` = AstrBot brain bridge (default, no key) / `llm` = direct LLM / `none` = tools only |
| `brain.baseUrl` / `apiKey` / `model` | OpenAI-compatible endpoint / key / model (astrbot mode only needs `baseUrl`) |
| `brain.sessionId` | Memory session ID |
| `guardian.enabled` | Survival guardian: retreat at `retreatHp`, eat at `eatHp` |
| `lifestyle.enabled` | Lifestyle mode (auto explore/learn, on by default) |

---

## 🧰 Tool List (49 MCP tools)

| Category | Tools |
|---|---|
| Perception (9) | `get-state` `find-blocks` `find-entity` `get-block-info` `observe` `look` `read-chat` `list-inventory` `find-item` |
| Movement (7) | `move-to` `move-direction` `jump` `look-at` `fly-to` `follow-player` `stop-follow` |
| Building (2) | `place-block` `build-shelter` |
| Gathering (4) | `dig-block` `collect-tree` `mine-ore` `pickup-item` |
| Craft/Smelt (2) | `craft-item` `smelt-item` |
| Storage (3) | `chest-deposit` `chest-withdraw` `drop-item` |
| Combat (2) | `attack-nearest-hostile` `attack-entity` |
| Survival (3) | `eat` `sleep` `equip-item` |
| Farming (5) | `till-land` `plant-seed` `harvest` `fish` `breed-animal` |
| Creative (1) | `creative-give` ★ |
| Skills (5) | `skill-setup-base` `skill-mine-iron` `skill-plant-farm` `skill-explore` `skill-surprise` |
| Memory/Goals (4) | `memory-read` `memory-write` `set-goal` `get-goals` |
| Social/System (2) | `send-chat` `self-check` |

---

## 🛠️ FAQ

**Q: AstrBot shows MCP "not connected" or 0 tools?**
A: If the bot started *after* AstrBot (or the bot restarted), registration isn't re-pushed automatically. Re-save/edit that MCP server in AstrBot settings (triggers a PATCH reconnect), or start bot → then AstrBot.

**Q: Building stuck on "No available actions"?**
A: The schematic origin is floating or chunks aren't loaded. Handled automatically (auto-walk to load chunks + 45s stall cancel); if calling an old version manually, walk the bot to the build area first.

**Q: creative-give said done but inventory is empty?**
A: Hotbar slots (0-8) are protected on some servers; the tool auto-skips them. If every slot is rejected, check account permission / creative mode.

**Q: Can't connect to MCP?**
A: Make sure `mcpPort` is free and `http://127.0.0.1:3001/mcp` responds.

**Q: Bot not moving / action conflicts?**
A: Body control lock: perception tools never block; action tools allow one session at a time (guardian can preempt for survival). Auto-release after 2 min idle.

---

## 🔧 Development

- `dist/` is **directly runnable CommonJS** — edit and it takes effect immediately (no build step)
- `src/` is legacy TypeScript source (not fully in sync with dist); modify `dist/*.js` for features — **do NOT blindly run `npm run build`** (tsc overwrites dist patches with old src)
- `test-mcp.js`: call tools without a client — the debugging Swiss-army knife
- Adding a tool: `mcp.registerTool(...)` in `dist/tools/xxx.js`, then register it in `dist/tools/index.js`
- Wrap action tools with `withBody(ctx, 'player', 'tool-name', ...)` (body lock)

## 📄 Disclaimer
- The bot logs in with your account — **respect server rules**, don't use it for cheating or griefing
- The config holds your password and API key — **never commit it to a public repo**
- For learning purposes only; the author is not responsible for misuse

---

## 📦 Changelog

### v1.4.0 (2026-09-05)
- 🧩 **Emotion + Events wired (v1, blueprint "inject, don't intervene")**: `emotion.ts` / `events.ts` now live — the lifestyle 5s tick **reuses its status snapshot** to scan world events (danger/environment/social/achievement, 60s dedup), driving emotions (nervous/relieved/calm...) with natural decay (3%/tick); brain context now includes "current mood + what just happened" — tone reference only, never decision input
- ⚡ **Perf**: EventWatcher scan collapsed from 4 full `getStatus()` calls to 1 (shares lifestyle snapshot)
- 🎯 Version bumped → 1.4.0 (v1.3.2 = reconnect-fix snapshot)

### v1.3.2 (2026-09-05)
- 🐛 **Fix reconnect leak**: Guardian / Lifestyle / Companion now detach cleanly (timers + listeners fully cleared); no leftover background timers fighting for the body after reconnects — verified with 5 simulated reconnects (`verify-reconnect.cjs`, zero leak)
- 🛡️ **Crash guard**: companion delayed greetings/care now wrapped in try/catch (no more crash risk if they fire after disconnect)
- 🧩 **New foundation modules**: `emotion.ts` (valence/arousal emotion system, 13 event triggers + decay) and `events.ts` (EventBus / EventWatcher detecting danger/environment/social/achievement) — groundwork for "human-view perception + proactive world events" (not yet wired in this release)
- 🎯 Version bumped to 1.3.2

### v1.3.0 (2026-08-31)
- 🪃 **Follow player**: new `follow-player` / `stop-follow` (dynamic pathfinding, 1.5s check, self-heal on disconnect, body-lock exclusive)
- 🔒 **Body lock completed**: `jump` / `fly-to` etc. now go through `withBody`, aligned with the body-controller whitelist
- 🧠 **Pure-forward brain bridge**: brain no longer embeds persona / direct LLM — forwards to AstrBot `/api/v1/chat` (persona & memory live in AstrBot; the bot is just "mouthpiece + hands")
- 🔗 **Multi-client MCP**: SSE supports `?clientId=name`
- 📊 **49 tools** (13 categories)
- 🐛 Fixed: no duplicate commands while building (tool mutex), welcome message persisted across restarts
- 🗑️ Cleanup: removed the unused `build-schem` tool reference and the sample schematic (open-source compliance check)

### v1.2.0 (2026-08-30)
- 🤖 **AI one-click deploy**: `AGENT_DEPLOY.md` + `setup.js` smart wizard (`node setup.js --auto`)
- 🧠 **Zero-config brain**: auto-detects AstrBot(6185) → astrbot bridge mode, no API key
- 🔗 **Pathfinding upgrade**: `@nxg-org/mineflayer-pathfinder@0.0.26`, gotoSmart self-rescue chain (dig → tp → ask for help)
- 🛡️ **Config validation**: startup clearly reports missing fields, hints at setup.js
- 📖 README: AI Agent deployment quick entry

### v1.1.0 (2026-08-30)
- 📘 `PROJECT_DOC.md` project master doc
- 🧠 **Memory injection**: goals / prefs / recent events injected into context every reply — no more amnesia
- 🔒 **Single active controller lock**: one session at a time for action tools, 2-min idle auto-release
- ⏱️ **Build stall detection**: build-schem auto-cancels after 45s with no real progress
- ✂️ **Fixed double replies**: send-chat dedup within 5s
- 📣 **Welcome message once**: persisted across processes/restarts

### v1.0.0 (2026-08-29)
- First runnable version: mineflayer body + AstrBot/LLM brain + MCP SSE interface
- 40+ MCP tools: perception / movement / building / crafting / smelting / fishing / breeding / farming / combat / schematic building / creative-give

---

## 🙏 Acknowledgements / Credits

The design and implementation ideas of this project were inspired by the following open-source projects.
**(All code here is an independent implementation — no code is reused from the projects below; all rights belong to their respective authors):**

| Project | License | Inspiration |
|---|---|---|
| [yuniko-software/minecraft-mcp-server](https://github.com/yuniko-software/minecraft-mcp-server) | Apache-2.0 | Overall approach of controlling a mineflayer bot over MCP |
| [mindcraft-bots/mindcraft](https://github.com/mindcraft-bots/mindcraft) | MIT | LLM-driven mineflayer gameplay |
| [PrismarineJS/mineflayer](https://github.com/PrismarineJS/mineflayer) (and the minecraft-data / pathfinder ecosystem) | MIT | The bot body & core dependencies |

This project is open-sourced under the **MIT** license.
