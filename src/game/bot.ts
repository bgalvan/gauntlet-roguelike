import type { Hasher } from '../core/checksum';
import { BOT, DEATH, PLAYER, ROOM } from '../core/constants';
import type { Rng } from '../core/rng';
import type { InputState } from '../input/input-state';
import { clampToUnit } from '../input/input-state';
import { AbilityId } from './classes';
import type { AbilityDef } from './classes';
import type { PlayerController } from './controller';
import { distanceSq } from './entities/entity';
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

  /** Entity id of the ally this bot has committed to reviving, or -1. */
  private rescueTargetId = -1;

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

    // Self-preservation, with hysteresis so it doesn't oscillate on the
    // threshold. Evaluated before the rescue check, because whether this bot
    // is retreating decides whether it should be the one to commit.
    const healthFraction = self.hp / self.maxHp;
    if (this.retreating) {
      if (healthFraction >= BOT.REENGAGE_HP) this.retreating = false;
    } else if (healthFraction < BOT.RETREAT_HP) {
      this.retreating = true;
    }

    // Reviving outranks fighting for the elected rescuer. A downed ally is on
    // a 20s clock (§8) and the party is a body down until they're up.
    const rescue = this.pickRescue(self, allies);
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

    // Auto-attack keeps firing while retreating (constraint #6 — attacks
    // aren't aimed), so a kiting bot is still contributing.
    const target = nearestLiving(self, enemies);
    this.useAbilities(self, target, enemies, out);

    if (target) {
      const dx = target.x - self.x;
      const dy = target.y - self.y;
      const dist = Math.hypot(dx, dy);

      if (dist > 0) {
        const towardX = dx / dist;
        const towardY = dy / dist;
        // Standoff is per-class now: an Archer at 330 range and a Warrior at
        // 116 want completely different spacing, and using one shared number
        // made three of the four classes fight like the fourth.
        const standoff = this.retreating
          ? BOT.RETREAT_DISTANCE
          : self.def.attackRange * BOT.STANDOFF;

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

  // --- abilities -----------------------------------------------------------

  /**
   * Decide which of the three slots to press this tick.
   *
   * Bots must exercise all twelve abilities or three of the four classes go
   * untested — and untested is where the last two bugs lived. Conditions are
   * pure functions of world state: no PRNG draws, so adding this cannot shift
   * any other system's random stream.
   *
   * Player.tryAbilities reads `pressed` for tap abilities and `down` for held
   * ones. Bot inputs never go through InputManager, so nothing derives edges
   * for them — the bot sets both flags itself.
   */
  private useAbilities(
    self: Player,
    target: Entity | null,
    enemies: readonly Entity[],
    out: InputState,
  ): void {
    const payoff = self.def.abilities[2]!;
    const payoffCost = payoff.spendsAll ? self.def.resource.max : payoff.cost;

    /**
     * Hold the resource when the room already warrants the payoff but the
     * pool is short.
     *
     * Without this the signature drains the pool on cooldown and the payoff
     * literally never fires: the Sorcerer spent mana on Blast at 67 and fell
     * back to 35, so Deep Freeze's full pool was unreachable, and the Valkyrie
     * bled stamina into Block so Slam never came up. Measured — both were
     * dead code until this rule existed. It is also just correct play.
     */
    const savingForPayoff =
      payoffCost > 0 &&
      self.resource < payoffCost &&
      this.abilityCondition(self, payoff, target, enemies);

    for (let slot = 0; slot < 3; slot++) {
      const def = self.def.abilities[slot]!;

      const cost = def.spendsAll ? self.def.resource.max : def.cost;
      if (cost > 0 && self.resource < cost) continue;
      // Slot 2 is the only one that ever yields to the payoff; slot 1 is
      // traversal and free, slot 3 *is* the payoff.
      // `def.held` matters as much as `cost`: Block lists no cost but drains
      // stamina every tick it is down, which starved Slam of its full pool.
      if (slot === 1 && savingForPayoff && (cost > 0 || def.held)) continue;
      if (!this.abilityCondition(self, def, target, enemies)) continue;

      const button = out.ability[slot]!;
      button.down = true;
      button.pressed = !def.held;
      button.value = 1;
    }
  }

  /** Situational condition only — affordability is checked by the caller, so
   *  that "would I want this if I could pay?" can be asked separately. */
  private abilityCondition(
    self: Player,
    def: AbilityDef,
    target: Entity | null,
    enemies: readonly Entity[],
  ): boolean {
    const targetDist = target ? Math.hypot(target.x - self.x, target.y - self.y) : Infinity;

    switch (def.id) {
      // --- Slot 1: traversal ---------------------------------------------
      case AbilityId.Charge:
      case AbilityId.Plow:
        // Gap closers: only worth it when there is a gap, and never while
        // running away — charging into the swarm you are fleeing is suicide.
        return !this.retreating && targetDist > self.def.attackRange * 1.4 && targetDist < def.distance * 1.5;

      case AbilityId.Dash:
      case AbilityId.Blink:
        // Escapes: break contact whenever something has closed the gap. Not
        // gated on being hurt — a dash is the ranged classes' answer to
        // "something reached me", which is true at full health too. Absolute
        // distance; see BOT.ESCAPE_DISTANCE for why range-relative fails.
        return targetDist < BOT.ESCAPE_DISTANCE;

      // --- Slot 2: signature ----------------------------------------------
      case AbilityId.Whirlwind:
        // Worth a 6s cooldown only against a group.
        return countWithin(self.x, self.y, def.radius, enemies) >= 2;

      case AbilityId.ChargedShot:
        return target !== null && targetDist <= def.distance * 0.8;

      case AbilityId.Blast:
        // Mana is a budget, so spend it on clusters rather than singles.
        return target !== null && countWithin(target.x, target.y, def.radius, enemies) >= 2;

      case AbilityId.Block:
        // §3.3 slot 2 is "rhythm" — the Valkyrie's is holding ground. Blocking
        // halves movement, so only while something is actually close, and only
        // with stamina to spare.
        return targetDist < self.def.attackRange * 1.2 && self.resourceFraction > 0.3;

      // --- Slot 3: payoff --------------------------------------------------
      case AbilityId.Shockwave:
      case AbilityId.Freeze:
        // §3.3: the payoff fires 3–8 times a floor and should read as an
        // event. Gate it on the room actually being dangerous.
        return countWithin(self.x, self.y, def.radius, enemies) >= 4;

      case AbilityId.Slam:
        return countWithin(self.x, self.y, def.radius, enemies) >= 3;

      case AbilityId.Volley:
        return target !== null && countWithin(target.x, target.y, def.radius, enemies) >= 3;

      default:
        return false;
    }
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

  /**
   * The downed ally this bot should go and revive — or null if someone else
   * should.
   *
   * Reviving means standing still for three seconds. When every bot committed
   * to the same body, the whole party stopped fighting and stopped dodging in
   * the middle of a swarm, and all of them died standing over it. Measured:
   * the channel would reach ~80/180 before every rescuer went down, so the
   * victim bled out and the party wiped. §8 explicitly warns against building
   * things that pile on when the party is already losing.
   *
   * So: exactly one rescuer per body, and never a bot that is itself hurt
   * enough to be retreating.
   */
  private pickRescue(self: Player, allies: readonly Player[]): Player | null {
    // Honour an existing commitment before re-electing.
    //
    // This is the important line. Electing a rescuer fresh every tick looks
    // reasonable and does not work: channelling means standing still, standing
    // still means taking hits, taking hits drops you below the health bar that
    // qualifies you — so the job is handed to a healthy bot on the far side of
    // the room, the 3s channel restarts from zero, and by the time that one
    // arrives it happens again. Measured: the channel reached 86/180, then
    // 10/180, then 35/180, and the victim bled out with three allies alive.
    if (this.rescueTargetId !== -1) {
      const committed = findById(allies, this.rescueTargetId);
      if (committed && committed.life === LifeState.Downed) return committed;
      this.rescueTargetId = -1;
    }

    const victim = this.nearestDownedAlly(self, allies);
    if (!victim) return null;

    // Candidates are other *bots* only. A bot cannot defer to a human: the
    // human may never press the button, and the victim bleeds out while the
    // party politely waits. Measured before this rule existed — a full 20s
    // bleed-out with three allies standing by.
    //
    // Health is judged by HP rather than by the private `retreating` latch, so
    // every bot evaluates every candidate — including itself — by the same
    // observable rule and they all elect the same rescuer with no messaging.
    const selfHealthy = self.hp / self.maxHp >= BOT.RETREAT_HP;

    let anyHealthy = selfHealthy;
    if (!anyHealthy) {
      for (let i = 0; i < allies.length; i++) {
        const other = allies[i]!;
        if (other.id === self.id || !other.botControlled) continue;
        if (other.life !== LifeState.Alive) continue;
        if (other.hp / other.maxHp >= BOT.RETREAT_HP) {
          anyHealthy = true;
          break;
        }
      }
    }

    // Healthy bots do the rescuing — but if none are healthy, the hurt ones
    // are eligible rather than nobody. An election that can elect no one is
    // how the whole party ends up watching someone bleed out.
    if (anyHealthy && !selfHealthy) return null;

    const selfDistSq = distanceSq(self, victim);
    for (let i = 0; i < allies.length; i++) {
      const other = allies[i]!;
      if (other.id === self.id || !other.botControlled) continue;
      if (other.life !== LifeState.Alive) continue;
      if (anyHealthy && other.hp / other.maxHp < BOT.RETREAT_HP) continue;

      const otherDistSq = distanceSq(other, victim);
      // Strictly closer wins; equal distance is broken by id so every peer
      // elects the same rescuer without any communication.
      if (otherDistSq < selfDistSq || (otherDistSq === selfDistSq && other.id < self.id)) {
        return null;
      }
    }

    this.rescueTargetId = victim.id;
    return victim;
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
      .int(this.rescueTargetId)
      .float(this.jitterX)
      .float(this.jitterY);
  }
}

function findById(players: readonly Player[], id: number): Player | null {
  for (let i = 0; i < players.length; i++) {
    if (players[i]!.id === id) return players[i]!;
  }
  return null;
}

/** Living enemies inside a circle. Indexed loop — deterministic on all peers. */
function countWithin(x: number, y: number, radius: number, enemies: readonly Entity[]): number {
  let n = 0;
  const radiusSq = radius * radius;
  for (let i = 0; i < enemies.length; i++) {
    const e = enemies[i]!;
    if (!e.alive) continue;
    const dx = e.x - x;
    const dy = e.y - y;
    if (dx * dx + dy * dy <= radiusSq) n++;
  }
  return n;
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
