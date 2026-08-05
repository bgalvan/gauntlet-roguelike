import { Rng } from '../core/rng';

/**
 * Pooled particle system. **Render-only** — nothing here ever feeds back into
 * the simulation, which is why it may use its own generator freely without
 * touching constraint #3's seeded stream.
 *
 * It still uses a seeded Rng rather than Math.random, for two reasons: a
 * recorded run looks identical on replay, and it keeps `Math.random` absent
 * from the whole codebase so the harness's trap check stays meaningful.
 *
 * Fixed capacity, no allocation after construction (constraint #4).
 */

const CAPACITY = 640;

export const ParticleShape = {
  Spark: 0,
  Dot: 1,
  Ring: 2,
} as const;

export type ParticleShape = (typeof ParticleShape)[keyof typeof ParticleShape];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: number;
  shape: ParticleShape;
  drag: number;
  active: boolean;
}

export class Particles {
  private readonly pool: Particle[] = [];
  private readonly rng = new Rng('vfx');
  /** Round-robin cursor, so a burst that exceeds capacity overwrites the
   *  oldest rather than silently dropping the newest. */
  private cursor = 0;

  constructor() {
    for (let i = 0; i < CAPACITY; i++) {
      this.pool.push({
        x: 0, y: 0, vx: 0, vy: 0,
        life: 0, maxLife: 1, size: 2,
        color: 0xffffff, shape: ParticleShape.Dot, drag: 0.9, active: false,
      });
    }
  }

  /** Cone of sparks — a hit landing. */
  burst(
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    count: number,
    opts: { color?: number; speed?: number; spread?: number; life?: number; size?: number; shape?: ParticleShape } = {},
  ): void {
    const baseAngle = Math.atan2(dirY, dirX);
    const spread = opts.spread ?? 0.9;
    const speed = opts.speed ?? 220;

    for (let i = 0; i < count; i++) {
      const p = this.next();
      const angle = baseAngle + this.rng.range(-spread, spread);
      const v = speed * this.rng.range(0.45, 1.25);
      p.x = x;
      p.y = y;
      p.vx = Math.cos(angle) * v;
      p.vy = Math.sin(angle) * v;
      p.maxLife = (opts.life ?? 0.36) * this.rng.range(0.7, 1.2);
      p.life = p.maxLife;
      p.size = opts.size ?? 3;
      p.color = opts.color ?? 0xffd9a0;
      p.shape = opts.shape ?? ParticleShape.Spark;
      p.drag = 0.9;
      p.active = true;
    }
  }

  /** Even ring — a death, or an ability going off. */
  ring(x: number, y: number, count: number, opts: { color?: number; speed?: number; life?: number; size?: number } = {}): void {
    for (let i = 0; i < count; i++) {
      const p = this.next();
      const angle = (i / count) * Math.PI * 2;
      const v = (opts.speed ?? 190) * this.rng.range(0.8, 1.15);
      p.x = x;
      p.y = y;
      p.vx = Math.cos(angle) * v;
      p.vy = Math.sin(angle) * v;
      p.maxLife = opts.life ?? 0.5;
      p.life = p.maxLife;
      p.size = opts.size ?? 3;
      p.color = opts.color ?? 0xffffff;
      p.shape = ParticleShape.Dot;
      p.drag = 0.9;
      p.active = true;
    }
  }

  /** A single expanding outline — the footprint of a big ability. */
  shockRing(x: number, y: number, radius: number, color: number, life = 0.42): void {
    const p = this.next();
    p.x = x;
    p.y = y;
    p.vx = 0;
    p.vy = 0;
    p.maxLife = life;
    p.life = life;
    p.size = radius;
    p.color = color;
    p.shape = ParticleShape.Ring;
    p.drag = 1;
    p.active = true;
  }

  /** Soft trail dot — dashes, projectiles. */
  trail(x: number, y: number, color: number, size = 4, life = 0.28): void {
    const p = this.next();
    p.x = x + this.rng.range(-2, 2);
    p.y = y + this.rng.range(-2, 2);
    p.vx = this.rng.range(-18, 18);
    p.vy = this.rng.range(-18, 18);
    p.maxLife = life;
    p.life = life;
    p.size = size;
    p.color = color;
    p.shape = ParticleShape.Dot;
    p.drag = 0.86;
    p.active = true;
  }

  update(dt: number): void {
    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i]!;
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const drag = Math.pow(p.drag, dt * 60);
      p.vx *= drag;
      p.vy *= drag;
    }
  }

  draw(g: Phaser.GameObjects.Graphics): void {
    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i]!;
      if (!p.active) continue;
      const t = p.life / p.maxLife;

      if (p.shape === ParticleShape.Ring) {
        // Expands and fades — reads as a pressure wave.
        g.lineStyle(2 + 3 * t, p.color, t * 0.8);
        g.strokeCircle(p.x, p.y, p.size * (1.05 - t * 0.55));
        continue;
      }

      g.fillStyle(p.color, Math.min(1, t * 1.4));
      if (p.shape === ParticleShape.Spark) {
        // Stretched along travel — motion reads better than a round dot.
        const len = Math.min(11, Math.hypot(p.vx, p.vy) * 0.035);
        const nx = p.vx === 0 && p.vy === 0 ? 0 : p.vx / (Math.hypot(p.vx, p.vy) || 1);
        const ny = p.vx === 0 && p.vy === 0 ? 0 : p.vy / (Math.hypot(p.vx, p.vy) || 1);
        g.fillCircle(p.x, p.y, p.size * t);
        g.fillCircle(p.x - nx * len, p.y - ny * len, p.size * t * 0.55);
      } else {
        g.fillCircle(p.x, p.y, p.size * t);
      }
    }
  }

  clear(): void {
    for (let i = 0; i < this.pool.length; i++) this.pool[i]!.active = false;
  }

  private next(): Particle {
    const p = this.pool[this.cursor]!;
    this.cursor = (this.cursor + 1) % this.pool.length;
    return p;
  }
}
