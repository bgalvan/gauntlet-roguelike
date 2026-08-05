import { Hasher } from '../core/checksum';
import { ROOM } from '../core/constants';
import { Rng } from '../core/rng';
import type { InputState } from '../input/input-state';
import { Dummy } from './entities/dummy';
import { Player } from './entities/player';

/**
 * The whole simulation. Holds no renderer reference and imports no Phaser —
 * it can be stepped headless, which is how determinism gets tested and how
 * lockstep peers will run.
 *
 * Entities live in plain arrays. Iteration is by index, always in spawn
 * order, so every peer visits them identically (constraint #3).
 */
export class World {
  readonly rng: Rng;
  readonly seed: number | string;

  readonly player: Player;
  readonly dummies: Dummy[] = [];

  /** Simulation steps run. Authoritative clock — nothing reads wall time. */
  tick = 0;

  private nextEntityId = 0;

  constructor(seed: number | string) {
    this.seed = seed;
    this.rng = new Rng(seed);

    this.player = new Player(this.nextEntityId++, ROOM.WIDTH / 2, ROOM.HEIGHT / 2);

    // Dummy placement comes from the seeded PRNG, never Math.random. Same
    // seed, same room, every time — that's the Phase 0 proof.
    // Three of them, because target override (§16.5b) cannot be observed with
    // a single candidate.
    const margin = ROOM.WALL + 120;
    for (let i = 0; i < 3; i++) {
      const x = this.rng.range(margin, ROOM.WIDTH - margin);
      const y = this.rng.range(margin, ROOM.HEIGHT - margin);
      this.dummies.push(new Dummy(this.nextEntityId++, x, y));
    }
  }

  /** One fixed simulation step. `dt` is always SIM.STEP_SECONDS. */
  step(dt: number, input: InputState): void {
    this.player.snapshot();
    for (let i = 0; i < this.dummies.length; i++) this.dummies[i]!.snapshot();

    this.player.step(dt, input, this.dummies);

    for (let i = 0; i < this.dummies.length; i++) this.dummies[i]!.step();

    this.tick++;
  }

  /**
   * Hash of everything the simulation depends on. Two peers running the same
   * tick with the same inputs must produce the same string; the first tick
   * where they differ is the desync.
   *
   * Includes the RNG state — a peer that has consumed a different number of
   * rolls is already diverging, even if no entity has visibly moved yet.
   */
  checksum(): string {
    const h = new Hasher();
    h.int(this.tick).int(this.rng.getState());
    this.player.writeChecksum(h);
    for (let i = 0; i < this.dummies.length; i++) this.dummies[i]!.writeChecksum(h);
    return h.value;
  }
}
