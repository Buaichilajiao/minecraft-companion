import type mineflayer from 'mineflayer';
import { goals } from '@nxg-org/mineflayer-pathfinder';
import type { MemoryManager } from './memory';
import type { StatusCollector } from './status';
import type { AppConfig } from './config';
import type { BodyController } from './body-controller';
import type { EmotionSystem } from './emotion';
import { log, sleep, dimOf } from './utils';
import { gotoSmart, walkStraightTo, faceToward } from './tools/helpers';
import { getGlobalLandmark } from './landmark';

const HOSTILE = ['zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman', 'witch', 'phantom', 'blaze', 'drowned', 'husk', 'stray', 'pillager', 'vindicator', 'ravager', 'slime', 'magma_cube', 'hoglin', 'zoglin', 'piglin_brute', 'vex', 'guardian', 'elder_guardian', 'wither_skeleton', 'zombified_piglin'];
// 会爆炸/不可激怒，不主动打（贴身才避让）：苦力怕靠近会炸、末影人被看会狂暴
const NO_PROVOKE = new Set(['creeper', 'enderman']);

/** 战斗事件说话类型（喂给大脑生成，只给"语气种子"不给预设文案） */
export type CombatSayEvent =
  | 'combat_start_pve'      // 主动迎击怪物
  | 'protect_start'         // 玩家即时保护：身旁玩家被怪威胁 → 冲过去护（先喊一声让人安心）
  | 'killed_mob'            // 打退/击杀怪物
  | 'escaped'               // 甩掉威胁脱战
  | 'hit_by_player_1'       // 被玩家打第1次 → 困惑询问
  | 'hit_by_player_2'       // 被玩家打第2次 → 委屈
  | 'hit_by_player_3plus'   // 被玩家打第3次+ → 难过跑远
  | 'player_declared_pvp'   // 玩家提出且大脑确认切磋
  | 'pvp_end';              // PVP 结束（赢/输/超时/叫停，大脑看血量情绪自然发挥）

/** 生存守护：受击反击、血低逃跑+进食、饥饿进食、防走丢 + PVE 战斗反应层（战术应对）。独立于生活循环，永远生效。 */
export class Guardian {
  private bot: mineflayer.Bot;
  private memory: MemoryManager;
  private status: StatusCollector;
  private cfg: AppConfig['guardian'];
  private body: BodyController;
  private emotion?: EmotionSystem | null;
  private fleeing = false;
  private checkTimer: NodeJS.Timeout | null = null;
  private lastAutoEat = 0;
  // —— PVE 战斗层状态 ——
  private combatState: 'idle' | 'fighting' | 'retreating' | 'kiting' = 'idle';
  private combatInitId = -1;   // 触发战斗的实体 id（优先追踪它）
  // —— 玩家即时保护反射（guardian.playerProtection）：护身旁玩家，独立于 autoCombat ——
  private protectPendingAt = 0;      // 去抖起点（500ms 确认真威胁）
  private protectTargetId = -1;      // 待护的对怪实体 id
  private protectPlayerName = '';    // 正在护（或被护的）玩家名
  private protectInProgress = false; // 护人进行中（防事件+扫描双触发重入）
  // —— 玩家交互：3级委屈递进 + 约定 PVP ——
  private playerHitCount = 0;          // 10s 窗口内同一玩家连续打我次数
  private lastPlayerHitAt = 0;
  private lastPlayerHitName = '';
  private playerReacting = false;      // 分级后退动作防重入
  private pvpName = '';                // 约定 PVP 对手；空 = 未约定
  private pvpUntil = 0;                // 约定过期时间（最后攻击 + 60s）
  private pvpLastHitAt = 0;
  private lastCombatSay = 0;           // 战斗说话冷却（避免连发刷屏）
  /** 战斗事件说话钩子（main 装配成 companion.sayCombat → 大脑生成，禁预设台词） */
  combatSay: ((ev: CombatSayEvent, target?: string) => void) | null = null;
  /** 护人进行中状态变化 → 通知 companion 抑制心跳（防叠话）。true=开护 false=护完/中断 */
  onProtectChange: ((active: boolean) => void) | null = null;
  // 事件监听器引用（匿名箭头无法 removeListener，必须存引用——重连泄漏修复）
  private hurtHandler: ((attacker: unknown) => void) | null = null;
  private deathHandler: (() => void) | null = null;
  private entityHurtHandler: ((en: unknown, cause: unknown) => void) | null = null;

  constructor(bot: mineflayer.Bot, memory: MemoryManager, status: StatusCollector, cfg: AppConfig['guardian'], body: BodyController, emotion?: EmotionSystem | null) {
    this.bot = bot;
    this.memory = memory;
    this.status = status;
    this.cfg = cfg;
    this.body = body;
    this.emotion = emotion;
  }

  attach(): void {
    this.hurtHandler = (attacker: unknown) => this.onHurt(attacker);
    this.deathHandler = () => this.onDeath();
    this.bot.on('hurt' as never, this.hurtHandler as never);
    this.bot.on('death' as never, this.deathHandler as never);
    if (this.cfg.playerProtection) {
      // 玩家即时保护：监听"任何实体受伤"，判定是不是身旁玩家被怪打 → 毫秒级冲过去护
      this.entityHurtHandler = (en: unknown, cause: unknown) => this.onEntityHurtForProtect(en, cause);
      this.bot.on('entityHurt' as never, this.entityHurtHandler as never);
    }
    this.checkTimer = setInterval(() => void this.check(), 2000);
    log('INFO', `🛡️ 生存守护已启动${this.cfg.playerProtection ? '（玩家即时保护反射：开）' : ''}`);
  }

  detach(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
    if (this.hurtHandler) {
      this.bot.removeListener('hurt' as never, this.hurtHandler as never);
      this.hurtHandler = null;
    }
    if (this.deathHandler) {
      this.bot.removeListener('death' as never, this.deathHandler as never);
      this.deathHandler = null;
    }
    if (this.entityHurtHandler) {
      this.bot.removeListener('entityHurt' as never, this.entityHurtHandler as never);
      this.entityHurtHandler = null;
    }
    this.fleeing = false;
    this.setProtect(false);
    log('INFO', '🛡️ 生存守护已停止');
  }

  private onHurt(attacker: unknown): void {
    const s = this.status.getStatus();
    const health = s.self.health;
    log('WARN', `受到攻击！血量 ${health}`);
    const attackerEntity = attacker as { id?: number; name?: string; attack?: () => Promise<void>; position?: { x: number; y: number; z: number } } | null;
    const aName = attackerEntity?.name;
    // ── 玩家攻击（陪伴定位：非约定 PVP 绝不反击，走困惑→委屈→难过 3 级递进）──
    if (aName && aName !== this.bot.username && this.bot.players?.[aName]) {
      this.handlePlayerAttack(aName, health);
      return;
    }
    if (health < this.fleeLine()) {
      // 被打到撤退线 = 差点死（蓝图 almost_died 情绪）
      this.emotion?.react('almost_died');
      void this.flee();
      return;
    }
    if (!attackerEntity) return;
    // PVE 战斗层开启 → 进连续战斗（打/追/撤都由战斗循环管）；关闭则退回"反击一下"
    if (this.cfg.autoCombat) {
      this.combatInitId = attackerEntity.id ?? -1;
      void this.startCombat(attackerEntity as never);
      return;
    }
    const attackFn = attackerEntity?.attack;
    if (attackFn) {
      log('INFO', `反击 ${attackerEntity.name ?? '攻击者'}`);
      void (async () => {
        const release = await this.body.acquire('guardian', '反击');
        try {
          await attackFn().catch(() => undefined);
        } finally {
          release();
        }
      })();
    }
  }

