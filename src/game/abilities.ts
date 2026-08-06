import { COMBAT, ENEMY, SIM } from '../core/constants';
import { AbilityId } from './classes';
import type { AbilityDef } from './classes';
import type { Enemy } from './entities/enemy';
import type { Player } from './entities/player';
import { EventKind } from './events';
import type { EventBuffer } from './events';

/**
 * Ability execution.
 *
 * Class *data* lives in classes.ts; this is the behaviour behind each id. A
 * new class that reuses existing ability kinds needs no code here, which is
 * what §3.1's "content work, not engineering work" asks for.
 *
 * Everything in this file is deterministic: no PRNG, no wall clock, indexed
 * iteration only.
 */

/** What the world hands an ability so it can act on the room. */
export interface AbilityContext {
  readonly enemies: readonly Enemy[];
  readonly allies: readonly Player[];
  readonly events: EventBuffer;
  /** Fire a projectile. Returns false if the pool is exhausted. */
  spawnProjectile(
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    speed: number,
    damage: number,
    ownerSlot: number,
    opts?: { piercing?: boolean; knockback?: number; radius?: number; lifeTicks?: number },
  ): boolean;
}

/**
 * Where an area ability landed, so the caller can mark the ground.
 *
 * Returned rather than recomputed by Player: Blast and Volley land on the
 * current target while Whirlwind and Shockwave land underfoot, and deriving
 * that a second time at the call site is exactly how a §4 Field ends up
 * burning somewhere the blast never touched.
 */
