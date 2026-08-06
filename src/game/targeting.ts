import { TARGETING } from '../core/constants';
import type { Entity } from './entities/entity';

/**
 * Auto-target with tactical override (§16.5b, constraint #6).
 *
 * Basic attacks are never manually aimed. Auto-target picks the nearest
 * enemy; the override lets the player say "that one instead" by pointing a
 * *direction*. It is a tactical choice, not a precision test — which is what
 * makes a mouse, a stick and (later) a thumb equally expressive.
 */
export function selectTarget<T extends Entity>(
  source: Entity,
  candidates: readonly T[],
  overrideActive: boolean,
  overrideX: number,
  overrideY: number,
  maxRangeSq: number,
): T | null {
  if (overrideActive) {
    const picked = pickByDirection(source, candidates, overrideX, overrideY);
    // An override outside attack range still *holds* the selection — the
    // player is committing to a target they're walking toward.
    if (picked) return picked;
  }
  return pickNearest(source, candidates, maxRangeSq);
}

function pickNearest<T extends Entity>(
  source: Entity,
  candidates: readonly T[],
  maxRangeSq: number,
): T | null {
  let best: T | null = null;
  let bestDistSq = Infinity;

  // Indexed loop over an array: deterministic order, and the id tie-break
  // below means two equidistant enemies resolve identically on every peer.
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (!c.alive) continue;
    const dx = c.x - source.x;
    const dy = c.y - source.y;
    const distSq = dx * dx + dy * dy;
    if (distSq > maxRangeSq) continue;
    if (distSq < bestDistSq || (distSq === bestDistSq && best !== null && c.id < best.id)) {
      best = c;
      bestDistSq = distSq;
    }
  }
  return best;
}

function pickByDirection<T extends Entity>(
  source: Entity,
  candidates: readonly T[],
  dirX: number,
  dirY: number,
): T | null {
  const minDot = Math.cos(TARGETING.OVERRIDE_HALF_ANGLE);
  let best: T | null = null;
  let bestDot = -Infinity;
  let bestDistSq = Infinity;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    if (!c.alive) continue;
    const dx = c.x - source.x;
    const dy = c.y - source.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) continue;
    const dot = (dx / len) * dirX + (dy / len) * dirY;
    if (dot < minDot) continue;

    const distSq = dx * dx + dy * dy;
    // Alignment first, then proximity, then id — a total order, so no peer
    // can disagree about the winner.
    const better =
      dot > bestDot ||
      (dot === bestDot && distSq < bestDistSq) ||
      (dot === bestDot && distSq === bestDistSq && best !== null && c.id < best.id);
    if (better) {
      best = c;
      bestDot = dot;
      bestDistSq = distSq;
    }
  }
  return best;
}

/** Ticks an override selection survives after the input stops. */
export function overrideHoldTicks(tickRate: number): number {
  return Math.round(TARGETING.OVERRIDE_HOLD * tickRate);
}
