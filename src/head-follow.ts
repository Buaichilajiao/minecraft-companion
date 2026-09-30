import type mineflayer from 'mineflayer';
import { log } from './utils';
import { aimAt, aimDir, releaseHead } from './head-channel';

/**
 * 底层「移动即注视」— 全局移动转头（v2，9/10 玩家重构建议）
 * ─────────────────────────────────────────────────────────────
 * v1 走的是"位移反应式 + 固定时长转头动画"，玩家反馈有先天缺陷：
 *   反应式注定"身体先动、头后转"（螃蟹步/先走再转）；固定时长动画在目标
 *   移动时会追不准。索性放弃动画方案，直接套用常驻注视(gaze)那套：
 *
 *   **移动时把视线实时锁定目标本身**（gotoSmart/walkStraight 起手 setPoint 目标坐标）：
 *   - 目标固定：一路看着它走过去，头始终朝目标方向（平路即前进方向）
 *   - 目标在动：每 tick 按当前 point 重新对准 → 视线实时跟（调用方可刷新 point 追实体）
 *   - 视线直转（gaze 同款干脆利落，50ms 一档跟手，玩家认可注视观感）
 *   - 叠加拟人微差：注视点加低频随机漂移（每 0.4~0.7s ±小幅），
 *     避免"像素级死盯"的机械感，像真人视线自然游移
 *   - 无目标但有位移（保命逃跑/意外被推/未来新移动）→ 兜底直转朝净位移方向，防横飘
 *
 * 让位规则：**站定且无目标 → 绝不碰头**（主动视线 gaze-at/look-at 站定时天然不受扰）；
 * 移动任务结束 clear() 交还视线控制权。
 */
export class HeadFollowController {
  private bot: mineflayer.Bot;
  private tickHandler: (() => void) | null = null;
  private lastX = 0;
  private lastZ = 0;
  private hasLast = false;

  /** 当前注视目标（世界坐标，注视点本身）；null = 无目标，退回位移方向兜底 */
  private point: { x: number; y: number; z: number } | null = null;

  /**
   * 挂起计数（>0 = 外部执行器独占朝向，本模块彻底不碰头，连兜底都不做）。
   * walk-path 这类"直写 yaw 自控航向"的执行器必须挂起本模块：兜底分支是按上一 tick 的
   * 净位移反推朝向，天然慢半拍；且到拐点减速时位移 < MOVE_EPS 会直接【冻住头】，
   * 等身子拐完才猛甩过去 —— 正是玩家吐槽的"先冲墙、再突然转头跑掉"。
   */
  private suspended = 0;
  /** 拟人视线漂移（每 JITTER 周期随机重设一次） */
  private jitter = { x: 0, y: 0, z: 0 };
  private jitterAt = 0;

  /** 每 tick 位移阈值（<0.02 格 ≈ 0.4 格/秒 = 算站定，兜底时用） */
  private readonly MOVE_EPS = 0.02;

  constructor(bot: mineflayer.Bot) {
    this.bot = bot;
  }

  attach(): void {
    this.tickHandler = () => this.onTick();
    this.bot.on('physicsTick' as never, this.tickHandler as never);
    // 挂到 bot 上，供移动原语(helpers)设置注视目标 —— 全局兜底 + 目标驱动的唯一入口
    (this.bot as unknown as { __headFollow?: HeadFollowController }).__headFollow = this;
    log('INFO', '🎯 移动即注视已挂载（移动时视线锁定目标+拟人微差；站定无目标不碰头；无目标移动兜底直转）');
  }

  detach(): void {
    if (this.tickHandler) {
      this.bot.removeListener('physicsTick' as never, this.tickHandler as never);
      this.tickHandler = null;
    }
    const b = this.bot as unknown as { __headFollow?: HeadFollowController };
    if (b.__headFollow === this) b.__headFollow = undefined;
    this.hasLast = false;
    this.point = null;
  }

  /** 设置注视目标（移动原语起手调用）；目标在动就反复 setPoint 刷新，视线实时跟 */
  setPoint(x: number, y: number, z: number): void {
    this.point = { x, y, z };
  }

