import mineflayer from 'mineflayer';
import { createPlugin } from '@nxg-org/mineflayer-pathfinder';
import { log, sleep } from './utils';
import type { MCConfig } from './config';

/** 与 MC 服务器的连接管理：登录去重、指数退避重连 */
export class BotConnection {
  bot: mineflayer.Bot | null = null;
  private cfg: MCConfig;
  private shouldRun = false;
  private retryDelay = 2000;
  private connecting = false;

  /** 对外事件回调 */
  onSpawn?: (bot: mineflayer.Bot) => void;
  onDisconnect?: (reason: string) => void;

  constructor(cfg: MCConfig) {
    this.cfg = cfg;
  }

  /** 启动连接（幂等：先销毁旧连接再连，防止重复登录） */
  async start(): Promise<void> {
    this.shouldRun = true;
    this.dispose();
    await this.connect();
  }

  stop(): void {
    this.shouldRun = false;
    this.dispose();
  }

  private dispose(): void {
    if (this.bot) {
      try {
        this.bot.end();
      } catch {
        /* ignore */
      }
      this.bot = null;
    }
  }

  private async connect(): Promise<void> {
    if (!this.shouldRun || this.connecting) return;
    this.connecting = true;
    log('INFO', `正在连接 ${this.cfg.host}:${this.cfg.port} (${this.cfg.username})...`);

    // 认证模式：minecraft-protocol 1.68 只认 offline/microsoft/mojang。
    // 'yggdrasil'（外置登录，LittleSkin 等 authlib-injector 兼容站）：
    // 协议层在 auth='mojang' + authServer + password 时自动走 yggdrasil 客户端认证（mojangAuth.js），
    // 与正版 Mojang 登录同一条路径，只是认证服务器换成外置站 —— 配置即用，无需额外依赖。
    const authMode = this.cfg.auth === 'yggdrasil' ? 'mojang' : this.cfg.auth;
    const options: Record<string, unknown> = {
      host: this.cfg.host,
      port: this.cfg.port,
      username: this.cfg.username,
      version: this.cfg.version && this.cfg.version !== 'auto' ? this.cfg.version : false,
      auth: authMode,
    };
    if ((this.cfg.auth === 'yggdrasil' || this.cfg.auth === 'mojang') && this.cfg.authServer) {
      options.authServer = this.cfg.authServer;
      // authlib-injector 规范：session server（握手校验端点）= 根 + /sessionserver。
      // authServer 形如 .../api/yggdrasil/authserver，去掉 /authserver 尾巴再拼 /sessionserver。
      options.sessionServer = this.cfg.authServer.replace(/\/authserver\/?$/, '') + '/sessionserver';
    }
    if (this.cfg.password) {
      options.password = this.cfg.password;
    }

    try {
      const bot = mineflayer.createBot(options as unknown as mineflayer.BotOptions);

      // 【头身观感 BUGFIX 9/12】玩家反馈"转头比身子慢半拍，像傻子直直冲上墙、再猛地一甩头跑出去"。
      // 根因在 mineflayer 发包层（lib/plugins/physics.js:163-169）：发往服务器的朝向 lastSentYaw
      // 被按 physics.yawSpeed(默认 3 rad/s) 小碎步逼近 entity.yaw ——
      // 本地移动方向是瞬间拐的，别人看到的朝向却要爬 90°/0.52s 才跟上 → 头身割裂、"螃蟹步"观感。
      // 而服务端本就把包里的 yaw 当【头部朝向】瞬间生效，再用 yBodyRot += f*0.3 让【身子】平滑追头，
      // 天然就是玩家要的"拐弯时先转脑袋、再转身子"。所以这里解锁限速：让包里的朝向瞬间到位，
      // 把这份拟人感交还给 vanilla 服务端自己演，别在客户端把它磨平。
      const unleashLookSync = (): void => {
        const ph = (bot as unknown as { physics?: { yawSpeed: number; pitchSpeed: number } }).physics;
        if (!ph) return; // physics 插件尚未注入（极少见），下个 spawn 事件还会再调一次
        ph.yawSpeed = 200; // rad/s ≈ 10 rad/tick：任何单 tick 的转向都能一口气发完，不再被削成 0.15rad
        ph.pitchSpeed = 200;
      };
      unleashLookSync();
      bot.once('spawn', unleashLookSync);

      // 【飞行诊断】记录服务器下发的 abilities（确认 canFly / flying 标志），定位垂直飞行被拉回问题
      const dbgCli = (bot as unknown as { _client?: { on?: (ev: string, cb: (p: unknown) => void) => void } })._client;
      dbgCli?.on?.('abilities', (p: unknown) => console.log('[abilities←S]', JSON.stringify(p)));

      // 【头身观感·可观测性 9/12】pos-raw 暴露 sentYaw = 真正发往服务器的朝向 = 别人看到的【头部】朝向。
      // lastSentYaw 是 mineflayer physics.js 的闭包私有变量，外部读不到，故钩一层 _client.write
      // 把每次发包的 yaw 记下来。用途：拐角处「entity.yaw(移动方向) 瞬间拐、sentYaw 却按 3rad/s 爬」
      // 这种头身割裂能被量化验证（两者夹角 = 视觉上的"身子转了头没转"）。
      const netStat: { sentYaw: number | null; sentAt: number; headYaw: number | null } = {
        sentYaw: null,
        sentAt: 0,
        headYaw: null
      };
      (bot as unknown as { __netStat?: typeof netStat }).__netStat = netStat;
      const hookSentYaw = (): void => {
        const cli = (bot as unknown as { _client?: { write: (n: string, p: unknown) => void; __hooked?: boolean } })._client;
        if (!cli || cli.__hooked) return;
        const orig = cli.write.bind(cli);
        cli.write = (name: string, params: unknown): void => {
          if ((name === 'position_look' || name === 'look') && params && typeof params === 'object') {
            // 【头身解耦 9/12-v3】walk-path 在 1 格宽迷宫走廊里需要"位移按拐点即时转向（推力不平滑，
            // 否则会斜切戳墙）+ 玩家看到的脑袋按真人速率匀速转（还要提前）"。两件事物理上就不同源：
            // 移动吃 entity.yaw（本地物理），头部朝向只是这个包里的 yaw 字段 → 允许 walk-path 用
            // __netStat.headYaw 覆盖它。服务端照旧把它当头部朝向、让 yBodyRot 平滑跟（vanilla 拟人感）。
            const want = netStat.headYaw;
            if (typeof want === 'number' && Number.isFinite(want)) {
              (params as { yaw?: number }).yaw = want;
            }
            const y = (params as { yaw?: number }).yaw;
            if (typeof y === 'number') {
              netStat.sentYaw = y;
              netStat.sentAt = Date.now();
            }
          }
          orig(name, params);
        };
        cli.__hooked = true;
      };
      hookSentYaw();
      bot.once('spawn', hookSentYaw);

      // 新版 pathfinder（@nxg-org 0.0.26，兼容 minecraft-data 3.65）：
      // movements 内置，用 moveSettings 调优：可挖方块/开门/搭 1x1 柱子（提升通过性，减少卡住）
      // 【纯走路模式 9/11】PF_PURE_WALK=1 → 关掉一切"作弊通道"：不能挖墙(canDig)、
      // 不能放方块/搭塔/搭桥(canPlace/allow1by1towers/allowDiagonalBridging)。
      // 用途：迷宫寻路实测（否则 A* 会直接挖穿墙或垫塔翻出去，测的不是"找路"而是"拆墙"）。
      // 默认不设这个环境变量 → 日常跟随/移动维持"通过性优先"的原设定。
      const pureWalk = process.env.PF_PURE_WALK === '1';
      const setupPathfinder = () => {
        bot.loadPlugin(createPlugin({
          moveSettings: {
            allowDiagonalBridging: !pureWalk,
            // 【拟人跑跳临时关闭 9/8】allowJumpSprint/allowSprinting 原为拟人化开启（玩家反馈 bot 跑跳失控/观感抽搐）。
            // 先置 false 排查：pathfinder 不再主动疾跑+跳（连跳 1.5 格距 + 跟随时频繁换向 → 抖动放大）。
            allowJumpSprint: false,
            allow1by1towers: !pureWalk,
            liquidCost: 20,
            digCost: 20,
            forceLook: false,
            jumpCost: 2,
            placeCost: 30,
            velocityKillCost: 100,
            canOpenDoors: true,
            canDig: !pureWalk,
            canPlace: !pureWalk,
            dontCreateFlow: true,
            dontMineUnderFallingBlock: true,
            maxDropDown: 2,
            infiniteLiquidDropdownDistance: false,
            allowSprinting: false, // 与上方一致：拟人跑跳暂关
            careAboutLookAlignment: false,
            movementTimeoutMs: 8000, // 单步移动超时，防止单步卡死
          },
        }));

        // 【垫脚常识】@nxg-org pathfinder 默认只把 dirt/cobblestone 当垫脚料：
        // 背包只有 obsidian/石头/木板时它想搭 1x1 垫脚塔也无料可用 → "目标高一格就卡死喊人"。
        // 把常见可放置方块加进垫脚白名单，让 pathfinder 能拿背包里的真实方块自动垫高。
        // （配合 allow1by1towers=true：够不着时先自己垫脚，而不是放弃）
        try {
          const { BlockInfo } = require('@nxg-org/mineflayer-pathfinder/dist/mineflayer-specific/world/cacheWorld') as {
            BlockInfo?: { scaffoldingBlockItems?: Set<number> };
          };
          const scaffoldNames = [
            'dirt', 'cobblestone', 'stone', 'obsidian', 'granite', 'diorite', 'andesite',
            'netherrack', 'deepslate', 'cobbled_deepslate', 'gravel', 'sandstone',
            'oak_planks', 'spruce_planks', 'birch_planks', 'dark_oak_planks', 'acacia_planks',
          ];
          const itemsByName = bot.registry.itemsByName as Record<string, { id: number } | undefined>;
          for (const n of scaffoldNames) {
            const it = itemsByName[n];
            if (it && BlockInfo?.scaffoldingBlockItems) BlockInfo.scaffoldingBlockItems.add(it.id);
          }
          log('INFO', `🧱 已扩充 pathfinder 垫脚白名单（${scaffoldNames.length} 种方块可自动垫脚）`);
        } catch (e) {
          log('WARN', `🧱 扩充垫脚白名单失败：${String(e)}`);
        }
      };
      // mineflayer 4.38+：bot.world 在收到服务器 login 包后才创建（blocks 插件 switchWorld），
      // 而插件注入发生在 inject_allowed（login 前），@nxg-org 0.0.26 构造时直接访问 bot.world 会崩。
      // 因此延迟到 login 事件后注入（login 时 bot.world 已就绪）。
      if (bot.world) {
        setupPathfinder();
      } else {
        bot.once('login', setupPathfinder);
      }

      // 修复 minecraft-data 3.65 缺 1.21.1 'noAckOnCreateSetSlotPacket' feature 的问题：
      // 1.21+ 服务器对 set_creative_slot 不回确认包，若走 ack 等待分支会 5s 超时。
      // 强制声明支持该 feature，让 mineflayer 走"本地乐观设置 + 400ms 探测拒绝"路径。
      // 注意：version:auto 时 supportFeature 要等版本检测完成(connect_allowed→inject_allowed)才挂载
      const patchSupportFeature = () => {
        if (!bot.supportFeature) return false;
        const origSupportFeature = bot.supportFeature.bind(bot) as (feature: string) => boolean;
        bot.supportFeature = ((feature: string) => {
          if (feature === 'noAckOnCreateSetSlotPacket') return true;
          return origSupportFeature(feature);
        }) as unknown as typeof bot.supportFeature;
        return true;
      };
      if (!patchSupportFeature()) bot.once('inject_allowed', () => { patchSupportFeature(); });

      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          bot.off('spawn', onSpawn);
          bot.off('error', onError);
          bot.off('kicked', onKicked);
          bot.off('end', onEnd);
        };
        const onSpawn = () => {
          cleanup();
          resolve();
        };
        const onError = (e: Error) => {
          cleanup();
          reject(e);
        };
        const onKicked = (reason: unknown) => {
          cleanup();
          const dump = (v: unknown): string => {
            try {
              if (v === null || v === undefined) return String(v);
              if (typeof v === 'string') return v;
              return JSON.stringify(v);
            } catch {
              try { return String(v); } catch { return '<unserializable>'; }
            }
          };
          reject(new Error('被踢出: ' + dump(reason)));
        };
        const onEnd = () => {
          cleanup();
          reject(new Error('连接结束'));
        };
        bot.once('spawn', onSpawn);
        bot.once('error', onError);
        bot.once('kicked', onKicked);
        bot.once('end', onEnd);
      });

      this.bot = bot;
      this.retryDelay = 2000;
      this.setupRuntimeEvents(bot);
      log('INFO', `✅ 已进入游戏！位置: ${bot.entity.position}`);

      this.onSpawn?.(bot);
    } catch (e) {
      this.bot = null;
      const errMsg = e instanceof Error ? e.message : String(e);
      log('ERROR', `连接失败: ${errMsg}`);
      if (this.shouldRun) {
        log('INFO', `${Math.round(this.retryDelay / 1000)}s 后重连...`);
        setTimeout(() => this.connect(), this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 30000);
      }
    } finally {
      this.connecting = false;
    }
  }

  private setupRuntimeEvents(bot: mineflayer.Bot): void {
    bot.on('end', () => {
      log('WARN', '连接断开 (end)');
      this.bot = null;
      this.onDisconnect?.('end');
      if (this.shouldRun) this.scheduleReconnect();
    });
    bot.on('error', (e) => {
      log('ERROR', `连接错误: ${e.message}`);
    });
    bot.on('kicked', (reason) => {
      const dump = (v: unknown): string => {
        try {
          if (v === null || v === undefined) return String(v);
          if (typeof v === 'string') return v;
          return JSON.stringify(v, null, 0);
        } catch {
          try { return String(v); } catch { return '<unserializable>'; }
        }
      };
      log('WARN', `被踢出: ${dump(reason)}`);
    });
  }

  private scheduleReconnect(): void {
    if (!this.shouldRun) return;
    log('INFO', `${Math.round(this.retryDelay / 1000)}s 后重连...`);
    setTimeout(() => this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 30000);
  }
}
