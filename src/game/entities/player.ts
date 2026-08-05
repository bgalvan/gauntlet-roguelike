import type { Hasher } from '../../core/checksum';
import { DEATH, PLAYER, SIM } from '../../core/constants';
import type { InputState } from '../../input/input-state';
import { LifeState } from '../life-state';
import { overrideHoldTicks, selectTarget } from '../targeting';
import { Entity } from './entity';

const ATTACK_INTERVAL_TICKS = Math.round(PLAYER.ATTACK_INTERVAL * SIM.TICK_RATE);
const ATTACK_RANGE_SQ = PLAYER.ATTACK_RANGE * PLAYER.ATTACK_RANGE;
const BLEED_OUT_TICKS = Math.round(DEATH.BLEED_OUT * SIM.TICK_RATE);
const REVIVE_CHANNEL_TICKS = Math.round(DEATH.REVIVE_CHANNEL * SIM.TICK_RATE);

/**
 * Placeholder player. No class kit yet — the ability slots are wired to the
 * abstract input but bound to nothing, because class design (§3) is its own
 * milestone.
 *
 * What is real here: movement, auto-attack, and the §8 death state machine.
 */
export class Player extends Entity {
  /** Facing, kept as a unit vector so it survives standing still. */
  facingX = 0;
  facingY = 1;

  /** Integer countdown to the next swing — see the note in Enemy about ticks. */
  private attackCooldown = 0;

  /** Currently focused enemy, or null when nothing is in reach. */
  target: Entity | null = null;

  /** Ticks left before a manual override decays back to auto-target. */
  private overrideTicks = 0;
  private overrideX = 0;
  private overrideY = 0;

  /** Set for one tick when a swing lands — the renderer draws the arc. */
  attackedThisTick = false;

  /** Party slot 0..3. Stable identity for colours, HUD, and later for
   *  matching a remote peer's input stream to a body. */
  readonly slot: number;

  // --- §8 death state ------------------------------------------------------

  life: LifeState = LifeState.Alive;

  /** Ticks left before a Downed player becomes a Wraith. */
  bleedOutTicks = 0;

  /** Ticks of ally channelling accumulated on this Downed player. */
  reviveTicks = 0;

  /** True for one tick when an ally's channel completed. Render/audio hook. */
  revivedThisTick = false;

  /** True for one tick on the Alive → Downed transition. */
  downedThisTick = false;

  constructor(id: number, slot: number, x: number, y: number) {
    super(id, x, y, PLAYER.RADIUS, PLAYER.MAX_HP);
    this.slot = slot;
  }

  /** Wraiths pass through everything — they cannot be hurt or blocked. */
  override get collides(): boolean {
    return this.life !== LifeState.Wraith;
  }

  step(dt: number, input: InputState, enemies: readonly Entity[]): void {
    this.attackedThisTick = false;
    this.revivedThisTick = false;
    this.downedThisTick = false;

    this.move(dt, input);

    if (this.life === LifeState.Alive) {
      this.updateOverride(input);
      this.acquireTarget(enemies);
      this.attack();
    } else {
      this.target = null;
      this.overrideTicks = 0;
      if (this.life === LifeState.Downed) this.bleedOut();
    }
  }

  private move(dt: number, input: InputState): void {
    const mx = input.moveVector.x;
    const my = input.moveVector.y;
    if (mx === 0 && my === 0) return;

    const speed =
      this.life === LifeState.Alive
        ? PLAYER.MOVE_SPEED
        : this.life === LifeState.Downed
          ? DEATH.CRAWL_SPEED
          : DEATH.WRAITH_SPEED;

    this.x += mx * speed * dt;
    this.y += my * speed * dt;

    const len = Math.hypot(mx, my);
    if (len > 0) {
      this.facingX = mx / len;
      this.facingY = my / len;
    }
    // Walls are resolved centrally, so enemies obey them too.
  }

