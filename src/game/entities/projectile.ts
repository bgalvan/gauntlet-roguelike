import type { Hasher } from '../../core/checksum';
import { COMBAT, ROOM } from '../../core/constants';
import { Entity } from './entity';

/**
 * A travelling shot. Archer and Sorcerer basic attacks, plus Charged Shot.
 *
 * Projectiles are pooled and reused: at Archer cadence (4 shots a second, ×4
 * players) allocating one per shot is steady garbage, and constraint #4
 * budgets for a mid-range phone.
 */
export class Projectile extends Entity {
  /** Velocity in world units per second. */
  vx = 0;
  vy = 0;

  damage_ = 0;
  /** Party slot that fired it, for attribution and colour. */
  ownerSlot = -1;
  /** Passes through targets instead of expiring on the first hit. */
  piercing = false;
  knockback = 0;
  /** Ticks before it expires on its own. */
  lifeTicks = 0;

  /** Entity ids already hit — a piercing shot must not hit the same body
   *  twice. Bounded by the number of enemies, and cleared on reuse. */
  readonly hitIds: number[] = [];

  /** Pool slot is free when this is false. */
  active = false;

  constructor(id: number) {
    super(id, 0, 0, COMBAT.PROJECTILE_RADIUS, 1);
    this.alive = false;
  }

  /** Projectiles never take part in body collision. */
  override get collides(): boolean {
    return false;
  }

  launch(
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    speed: number,
    damage: number,
    ownerSlot: number,
    opts: { piercing?: boolean; knockback?: number; radius?: number; lifeTicks?: number } = {},
  ): void {
    this.x = x;
    this.y = y;
    this.prevX = x;
    this.prevY = y;
    this.vx = dirX * speed;
    this.vy = dirY * speed;
    this.damage_ = damage;
    this.ownerSlot = ownerSlot;
    this.piercing = opts.piercing ?? false;
    this.knockback = opts.knockback ?? COMBAT.PROJECTILE_KNOCKBACK;
    this.radius = opts.radius ?? COMBAT.PROJECTILE_RADIUS;
    this.lifeTicks = opts.lifeTicks ?? COMBAT.PROJECTILE_LIFE_TICKS;
    this.hitIds.length = 0;
    this.active = true;
    this.alive = true;
  }

  retire(): void {
    this.active = false;
    this.alive = false;
    this.hitIds.length = 0;
  }

  /** Advance. Returns false when it should be retired. */
  advance(dt: number): boolean {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.lifeTicks--;

    if (this.lifeTicks <= 0) return false;
    // Walls stop shots. Doors and destructibles are a later concern.
    if (this.x < ROOM.WALL || this.x > ROOM.WIDTH - ROOM.WALL) return false;
    if (this.y < ROOM.WALL || this.y > ROOM.HEIGHT - ROOM.WALL) return false;
    return true;
  }

  hasHit(id: number): boolean {
    for (let i = 0; i < this.hitIds.length; i++) if (this.hitIds[i] === id) return true;
    return false;
  }

  override writeChecksum(h: Hasher): void {
    // Inactive pool slots contribute a constant, so pool churn cannot change
    // the checksum — only live projectiles matter.
    if (!this.active) {
      h.int(-1);
      return;
    }
    super.writeChecksum(h);
    h.float(this.vx).float(this.vy).float(this.damage_).int(this.lifeTicks).int(this.hitIds.length);
  }
}
