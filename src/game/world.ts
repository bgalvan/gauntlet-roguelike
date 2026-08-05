import { Hasher } from '../core/checksum';
import { PARTY_SIZE, PLAYER, ROOM } from '../core/constants';
import { Rng } from '../core/rng';
import type { InputState } from '../input/input-state';
import { makeInputState } from '../input/input-state';
import { BotController } from './bot';
import type { PlayerController } from './controller';
import { HumanController } from './controller';
import { Dummy } from './entities/dummy';
import { Player } from './entities/player';

/** One party member: an entity, whatever drives it, and its input buffer. */
export interface PartySlot {
  readonly player: Player;
  readonly controller: PlayerController;
  /** This slot's input for the current tick. Reused, never reallocated. */
  readonly input: InputState;
}

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

  readonly party: PartySlot[] = [];
  readonly dummies: Dummy[] = [];

  /** Simulation steps run. Authoritative clock — nothing reads wall time. */
  tick = 0;

  private nextEntityId = 0;

  /** Stable player array, built once at construction — `step` runs 60 times a
   *  second and must not allocate. */
  private readonly playerCache: readonly Player[];

  /**
   * @param seed       run seed — everything random derives from this
   * @param humanSlots how many slots are driven from outside; the rest are
   *                   bots. Solo testing is 1; four humans is 4.
   */
  constructor(seed: number | string, humanSlots = 1) {
    this.seed = seed;
    this.rng = new Rng(seed);

    // Spawn in a ring so the party starts spread out rather than stacked.
    const spawnRadius = PLAYER.RADIUS * 5;
    for (let slot = 0; slot < PARTY_SIZE; slot++) {
      const angle = (slot / PARTY_SIZE) * Math.PI * 2;
      const player = new Player(
        this.nextEntityId++,
        slot,
        ROOM.WIDTH / 2 + Math.cos(angle) * spawnRadius,
        ROOM.HEIGHT / 2 + Math.sin(angle) * spawnRadius,
      );

      // Each bot gets its own forked stream, so a bot consuming a different
      // number of rolls can never shift another system's sequence.
      const controller: PlayerController =
        slot < humanSlots
          ? new HumanController(makeInputState())
          : new BotController(this.rng.fork());

      this.party.push({ player, controller, input: makeInputState() });
    }

    this.playerCache = this.party.map((s) => s.player);

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

  /** Slot 0 — the player at this keyboard. Renderer-facing convenience. */
  get localPlayer(): Player {
    return this.party[0]!.player;
  }

  get players(): readonly Player[] {
    return this.playerCache;
  }

  /**
   * Hand a human-driven slot its input for the coming tick. Called before
   * `step`. Later this is also where a remote peer's input frame or a replay
   * log enters the simulation — from the sim's side they are the same thing.
   */
  setInput(slot: number, state: InputState): void {
    const entry = this.party[slot];
    if (!entry) return;
    if (entry.controller.kind !== 'human') return;
    (entry.controller as HumanController).set(state);
  }

  /** One fixed simulation step. `dt` is always SIM.STEP_SECONDS. */
  step(dt: number): void {
    for (let i = 0; i < this.party.length; i++) this.party[i]!.player.snapshot();
    for (let i = 0; i < this.dummies.length; i++) this.dummies[i]!.snapshot();

    // Two passes, deliberately. Every controller decides against the same
    // start-of-tick state, so a bot's choice cannot depend on whether it
    // happens to sit before or after another player in the array.
    for (let i = 0; i < this.party.length; i++) {
      const slot = this.party[i]!;
      slot.controller.produceInput(slot.player, this.playerCache, this.dummies, slot.input);
    }

    for (let i = 0; i < this.party.length; i++) {
      const slot = this.party[i]!;
      slot.player.step(dt, slot.input, this.dummies);
    }

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
    for (let i = 0; i < this.party.length; i++) {
      const slot = this.party[i]!;
      slot.player.writeChecksum(h);
      // A bot's internal RNG and phase decide its future inputs, so they are
      // simulation state as much as any position is.
      slot.controller.writeChecksum?.(h);
    }
    for (let i = 0; i < this.dummies.length; i++) this.dummies[i]!.writeChecksum(h);
    return h.value;
  }
}
