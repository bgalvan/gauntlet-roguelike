import type { Hasher } from '../../core/checksum';
import { PICKUP } from '../../core/constants';

/**
 * A thing on the floor.
 *
 * §7.2 tier 1: hearts are free-for-all, touch pickup — "high frequency, low
 * stakes; ceremony here is pure friction." No hold-to-take, no claim window,
 * no assignment. Those exist in §7 for the tiers where an argument is actually
 * possible, and a heart is not one of them.
 *
 * Not an `Entity`: pickups have no health, take no knockback and never
 * collide. Inheriting one would hand them three fields the collision pass
 * would then have to be told to ignore.
 */

export const PickupKind = {
  Heart: 'heart',
} as const;

export type PickupKind = (typeof PickupKind)[keyof typeof PickupKind];

export class Pickup {
  readonly id: number;
  readonly kind: PickupKind;

  x: number;
  y: number;
  readonly radius = PICKUP.RADIUS;

  /** Consumed pickups stay in the array until the room is left, so the
   *  renderer can play them out and indices never shift mid-tick. */
  taken = false;

  /** Slot that took it, for attribution. -1 until then. */
  takenBy = -1;

  constructor(id: number, kind: PickupKind, x: number, y: number) {
    this.id = id;
    this.kind = kind;
    this.x = x;
    this.y = y;
  }

  writeChecksum(h: Hasher): void {
    h.int(this.id).float(this.x).float(this.y).bool(this.taken).int(this.takenBy);
  }
}