  /**
   * 玩家攻击 Bot 的分级响应（规格 §三）。
   * 约定 PVP 中 → 对打（只防反击约定对象，血≤4 认输）；否则困惑(1)→委屈(2)→难过逃跑(3+)，绝不还手。
   */
  private handlePlayerAttack(name: string, health: number): void {
    const now = Date.now();
    // —— 约定 PVP 中：对打（克制：只打约定对象；血≤4 认输）——
    if (this.pvpName === name && now < this.pvpUntil) {
      this.pvpLastHitAt = now;
      if (health <= 4) {
        log('WARN', `PVP 血量 ${health} ≤ 4，认输`);
        this.emotion?.react('almost_died');
        this.endPvp();
        void this.flee();
        return;
      }
      const pe = this.bot.players[name]?.entity;
      if (pe) void this.startCombat(pe as never, { pvpPlayer: name });
      return;
    }
    // —— 非约定：3 级递进 ——
    if (now - this.lastPlayerHitAt < 10000 && this.lastPlayerHitName === name) this.playerHitCount++;
    else this.playerHitCount = 1;
    this.lastPlayerHitAt = now;
    this.lastPlayerHitName = name;
    this.memory.pushTimeline(`被玩家${name}打了一下（连续第${this.playerHitCount}次）`);
    this.memory.addStat('attacked_by_player', 1);
    if (this.playerHitCount === 1) {
      log('WARN', `玩家 ${name} 打我第 1 次 → 困惑后退，不还手`);
      this.emotion?.react('hit_by_player_1');
      this.combatSayFired('hit_by_player_1', name);
      void this.playerBackOff(name, 6);
    } else if (this.playerHitCount === 2) {
      log('WARN', `玩家 ${name} 打我第 2 次 → 委屈后退，不还手`);
      this.emotion?.react('hit_by_player_2');
      this.combatSayFired('hit_by_player_2', name);
      void this.playerBackOff(name, 8);
    } else {
      log('WARN', `玩家 ${name} 打我第 3+ 次 → 难过跑远`);
      this.emotion?.react('hit_by_player_3');
      this.combatSayFired('hit_by_player_3plus', name);
      void this.playerBackOff(name, 30);
    }
  }

  /** 大脑/工具确认玩家想切磋 → 进入约定 PVP（60s 无攻击自动退出） */
  startAgreedPvp(name: string): { ok: boolean; msg?: string } {
    if (!this.bot.players?.[name]?.entity) return { ok: false, msg: `${name} 不在附近，没法切磋` };
    if (this.bot.health <= 4) return { ok: false, msg: '我血量太低了，先缓缓' };
    this.pvpName = name;
    this.pvpUntil = Date.now() + 60_000;
    this.pvpLastHitAt = Date.now();
    this.playerHitCount = 0;
    this.lastPlayerHitAt = 0;
    this.emotion?.react('pvp_agreed');
    this.memory.pushTimeline(`和玩家${name}约好切磋一把（点到为止）`);
    log('INFO', `⚔️ 约定 PVP 开始：${name}`);
    this.combatSayFired('player_declared_pvp', name);
    return { ok: true };
  }

  /** 玩家口头停战（"不打了/停/认输"）→ 立即退出约定 PVP */
  stopAgreedPvp(): void {
    if (!this.pvpName) return;
    log('INFO', `玩家叫停，结束与 ${this.pvpName} 的切磋`);
    this.endPvp();
  }

  /** 是否正处于约定 PVP */
  inAgreedPvp(): boolean {
    return !!this.pvpName && Date.now() < this.pvpUntil;
  }

  /** 清理约定 PVP 状态（输/赢/超时/叫停共用；说话交大脑语境，不硬编码预设） */
  private endPvp(): void {
    if (!this.pvpName) { this.pvpUntil = 0; return; }
    const name = this.pvpName;
    this.combatSayFired('pvp_end', name);
    this.pvpName = '';
    this.pvpUntil = 0;
    this.memory.pushTimeline(`和玩家${name}的切磋结束了`);
  }

  private onDeath(): void {
    log('WARN', '💀 我死了！');
    this.emotion?.react('lost_items'); // 死亡丢东西 → 沮丧
    // 记死亡点（含维度）：死亡回捡技能靠它走回去捡掉落物（A1 M0 硬门槛）
    const p = this.bot.entity?.position;
    const dim = dimOf(this.bot);
    const dimName = dim === 'nether' ? '下界' : dim === 'end' ? '末地' : '主世界';
    if (p) {
      const pos: [number, number, number] = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
      this.memory.setDeathPoint(dim === 'unknown' ? 'overworld' : dim, pos);
      getGlobalLandmark()?.recordDeath(dim === 'unknown' ? 'overworld' : dim, { x: pos[0], y: pos[1], z: pos[2] });
      // ★ v26 死亡台词按模式分岔（9/12 玩家实测吐槽：跑酷图里连死 4 次，大脑却蹦出"去找木头/攒装备/老实发育"）
      //   根因就是这句生存向模板 —— 冒险/旁观模式里根本没有掉落物可捡，也不该按生存套路说话。
      const gm = (this.bot.game as unknown as { gameMode?: string } | undefined)?.gameMode;
      const advLike = gm === 'adventure' || gm === 'spectator';
      this.memory.pushTimeline(
        advLike
          ? `我在${dimName}摔死了（${pos.join(',')}），已经回出生点。注意：当前是${gm === 'adventure' ? '冒险' : '旁观'}模式（多半是跑酷/机关/小游戏图），身上没装备、也没有掉落物可捡 —— 不要说"去找木头/攒装备/老实发育"这类生存套话，就当被这张图摔了，接着陪玩家玩`
          : `我不小心在${dimName}死了（${pos.join(',')}），复活后要去捡回东西`,
        pos
      );
    } else {
      this.memory.pushTimeline(`我不小心在${dimName}死了`);
    }
    setTimeout(() => {
      // 修复：mineflayer 死亡后不会自动重生，必须显式 bot.respawn()（发送 client_command）。
      // 旧代码只打印"已重生"，bot 实际一直卡在死亡画面。
      try {
        this.bot.respawn();
        log('INFO', '↩ 死亡后已主动调用 respawn()');
      } catch (e) {
        log('WARN', `respawn() 调用失败（可能已在重生中）: ${e}`);
      }
    }, 1500);
  }

  private async flee(): Promise<void> {
    if (this.fleeing) return;
    this.fleeing = true;
    const release = await this.body.acquire('guardian', '保命逃跑');
    try {
      log('WARN', '血量过低，撤退！');
      const my = this.bot.entity.position;
      const dim = dimOf(this.bot);
      let target: { x: number; y: number; z: number };
      if (dim === 'nether' || dim === 'end') {
        // 下界/末地：主世界出生点坐标在本地维度是错的 → 朝记录的传送门退（没记录就随便退开保命）
        const anchor = dim === 'nether' ? this.memory.data.identity.nether_portal : undefined;
        if (anchor) {
          log('INFO', `朝${dim}传送门方向撤退`);
          target = { x: anchor[0], y: anchor[1], z: anchor[2] };
        } else {
          target = { x: my.x + 30, y: my.y, z: my.z };
        }
      } else {
        // 主世界：向出生点反方向退 30 格（现状行为）
        const spawn = this.bot.spawnPoint ?? { x: my.x, y: my.y, z: my.z };
        const dx = my.x - spawn.x, dz = my.z - spawn.z;
        const len = Math.hypot(dx, dz) || 1;
        target = { x: my.x + (dx / len) * 30, y: my.y, z: my.z + (dz / len) * 30 };
      }
      try {
        await gotoSmart(this.bot, new goals.GoalNear(target.x, target.y, target.z, 3), 15000, '逃跑', { rescue: true });
      } catch (e) {
        log('WARN', `逃跑卡住: ${e}`);
      }
      // 吃东西
      await this.autoEat();
      this.combatSayFired('escaped');
    } finally {
      release();
      this.fleeing = false;
    }
  }

