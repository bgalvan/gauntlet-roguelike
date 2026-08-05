import type { Hasher } from '../core/checksum';
import { BOT, DEATH, PLAYER, ROOM } from '../core/constants';
import type { Rng } from '../core/rng';
import type { InputState } from '../input/input-state';
import { clampToUnit } from '../input/input-state';
import type { PlayerController } from './controller';
import type { Entity } from './entities/entity';
import type { Player } from './entities/player';
import { LifeState } from './life-state';

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

  /** Hysteresis latch for the retreat behaviour. */
  private retreating = false;

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

    switch (self.life) {
      case LifeState.Downed:
        this.crawlToHelp(self, allies, out);
        return;
      case LifeState.Wraith:
        this.haunt(self, enemies, out);
        return;
      default:
        this.fight(self, allies, enemies, out);
    }
  }

  // --- Alive ---------------------------------------------------------------

  private fight(
    self: Player,
    allies: readonly Player[],
    enemies: readonly Entity[],
    out: InputState,
  ): void {
    let steerX = 0;
    let steerY = 0;

    // Reviving outranks fighting. A downed ally is on a 20s clock (§8) and
    // the party is a body down until they're up.
    const rescue = this.nearestDownedAlly(self, allies);
    if (rescue) {
      const dx = rescue.x - self.x;
      const dy = rescue.y - self.y;
      const dist = Math.hypot(dx, dy);

      // Channel on approach too — it costs nothing and covers the last few
      // units without a separate arrival test.
      out.contextAction.down = true;
      out.contextAction.value = 1;

      if (dist <= DEATH.REVIVE_RANGE * 0.7) {
        // In range: hold still. Drifting out resets the whole 3s channel.
        out.moveVector.x = 0;
        out.moveVector.y = 0;
        return;
      }

      if (dist > 0) {
        steerX = dx / dist;
        steerY = dy / dist;
      }
      this.applySteering(self, steerX, steerY, allies, out);
      return;
    }

    // Self-preservation, with hysteresis so it doesn't oscillate on the
    // threshold. Auto-attack keeps firing while retreating (constraint #6 —
    // attacks aren't aimed), so a kiting bot is still contributing.
    const healthFraction = self.hp / self.maxHp;
    if (this.retreating) {
      if (healthFraction >= BOT.REENGAGE_HP) this.retreating = false;
    } else if (healthFraction < BOT.RETREAT_HP) {
      this.retreating = true;
    }

    const target = nearestLiving(self, enemies);

    if (target) {
      const dx = target.x - self.x;
      const dy = target.y - self.y;
      const dist = Math.hypot(dx, dy);

      if (dist > 0) {
        const towardX = dx / dist;
        const towardY = dy / dist;
        const standoff = this.retreating
          ? BOT.RETREAT_DISTANCE
          : PLAYER.ATTACK_RANGE * BOT.STANDOFF;

        if (dist > standoff + BOT.TOLERANCE) {
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

    this.applySteering(self, steerX, steerY, allies, out);
  }

  // --- Downed (§8 stage 1) -------------------------------------------------

  /** Crawl toward the nearest living ally, to shorten their trip. */
  private crawlToHelp(self: Player, allies: readonly Player[], out: InputState): void {
    let best: Player | null = null;
    let bestDistSq = Infinity;
    for (let i = 0; i < allies.length; i++) {
      const ally = allies[i]!;
      if (ally.id === self.id || ally.life !== LifeState.Alive) continue;
      const dx = ally.x - self.x;
      const dy = ally.y - self.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq || (distSq === bestDistSq && best !== null && ally.id < best.id)) {
        best = ally;
        bestDistSq = distSq;
      }
    }
    if (!best) return;

    const dist = Math.sqrt(bestDistSq);
    if (dist < DEATH.REVIVE_RANGE * 0.5) return; // close enough; stop squirming
    out.moveVector.x = (best.x - self.x) / dist;
    out.moveVector.y = (best.y - self.y) / dist;
  }

  // --- Wraith (§8 stage 2) -------------------------------------------------

  /**
   * A Wraith's utility is slowing nearby enemies, so the useful thing to do
   * is park on the densest cluster. Still playing, weakly — which is the
   * whole point of the stage.
   */
  private haunt(self: Player, enemies: readonly Entity[], out: InputState): void {
    let bestX = 0;
    let bestY = 0;
    let bestScore = -1;

    for (let i = 0; i < enemies.length; i++) {
      const candidate = enemies[i]!;
      if (!candidate.alive) continue;
      // Score each living enemy by how many others sit inside the slow
      // radius around it — a cheap densest-cluster pick.
      let score = 0;
      for (let j = 0; j < enemies.length; j++) {
        const other = enemies[j]!;
        if (!other.alive) continue;
        const dx = other.x - candidate.x;
        const dy = other.y - candidate.y;
        if (dx * dx + dy * dy <= DEATH.WRAITH_SLOW_RADIUS * DEATH.WRAITH_SLOW_RADIUS) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestX = candidate.x;
        bestY = candidate.y;
      }
    }

    if (bestScore < 0) return;

    const dx = bestX - self.x;
    const dy = bestY - self.y;
    const dist = Math.hypot(dx, dy);
    if (dist < PLAYER.RADIUS) return;
    out.moveVector.x = dx / dist;
    out.moveVector.y = dy / dist;
  }

  // --- shared --------------------------------------------------------------

  private applySteering(
    self: Player,
    steerX: number,
    steerY: number,
    allies: readonly Player[],
    out: InputState,
  ): void {
    // Separation. Collision pushes overlapping bodies apart, but steering
    // apart expresses *intent* — it is what stops four players converging on
    // one enemy and standing in a pile in the first place.
    for (let i = 0; i < allies.length; i++) {
      const ally = allies[i]!;
      if (ally.id === self.id || ally.life === LifeState.Wraith) continue;
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

    // Steer away from walls before the hard clamp does it, so bots don't
    // grind along the edges.
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

  private nearestDownedAlly(self: Player, allies: readonly Player[]): Player | null {
    let best: Player | null = null;
    let bestDistSq = Infinity;
    for (let i = 0; i < allies.length; i++) {
      const ally = allies[i]!;
      if (ally.id === self.id || ally.life !== LifeState.Downed) continue;
      const dx = ally.x - self.x;
      const dy = ally.y - self.y;
      const distSq = dx * dx + dy * dy;
      // Ties broken by id so every peer picks the same rescuee.
      if (distSq < bestDistSq || (distSq === bestDistSq && best !== null && ally.id < best.id)) {
        best = ally;
        bestDistSq = distSq;
      }
    }
    return best;
  }

  writeChecksum(h: Hasher): void {
    h.int(this.rng.getState())
      .int(this.age)
      .int(this.strafeSign)
      .bool(this.retreating)
      .float(this.jitterX)
      .float(this.jitterY);
  }
}

/** Nearest living enemy at any distance — bots walk to a fight, they don't
 *  wait for one to enter attack range. */
function nearestLiving(self: Player, enemies: readonly Entity[]): Entity | null {
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
