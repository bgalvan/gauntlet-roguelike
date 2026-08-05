import type { Hasher } from '../core/checksum';
import { BOT, PLAYER, ROOM } from '../core/constants';
import type { Rng } from '../core/rng';
import type { InputState } from '../input/input-state';
import { clampToUnit } from '../input/input-state';
import type { PlayerController } from './controller';
import type { Entity } from './entities/entity';
import type { Player } from './entities/player';

/**
 * A bot party member.
 *
 * CLAUDE.md is explicit that these are testing infrastructure, not a stretch
 * goal — co-op cannot be tested solo, and every question in §13 needs four
 * players on screen. This is not trying to be a good AI. It is trying to
 * produce a plausible fourth body so that readability, camera and VFX
 * questions can be asked at all.
 *
 * Determinism (constraint #3): every decision comes from world state plus
 * this bot's own forked PRNG. No wall clock, no Math.random, no iteration
 * over anything but indexed arrays. Because bot inputs are a pure function
 * of shared state, lockstep peers derive identical bot behaviour on their
 * own — bot inputs never need to go over the wire.
 */
export class BotController implements PlayerController {
  readonly kind = 'bot';

  private readonly rng: Rng;

  /** Current wobble, resampled every JITTER_INTERVAL_TICKS. */
  private jitterX = 0;
  private jitterY = 0;

  /** +1 or -1: which way this bot circles its target. */
  private strafeSign: number;

  /** Local tick counter — the bot never reads the world's clock, so it stays
   *  correct if it is ever spawned mid-run. */
  private age = 0;

  constructor(rng: Rng) {
    this.rng = rng;
    this.strafeSign = this.rng.chance(0.5) ? 1 : -1;
  }

  produceInput(
    self: Player,
    allies: readonly Player[],
    enemies: readonly Entity[],
    out: InputState,
  ): void {
    this.age++;

    if (this.age % BOT.JITTER_INTERVAL_TICKS === 0) {
      this.jitterX = this.rng.range(-1, 1);
      this.jitterY = this.rng.range(-1, 1);
    }
    if (this.age % BOT.STRAFE_FLIP_TICKS === 0) {
      this.strafeSign = -this.strafeSign;
    }

    let steerX = 0;
    let steerY = 0;

    const target = nearestEnemy(self, enemies);

    if (target) {
      const dx = target.x - self.x;
      const dy = target.y - self.y;
      const dist = Math.hypot(dx, dy);

      if (dist > 0) {
        const towardX = dx / dist;
        const towardY = dy / dist;
        const standoff = PLAYER.ATTACK_RANGE * BOT.STANDOFF;

        if (dist > standoff + BOT.TOLERANCE) {
          // Close the gap.
          steerX += towardX;
          steerY += towardY;
        } else if (dist < standoff - BOT.TOLERANCE) {
          // Too close — back off rather than stacking on the target.
          steerX -= towardX;
          steerY -= towardY;
        } else {
          // In the band: circle. Keeps four bodies in motion so overlapping
          // VFX actually get tested (§13 question 3).
          steerX += -towardY * this.strafeSign * BOT.STRAFE_WEIGHT;
          steerY += towardX * this.strafeSign * BOT.STRAFE_WEIGHT;
        }
      }
    } else {
      // Nothing to fight — regroup toward the middle of the room.
      const dx = ROOM.WIDTH / 2 - self.x;
      const dy = ROOM.HEIGHT / 2 - self.y;
      const dist = Math.hypot(dx, dy);
      if (dist > PLAYER.RADIUS * 4) {
        steerX += dx / dist;
        steerY += dy / dist;
      }
    }

    // Separation. Phase 0 has no collision, so without this four players
    // occupy the same pixel and every readability question is meaningless.
    for (let i = 0; i < allies.length; i++) {
      const ally = allies[i]!;
      if (ally.id === self.id || !ally.alive) continue;
      const dx = self.x - ally.x;
      const dy = self.y - ally.y;
      const distSq = dx * dx + dy * dy;
      if (distSq === 0 || distSq > BOT.SEPARATION_RADIUS * BOT.SEPARATION_RADIUS) continue;
      const dist = Math.sqrt(distSq);
      // Falls off linearly with distance — a hard push at contact, nothing
      // at the edge of the radius.
      const push = (1 - dist / BOT.SEPARATION_RADIUS) * BOT.SEPARATION_WEIGHT;
      steerX += (dx / dist) * push;
      steerY += (dy / dist) * push;
    }

    steerX += this.jitterX * BOT.JITTER;
    steerY += this.jitterY * BOT.JITTER;

    // Steer away from walls before the player's hard clamp does it, so bots
    // don't grind along the edges.
    const margin = ROOM.WALL + PLAYER.RADIUS * 3;
    if (self.x < margin) steerX += 1;
    if (self.x > ROOM.WIDTH - margin) steerX -= 1;
    if (self.y < margin) steerY += 1;
    if (self.y > ROOM.HEIGHT - margin) steerY -= 1;

    out.moveVector.x = steerX;
    out.moveVector.y = steerY;
    clampToUnit(out.moveVector);

    // Bots leave the auto-target alone. Target override is a human tactical
    // choice (§16.5b) — a bot exercising it would muddy the very question
    // the prototype is meant to answer.
  }

  writeChecksum(h: Hasher): void {
    h.int(this.rng.getState())
      .int(this.age)
      .int(this.strafeSign)
      .float(this.jitterX)
      .float(this.jitterY);
  }
}

/** Nearest living enemy at any distance — bots walk to a fight, they don't
 *  wait for one to enter attack range. */
function nearestEnemy(self: Player, enemies: readonly Entity[]): Entity | null {
  let best: Entity | null = null;
  let bestDistSq = Infinity;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i]!;
    if (!e.alive) continue;
    const dx = e.x - self.x;
    const dy = e.y - self.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq || (distSq === bestDistSq && best !== null && e.id < best.id)) {
      best = e;
      bestDistSq = distSq;
    }
  }
  return best;
}
