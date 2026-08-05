/**
 * Events the simulation emits for the renderer to react to.
 *
 * The split that matters: **knockback and stagger live in the simulation;
 * screen shake, particles and damage numbers live in the renderer.** Anything
 * that changes what happens next must be deterministic and checksummed;
 * anything purely cosmetic must never feed back into the sim, or two peers
 * with different window sizes desync.
 *
 * This buffer is cleared at the top of every step and is deliberately *not*
 * part of the checksum — it is derived output, not state.
 */

import type { AbilityId } from './classes';

export const EventKind = {
  Hit: 'hit',
  Kill: 'kill',
  Ability: 'ability',
  Downed: 'downed',
  Revived: 'revived',
  Blocked: 'blocked',
} as const;

export type EventKind = (typeof EventKind)[keyof typeof EventKind];

export interface SimEvent {
  kind: EventKind;
  x: number;
  y: number;
  /** Damage dealt, for Hit. */
  amount: number;
  /** Direction the impact came from, for particle spray. */
  dirX: number;
  dirY: number;
  /** Which ability fired, for Ability events. */
  ability: AbilityId | null;
  /** Party slot responsible, or -1. */
  slot: number;
  /** Radius of the effect, for Ability events that have one. */
  radius: number;
}

/**
 * Fixed-capacity ring of reusable event objects. A busy tick with a Shockwave
 * can emit dozens of hits; allocating them 60 times a second is exactly the
 * kind of garbage that causes frame hitches on the mid-range phone that
 * constraint #4 budgets for.
 */
export class EventBuffer {
  private readonly pool: SimEvent[] = [];
  private count = 0;

  get length(): number {
    return this.count;
  }

  at(i: number): SimEvent {
    return this.pool[i]!;
  }

  clear(): void {
    this.count = 0;
  }

  emit(
    kind: EventKind,
    x: number,
    y: number,
    opts?: {
      amount?: number;
      dirX?: number;
      dirY?: number;
      ability?: AbilityId | null;
      slot?: number;
      radius?: number;
    },
  ): void {
    // Drop rather than grow without bound. A tick that wants more than this
    // many effects is already past what the frame can draw legibly.
    if (this.count >= 256) return;

    let event = this.pool[this.count];
    if (!event) {
      event = { kind, x, y, amount: 0, dirX: 0, dirY: 0, ability: null, slot: -1, radius: 0 };
      this.pool.push(event);
    }

    event.kind = kind;
    event.x = x;
    event.y = y;
    event.amount = opts?.amount ?? 0;
    event.dirX = opts?.dirX ?? 0;
    event.dirY = opts?.dirY ?? 0;
    event.ability = opts?.ability ?? null;
    event.slot = opts?.slot ?? -1;
    event.radius = opts?.radius ?? 0;

    this.count++;
  }
}