  private updateOverride(input: InputState): void {
    if (input.targetOverride.active) {
      this.overrideX = input.targetOverride.direction.x;
      this.overrideY = input.targetOverride.direction.y;
      this.overrideTicks = overrideHoldTicks(SIM.TICK_RATE);
    } else if (this.overrideTicks > 0) {
      this.overrideTicks--;
    }
  }

  private acquireTarget(enemies: readonly Entity[]): void {
    this.target = selectTarget(
      this,
      enemies,
      this.overrideTicks > 0,
      this.overrideX,
      this.overrideY,
      ATTACK_RANGE_SQ,
    );
  }

  private attack(): void {
    if (this.attackCooldown > 0) this.attackCooldown--;

    const target = this.target;
    if (!target || !target.alive) return;
    if (this.attackCooldown > 0) return;

    const dx = target.x - this.x;
    const dy = target.y - this.y;
    if (dx * dx + dy * dy > ATTACK_RANGE_SQ) return;

    // Face what we hit — auto-target implies auto-face (constraint #6).
    const len = Math.hypot(dx, dy);
    if (len > 0) {
      this.facingX = dx / len;
      this.facingY = dy / len;
    }

    target.damage(PLAYER.ATTACK_DAMAGE);
    this.attackCooldown = ATTACK_INTERVAL_TICKS;
    this.attackedThisTick = true;
  }

  // --- §8 transitions ------------------------------------------------------

  /** Damage from an enemy. Only an Alive player can be hurt. */
  takeDamage(amount: number): void {
    if (this.life !== LifeState.Alive) return;
    this.hp -= amount;
    if (this.hp > 0) return;

    // Stage 1. Note the player is NOT `alive = false` — a Downed player is
    // still a body in the world that allies can reach.
    this.hp = 0;
    this.life = LifeState.Downed;
    this.bleedOutTicks = BLEED_OUT_TICKS;
    this.reviveTicks = 0;
    this.downedThisTick = true;
    this.target = null;
  }

  private bleedOut(): void {
    this.bleedOutTicks--;
    if (this.bleedOutTicks <= 0) {
      this.bleedOutTicks = 0;
      this.life = LifeState.Wraith;
      this.reviveTicks = 0;
    }
  }

  /**
   * Advance an ally's revive channel by one tick. Called by the world, which
   * knows who is channelling — the player itself doesn't.
   *
   * @param channelling whether at least one ally is in range and holding the
   *                    context action this tick
   */
  advanceRevive(channelling: boolean): void {
    if (this.life !== LifeState.Downed) return;

    if (!channelling) {
      // Interrupted. Resetting rather than decaying makes the 3s a real
      // commitment — you cannot chip away at it between dodges.
      this.reviveTicks = 0;
      return;
    }

    this.reviveTicks++;
    if (this.reviveTicks < REVIVE_CHANNEL_TICKS) return;

    this.life = LifeState.Alive;
    this.hp = DEATH.REVIVE_HP;
    this.bleedOutTicks = 0;
    this.reviveTicks = 0;
    this.revivedThisTick = true;
  }

  /** 0..1 progress of an in-flight revive channel. Render-only. */
  get reviveProgress(): number {
    return this.reviveTicks / REVIVE_CHANNEL_TICKS;
  }

  /** 0..1 of the bleed-out remaining. Render-only. */
  get bleedOutRemaining(): number {
    return this.bleedOutTicks / BLEED_OUT_TICKS;
  }

  /** True while the player is holding a manual target pick. Debug/UI only. */
  get overrideActive(): boolean {
    return this.overrideTicks > 0;
  }

  override writeChecksum(h: Hasher): void {
    super.writeChecksum(h);
    h.float(this.facingX)
      .float(this.facingY)
      .int(this.attackCooldown)
      .int(this.overrideTicks)
      .float(this.overrideX)
      .float(this.overrideY)
      .int(this.life)
      .int(this.bleedOutTicks)
      .int(this.reviveTicks)
      // Target identity, not the object — a peer that picked a different
      // enemy has already desynced even if positions still agree.
      .int(this.target ? this.target.id : -1);
  }
}