  private async autoEat(): Promise<void> {
    const now = Date.now();
    if (now - this.lastAutoEat < 5000) return;
    this.lastAutoEat = now;
    const release = await this.body.acquire('guardian', '自动进食');
    try {
      const items = this.bot.inventory.items() as unknown as Array<{ name: string; count: number }>;
      const food = items.find((it) => {
        const n = it.name;
        return n.includes('beef') || n.includes('pork') || n.includes('chicken') || n.includes('bread') || n.includes('apple') || n.includes('mutton') || n.includes('cod') || n.includes('salmon') || n === 'baked_potato';
      });
      if (!food) return;
      await this.bot.equip(food as never, 'hand');
      await this.bot.activateItem();
      await sleep(1500);
      log('INFO', `已自动进食 ${food.name}`);
    } catch {
      /* ignore */
    } finally {
      release();
    }
  }

  /** 战斗事件说话（冷却 ≥8s 防连发刷屏；钩子为空=静默——战斗说话本来就是可选项） */
  private combatSayFired(ev: CombatSayEvent, target?: string): void {
    const now = Date.now();
    if (now - this.lastCombatSay < 8000) return;
    this.lastCombatSay = now;
    try { this.combatSay?.(ev, target); } catch { /* 说话失败不影响战斗 */ }
  }

  /** 护人状态置位并广播给 companion（心跳抑制）。true=开护 false=护完/中断 */
  private setProtect(active: boolean): void {
    this.protectInProgress = active;
    try { this.onProtectChange?.(active); } catch { /* 广播失败不影响战斗 */ }
  }

  /** 被玩家打后的拉开距离（1/2 次短退，3+ 次 30 格跑远）。绝不还手，只拉开 */
  private async playerBackOff(name: string, dist: number): Promise<void> {
    if (this.playerReacting || !this.bot.entity) return;
    this.playerReacting = true;
    const release = await this.body.acquire('guardian', `玩家打我(后退${dist})`);
    try {
      const p = this.bot.players[name]?.entity?.position;
      const me = this.bot.entity.position;
      if (!p) return;
      const dx = me.x - p.x, dz = me.z - p.z;
      const len = Math.hypot(dx, dz) || 1;
      const away = { x: me.x + (dx / len) * dist, y: me.y, z: me.z + (dz / len) * dist };
      try {
        await gotoSmart(this.bot, new goals.GoalNear(away.x, away.y, away.z, 2), 4000, '拉开距离', { rescue: true });
      } catch { /* 走不动就停，不再硬挤 */ }
    } finally {
      release();
      this.playerReacting = false;
    }
  }

  private async check(): Promise<void> {
    if (!this.bot.entity || this.bot.isSleeping) return;
    const s = this.status.getStatus();
    // 玩家伤害分级复位：10s 没再被打 → 翻篇
    if (this.playerHitCount > 0 && Date.now() - this.lastPlayerHitAt > 10000) {
      this.playerHitCount = 0;
      this.lastPlayerHitName = '';
      this.playerReacting = false;
    }
    // 约定 PVP 超时：60s 无新攻击自动退出
    if (this.pvpName && Date.now() >= this.pvpUntil) {
      log('INFO', `与 ${this.pvpName} 的切磋 60s 无攻击，自动结束`);
      this.endPvp();
    }
    // —— PVE 战斗层：贴身敌对威胁探测（不依赖受伤，创造/无敌模式也能触发）——
    if (this.cfg.autoCombat && this.combatState === 'idle') {
      const me = this.bot.entity.position;
      let nearestThreat: { e: never; dist: number } | null = null;
      for (const e of Object.values(this.bot.entities)) {
        const ent = e as unknown as { name?: string; position?: { x: number; y: number; z: number } };
        const en = (ent.name ?? '').toLowerCase();
        if (!HOSTILE.includes(en) || !ent.position) continue;
        const d = Math.hypot(ent.position.x - me.x, ent.position.y - me.y, ent.position.z - me.z);
        if (d < this.combatRangeEff() && (!nearestThreat || d < nearestThreat.dist)) {
          nearestThreat = { e: e as never, dist: d };
        }
      }
      if (nearestThreat) {
        const t = nearestThreat.e as unknown as { name?: string };
        const en = (t.name ?? '').toLowerCase();
        if (en === 'creeper') {
          // 苦力怕贴身：视距离与血线决定"打一下跑一下"还是纯避让（避免引爆）
          this.emotion?.react('mob_nearby');
          void this.handleCreeperContact(nearestThreat.e, nearestThreat.dist);
        } else if (en === 'enderman') {
          // 末影人被看会狂暴+瞬移，只能纯避让不硬刚
          log('WARN', `enderman 贴身 ${nearestThreat.dist.toFixed(1)} 格，拉开距离避让`);
          this.emotion?.react('mob_nearby');
          void this.retreatFromThreat(nearestThreat.e);
        } else {
          log('WARN', `发现 ${en} 贴身 ${nearestThreat.dist.toFixed(1)} 格，主动迎击`);
          void this.startCombat(nearestThreat.e);
        }
      }
    }
    // —— 玩家即时保护反射（独立于 autoCombat）：怪逼近身旁玩家 → 护人 ——
    if (this.cfg.playerProtection) {
      this.scanPlayerProtection();
    }
    // 饥饿
    if (s.self.food < 7) {
      void this.autoEat();
    }
    // 防走丢（锚点按维度取：主世界=home，下界=下界侧传送门，末地/无锚点则跳过）
    const dim = dimOf(this.bot);
    const anchor = dim === 'nether'
      ? this.memory.data.identity.nether_portal
      : dim === 'overworld'
        ? this.memory.data.identity.home
        : null;
    if (anchor && this.cfg.leashRadius > 0) {
      const [hx, , hz] = anchor;
      const [px, , pz] = s.self.position;
      const dist = Math.hypot(px - hx, pz - hz);
      if (dist > this.cfg.leashRadius) {
        // v17 审查修复：玩家任务（跟随/移动指令）占用身体时不抢 —— "离家远"不是危险，
        // 抢了会把跟随踢断（玩家看到"跟着跟着自己跑回家了"）。跟随时玩家会带它回来。
        const cur = this.body.current();
        if (cur.owner === 'player') {
          log('INFO', `${dim === 'nether' ? '离传送门' : '离家'} ${Math.round(dist)} 格，但玩家任务（${cur.label}）占用身体，暂不回收`);
        } else {
          log('WARN', `${dim === 'nether' ? '离传送门' : '离家'} ${Math.round(dist)} 格，超出半径，回去！`);
          const release = await this.body.acquire('guardian', '防走丢回锚点');
          try {
            await gotoSmart(this.bot, new goals.GoalBlock(hx, anchor[1], hz), 20000, '回锚点', { rescue: true });
          } catch (e) {
            log('WARN', `回锚点卡住: ${e}`);
          } finally {
            release();
          }
        }
      }
    }
  }

  // ================== PVE 战斗层 ==================

  // —— 情绪调制（PDF 模块二：性格/情绪影响战斗风格）——
  // risk_tolerance: 心情好(>1)→敢冒险，心情差/害怕(<1)→保守，默认 1（emotion valence ±100 → 0.5~1.5）
  private emotionRisk(): number {
    return this.emotion?.getBehaviorModifier().risk_tolerance ?? 1;
  }