  /** 清除注视目标（移动结束交还视线）；随后站定不碰头，由常驻 gaze / 大脑接管 */
  clear(): void {
    this.point = null;
    releaseHead(this.bot, 'head-follow');
  }

  /** 挂起（外部执行器独占朝向；可重入计数，与 resume 成对调用） */
  suspend(): void {
    this.suspended++;
    if (this.suspended === 1) releaseHead(this.bot, 'head-follow'); // 交还头部覆盖，别压 walk-path 自己的头部通道
  }

  /** 恢复视线控制权（外部动作结束 / 异常退出都要调） */
  resume(): void {
    this.suspended = Math.max(0, this.suspended - 1);
  }

  private onTick(): void {
    try {
      // 【纯走路模式 9/11】朝向全部让给 pathfinder：本模块每 tick 写 yaw 会和寻路器的转向打架
      // （bot 的 forward 是相对 yaw 的，yaw 被外部钉死 → 遇拐弯只会朝旧方向撞墙）。
      if (process.env.PF_PURE_WALK === '1') {
        releaseHead(this.bot, 'head-follow');
        return;
      }
      // 外部执行器独占朝向（walk-path 正在直写 yaw 控航向）→ 让位，别用滞后位移反推的头朝向覆盖它
      if (this.suspended > 0) return; // 交还动作已在 suspend() 里做过
      const e = this.bot.entity;
      if (!e || !e.position) return;
      const me = e.position;

      // 让位（v17）：保命动作（guardian 逃跑/进食/战斗）接管身体时不动视线，
      // 否则本模块的"位移兜底直转"会与 guardian 的朝向在同一 tick 内互相覆盖。
      const bodyRef = (this.bot as unknown as { __bodyController?: { current(): { owner: string | null } } }).__bodyController;
      if (bodyRef && bodyRef.current().owner === 'guardian') {
        releaseHead(this.bot, 'head-follow');
        return;
      }

      if (this.point) {
        // —— 有目标：实时注视（gaze 同款直转）+ 拟人视线漂移 ——
        this.faceWithJitter(this.point.x, this.point.y, this.point.z, me);
        return;
      }

      // —— 无目标：仅在有位移时朝净位移方向直转（兜底防横飘），站定不碰头 ——
      if (!this.hasLast) {
        this.hasLast = true;
        this.lastX = me.x;
        this.lastZ = me.z;
        return;
      }
      const dx = me.x - this.lastX;
      const dz = me.z - this.lastZ;
      this.lastX = me.x;
      this.lastZ = me.z;
      if (Math.hypot(dx, dz) >= this.MOVE_EPS) {
        aimDir(this.bot, 'head-follow', Math.atan2(-dx, -dz), 0); // 走统一通道（300°/s + 2°死区）
      }
    } catch {
      /* physicsTick 高频触发，静默防崩 */
    }
  }

  /** 朝注视点直转，叠加低频随机漂移（拟人，避免死盯） */
  private faceWithJitter(tx: number, ty: number, tz: number, me: { x: number; y: number; z: number }): void {
    const now = Date.now();
    // 每 0.4~0.7s 换一次注视点漂移
    if (now >= this.jitterAt) {
      const dist = Math.max(1, Math.hypot(tx - me.x, tz - me.z));
      const amp = Math.min(0.8, Math.max(0.08, dist * 0.015)); // 远处漂移大、近处小（角感一致）
      this.jitter = {
        x: (Math.random() * 2 - 1) * amp,
        y: (Math.random() * 2 - 1) * amp * 0.5,
        z: (Math.random() * 2 - 1) * amp,
      };
      this.jitterAt = now + 400 + Math.random() * 300;
    }
    const px = tx + this.jitter.x;
    const py = ty + this.jitter.y;
    const pz = tz + this.jitter.z;
    // 走统一转向通道：物理朝向即时，观感 300°/s + 2°死区 + pitch 低通（原来 20Hz 直写 = 甩头）
    aimAt(this.bot, 'head-follow', px, py, pz, { smoothPos: false });
  }
}
