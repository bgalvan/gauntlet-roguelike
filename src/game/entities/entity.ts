import type { Hasher } from '../../core/checksum';

/**
 * Base entity. Deliberately not a Phaser GameObject — the simulation must be
 * runnable with no renderer at all, both for headless determinism tests and
 * because lockstep peers will step this same code.
 */
export abstract class Entity {
  /** Stable, monotonic, assigned in spawn order. Iteration and tie-breaks use
   *  this — never object key order or Set order (constraint #3). */
  readonly id: number;

  x: number;
  y: number;

  /** Position at the end of the previous sim step, for render interpolation.
   *  The sim never reads these. */
  prevX: number;
  prevY: number;

  radius: number;
  hp: number;
  maxHp: number;
  alive = true;

  /**
   * Knockback velocity, in world units per second. Decays exponentially.
   *
   * This is simulation state, not a visual effect — it moves bodies, so it is
   * deterministic and checksummed. Being shoved is most of what makes a hit
   * feel like it connected.
   */
  knockX = 0;
  knockY = 0;

  /**
   * Ticks this body is stunned. Staggered entities take knockback but do not
   * act — the local, deterministic version of hit-stop. A *global* freeze
   * would feel better still, but it would have to be identical on every peer
   * and is a poor fit for lockstep, so impact is sold per-body instead.
   */
  staggerTicks = 0;

  constructor(id: number, x: number, y: number, radius: number, maxHp: number) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.prevX = x;
    this.prevY = y;
    this.radius = radius;
    this.hp = maxHp;
    this.maxHp = maxHp;
  }

  /** Whether this body participates in collision. Wraiths (§8) do not. */
  get collides(): boolean {
    return this.alive;
  }

  /** Call at the top of every sim step, before any movement. */
  snapshot(): void {
    this.prevX = this.x;
    this.prevY = this.y;
  }

  damage(amount: number): void {
    if (!this.alive) return;
    this.hp -= amount;
    if (this.hp <= 0) {
      this.hp = 0;
      this.alive = false;
    }
  }

  /** Add an impulse. `dirX/dirY` should be a unit vector. */
  applyKnockback(dirX: number, dirY: number, speed: number): void {
    this.knockX += dirX * speed;
    this.knockY += dirY * speed;
  }

  stagger(ticks: number): void {
    if (ticks > this.staggerTicks) this.staggerTicks = ticks;
  }

  /**
   * Integrate knockback and tick down stagger. Called for every body once per
   * step, after the entity's own update.
   */
  stepPhysics(dt: number): void {
    if (this.staggerTicks > 0) this.staggerTicks--;

    if (this.knockX === 0 && this.knockY === 0) return;

    this.x += this.knockX * dt;
    this.y += this.knockY * dt;

    // Exponential decay with a cutoff, so knockback settles in a bounded
    // number of ticks instead of asymptotically drifting forever — an
    // never-quite-zero velocity is a float-drift source.
    const decay = 0.86;
    this.knockX *= decay;
    this.knockY *= decay;
    if (Math.abs(this.knockX) < 1) this.knockX = 0;
    if (Math.abs(this.knockY) < 1) this.knockY = 0;
  }

  /**
   * Contribute every field the simulation reads to the checksum. Subclasses
   * must call super and then add their own — a field that affects future
   * behaviour but is omitted here makes desyncs invisible until they've
   * already diverged.
   *
   * `prevX`/`prevY` are excluded on purpose: they are render-only.
   */
  writeChecksum(h: Hasher): void {
    h.int(this.id)
      .float(this.x)
      .float(this.y)
      .float(this.hp)
      .bool(this.alive)
      .float(this.knockX)
      .float(this.knockY)
      .int(this.staggerTicks);
  }
}

export function distanceSq(a: Entity, b: Entity): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dx * dx + dy * dy;
}