  /** 情绪化撤退线：心情差(risk<1)时血线抬高、更早逃；心情好(risk>1)也不低于硬线——保命标准不因心情下调 */
  private fleeLine(): number {
    const base = this.cfg.fleeHealth;
    const r = this.emotionRisk();
    if (r >= 1) return base;
    const fear = Math.min(1, 1 - r);
    return Math.min(10, Math.ceil(base * (1 + fear)));
  }

  /** 情绪化警戒半径：越勇(risk 高)越早主动迎击，越怂警戒越贴身 */
  private combatRangeEff(): number {
    const r = this.emotionRisk();
    return this.cfg.combatRange * (0.7 + r * 0.3);
  }

  /** 苦力怕贴身分流：贴脸(<2.5格)或血线不安全 → 纯避让；还有先手余地 → 打一下跑一下（PDF PVE tactic hit_and_run） */
  private async handleCreeperContact(e: never, dist: number): Promise<void> {
    if (this.combatState !== 'idle') return;
    const hp = this.bot.health;
    // 血量没余量挨一炸（爆炸半径3格约半血+）或已贴脸到起爆临界 → 只跑不撩
    if (dist < 2.5 || hp <= this.fleeLine() + 4) {
      log('WARN', `苦力怕贴脸 ${dist.toFixed(1)} 格/血线不足，纯避让`);
      await this.retreatFromThreat(e);
      return;
    }
    await this.creeperKite(e);
  }

  /** 苦力怕拉锯：接近→先手一刀→立刻反跑脱离爆炸半径→回头再来，直到它死/跑远/超时。每轮查血线，随时让路给 flee */
  private async creeperKite(e: never): Promise<void> {
    if (this.combatState !== 'idle') return;
    this.combatState = 'kiting';
    const release = await this.body.acquire('guardian', '苦力怕拉锯');
    let released = false;
    const drop = () => { if (!released) { released = true; release(); } };
    try {
      await this.equipBestWeapon();
      const tid = String((e as unknown as { id?: number })?.id ?? '');
      const initName = String((e as unknown as { name?: string })?.name ?? 'creeper');
      const T0 = Date.now();
      const TIMEOUT = 18000;
      let slashed = false; // 是否成功先手过（之后实体消失=击杀/引爆）
      while (Date.now() - T0 < TIMEOUT) {
        // 血线检查：低血立刻释放锁转 flee
        if (this.bot.health <= this.fleeLine()) {
          log('WARN', '拉锯中血量过低，转逃跑');
          this.emotion?.react('almost_died');
          drop();
          await this.flee();
          this.combatState = 'idle';
          return;
        }
        const live = tid ? (this.bot.entities as Record<string, unknown>)[tid] : null;
        if (!live) {
          // 苦力怕消失：被砍死/自己引爆/走远 → 目标达成
          log('INFO', slashed ? '苦力怕处理完毕（击杀/引爆/消失）' : '苦力怕已离开');
          break;
        }
        const me = this.bot.entity?.position;
        const tp = (live as unknown as { position?: { x: number; y: number; z: number } })?.position;
        if (!me || !tp) break;
        let d = Math.hypot(tp.x - me.x, tp.y - me.y, tp.z - me.z);
        // 已点燃(fuse)的苦力怕：实体无直接标记，靠距离信号——离 <2.2 说明它贴上来要炸，直接跑
        if (d > 2.6) {
          try {
            // 短距直走（快稳，绕开短距寻路空转）；走不近就降级寻路
            try {
              await walkStraightTo(this.bot, { x: tp.x, y: tp.y, z: tp.z }, { timeoutMs: 4000, tol: 1.8 });
            } catch {
              await gotoSmart(this.bot, new goals.GoalNear(tp.x, tp.y, tp.z, 1.8), 2000, '接近苦力怕', { rescue: true });
            }
          } catch { break; }
        } else {
          // 到位：先手一刀（点燃 fuse 1.5s）→ 立刻标记要跑。出刀前先面向（修复"手从背后伸出去打"）
          try { faceToward(this.bot, tp.x, tp.y + 0.8, tp.z); } catch { /* ignore */ }
          await sleep(60);
          try { (this.bot as unknown as { attack: (x: never) => void }).attack(live as never); } catch { /* ignore */ }
          slashed = true;
          await sleep(80);
          const me2 = this.bot.entity?.position;
          const tp2 = (live as unknown as { position?: { x: number; y: number; z: number } })?.position;
          if (!me2 || !tp2) break;
          const dx = me2.x - tp2.x, dz = me2.z - tp2.z;
          const len = Math.hypot(dx, dz) || 1;
          // 反方向跑 8 格（>爆炸半径3），分 3 段各 ~2.7 格，段间不查血线（快速脱离优先）
          for (let seg = 0; seg < 3; seg++) {
            const m = this.bot.entity?.position;
            if (!m || !this.bot.entity) return;
            const away = { x: m.x + (dx / len) * 3, y: m.y, z: m.z + (dz / len) * 3 };
            try {
              await gotoSmart(this.bot, new goals.GoalNear(away.x, away.y, away.z, 1.2), 1400, '脱离爆炸', { rescue: true });
            } catch { break; }
          }
          await sleep(300); // 等 fuse 结算（炸死/哑火）
          if (!slashed) break;
        }
        await sleep(120);
      }
      // 收尾：真处理过且目标没了 → 算一次战果
      if (slashed) {
        const still = tid ? (this.bot.entities as Record<string, unknown>)[tid] : null;
        if (!still) {
          log('INFO', `干掉了贴身的 ${initName}`);
          this.emotion?.react('killed_mob');
          this.memory.pushTimeline(`用放风筝打掉了贴身的苦力怕`);
          this.memory.addStat('mob_kills', 1);
        }
      }
    } catch (e) {
      log('WARN', `苦力怕拉锯异常: ${e}`);
    } finally {
      drop();
      this.combatState = 'idle';
    }
  }

  /** 扫描附近可交战的敌对生物（排除苦力怕/末影人这类不能主动惹的），按距离升序 */
  private scanThreats(maxDist: number): Array<{ e: never; dist: number }> {
    const me = this.bot.entity.position;
    const out: Array<{ e: never; dist: number }> = [];
    for (const e of Object.values(this.bot.entities)) {
      const ent = e as unknown as { name?: string; position?: { x: number; y: number; z: number } };
      const en = (ent.name ?? '').toLowerCase();
      if (!HOSTILE.includes(en) || NO_PROVOKE.has(en)) continue;
      if (!ent.position) continue;
      const d = Math.hypot(ent.position.x - me.x, ent.position.y - me.y, ent.position.z - me.z);
      if (d <= maxDist) out.push({ e: e as never, dist: d });
    }
    out.sort((a, b) => a.dist - b.dist);
    return out;
  }

