import type { Hasher } from '../../core/checksum';
import { PLAYER, ROOM, SIM } from '../../core/constants';
import type { InputState } from '../../input/input-state';
import { overrideHoldTicks, selectTarget } from '../targeting';
import { Entity } from './entity';

const ATTACK_INTERVAL_TICKS = Math.round(PLAYER.ATTACK_INTERVAL * SIM.TICK_RATE);
const ATTACK_RANGE_SQ = PLAYER.ATTACK_RANGE * PLAYER.ATTACK_RANGE;

/**
 * Placeholder player. No class kit yet — Phase 0 is movement plus an
 * auto-attack, and nothing more (CLAUDE.md, current phase).
 */
export class Player extends Entity {
  /** Facing, kept as a unit vector so it survives standing still. */
  facingX = 0;
  facingY = 1;

  /** Integer countdown to the next swing — see the note in Dummy about ticks. */
  private attackCooldown = 0;

  /** Currently focused enemy, or null when nothing is in reach. */
  target: Entity | null = null;

  /** Ticks left before a manual override decays back to auto-target. */
  private overrideTicks = 0;
  private overrideX = 0;
  private overrideY = 0;

  /** Set for one tick when a swing lands — the renderer draws the arc. */
  attackedThisTick = false;

  constructor(id: number, x: number, y: number) {
    super(id, x, y, PLAYER.RADIUS, PLAYER.MAX_HP);
  }

  step(dt: number, input: InputState, enemies: readonly Entity[]): void {
    this.attackedThisTick = false;

    this.move(dt, input);
    this.updateOverride(input);
    this.acquireTarget(enemies);
    this.attack();
  }

  private move(dt: number, input: InputState): void {
    const mx = input.moveVector.x;
    const my = input.moveVector.y;

    if (mx !== 0 || my !== 0) {
      this.x += mx * PLAYER.MOVE_SPEED * dt;
      this.y += my * PLAYER.MOVE_SPEED * dt;

      const len = Math.hypot(mx, my);
      if (len > 0) {
        this.facingX = mx / len;
        this.facingY = my / len;
      }
    }

    // One room, four walls. Collision beyond this is Phase 1.
    const minX = ROOM.WALL + this.radius;
    const maxX = ROOM.WIDTH - ROOM.WALL - this.radius;
    const minY = ROOM.WALL + this.radius;
    const maxY = ROOM.HEIGHT - ROOM.WALL - this.radius;
    if (this.x < minX) this.x = minX;
    if (this.x > maxX) this.x = maxX;
    if (this.y < minY) this.y = minY;
    if (this.y > maxY) this.y = maxY;
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
      // Target identity, not the object — a peer that picked a different
      // enemy has already desynced even if positions still agree.
      .int(this.target ? this.target.id : -1);
  }
}