export interface AbilityImpact {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/**
 * Execute an ability. `dirX/dirY` is the aim direction — for abilities that
 * need one it is the target override if the player is expressing one, else
 * the facing (§16.5b: abilities are *directional*, never precision-aimed).
 *
 * `power` and `radius` come in already scaled by the user's §4 upgrades. The
 * AbilityDef carries the *authored* values and is never read for them here —
 * a class's numbers are its base, not its live stats.
 */
export function executeAbility(
  def: AbilityDef,
  user: Player,
  dirX: number,
  dirY: number,
  ctx: AbilityContext,
  power: number,
  radius: number,
): AbilityImpact | null {
  ctx.events.emit(EventKind.Ability, user.x, user.y, {
    ability: def.id,
    slot: user.slot,
    dirX,
    dirY,
    radius,
  });

  switch (def.id) {
    // --- Slot 1: traversal ------------------------------------------------
    // Traversal returns no impact. A field trailing behind every dash would
    // make the Field breakpoint a movement upgrade, which is a different
    // design than the one §4.1 describes.
    case AbilityId.Charge:
      // Warrior: a moving hitbox. Damage happens over the dash, not at the end.
      user.beginDash(dirX, dirY, def.distance, { damage: power, radius });
      return null;

    case AbilityId.Dash:
      // Archer: pure repositioning. §3.3 — traversal is always slot 1, but it
      // does not have to carry damage.
      user.beginDash(dirX, dirY, def.distance, {});
      return null;

    case AbilityId.Blink:
      // Sorcerer: instant, ignores bodies. The teleport is clamped to the room
      // by the collision pass on the same tick.
      user.x += dirX * def.distance;
      user.y += dirY * def.distance;
      user.blinkTicks = 8;
      return null;

    case AbilityId.Plow:
      // Valkyrie: shoves rather than kills.
      user.beginDash(dirX, dirY, def.distance, {
        damage: power,
        radius,
        knockback: 300,
      });
      return null;

    // --- Slot 2: signature ------------------------------------------------
    case AbilityId.Whirlwind:
      damageArea(user, user.x, user.y, radius, power, ctx, {
        knockback: 230,
        stagger: COMBAT.HIT_STAGGER_TICKS * 2,
      });
      return { x: user.x, y: user.y, radius };

    case AbilityId.ChargedShot:
      ctx.spawnProjectile(user.x, user.y, dirX, dirY, 780, power, user.slot, {
        piercing: true,
        knockback: 260,
        radius,
        lifeTicks: Math.round((def.distance / 780) * SIM.TICK_RATE),
      });
      // A line, not an area — nothing to set alight.
      return null;

    case AbilityId.Blast: {
      // Lands on the current target — the auto-pick, or whoever the override
      // chose (§16.5b: targeting is the tactical layer; the ability rides it).
      // Direction-at-max-range is only the fallback when nothing is targeted.
      const aimed = user.target;
      const tx = aimed && aimed.alive ? aimed.x : user.x + dirX * def.distance;
      const ty = aimed && aimed.alive ? aimed.y : user.y + dirY * def.distance;
      damageArea(user, tx, ty, radius, power, ctx, {
        knockback: 240,
        stagger: COMBAT.HIT_STAGGER_TICKS * 3,
      });
      return { x: tx, y: ty, radius };
    }

    case AbilityId.Block:
      // Held. The absorbing happens in Player.takeDamage; firing it just
      // marks the state for this tick.
      user.blocking = true;
      return null;

    // --- Slot 3: payoff ---------------------------------------------------
    case AbilityId.Shockwave:
      // §3.3: the payoff is "often about the party" and should read loudest.
      // Room-wide stagger is a coordination window, not just damage.
      damageArea(user, user.x, user.y, radius, power, ctx, {
        knockback: 420,
        stagger: COMBAT.HEAVY_STAGGER_TICKS,
        falloff: true,
      });
      return { x: user.x, y: user.y, radius };

    case AbilityId.Volley: {
      // A lingering zone rather than an instant hit — arrows rain for a
      // while. Centres on the current target like Blast, falling back to
      // direction-at-range.
      const aimed = user.target;
      const zx = aimed && aimed.alive ? aimed.x : user.x + dirX * def.distance;
      const zy = aimed && aimed.alive ? aimed.y : user.y + dirY * def.distance;
      user.beginZone(
        zx,
        zy,
        radius,
        power,
        Math.round(3.5 * SIM.TICK_RATE),
        Math.round(0.28 * SIM.TICK_RATE),
      );
      // Volley already *is* a field; stacking a second one on top would
      // double-dip the breakpoint on the one ability that least needs it.
      return null;
    }

    case AbilityId.Freeze:
      // Control, not damage. Freezing the room is the Sorcerer's contribution
      // to a party opening.
      for (let i = 0; i < ctx.enemies.length; i++) {
        const enemy = ctx.enemies[i]!;
        if (!enemy.alive) continue;
        const dx = enemy.x - user.x;
        const dy = enemy.y - user.y;
        if (dx * dx + dy * dy > radius * radius) continue;
        enemy.stagger(Math.round(2.6 * SIM.TICK_RATE));
        ctx.events.emit(EventKind.Hit, enemy.x, enemy.y, {
          amount: 0,
          slot: user.slot,
          ability: AbilityId.Freeze,
        });
      }
      return { x: user.x, y: user.y, radius };

    case AbilityId.Slam: {
      // Cone knockback plus an ally shield — the party-affecting payoff.
      damageCone(user, dirX, dirY, radius, power, ctx, {
        knockback: 460,
        stagger: COMBAT.HEAVY_STAGGER_TICKS,
      });
      const shieldTicks = Math.round(COMBAT.SHIELD_DURATION * SIM.TICK_RATE);
      for (let i = 0; i < ctx.allies.length; i++) {
        const ally = ctx.allies[i]!;
        if (!ally.alive) continue;
        ally.shieldTicks = Math.max(ally.shieldTicks, shieldTicks);
      }
      return { x: user.x, y: user.y, radius };
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------

export interface HitOpts {
  knockback?: number;
  stagger?: number;
  /** Scale damage down toward the edge of the radius. */
  falloff?: boolean;
}

/** Damage every living enemy inside a circle. Indexed iteration — order is
 *  identical on every peer. */
export function damageArea(
  user: Player,
  x: number,
  y: number,
  radius: number,
  power: number,
  ctx: AbilityContext,
  opts: HitOpts = {},
): number {
  let hits = 0;

  for (let i = 0; i < ctx.enemies.length; i++) {
    const enemy = ctx.enemies[i]!;
    if (!enemy.alive) continue;

    const dx = enemy.x - x;
    const dy = enemy.y - y;
    const distSq = dx * dx + dy * dy;
    const reach = radius + enemy.radius;
    if (distSq > reach * reach) continue;

    const dist = Math.sqrt(distSq);
    let amount = power;
    if (opts.falloff && radius > 0) {
      // Linear falloff to 40% at the rim — never to zero, so a hit that
      // visibly connected always does something.
      amount = power * (1 - 0.6 * Math.min(1, dist / radius));
    }

    applyHit(user, enemy, amount, dx, dy, dist, ctx, opts);
    hits++;
  }
  return hits;
}

/** Damage living enemies inside a cone facing `dirX/dirY`. */
export function damageCone(
  user: Player,
  dirX: number,
  dirY: number,
  radius: number,
  power: number,
  ctx: AbilityContext,
  opts: HitOpts = {},
): number {
  let hits = 0;
  const minDot = Math.cos(COMBAT.BLOCK_CONE);

  for (let i = 0; i < ctx.enemies.length; i++) {
    const enemy = ctx.enemies[i]!;
    if (!enemy.alive) continue;

    const dx = enemy.x - user.x;
    const dy = enemy.y - user.y;
    const dist = Math.hypot(dx, dy);
    if (dist > radius + enemy.radius) continue;
    if (dist > 0 && (dx / dist) * dirX + (dy / dist) * dirY < minDot) continue;

    applyHit(user, enemy, power, dx, dy, dist, ctx, opts);
    hits++;
  }
  return hits;
}

/** Land one hit: damage, knockback, stagger, event. Exported for the dash
 *  sweep in Player, which needs per-enemy dedup that damageArea can't do. */
export function applyHit(
  user: Player,
  enemy: Enemy,
  amount: number,
  dx: number,
  dy: number,
  dist: number,
  ctx: AbilityContext,
  opts: HitOpts,
): void {
  // Coincident bodies get a stable direction from ids rather than a roll.
  let nx = 1;
  let ny = 0;
  if (dist > 0) {
    nx = dx / dist;
    ny = dy / dist;
  } else {
    const angle = ((user.id * 31 + enemy.id * 17) % 360) * (Math.PI / 180);
    nx = Math.cos(angle);
    ny = Math.sin(angle);
  }

  const wasAlive = enemy.alive;
  enemy.damage(amount);
  if (opts.knockback) enemy.applyKnockback(nx, ny, opts.knockback);
  enemy.stagger(opts.stagger ?? COMBAT.HIT_STAGGER_TICKS);

  const killed = wasAlive && !enemy.alive;
  ctx.events.emit(killed ? EventKind.Kill : EventKind.Hit, enemy.x, enemy.y, {
    amount,
    dirX: nx,
    dirY: ny,
    slot: user.slot,
  });

  // §4 Burst. Every kill a player can be credited with passes through here or
  // through the World's projectile loop, so those are the two places that ask.
  if (killed) user.onKill(enemy.x, enemy.y, ctx);
}

/** Enemy contact radius, used by dash sweeps. */
export const ENEMY_CONTACT = ENEMY.RADIUS;
