import { Hasher } from '../core/checksum';
import { DEATH, PARTY_SIZE, PLAYER, ROOM, SIM, WAVE } from '../core/constants';
import { Rng } from '../core/rng';
import type { InputState } from '../input/input-state';
import { makeInputState } from '../input/input-state';
import { BotController } from './bot';
import { resolveCollisions } from './collision';
import type { PlayerController } from './controller';
import { HumanController } from './controller';
import { Enemy } from './entities/enemy';
import type { Entity } from './entities/entity';
import { Player } from './entities/player';
import { LifeState } from './life-state';

const RESPAWN_DELAY_TICKS = Math.round(WAVE.RESPAWN_DELAY * SIM.TICK_RATE);
const REVIVE_RANGE_SQ = DEATH.REVIVE_RANGE * DEATH.REVIVE_RANGE;

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
  readonly enemies: Enemy[] = [];

  /** Simulation steps run. Authoritative clock — nothing reads wall time. */
  tick = 0;

  /** Total party wipe ends the run (§8, `[LOCKED]`). */
  runOver = false;

  /** Waves cleared this run. Stands in for room progression. */
  wavesCleared = 0;

  private nextEntityId = 0;
  private respawnTicks = 0;

  private readonly playerCache: readonly Player[];
  /** Reused scratch arrays — `step` runs 60 times a second and must not
   *  allocate. Contents are rebuilt each tick. */
  private readonly wraiths: Player[] = [];
  private readonly bodies: Entity[] = [];

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
    this.spawnWave();
  }

  /** Slot 0 — the player at this keyboard. Renderer-facing convenience. */
  get localPlayer(): Player {
    return this.party[0]!.player;
  }

  get players(): readonly Player[] {
    return this.playerCache;
  }

  get enemiesRemaining(): number {
    let n = 0;
    for (let i = 0; i < this.enemies.length; i++) if (this.enemies[i]!.alive) n++;
    return n;
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
    for (let i = 0; i < this.enemies.length; i++) this.enemies[i]!.snapshot();

    // Two passes, deliberately. Every controller decides against the same
    // start-of-tick state, so a bot's choice cannot depend on whether it
    // happens to sit before or after another player in the array.
    for (let i = 0; i < this.party.length; i++) {
      const slot = this.party[i]!;
      slot.controller.produceInput(slot.player, this.playerCache, this.enemies, slot.input);
    }

    for (let i = 0; i < this.party.length; i++) {
      const slot = this.party[i]!;
      slot.player.step(dt, slot.input, this.enemies);
    }

    this.collectWraiths();
    for (let i = 0; i < this.enemies.length; i++) {
      this.enemies[i]!.step(dt, this.playerCache, this.wraiths);
    }

    this.resolveRevives();

    this.bodies.length = 0;
    for (let i = 0; i < this.playerCache.length; i++) this.bodies.push(this.playerCache[i]!);
    for (let i = 0; i < this.enemies.length; i++) this.bodies.push(this.enemies[i]!);
    resolveCollisions(this.bodies);

    this.updateWaves();
    this.updateRunState();

    this.tick++;
  }

  private collectWraiths(): void {
    this.wraiths.length = 0;
    for (let i = 0; i < this.playerCache.length; i++) {
      const p = this.playerCache[i]!;
      if (p.life === LifeState.Wraith) this.wraiths.push(p);
    }
  }

  /**
   * Stage 1 revives (§8): any ally in range holding the context action.
   *
   * Slot 4 — context — is the same input used for pickup, transfer and
   * interact (§3.3). They never conflict because you are either standing on
   * something or you aren't, so one binding covers all of them. This is the
   * first real consumer of the four-input budget.
   */
  private resolveRevives(): void {
    for (let i = 0; i < this.party.length; i++) {
      const downed = this.party[i]!.player;
      if (downed.life !== LifeState.Downed) continue;

      let channelling = false;
      for (let j = 0; j < this.party.length; j++) {
        if (i === j) continue;
        const ally = this.party[j]!;
        // Only an Alive ally can revive — a Downed or Wraith player cannot.
        if (ally.player.life !== LifeState.Alive) continue;
        if (!ally.input.contextAction.down) continue;

        const dx = ally.player.x - downed.x;
        const dy = ally.player.y - downed.y;
        if (dx * dx + dy * dy > REVIVE_RANGE_SQ) continue;

        channelling = true;
        break;
      }

      downed.advanceRevive(channelling);
    }
  }

  private updateWaves(): void {
    if (this.enemiesRemaining > 0) {
      this.respawnTicks = 0;
      return;
    }
    // Wave cleared. Stands in for "room cleared, doors unlock" (§2) until the
    // room system exists.
    if (this.respawnTicks === 0) {
      this.wavesCleared++;
      this.respawnTicks = RESPAWN_DELAY_TICKS;
      this.healOnClear();
      return;
    }
    this.respawnTicks--;
    if (this.respawnTicks === 0) this.spawnWave();
  }

  /**
   * Sandbox scaffolding — see WAVE.CLEAR_HEAL. Deliberately heals only living
   * players: healing a Downed player would quietly undo §8's stage 1 and turn
   * every wave clear into a free party revive.
   */
  private healOnClear(): void {
    const amount = PLAYER.MAX_HP * WAVE.CLEAR_HEAL;
    for (let i = 0; i < this.playerCache.length; i++) {
      const p = this.playerCache[i]!;
      if (p.life !== LifeState.Alive) continue;
      p.hp = Math.min(p.maxHp, p.hp + amount);
    }
  }

  private updateRunState(): void {
    if (this.runOver) return;
    for (let i = 0; i < this.playerCache.length; i++) {
      if (this.playerCache[i]!.life !== LifeState.Wraith) return;
    }
    this.runOver = true;
  }

  /**
   * §2 party scaling: 100 / 165 / 220 / 270% of the base budget for 1–4
   * players. Scaled by party *size*, never by living players — see the note
   * on death spirals in constants.ts.
   */
  private spawnWave(): void {
    this.enemies.length = 0;

    const scale = WAVE.PARTY_SCALING[this.party.length - 1] ?? 1;
    const count = Math.round(WAVE.BASE_COUNT * scale);

    const margin = ROOM.WALL + 60;
    for (let i = 0; i < count; i++) {
      let x = 0;
      let y = 0;
      // Templates will declare spawn anchors and a safe pocket (§2). Until
      // then: reject positions too close to a player, with a bounded number
      // of attempts so the RNG draw count stays deterministic and finite.
      for (let attempt = 0; attempt < 12; attempt++) {
        x = this.rng.range(margin, ROOM.WIDTH - margin);
        y = this.rng.range(margin, ROOM.HEIGHT - margin);
        if (this.farFromPlayers(x, y)) break;
      }
      this.enemies.push(new Enemy(this.nextEntityId++, x, y));
    }
  }

  private farFromPlayers(x: number, y: number): boolean {
    for (let i = 0; i < this.playerCache.length; i++) {
      const p = this.playerCache[i]!;
      const dx = p.x - x;
      const dy = p.y - y;
      if (dx * dx + dy * dy < WAVE.SAFE_SPAWN_DISTANCE * WAVE.SAFE_SPAWN_DISTANCE) return false;
    }
    return true;
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
    h.int(this.tick).int(this.rng.getState()).int(this.respawnTicks).bool(this.runOver);
    for (let i = 0; i < this.party.length; i++) {
      const slot = this.party[i]!;
      slot.player.writeChecksum(h);
      // A bot's internal RNG and phase decide its future inputs, so they are
      // simulation state as much as any position is.
      slot.controller.writeChecksum?.(h);
    }
    for (let i = 0; i < this.enemies.length; i++) this.enemies[i]!.writeChecksum(h);
    return h.value;
  }
}
