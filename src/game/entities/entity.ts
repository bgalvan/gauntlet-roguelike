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
}

export function distanceSq(a: Entity, b: Entity): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dx * dx + dy * dy;
}