  private entityDist(e: unknown): number {
    const p = (e as unknown as { position?: { x: number; y: number; z: number } })?.position;
    const me = this.bot.entity?.position;
    if (!p || !me) return 999;
    return Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z);
  }

  /** 装备背包里最好的剑（netherite→diamond→iron→gold→stone→wood） */
  private async equipBestWeapon(): Promise<void> {
    try {
      const items = this.bot.inventory.items() as unknown as Array<{ name: string }>;
      const order = ['netherite_sword', 'diamond_sword', 'iron_sword', 'golden_sword', 'stone_sword', 'wooden_sword'];
      let best: { name: string } | null = null;
      for (const n of order) {
        const it = items.find((x) => x.name === n);
        if (it) { best = it; break; }
      }
      if (!best) return;
      const cur = (this.bot.heldItem as unknown as { name?: string })?.name;
      if (cur !== best.name) {
        await this.bot.equip(best as never, 'hand');
        log('INFO', `已装备 ${best.name} 战斗`);
      }
    } catch (e) {
      log('WARN', `装备武器失败: ${e}`);
    }
  }

  /** 苦力怕/末影人贴身避让：不硬刚，往反方向拉开。分段走，每段检查血线——低血立刻让路给逃生（v2.0 bugfix：避让长锁会阻塞 flee 排队致死） */
  private async retreatFromThreat(e: never): Promise<void> {
    if (this.combatState !== 'idle') return;
    this.combatState = 'retreating';
    const release = await this.body.acquire('guardian', '危险避让');
    let released = false;
    const drop = () => { if (!released) { released = true; release(); } };
    try {
      const tid = String((e as unknown as { id?: number })?.id ?? '');
      const initPos = (e as unknown as { position?: { x: number; y: number; z: number } })?.position;
      // 每段沿"远离威胁"方向走 5 格，段间查血线；最多 4 段（~8s）
      for (let step = 0; step < 4; step++) {
        const me = this.bot.entity?.position;
        if (!me || !this.bot.entity) return;
        const hp = this.bot.health;
        if (hp <= this.fleeLine()) {
          log('WARN', `避让中血量 ${hp} 触撤退线，转逃跑`);
          this.emotion?.react('almost_died');
          drop();
          await this.flee();            // 需先释放锁再 flee，否则排队等自己
          this.combatState = 'idle';
          return;
        }
        // 取威胁最新位置（可能已移动）
        const live = tid ? (this.bot.entities as Record<string, unknown>)[tid] : null;
        const p = (live ?? e) as unknown as { position?: { x: number; y: number; z: number } };
        const tp = p?.position ?? initPos;
        if (!tp) return;
        let dx = me.x - tp.x, dz = me.z - tp.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len; dz /= len;
        const away = { x: me.x + dx * 5, y: me.y, z: me.z + dz * 5 };
        try {
          await gotoSmart(this.bot, new goals.GoalNear(away.x, away.y, away.z, 2), 2000, '危险避让', { rescue: true });
        } catch {
          break; // 走不动就停，交给下轮探测/逃生
        }
      }
    } finally {
      drop();
      this.combatState = 'idle';
    }
  }

  /**
   * —— 玩家即时保护反射 ——
   * 身旁玩家被怪威胁时，毫秒级冲过去护（独立于 autoCombat）。
   * 触发①：entityHurt 玩家被怪打（onEntityHurtForProtect 事件直通）；
   * 触发②：定时扫描发现怪逼近玩家（≤6格且 bot 够得着 ≤24格）——走 500ms 去抖确认。
   * 战斗执行复用 startCombat + protect 标记；血不安全时不硬送死。
   */

  /** entityHurt 事件：被伤者若是身旁玩家、且伤害源是敌对生物 → 立即护（事件直通，无去抖） */
  private onEntityHurtForProtect(en: unknown, cause: unknown): void {
    if (!this.cfg.playerProtection || this.protectInProgress) return;
    const ent = en as { type?: string; username?: string; position?: { x: number; y: number; z: number } };
    // 被伤者必须是玩家（且非 bot 自己）
    if (ent.type !== 'player' || !ent.username || ent.username === this.bot.username) return;
    // 伤害源是敌对生物才算（护人只管打你的怪，摔伤/岩浆不管）
    const src = cause as { name?: string } | null;
    const srcName = (src?.name ?? '').toLowerCase();
    if (!HOSTILE.includes(srcName)) return;
    log('INFO', `🛡 玩家 ${ent.username} 被 ${srcName} 袭击 → 立即护`);
    this.protectPlayerName = ent.username;
    this.setProtect(true);
    // 触发时锁定打他的那只怪（伤害源是 srcName），实体此刻必在场，不重扫不丢目标
    const tid = this.entityIdNearPlayer(ent.username, srcName);
    if (tid) log('INFO', `🛡 锁定袭击者 ${srcName}(id=${tid})`);
    void this.startCombatForPlayer(ent.username, tid ?? undefined);
  }

  /** 定时扫描：怪逼近身旁玩家（≤6格且 bot 够得着 ≤24格）。带 500ms 去抖确认真威胁 */
  private scanPlayerProtection(): void {
    if (this.protectInProgress || this.combatState !== 'idle') return;
    const s = this.status.getStatus();
    const me = this.bot.entity?.position;
    if (!me) return;
    // 身旁玩家（在线且有坐标）
    const players = s.world.players.filter((p) => p.position && p.name !== this.bot.username);
    if (players.length === 0) return; // 只在玩家在线时触发
    let found: { e: never; d: number; playerName: string } | null = null;
    const now = Date.now();
    for (const p of players) {
      const pp = p.position!;
      for (const e of Object.values(this.bot.entities)) {
        const ent = e as unknown as { name?: string; position?: { x: number; y: number; z: number } };
        const en = (ent.name ?? '').toLowerCase();
        if (!HOSTILE.includes(en) || !ent.position) continue;
        const dToPlayer = Math.hypot(ent.position.x - pp[0], ent.position.y - pp[1], ent.position.z - pp[2]);
        if (dToPlayer > 6) continue;            // 只在玩家 ≤6 格内的怪算威胁
        const dToBot = Math.hypot(ent.position.x - me.x, ent.position.y - me.y, ent.position.z - me.z);
        if (dToBot > 24) continue;              // bot 够不着就不追
        if (!found || dToPlayer < found.d) {
          found = { e: e as never, d: dToPlayer, playerName: p.name };
        }
      }
    }
    if (!found) { this.protectPendingAt = 0; return; }
    // 500ms 去抖确认真威胁（保护自己当前可能正被 auto 占用时不被误拉入战）
    if (this.protectPendingAt === 0) {
      this.protectPendingAt = now;
    } else if (now - this.protectPendingAt >= 500) {
      log('INFO', `🛡 玩家 ${found.playerName} 被 ${String((found.e as { name?: string }).name ?? '怪')} 逼到 ${found.d.toFixed(1)} 格 → 去护`);
      this.protectPlayerName = found.playerName;
      this.protectPendingAt = 0;
      this.setProtect(true);
      void this.startCombatForPlayer(found.playerName, String((found.e as { id?: number })?.id ?? ''));
    }
  }

  /** 护人战斗入口：血不安全先喊协同不硬送；血安全 → startCombat + protect 标记。
   *  threatId：触发时已知的明显威胁实体的 id（不重扫，避免时序窗口丢目标）。 */
  private async startCombatForPlayer(playerName: string, threatId?: string): Promise<void> {
    try {
      const hp = this.bot.health;
      if (hp <= this.cfg.fleeHealth) {
        // 自己血太低，别白送死：喊玩家一起上/把怪引开，不硬撑
        log('WARN', `血量 ${hp} 过低无法直接护人，喊 ${playerName} 一起上/把怪引开`);
        this.combatSayFired('protect_start', `${playerName}（我被 ${hp} 血，上不了，一起打）`);
        return;
      }
      // 找目标：优先用触发时锁定的那只（不重扫，避免时序窗口丢目标）；没了才回退重扫
      let t = threatId ? this.entityById(threatId) : null;
      if (t) {
        log('INFO', `🛡 护人：用触发锁定的明显威胁实体(id=${threatId})`);
      } else {
        if (threatId) log('WARN', `🛡 触发实体(id=${threatId})已消失，回退重扫附近威胁`);
        t = this.nearestHostileNearPlayer(playerName);
        if (!t) {
          log('INFO', '🛡 护人：目标怪已不在，无需出手');
          return;
        }
      }
      // 先喊一声让人安心（本地战斗说话钩子 → 大脑现编，非阻塞，立即开打）
      this.combatSayFired('protect_start', playerName);
      // 把触发锁定实体 id 一起传进 startCombat，生成 protect 分支用它判断 creeper 并传入 fleeFromPlayerArea
      const tid = threatId ?? ((t.e as unknown as { id?: number })?.id ? String((t.e as unknown as { id: number }).id) : undefined);
      await this.startCombat(t.e, { protectPlayer: playerName, protectThreatId: tid });
    } finally {
      this.setProtect(false);
    }
  }

  /** 找离指定玩家最近的敌对实体（bot 够得着 ≤24 格） */
  private nearestHostileNearPlayer(playerName: string): { e: never; dist: number } | null {
    const me = this.bot.entity?.position;
    if (!me) return null;
    const p = this.bot.players[playerName]?.entity?.position;
    if (!p) return null;
    let best: { e: never; dist: number } | null = null;
    for (const e of Object.values(this.bot.entities)) {
      const ent = e as unknown as { name?: string; position?: { x: number; y: number; z: number } };
      const en = (ent.name ?? '').toLowerCase();
      if (!HOSTILE.includes(en) || !ent.position) continue;
      const dToBot = Math.hypot(ent.position.x - me.x, ent.position.y - me.y, ent.position.z - me.z);
      if (dToBot > 24) continue; // 够不着就不追
      const dToPlayer = Math.hypot(ent.position.x - p.x, ent.position.y - p.y, ent.position.z - p.z);
      if (!best || dToPlayer < best.dist) best = { e: e as never, dist: dToPlayer };
    }
    return best;
  }

  /** 按实体 id 取回实体（触发锁定的目标，防重扫丢目标） */
  private entityById(id: string): { e: never } | null {
    if (!id) return null;
    const e = (this.bot.entities as Record<string, unknown>)[id];
    return e ? ({ e: e as never } as { e: never }) : null;
  }

  /** 安全读实体坐标（读不到返回 null） */
  private cheapPos(e: unknown): { x: number; y: number; z: number } | null {
    const p = (e as { position?: { x?: number; y?: number; z?: number } } | null)?.position;
    if (!p || p.x === undefined || p.y === undefined || p.z === undefined) return null;
    return { x: p.x, y: p.y, z: p.z };
  }

  /** 找玩家身边最近的、指定名字(normalized)的敌对实体 id，锁定时用（触发瞬间必在场） */
  private entityIdNearPlayer(playerName: string, srcName: string): string | null {
    const p = this.bot.players[playerName]?.entity?.position;
    if (!p) return null;
    let bestId: string | null = null, bestD = Infinity;
    for (const [id, e] of Object.entries(this.bot.entities)) {
      const ent = e as unknown as { name?: string; position?: { x: number; y: number; z: number } };
      if ((ent.name ?? '').toLowerCase() !== srcName || !ent.position) continue;
      const d = Math.hypot(ent.position.x - p.x, ent.position.y - p.y, ent.position.z - p.z);
      if (d < bestD) { bestD = d; bestId = id; }
    }
    return bestId;
  }

  /** 护人遇不可硬刚生物（苦力怕/末影人）：真正把怪从玩家身边拉开，不硬刚不引爆。
   *  旧实现只 800ms/1.5 格假引离就收工（实测 creeper 紧贴玩家照样炸）。
   *  改为：走到怪外侧→把怪当靶子一步步引离玩家，直到怪距玩家 ≥ 安全半径才收工。 */
  /** 护人把怪引离玩家。threatId 为触发时已锁定的特定怪（不重扫，避免时序丢目标）；只引这只怪，它消失才回退重扫。 */
  private async fleeFromPlayerArea(playerName: string, threatId?: string): Promise<void> {
    if (!this.bot.entity) return;
    // 注意：本方法被 startCombat(protect 分支)在 drop() 释放锁之后调用，此时 combatState 仍是 'fighting'，
    // 不能再以 combatState==='idle' 作保护（那会直接 return 导致拉怪从不执行）。这里自行抢锁并接管状态。
    this.combatState = 'retreating';
    const release = await this.body.acquire('guardian', `护玩家拉怪(${playerName})`);
    const SAFE = 4.0;   // 爆炸半径 3 + 缓冲 → 怪离玩家 ≥4 格才算脱离
    try {
      await this.equipBestWeapon();
      const T0 = Date.now();
      const TIMEOUT = 20000;
      const me = () => this.bot.entity?.position;
      const pp = () => this.bot.players[playerName]?.entity?.position;
      let kited = false;   // 是否真的把怪拉动过
      if (threatId) log('INFO', `拉怪目标：触发锁定的实体 id=${threatId}`);
      // 目标解析：优先返回触发锁定那只（id 直取），丢了才回退扫玩家身边不可硬刚怪
      const resolveThreat = (): { e: never; dist: number } | null => {
        if (threatId) {
          const ent = (this.bot.entities as Record<string, unknown>)[threatId] as
            | { position?: { x: number; y: number; z: number }; name?: string }
            | undefined;
          const p = pp();
          if (ent?.position && p) {
            return { e: (this.bot.entities as Record<string, unknown>)[threatId] as never, dist: Math.hypot(ent.position.x - p.x, ent.position.y - p.y, ent.position.z - p.z) };
          }
          if (!ent) {
            // 锁定实体没了 → 回退重扫（其他不可硬刚怪还在就继续拉，防止它换了对象留在玩家身边）
            const fb = this.nearestHostileNearPlayerUnprovokable(playerName);
            if (fb) { log('WARN', `锁定实体(id=${threatId})已消失，回退拉附近不可硬刚怪`); threatId = String((fb.e as { id?: number })?.id ?? ''); }
            return fb;
          }
        }
        return this.nearestHostileNearPlayerUnprovokable(playerName);
      };
      while (me() && pp() && Date.now() - T0 < TIMEOUT) {
        // 血线检查：自己快死了，拉怪让位给逃跑（逃生优先）
        if (this.bot.health <= this.fleeLine()) {
          log('WARN', `拉怪中血量 ${this.bot.health} 触撤退线，转逃跑（别把玩家坑了）`);
          this.emotion?.react('almost_died');
          await this.flee();
          return;
        }
        // 混合团战：引离苦力怕的同时，先清玩家身边的"可硬刚"怪（僵尸/骷髅等），否则玩家会被群殴到死。
        // 穿插执行——拉怪不再串行独占，每轮先砍掉最近僵尸，再回头引离苦力怕。
        const hard = this.nearestHardHostileNearPlayer(playerName);
        if (hard) {
          const hp = this.cheapPos(hard.e);
          const ppos = pp();
          const hd = ppos && hp ? Math.hypot(hp.x - ppos.x, hp.y - ppos.y, hp.z - ppos.z) : 999;
          if (hd <= 6) {   // 僵尸已贴住玩家 → 别顾着拉苦力怕，先把命救下
            log('WARN', `护人：玩家身边有可硬刚怪（≈${hd.toFixed(1)}格），先穿插砍掉，再回身引离爆炸/狂暴怪`);
            try {
              // 近身出刀，直到砍掉/打退/它跑远
              for (let s = 0; s < 5 && hard.e; s++) {
                const still = (this.bot.entities as Record<string, unknown>)[String((hard.e as unknown as { id?: number })?.id ?? '')];
                if (!still) break;
                const hp2 = this.cheapPos(hard.e); const p2 = pp();
                const d2 = hp2 && p2 ? Math.hypot(hp2.x - p2.x, hp2.y - p2.y, hp2.z - p2.z) : 999;
                if (!hp2 || d2 > 8) break;   // 打跑了/拉远了就停
                const here = this.cheapPos(hard.e);
                if (here) {
                  try { await gotoSmart(this.bot, new goals.GoalNear(here.x, here.y, here.z, 1.5), 1200, '护人补刀', { rescue: true }); } catch { /* 走不到就停 */ }
                  try { (this.bot as unknown as { attack: (x: never) => void }).attack(hard.e); } catch { /* ignore */ }
                }
                await sleep(180);
              }
            } catch { /* 不因补刀失败影响引离 */ }
          }
          kited = false;   // 触发过补刀，本轮不算已拉走
        }
        // 找目标怪（优先触发锁定的那只）
        const t = resolveThreat();
        if (!t) {
          log('INFO', kited ? '拉怪完成：玩家身边已无敌对威胁' : '护人拉怪：目标怪已不在/身边本就无怪');
          return;
        }
        const tp = (t.e as unknown as { position?: { x: number; y: number; z: number } | null })?.position;
        if (!tp) return;   // 怪没坐标就谈不上引离
        const dToPlayer = Math.hypot(tp.x - pp()!.x, tp.y - pp()!.y, tp.z - pp()!.z);
        if (dToPlayer >= SAFE) {
          log('INFO', `✔ 怪已离玩家 ${dToPlayer.toFixed(1)} 格（≥${SAFE}），脱离成功`);
          return;
        }
        // 怪还贴着玩家：从「玩家→怪」延长线上走到怪外侧，然后拉着反向跑（把怪引离玩家）
        const tName = String(((t.e as unknown as { name?: string })?.name ?? '怪')).toLowerCase();
        const dirx = tp.x - pp()!.x, dirz = tp.z - pp()!.z;
        const len = Math.hypot(dirx, dirz) || 1;
        const outer = { x: tp.x + (dirx / len) * 2.5, y: tp.y, z: tp.z + (dirz / len) * 2.5 }; // 怪靠外的贴身点
        // ①走到怪外侧（贴着但保持是玩家反方向的那侧）
        try {
          await walkStraightTo(this.bot, outer, { timeoutMs: 2000, tol: 1.6 });
        } catch {
          try {
            await gotoSmart(this.bot, new goals.GoalNear(outer.x, outer.y, outer.z, 1.6), 1500, `贴${tName}外侧`, { rescue: true });
          } catch { /* 走不到就算了，直接尝试引离 */ }
        }
        await sleep(120);
        // ②从当前位置继续沿「远离玩家」方向连拉几拍，把怪拖着走
        for (let kick = 0; kick < 3; kick++) {
          const m = me(); const q = pp();
          if (!m || !q) break;
          const ax = m.x - q.x, az = m.z - q.z;
          const al = Math.hypot(ax, az) || 1;
          const via = { x: m.x + (ax / al) * 4, y: m.y, z: m.z + (az / al) * 4 };
          try {
            await gotoSmart(this.bot, new goals.GoalNear(via.x, via.y, via.z, 1.4), 1600, `引离${tName}`, { rescue: true });
          } catch { break; }
          kited = true;
          // 该拍结束就复查：目标怪离玩家安全则提前收（优先用锁定实体，不重扫）
          const chk = resolveThreat();
          if (chk) {
            const cp = (chk.e as unknown as { position?: { x: number; y: number; z: number } | null })?.position;
            if (cp) {
              const dc = Math.hypot(cp.x - pp()!.x, cp.y - pp()!.y, cp.z - pp()!.z);
              if (dc >= SAFE) { log('INFO', `✔ 拉怪中怪已离玩家 ${dc.toFixed(1)} 格（≥${SAFE}），收工`); return; }
            }
          }
          await sleep(150);
        }
      }
      if (Date.now() - T0 >= TIMEOUT) log('WARN', `护人拉怪超时，怪仍贴玩家（尽力了）`);
    } finally {
      this.combatState = 'idle';
      release();
    }
  }

  /** 找玩家身边最近的「不可硬刚」威胁（苦力怕/末影人），够得着≤24格，专供拉怪 */
  private nearestHostileNearPlayerUnprovokable(playerName: string): { e: never; dist: number } | null {
    const me = this.bot.entity?.position;
    const p = this.bot.players[playerName]?.entity?.position;
    if (!me || !p) return null;
    let best: { e: never; dist: number } | null = null;
    for (const e of Object.values(this.bot.entities)) {
      const ent = e as unknown as { name?: string; position?: { x: number; y: number; z: number } };
      const en = (ent.name ?? '').toLowerCase();
      if (!NO_PROVOKE.has(en) || !ent.position) continue;   // 只要苦力怕/末影人这类不能硬刚的
      const dToBot = Math.hypot(ent.position.x - me.x, ent.position.y - me.y, ent.position.z - me.z);
      if (dToBot > 24) continue;
      const dToPlayer = Math.hypot(ent.position.x - p.x, ent.position.y - p.y, ent.position.z - p.z);
      if (!best || dToPlayer < best.dist) best = { e: e as never, dist: dToPlayer };
    }
    return best;
  }

  /** 玩家身边最近的"可硬刚"敌对怪（僵尸/骷髅/蜘蛛等，排除苦力怕/末影人）；护人拉怪时用来穿插补刀保玩家 */
  private nearestHardHostileNearPlayer(playerName: string): { e: never; dist: number } | null {
    const me = this.bot.entity?.position;
    const p = this.bot.players[playerName]?.entity?.position;
    if (!me || !p) return null;
    let best: { e: never; dist: number } | null = null;
    for (const e of Object.values(this.bot.entities)) {
      const ent = e as unknown as { name?: string; position?: { x: number; y: number; z: number } };
      const en = (ent.name ?? '').toLowerCase();
      if (!HOSTILE.includes(en) || NO_PROVOKE.has(en) || !ent.position) continue; // 敌对且可硬刚
      const dToBot = Math.hypot(ent.position.x - me.x, ent.position.y - me.y, ent.position.z - me.z);
      if (dToBot > 24) continue;
      const dToPlayer = Math.hypot(ent.position.x - p.x, ent.position.y - p.y, ent.position.z - p.z);
      if (!best || dToPlayer < best.dist) best = { e: e as never, dist: dToPlayer };
    }
    return best;
  }

  /** PVE 主战斗循环：优先追打触发者，其次最近威胁；近身出刀，血低撤退，清场/超时退出 */
  private async startCombat(init: never, opts?: { pvpPlayer?: string; protectPlayer?: string; protectThreatId?: string }): Promise<void> {
    if (!this.bot.entity || this.bot.isSleeping) return;
    if (this.combatState !== 'idle') return;
    const pvpName = opts?.pvpPlayer ?? '';
    const protectName = opts?.protectPlayer ?? '';
    const protectThreatId = opts?.protectThreatId ?? '';   // 触发锁定的特定怪 id，一路传进引离（防目标丢）
    const initName = pvpName || protectName
      ? `${pvpName ? 'PVP' : '护'}${pvpName || protectName}`
      : String((init as unknown as { name?: string })?.name ?? '敌对生物');
    this.combatState = 'fighting';
    const release = await this.body.acquire('guardian', pvpName ? `PVP切磋(${pvpName})` : protectName ? `护玩家(${protectName})` : `PVE战斗(${initName})`);
    let released = false;
    const drop = () => { if (!released) { released = true; release(); } };
    try {
      await this.equipBestWeapon();
      if (!pvpName) {
        if (protectName) {
          // 护人：先喊让人安心那句已由 startCombatForPlayer 发 protect_start；这里不再重复
        } else {
          this.combatSayFired('combat_start_pve', initName);
        }
      }
      const T0 = Date.now();
      const TIMEOUT = pvpName ? 30000 : 25000;
      let swingAt = 0;
      let lastCloseInit = false;            // 上一轮在砍原触发者（用于确认它是我打掉的）
      const killedNames: string[] = [];
      const initDisplay = String((init as unknown as { name?: string })?.name ?? '怪物');
      const me = () => this.bot.entity?.position;
      // 护人的目标：优先用传入的触发实体（不重扫，避免时序窗口丢目标）；
      // 若目标是苦力怕/末影人则只驱离不硬刚（防引爆/狂暴）
      let protectTarget: never | null = null;
      if (protectName) {
        const inited = init as unknown as { name?: string };
        const itn = String(inited?.name ?? '').toLowerCase();
        if (itn) {
          // 传入的触发实体判定：苦力怕/末影人 → 引离；其它 → 做攻击目标
          if (NO_PROVOKE.has(itn)) {
            log('WARN', `护人遇 ${itn}（会炸/会狂暴），转为把怪引离玩家，不硬刚`);
            drop();                        // 先释锁，fleeFromPlayerArea 内部自行抢锁（避免重入自死锁）
            this.combatState = 'idle';     // 状态归位，fleeFromPlayerArea 的进入守卫可过
            await this.fleeFromPlayerArea(protectName, protectThreatId || undefined);   // 立即抢锁并持续拉走锁定怪，直到离玩家≥4格
            this.combatState = 'idle';
            return;
          }
          protectTarget = init;
        } else {
          // 触发实体名缺失（极端情况）→ 才回退重扫
          const t = this.nearestHostileNearPlayer(protectName);
          if (t) {
            const tn = String((t.e as unknown as { name?: string })?.name ?? '').toLowerCase();
            if (NO_PROVOKE.has(tn)) {
              log('WARN', `护人遇 ${tn}（会炸/会狂暴），转为把怪引离玩家，不硬刚`);
              drop();                        // 先释锁，fleeFromPlayerArea 内部自行抢锁（避免重入自死锁）
              this.combatState = 'idle';     // 状态归位，fleeFromPlayerArea 的进入守卫可过
              await this.fleeFromPlayerArea(protectName, protectThreatId || undefined);   // 立即抢锁并持续拉走锁定怪
              this.combatState = 'idle';
              return;
            }
            protectTarget = t.e;
          }
        }
      }
      while (me() && Date.now() - T0 < TIMEOUT) {
        const hp = this.bot.health;
        if (pvpName) {
          // 约定 PVP 点到为止：血≤4 认输（不进情绪撤退线，避免提前逃破坏约定）
          if (hp <= 4) {
            log('WARN', `PVP 血量 ${hp} ≤ 4，认输`);
            this.emotion?.react('almost_died');
            drop();
            this.endPvp();
            await this.flee();            // flee 内部自己拿锁，须先释放
            this.combatState = 'idle';
            return;
          }
        } else if (hp <= this.fleeLine()) {
          log('WARN', `战斗中血量 ${hp} 触撤退线，撤！`);
          this.emotion?.react('almost_died');
          drop();
          await this.flee();            // flee 内部自己拿锁，须先释放
          this.combatState = 'idle';
          return;
        }
        // 目标选择：约定 PVP → 只打约定玩家（跑出 20 格不追，切磋克制）；护人 → 玩家身边最近怪；否则原触发者 → 最近威胁
        let target: never | null = null;
        if (pvpName) {
          const pe = this.bot.players[pvpName]?.entity;
          if (pe && this.entityDist(pe as never) <= 20) target = pe as never;
        } else if (protectName) {
          // 护人：始终盯"玩家身边最近怪"，不打到别处去
          const t = this.nearestHostileNearPlayer(protectName);
          if (t && this.entityDist(t.e) <= 24) target = t.e;
        } else {
          const initId = String((init as unknown as { id?: number })?.id ?? -1);
          const initStill = initId !== '-1' && Object.prototype.hasOwnProperty.call(this.bot.entities, initId) ? init : null;
          // 原触发者消失且上一轮正在砍它 → 击杀/打退，记名（PDF 模块三：战果进记忆）
          if (lastCloseInit && initId !== '-1' && !Object.prototype.hasOwnProperty.call(this.bot.entities, initId)) {
            killedNames.push(initDisplay);
            lastCloseInit = false;
            log('INFO', `击杀了 ${initDisplay}`);
          }
          if (initStill && this.entityDist(initStill) <= 24) target = initStill;
          else {
            const ts = this.scanThreats(24);
            target = ts.length ? ts[0].e : null;
          }
        }
        if (!target) {
          if (pvpName) {
            log('INFO', `切磋结束（用时 ${((Date.now() - T0) / 1000).toFixed(1)}s）`);
            this.emotion?.react('escaped');
            this.endPvp();
            this.memory.pushTimeline(`和${pvpName}的切磋告一段落`);
          } else if (protectName) {
            // 护人收尾：威胁清掉/离远了就算护住，自然收尾不邀功（不特意报战果邀功话）
            log('INFO', `护住 ${protectName}：威胁清场（用时 ${((Date.now() - T0) / 1000).toFixed(1)}s）`);
            this.emotion?.react('protect_done');
          } else {
            log('INFO', `战斗结束：威胁清场（用时 ${((Date.now() - T0) / 1000).toFixed(1)}s）`);
            this.emotion?.react('killed_mob');
            if (killedNames.length) {
              this.memory.pushTimeline(`打退了${killedNames.join('、')}`);
              this.memory.addStat('mob_kills', killedNames.length);
              this.combatSayFired('killed_mob', killedNames.join('、'));
            } else {
              this.memory.pushTimeline('打退了贴身的怪物');
            }
          }
          break;
        }
        const d = this.entityDist(target);
        // 每轮先面向目标（track-entity 追视同款直写 yaw）：修复倒车/侧身追击观感——
        // 真人追怪是"面向目标边看边追"，不是背对目标倒车跑（BUG-06）
        try {
          const tpp = (target as unknown as { position: { x: number; y: number; z: number } }).position;
          faceToward(this.bot, tpp.x, tpp.y + 0.8, tpp.z);
        } catch { /* ignore */ }
        if (d > 3.4) {
          try {
            const tp = (target as unknown as { position: { x: number; y: number; z: number } }).position;
            if (d <= 12) {
              // 短距直线走：快稳，绕开短距寻路空转（BUG-10）
              try {
                await walkStraightTo(this.bot, { x: tp.x, y: tp.y, z: tp.z }, { timeoutMs: 5000, tol: 1.5 });
              } catch { /* 直走被挡，下轮降级寻路 */ }
            } else {
              await gotoSmart(this.bot, new goals.GoalNear(tp.x, tp.y, tp.z, 1.5), 2500, '逼近', { rescue: true });
            }
          } catch { /* 逼近卡住/超时，下一轮重判 */ }
        } else {
          const now = Date.now();
          if (now >= swingAt) {
            try {
              // 出刀前再对准一次（目标会动，用最新位置）
              const tpp = (target as unknown as { position: { x: number; y: number; z: number } }).position;
              faceToward(this.bot, tpp.x, tpp.y + 0.8, tpp.z);
              await sleep(60);
              (this.bot as unknown as { attack: (e: never) => void }).attack(target);
            } catch { /* 出刀失败忽略 */ }
            swingAt = now + 300;
            if (target === init) lastCloseInit = true;
          }
        }
        await sleep(80);
      }
    } catch (e) {
      log('WARN', `战斗异常: ${e}`);
    } finally {
      drop();
      this.combatState = 'idle';
    }
  }
}
