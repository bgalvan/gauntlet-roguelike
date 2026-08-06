import type { Hasher } from '../../core/checksum';
import { DEATH, ENEMY, SIM } from '../../core/constants';
import { LifeState } from '../life-state';
import { Entity } from './entity';
import type { Player } from './player';

const WINDUP_TICKS = Math.round(ENEMY.WINDUP * SIM.TICK_RATE);
const ATTACK_INTERVAL_TICKS = Math.round(ENEMY.ATTACK_INTERVAL * SIM.TICK_RATE);

/**
 * Act I melee enemy. Chases the nearest living player, winds up, swings.
 *
 * The wind-up is not flavour. Pillar 3 (readable chaos) is a hard constraint
 * that vetoes features — an enemy that hits the instant it touches you is
 * unreadable once twenty of them are on screen, and the player has no
 * information to act on. The telegraph is what makes the fight parseable.
 *
 * Deterministic: no PRNG use at all. Behaviour is a pure function of
 * positions, so enemies need no seeded stream of their own.
 */
export class Enemy extends Entity {
  /** Ticks left in the current wind-up, or 0 when not winding up. */
  private windupTicks = 0;
  /** Ticks until it may begin another swing. */
  private cooldownTicks = 0;

  /** The player this enemy committed to when the wind-up began. Committing
   *  means it can't track a target that walked away mid-swing — which is
   *  what makes stepping out of a telegraph a real decision. */
  private committedTargetId = -1;

  facingX = 0;
  facingY = 1;

  /** Render-only. */
  hitFlashTicks = 0;

  /** Whether this corpse has had its drop rolled (§7.2). Set once, so a body
   *  cannot pay out twice however many ticks it spends dead in the room. */
  looted = false;

  constructor(id: number, x: number, y: number) {
    super(id, x, y, ENEMY.RADIUS, ENEMY.MAX_HP);
  }

  /** Fraction of the wind-up elapsed, 0..1. Render-only. */
  get windupProgress(): number {
    if (this.windupTicks <= 0) return 0;
    return 1 - this.windupTicks / WINDUP_TICKS;
  }

  get isWindingUp(): boolean {
    return this.windupTicks > 0;
  }

  step(dt: number, players: readonly Player[], wraiths: readonly Player[]): void {
    if (this.hitFlashTicks > 0) this.hitFlashTicks--;
    if (!this.alive) return;
    if (this.cooldownTicks > 0) this.cooldownTicks--;

    // Staggered: shoved around but unable to act. This is what sells a hit as
    // an impact, and what makes a payoff ability a party opening rather than
    // just damage. An interrupted wind-up is cancelled outright.
    if (this.staggerTicks > 0) {
      this.windupTicks = 0;
      return;
    }

    // Mid-swing: hold still and commit. Movement during a telegraph would
    // make the telegraph meaningless.
    if (this.windupTicks > 0) {
      this.windupTicks--;
      if (this.windupTicks === 0) this.land(players);
      return;
    }

    const target = this.pickTarget(players);
    if (!target) return;

    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0) {
      this.facingX = dx / dist;
      this.facingY = dy / dist;
    }

    const reach = ENEMY.ATTACK_RANGE + target.radius - ENEMY.PREFERRED_GAP;

    if (dist <= reach) {
      if (this.cooldownTicks === 0) {
        this.windupTicks = WINDUP_TICKS;
        this.committedTargetId = target.id;
      }
      return;
    }

    const speed = ENEMY.MOVE_SPEED * this.speedScale(wraiths);
    this.x += this.facingX * speed * dt;
    this.y += this.facingY * speed * dt;
  }

  /**
   * A Wraith's one weak utility (§8 stage 2): it slows nearby enemies. A dead
   * player is still contributing, which is the whole point of the stage.
   */
  private speedScale(wraiths: readonly Player[]): number {
    for (let i = 0; i < wraiths.length; i++) {
      const w = wraiths[i]!;
      const dx = w.x - this.x;
      const dy = w.y - this.y;
      if (dx * dx + dy * dy <= DEATH.WRAITH_SLOW_RADIUS * DEATH.WRAITH_SLOW_RADIUS) {
        return DEATH.WRAITH_SLOW_FACTOR;
      }
    }
    return 1;
  }

  /**
   * Nearest *living* player.
   *
   * Downed players are deliberately ignored. §8's design rule is that
   * anything which piles on when the party is already losing creates a death
   * spiral, and enemies finishing off a crawling player is exactly that. It
   * also means reviving is a real tactical option rather than a trap.
   * Wraiths cannot be hurt, so they are not targets either.
   */
  private pickTarget(players: readonly Player[]): Player | null {
    let best: Player | null = null;
    let bestDistSq = Infinity;
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      if (p.life !== LifeState.Alive) continue;
      const dx = p.x - this.x;
      const dy = p.y - this.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq || (distSq === bestDistSq && best !== null && p.id < best.id)) {
        best = p;
        bestDistSq = distSq;
      }
    }
    return best;
  }

  /** Wind-up finished — hit whatever is still in reach. */
  private land(players: readonly Player[]): void {
    this.cooldownTicks = ATTACK_INTERVAL_TICKS;

    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      if (p.id !== this.committedTargetId) continue;
      if (p.life !== LifeState.Alive) return;

      const dx = p.x - this.x;
      const dy = p.y - this.y;
      const reach = ENEMY.ATTACK_RANGE + p.radius;
      // Stepping out of the telegraph is the counterplay. If they moved, the
      // swing whiffs.
      if (dx * dx + dy * dy <= reach * reach) p.takeDamage(ENEMY.DAMAGE, this.x, this.y);
      return;
    }
  }

  override damage(amount: number): void {
    super.damage(amount);
    this.hitFlashTicks = 6;
    // Interrupt the swing on death so a corpse can't land a hit.
    if (!this.alive) this.windupTicks = 0;
  }

  override writeChecksum(h: Hasher): void {
    super.writeChecksum(h);
    h.int(this.windupTicks)
      .int(this.cooldownTicks)
      .int(this.committedTargetId)
      .float(this.facingX)
      .float(this.facingY)
      // The drop roll consumes the room's RNG stream, so whether it has
      // happened yet decides every later draw in the room.
      .bool(this.looted);
  }
}
