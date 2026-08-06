import { Hasher } from '../core/checksum';
import {
  COMBAT,
  DEATH,
  DOOR,
  LEASH,
  PARTY_SIZE,
  PICKUP,
  ROOM,
  SIM,
  UPGRADE,
  WAVE,
} from '../core/constants';
import { Rng } from '../core/rng';
import type { InputState } from '../input/input-state';
import { clearInputState, makeInputState } from '../input/input-state';
import type { AbilityContext } from './abilities';
import { BotController } from './bot';
import { CLASS_ORDER } from './classes';
import type { ClassId } from './classes';
import { resolveCollisions } from './collision';
import type { PlayerController, RoomBounds } from './controller';
import { HumanController } from './controller';
import { Enemy } from './entities/enemy';
import type { Entity } from './entities/entity';
import { Pickup, PickupKind } from './entities/pickup';
import { Player } from './entities/player';
import { Projectile } from './entities/projectile';
import { EventBuffer, EventKind } from './events';
import { LifeState } from './life-state';
import { generateFloor, RoomKind } from './rooms/floor';
import type { Floor, RoomNode } from './rooms/floor';
import { ALL_DIRECTIONS, Direction, oppositeDirection } from './rooms/templates';
import { Transformation, rollOffer, tierOf } from './upgrades';
import type { UpgradeOffer } from './upgrades';

const REVIVE_RANGE_SQ = DEATH.REVIVE_RANGE * DEATH.REVIVE_RANGE;
const TRANSITION_TICKS = Math.round(DOOR.TRANSITION * SIM.TICK_RATE);
const LEASH_GRACE_TICKS = Math.round(LEASH.GRACE * SIM.TICK_RATE);
const AUTO_CONFIRM_TICKS = Math.round(UPGRADE.AUTO_CONFIRM_SECONDS * SIM.TICK_RATE);
/** Stick deflection that counts as moving the highlight. Well above the
 *  deadzone the input layer already applies, so a resting stick never drifts
 *  a player's build. */
const HIGHLIGHT_THRESHOLD = 0.45;

/** One party member: an entity, whatever drives it, and its input buffer. */
export interface PartySlot {
  readonly player: Player;
  readonly controller: PlayerController;
  /** This slot's input for the current tick. Reused, never reallocated. */
  readonly input: InputState;
}

/** A door opening on one wall of the current room. */
export interface DoorInstance {
  readonly direction: Direction;
  readonly targetRoom: number;
  /** Centre of the opening, in room coordinates. */
  readonly x: number;
  readonly y: number;
  open: boolean;
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
  readonly projectiles: Projectile[] = [];
  /** Hearts on the floor (§7.2). Cleared when the party leaves the room. */
  readonly pickups: Pickup[] = [];
  readonly events = new EventBuffer();

  /** The generated floor (§2). Fully reproducible from the seed. */
  readonly floor: Floor;

  /** Index into `floor.rooms`. */
  currentRoom: number;

  /** Doors of the current room, rebuilt on entry. */
  readonly doors: DoorInstance[] = [];

  /** Simulation steps run. Authoritative clock — nothing reads wall time. */
  tick = 0;

  /** Total party wipe ends the run (§8, `[LOCKED]`). */
  runOver = false;

  /** Set once the boss room is cleared. */
  floorComplete = false;

  roomsCleared = 0;

  // --- §4 upgrades ---------------------------------------------------------

  /** Live offer per slot, or null. Non-null anywhere holds the doors shut. */
  private readonly offers: (UpgradeOffer | null)[] = [];
  /** Axis each slot was offered last, so the next draw rotates off it. */
  private readonly lastOfferAxis: number[] = [];
  /** Per-slot stream for offers. Forked so that changing how many rolls the
   *  offer system takes cannot shift floor generation or bot behaviour. */
  private readonly offerRng: Rng[] = [];
  /** Picks the party has earned but not yet been shown. */
  private offersOwed = 0;
  /** Picks resolved this run. Cheap progress read for the HUD and harness. */
  upgradesTaken = 0;

  /** Room drops (§7.2). Its own stream for the same reason. */
  private readonly lootRng: Rng;

  /** Ticks left in a door transition; 0 when not transitioning. */
  transitionTicks = 0;
  /** Direction the party is travelling during a transition, for the wipe. */
  transitionDirection: Direction = Direction.North;
  private pendingRoom = -1;

  /** The door of the current room the party walked in through, or null for
   *  the entry room. */
  private arrivedVia: Direction | null = null;

  /**
   * Which door leads onward. Recomputed on room entry and when doors unlock.
   *
   * A local "not the door I came in by" rule is not enough: on a dead-end
   * branch the only door *is* the arrival door, so the party bounced straight
   * back out, and the room behind it sent them straight back in. Measured:
   * 2593 transitions across 7 rooms. This is a graph search instead, so the
   * chosen door is always a step along a real path to somewhere new.
   */
  private preferredExit: Direction | null = null;

  private nextEntityId = 0;

  private readonly playerCache: readonly Player[];
  private readonly wraiths: Player[] = [];
  private readonly bodies: Entity[] = [];
  private readonly abilityContext: AbilityContext;

  /** Ticks each slot has spent beyond the leash radius. */
  private readonly leashTicks: number[] = [];

  /** Party centroid, recomputed each tick. The camera follows this, and so
   *  does the leash — one definition, so they can never disagree. */
  centroidX = 0;
  centroidY = 0;

  constructor(
    seed: number | string,
    humanSlots = 1,
    classIds: readonly ClassId[] = CLASS_ORDER,
  ) {
    this.seed = seed;
    this.rng = new Rng(seed);

    for (let i = 0; i < COMBAT.PROJECTILE_POOL; i++) {
      this.projectiles.push(new Projectile(-1000 - i));
    }

    // The floor is drawn from the run seed before anything else consumes the
    // stream, so the same seed always produces the same floor regardless of
    // party composition.
    this.floor = generateFloor(this.rng.fork());
    this.lootRng = this.rng.fork();
    this.currentRoom = this.floor.entryIndex;

    const entry = this.room;
    for (let slot = 0; slot < PARTY_SIZE; slot++) {
      const angle = (slot / PARTY_SIZE) * Math.PI * 2;
      const isBot = slot >= humanSlots;
      const player = new Player(
        this.nextEntityId++,
        slot,
        entry.template.safePocket.x + Math.cos(angle) * 70,
        entry.template.safePocket.y + Math.sin(angle) * 70,
        isBot,
        classIds[slot] ?? CLASS_ORDER[slot % CLASS_ORDER.length]!,
      );

      const controller: PlayerController = isBot
        ? new BotController(this.rng.fork())
        : new HumanController(makeInputState());

      this.party.push({ player, controller, input: makeInputState() });
      this.leashTicks.push(0);
      this.offers.push(null);
      this.lastOfferAxis.push(-1);
      this.offerRng.push(this.rng.fork());
    }

    this.playerCache = this.party.map((s) => s.player);
    this.abilityContext = this.buildAbilityContext();
    this.enterRoom(this.currentRoom, null);
  }

  // --- accessors -----------------------------------------------------------

  get room(): RoomNode {
    return this.floor.rooms[this.currentRoom]!;
  }

  get roomWidth(): number {
    return this.room.template.width;
  }

  get roomHeight(): number {
    return this.room.template.height;
  }

  get roomBounds(): RoomBounds {
    let exit: { x: number; y: number } | null = null;
    for (let i = 0; i < this.doors.length; i++) {
      const door = this.doors[i]!;
      if (!door.open) continue;
      if (door.direction !== this.preferredExit) continue;
      exit = { x: door.x, y: door.y };
      break;
    }

    return {
      width: this.roomWidth,
      height: this.roomHeight,
      exit,
      botsLead: this.botsLead,
      pickups: this.pickups,
    };
  }

  /** True when nobody in the party is externally driven. */
  get botsLead(): boolean {
    for (let i = 0; i < this.playerCache.length; i++) {
      if (!this.playerCache[i]!.botControlled) return false;
    }
    return true;
  }

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

  /** True while the room still has to be fought. Doors stay shut (§2). */
  get inCombat(): boolean {
    return this.enemiesRemaining > 0;
  }

  /** The offer waiting on a slot, or null. */
  offerFor(slot: number): UpgradeOffer | null {
    return this.offers[slot] ?? null;
  }

  /**
   * True while anyone still owes the party a pick.
   *
   * This holds the doors shut. §4.3 asks for choices to be visible to the
   * party — "if the Sorcerer commits to AoE, the Warrior can go Reach to
   * complement" — and that only happens if everyone is looking at the same
   * moment. Letting the party walk on turns four shared decisions into four
   * private ones.
   */
  get offerPending(): boolean {
    for (let i = 0; i < this.offers.length; i++) if (this.offers[i]) return true;
    return false;
  }

  /** Someone is on the floor bleeding out (§8 stage 1). */
  get anyDowned(): boolean {
    for (let i = 0; i < this.playerCache.length; i++) {
      if (this.playerCache[i]!.life === LifeState.Downed) return true;
    }
    return false;
  }

  /** How far a slot is outside the leash, 0 when inside. Render uses it for
   *  the directional arrow (§2). */
  leashOvershoot(slot: number): number {
    const p = this.party[slot]?.player;
    if (!p) return 0;
    const d = Math.hypot(p.x - this.centroidX, p.y - this.centroidY);
    return Math.max(0, d - LEASH.RADIUS);
  }

  setInput(slot: number, state: InputState): void {
    const entry = this.party[slot];
    if (!entry) return;
    if (entry.controller.kind !== 'human') return;
    (entry.controller as HumanController).set(state);
  }

  // --- step ----------------------------------------------------------------

  step(dt: number): void {
    this.events.clear();

    for (let i = 0; i < this.party.length; i++) this.party[i]!.player.snapshot();
    for (let i = 0; i < this.enemies.length; i++) this.enemies[i]!.snapshot();
    for (let i = 0; i < this.projectiles.length; i++) {
      if (this.projectiles[i]!.active) this.projectiles[i]!.snapshot();
    }

    // A transition freezes the room: no input, no fighting, just the wipe.
    if (this.transitionTicks > 0) {
      this.transitionTicks--;
      if (this.transitionTicks === 0 && this.pendingRoom !== -1) {
        const from = this.transitionDirection;
        this.currentRoom = this.pendingRoom;
        this.pendingRoom = -1;
        this.enterRoom(this.currentRoom, from);
      }
      this.tick++;
      return;
    }

    const bounds = this.roomBounds;

    for (let i = 0; i < this.party.length; i++) {
      const slot = this.party[i]!;
      clearInputState(slot.input);
      slot.controller.produceInput(
        slot.player,
        this.playerCache,
        this.enemies,
        bounds,
        slot.input,
      );
    }

    // Offers consume the input of any slot they are holding, before that
    // input can also drive movement or an ability. Constraint #1 still holds:
    // this reads the abstract InputState, never a key.
    this.updateOffers();

    for (let i = 0; i < this.party.length; i++) {
      const slot = this.party[i]!;
      slot.player.step(dt, slot.input, this.abilityContext);
    }

    // Auras before the enemies act, so a hit landing this tick is reduced by
    // the shelter that was standing when it landed.
    this.updateAuras();

    this.collectWraiths();
    for (let i = 0; i < this.enemies.length; i++) {
      this.enemies[i]!.step(dt, this.playerCache, this.wraiths);
    }

    this.stepProjectiles(dt);
    this.resolveRevives();

    for (let i = 0; i < this.playerCache.length; i++) this.playerCache[i]!.stepPhysics(dt);
    for (let i = 0; i < this.enemies.length; i++) this.enemies[i]!.stepPhysics(dt);

    this.bodies.length = 0;
    for (let i = 0; i < this.playerCache.length; i++) this.bodies.push(this.playerCache[i]!);
    for (let i = 0; i < this.enemies.length; i++) this.bodies.push(this.enemies[i]!);
    resolveCollisions(this.bodies, bounds.width, bounds.height);

    this.updateCentroid();
    this.updateLeash(dt);
    this.updateLoot();
    this.updateRoomState();
    this.updateDoors();
    this.updateRunState();

    this.tick++;
  }

  // --- rooms ---------------------------------------------------------------

  /**
   * Enter a room: rebuild its doors, spawn its wave if it has never been
   * cleared, and place the party just inside the door they came through.
   */
  private enterRoom(index: number, cameFrom: Direction | null): void {
    const node = this.floor.rooms[index]!;
    // Record arrival *before* marking visited, so "somewhere never visited"
    // still means somewhere new.
    this.arrivedVia = cameFrom === null ? null : oppositeDirection(cameFrom);
    this.preferredExit = null;
    node.visited = true;

    this.doors.length = 0;
    for (const dir of ALL_DIRECTIONS) {
      const target = node.exits[dir];
      if (target === undefined || target === -1) continue;
      const [dx, dy] = doorCentre(dir, node.template.width, node.template.height);
      this.doors.push({ direction: dir, targetRoom: target, x: dx, y: dy, open: true });
    }

    this.enemies.length = 0;
    this.pickups.length = 0;
    for (let i = 0; i < this.projectiles.length; i++) this.projectiles[i]!.retire();

    if (!node.cleared && node.template.spawnAnchors.length > 0) {
      this.spawnFromAnchors(node);
    }

    this.placeParty(node, cameFrom);
    this.updateCentroid();
    this.updateDoors();
  }

  /**
   * Populate from the template's hand-authored anchors, spending the room's
   * budget. §2 party scaling applies — by party *size*, never living players,
   * per §8's anti-death-spiral rule.
   */
  private spawnFromAnchors(node: RoomNode): void {
    const scale = WAVE.PARTY_SCALING[this.party.length - 1] ?? 1;
    // Mild ramp with depth so the far end of a floor is harder than the door.
    const depthRamp = 1 + node.depth * 0.05;
    let budget = node.template.budget * scale * depthRamp;

    // Shuffle a copy so which anchors are used varies per seed while the
    // anchors themselves stay authored.
    const anchors = this.rng.shuffle(node.template.spawnAnchors.slice());
    const pocket = node.template.safePocket;

    for (let i = 0; i < anchors.length && budget > 0; i++) {
      const anchor = anchors[i]!;
      if (anchor.cost > budget) continue;

      // Belt and braces: authoring should never put an anchor in the pocket,
      // but a template edit that does would make a room unenterable.
      const dx = anchor.x - pocket.x;
      const dy = anchor.y - pocket.y;
      if (dx * dx + dy * dy < pocket.radius * pocket.radius) continue;

      this.enemies.push(new Enemy(this.nextEntityId++, anchor.x, anchor.y));
      budget -= anchor.cost;
    }

    // Anchors are finite; a high-budget room reuses them with a small offset
    // rather than inventing positions the designer never approved.
    let ring = 1;
    while (budget > 0 && anchors.length > 0 && ring < 4) {
      for (let i = 0; i < anchors.length && budget > 0; i++) {
        const anchor = anchors[i]!;
        if (anchor.cost > budget) continue;
        const angle = (i / anchors.length) * Math.PI * 2;
        const x = clamp(anchor.x + Math.cos(angle) * 46 * ring, 60, node.template.width - 60);
        const y = clamp(anchor.y + Math.sin(angle) * 46 * ring, 60, node.template.height - 60);
        const px = x - pocket.x;
        const py = y - pocket.y;
        if (px * px + py * py < pocket.radius * pocket.radius) continue;
        this.enemies.push(new Enemy(this.nextEntityId++, x, y));
        budget -= anchor.cost;
      }
      ring++;
    }
  }

  /** Put the party in the safe pocket, or just inside the door they used. */
  private placeParty(node: RoomNode, cameFrom: Direction | null): void {
    let baseX = node.template.safePocket.x;
    let baseY = node.template.safePocket.y;

    const spread = 58;

    if (cameFrom !== null) {
      // They arrive at the door opposite the one they left through.
      //
      // The offset has to clear the doorway trigger by more than the spread
      // radius, or a party member on the ring lands *inside* the door they
      // just came out of and instantly transitions back. Measured: a dead-end
      // room traded the party back and forth every 22 ticks, forever.
      const entryDir = oppositeDirection(cameFrom);
      const [dx, dy] = doorCentre(entryDir, node.template.width, node.template.height);
      const inward = inwardVector(entryDir);
      const clearance = DOOR.DEPTH + spread + 40;
      baseX = dx + inward[0] * clearance;
      baseY = dy + inward[1] * clearance;
    }

    for (let i = 0; i < this.party.length; i++) {
      const p = this.party[i]!.player;
      const angle = (i / this.party.length) * Math.PI * 2;
      p.x = clamp(baseX + Math.cos(angle) * spread, ROOM.WALL + p.radius, node.template.width - ROOM.WALL - p.radius);
      p.y = clamp(baseY + Math.sin(angle) * spread, ROOM.WALL + p.radius, node.template.height - ROOM.WALL - p.radius);
      p.prevX = p.x;
      p.prevY = p.y;
      p.knockX = 0;
      p.knockY = 0;
      p.target = null;
      this.leashTicks[i] = 0;
    }
  }

  /** §2: doors lock during combat — and while the party is still choosing. */
  private updateDoors(): void {
    const open = !this.inCombat && !this.offerPending;
    let changed = false;
    for (let i = 0; i < this.doors.length; i++) {
      if (this.doors[i]!.open !== open) changed = true;
      this.doors[i]!.open = open;
    }
    if (changed || this.preferredExit === null) this.computePreferredExit();
  }

  /**
   * Breadth-first search for the first step toward somewhere worth going:
   * the nearest unvisited room, or the boss once everything is explored.
   *
   * Deterministic — the frontier is a plain array walked in insertion order
   * and neighbours are visited in fixed direction order, so every peer picks
   * the same door without exchanging anything.
   */
  private computePreferredExit(): void {
    const rooms = this.floor.rooms;
    const cameFrom = new Map<number, { from: number; dir: Direction }>();
    const seen = new Set<number>([this.currentRoom]);
    const frontier: number[] = [this.currentRoom];
    let goal = -1;

    for (let head = 0; head < frontier.length; head++) {
      const at = frontier[head]!;
      if (at !== this.currentRoom && !rooms[at]!.visited) {
        goal = at;
        break;
      }
      for (const dir of ALL_DIRECTIONS) {
        const next = rooms[at]!.exits[dir];
        if (next === undefined || next === -1 || seen.has(next)) continue;
        seen.add(next);
        cameFrom.set(next, { from: at, dir });
        frontier.push(next);
      }
    }

    // Everything explored: head for the boss, unless we are standing in it.
    if (goal === -1 && this.floor.bossIndex !== this.currentRoom) {
      goal = seen.has(this.floor.bossIndex) ? this.floor.bossIndex : -1;
    }

    if (goal === -1) {
      this.preferredExit = null;
      return;
    }

    // Walk the parent chain back to the current room; the last hop is ours.
    let cursor = goal;
    let step = cameFrom.get(cursor);
    while (step && step.from !== this.currentRoom) {
      cursor = step.from;
      step = cameFrom.get(cursor);
    }
    this.preferredExit = step ? step.dir : null;
  }

  private updateRoomState(): void {
    const node = this.room;
    if (node.cleared || this.inCombat) {
      this.checkDoorEntry();
      return;
    }

    // Room cleared this tick.
    node.cleared = true;
    this.roomsCleared++;
    this.payOutRoom(node);
    this.offersOwed += UPGRADE.PER_COMBAT_ROOM;
    if (node.kind === RoomKind.Boss) this.floorComplete = true;
  }

  /**
   * §2's room-clear reward, and what replaced `WAVE.CLEAR_HEAL`.
   *
   * The scaffolding healed the party a flat 35% the instant a room fell,
   * because nothing in the game could heal and continuous waves guaranteed an
   * attrition wipe regardless of play. Hearts are the real thing: they land on
   * the floor, somebody has to walk to them, and whoever is hurt gets them
   * (§7.3 — a heart is not consumed by a player at full health).
   */
  private payOutRoom(node: RoomNode): void {
    const cx = node.template.width / 2;
    const cy = node.template.height / 2;

    for (let i = 0; i < PICKUP.CLEAR_HEARTS; i++) {
      const angle = this.lootRng.range(0, Math.PI * 2);
      const dist = this.lootRng.range(PICKUP.CLEAR_SCATTER * 0.35, PICKUP.CLEAR_SCATTER);
      this.spawnPickup(
        PickupKind.Heart,
        clamp(cx + Math.cos(angle) * dist, ROOM.WALL + 30, node.template.width - ROOM.WALL - 30),
        clamp(cy + Math.sin(angle) * dist, ROOM.WALL + 30, node.template.height - ROOM.WALL - 30),
      );
    }
  }

  /**
   * Any living player standing in an open doorway moves the whole party.
   *
   * Moving everyone rather than just the one who touched it is deliberate:
   * the leash already keeps the party together, and splitting them across
   * rooms would need the split-screen that §2 explicitly `[CUT]`.
   */
  private checkDoorEntry(): void {
    if (this.transitionTicks > 0) return;
    const botsLead = this.botsLead;

    for (let d = 0; d < this.doors.length; d++) {
      const door = this.doors[d]!;
      if (!door.open) continue;

      for (let i = 0; i < this.party.length; i++) {
        const p = this.party[i]!.player;
        if (p.life === LifeState.Wraith) continue;
        // A bot never leads the party through a door while a human is in it.
        // §2 locks doors so nobody gets dragged ahead; a bot triggering the
        // transition would do exactly that from the other direction.
        if (p.botControlled && !botsLead) continue;
        if (!inDoorway(p.x, p.y, door, this.roomWidth, this.roomHeight)) continue;

        this.transitionTicks = TRANSITION_TICKS;
        this.transitionDirection = door.direction;
        this.pendingRoom = door.targetRoom;
        return;
      }
    }
  }

  // --- leash ---------------------------------------------------------------

  private updateCentroid(): void {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let i = 0; i < this.playerCache.length; i++) {
      const p = this.playerCache[i]!;
      // Wraiths do not anchor the camera — a dead player drifting the room
      // would drag the frame away from the fight.
      if (p.life === LifeState.Wraith) continue;
      sx += p.x;
      sy += p.y;
      n++;
    }
    if (n === 0) {
      this.centroidX = this.roomWidth / 2;
      this.centroidY = this.roomHeight / 2;
      return;
    }
    this.centroidX = sx / n;
    this.centroidY = sy / n;
  }

  /**
   * Soft leash (§2): light damage-over-time while outside the radius.
   *
   * Damage is applied in whole points on an interval rather than as a
   * fractional amount every tick, because accumulating `rate * dt` into HP
   * sixty times a second is exactly the float drift constraint #3 warns about.
   */
  private updateLeash(_dt: number): void {
    const tickInterval = Math.round(SIM.TICK_RATE / LEASH.DAMAGE_PER_SECOND);

    for (let i = 0; i < this.party.length; i++) {
      const p = this.party[i]!.player;
      if (p.life !== LifeState.Alive) {
        this.leashTicks[i] = 0;
        continue;
      }

      const dx = p.x - this.centroidX;
      const dy = p.y - this.centroidY;
      if (dx * dx + dy * dy <= LEASH.RADIUS * LEASH.RADIUS) {
        this.leashTicks[i] = 0;
        continue;
      }

      const ticks = (this.leashTicks[i] ?? 0) + 1;
      this.leashTicks[i] = ticks;
      if (ticks <= LEASH_GRACE_TICKS) continue;
      if ((ticks - LEASH_GRACE_TICKS) % tickInterval !== 0) continue;

      p.takeDamage(1, this.centroidX, this.centroidY);
      this.events.emit(EventKind.Hit, p.x, p.y, { amount: 0, slot: p.slot });
    }
  }

  // --- §4 upgrades ---------------------------------------------------------

  /**
   * Deal and resolve offers.
   *
   * Runs after controllers have written their input and before players step,
   * so a slot holding an offer can consume its own input. Movement is the
   * highlight and the context action is the commit — no fifth binding, which
   * is constraint #2 holding even for a menu.
   */
  private updateOffers(): void {
    if (this.offerPending) {
      this.resolveOffers();
      return;
    }

    // Deal only once the room is genuinely settled. Dealing mid-fight would
    // hand out a build decision during a swarm; dealing over a downed ally
    // would put the choice and the 3s revive channel on the same button.
    if (this.offersOwed <= 0) return;
    if (this.inCombat || this.transitionTicks > 0 || this.anyDowned) return;

    this.dealOffers();
  }

  private dealOffers(): void {
    let dealt = false;

    for (let i = 0; i < this.party.length; i++) {
      const player = this.party[i]!.player;
      // A Wraith is out of the run (§8 stage 2) — offering them a build
      // decision they can never spend is worse than offering nothing.
      if (player.life === LifeState.Wraith) continue;

      const offer = rollOffer(
        player.def.id,
        player.stacks,
        this.offerRng[i]!,
        this.lastOfferAxis[i] ?? -1,
      );
      if (!offer) continue;

      this.offers[i] = offer;
      this.lastOfferAxis[i] = offer.axisIndex;
      dealt = true;
    }

    // Consume the debt either way. A party with every direction capped would
    // otherwise re-roll nothing on every tick for the rest of the run.
    this.offersOwed--;
    if (!dealt) return;
  }

  private resolveOffers(): void {
    for (let i = 0; i < this.party.length; i++) {
      const offer = this.offers[i];
      if (!offer) continue;

      const slot = this.party[i]!;
      offer.age++;

      let commit = false;

      if (slot.controller.kind === 'bot') {
        // A short pause, then a decision — so a party of bots reads as
        // choosing rather than teleporting through the screen.
        if (offer.age >= UPGRADE.BOT_DECISION_TICKS) {
          const pick = slot.controller.chooseUpgrade?.(slot.player, offer.a, offer.b) ?? 0;
          offer.highlight = pick === 1 ? 1 : 0;
          commit = true;
        }
      } else {
        const x = slot.input.moveVector.x;
        if (x <= -HIGHLIGHT_THRESHOLD) offer.highlight = 0;
        else if (x >= HIGHLIGHT_THRESHOLD) offer.highlight = 1;
        if (slot.input.contextAction.pressed) commit = true;
      }

      // The anti-stall net. See UPGRADE.AUTO_CONFIRM_SECONDS — the offer holds
      // the doors, so it cannot be allowed to hold them forever.
      if (offer.age >= AUTO_CONFIRM_TICKS) commit = true;

      // Whatever the offer did with this slot's input, the player does not
      // also get to act on it. Otherwise confirming a pick would fire an
      // ability, and walking the highlight would walk the body.
      clearInputState(slot.input);

      if (!commit) continue;

      const index = offer.highlight === 1 ? offer.b : offer.a;
      const before = tierSnapshot(slot.player);
      slot.player.applyUpgrade(index);
      this.offers[i] = null;
      this.upgradesTaken++;

      this.events.emit(EventKind.Upgrade, slot.player.x, slot.player.y, {
        slot: slot.player.slot,
        amount: index,
      });

      // §4.1's breakpoints are the moment worth announcing — a *new
      // behaviour*, not a bigger number. Reported as an event so the renderer
      // can sell it without the simulation knowing what a screen is.
      const after = tierSnapshot(slot.player);
      if (after !== before) {
        this.events.emit(EventKind.Breakpoint, slot.player.x, slot.player.y, {
          slot: slot.player.slot,
        });
      }
    }
  }

  /**
   * §4 Aegis: allies inside a sheltering player's radius take less damage.
   *
   * Computed here rather than inside `takeDamage` because damage arrives from
   * three call sites and none of them holds the party list. The strongest
   * shelter wins rather than stacking — four Aegis builds multiplying together
   * would round incoming damage to nothing, and §9.2 warns about exactly this:
   * any per-player effect is a ×4 party swing.
   */
  private updateAuras(): void {
    for (let i = 0; i < this.playerCache.length; i++) {
      const target = this.playerCache[i]!;
      let best = 1;

      for (let j = 0; j < this.playerCache.length; j++) {
        const source = this.playerCache[j]!;
        if (source.life !== LifeState.Alive) continue;
        const tier = tierOf(source.stats, Transformation.Aegis);
        if (tier === 0) continue;

        // Tier 2 shelters its holder too; tier 1 protects the people standing
        // with you, which is what makes it a positioning upgrade rather than
        // a personal one (§9.2: "change positioning, not numbers").
        if (source.id === target.id && tier < 2) continue;

        const radius = UPGRADE.AEGIS_RADIUS[tier - 1] ?? 0;
        const dx = source.x - target.x;
        const dy = source.y - target.y;
        if (dx * dx + dy * dy > radius * radius) continue;

        const factor = 1 - (UPGRADE.AEGIS_REDUCTION[tier - 1] ?? 0);
        if (factor < best) best = factor;
      }

      target.auraDamageFactor = best;
    }
  }

  // --- pickups (§7.2) -------------------------------------------------------

  private spawnPickup(kind: PickupKind, x: number, y: number): void {
    // Bounded: a room that dropped hearts without limit would eventually cost
    // more to draw than the fight did (constraint #4).
    if (this.pickups.length >= 24) return;
    this.pickups.push(new Pickup(this.nextEntityId++, kind, x, y));
  }

  /**
   * Roll corpse drops, then hand out anything a player is standing on.
   *
   * Free-for-all, touch pickup — §7.2 puts hearts in the tier where "ceremony
   * here is pure friction". No hold-to-take and no claim window; those exist
   * for the tiers where an argument is actually possible.
   */
  private updateLoot(): void {
    for (let i = 0; i < this.enemies.length; i++) {
      const enemy = this.enemies[i]!;
      if (enemy.alive || enemy.looted) continue;
      enemy.looted = true;
      if (this.lootRng.chance(PICKUP.DROP_CHANCE)) {
        this.spawnPickup(PickupKind.Heart, enemy.x, enemy.y);
      }
    }

    for (let i = 0; i < this.pickups.length; i++) {
      const pickup = this.pickups[i]!;
      if (pickup.taken) continue;

      for (let j = 0; j < this.playerCache.length; j++) {
        const p = this.playerCache[j]!;
        if (p.life !== LifeState.Alive) continue;

        const dx = p.x - pickup.x;
        const dy = p.y - pickup.y;
        const reach = PICKUP.REACH + p.radius;
        if (dx * dx + dy * dy > reach * reach) continue;

        // §7.3: most co-op loot resentment is accidental pickup in a crowded
        // room — a UX defect, not a design tradeoff. A player at full health
        // walks over the heart and leaves it for whoever needs it.
        if (p.maxHp - p.hp < PICKUP.MIN_MISSING_HP) continue;

        const healed = p.heal(p.maxHp * PICKUP.HEART_HEAL);
        if (healed <= 0) continue;

        pickup.taken = true;
        pickup.takenBy = p.slot;
        this.events.emit(EventKind.Pickup, pickup.x, pickup.y, {
          slot: p.slot,
          amount: healed,
        });
        break;
      }
    }
  }

  // --- projectiles / revives / run state ------------------------------------

  private stepProjectiles(dt: number): void {
    for (let i = 0; i < this.projectiles.length; i++) {
      const shot = this.projectiles[i]!;
      if (!shot.active) continue;

      if (!shot.advance(dt, this.room.template.width, this.room.template.height)) {
        shot.retire();
        continue;
      }

      for (let j = 0; j < this.enemies.length; j++) {
        const enemy = this.enemies[j]!;
        if (!enemy.alive || shot.hasHit(enemy.id)) continue;

        const dx = enemy.x - shot.x;
        const dy = enemy.y - shot.y;
        const reach = enemy.radius + shot.radius;
        if (dx * dx + dy * dy > reach * reach) continue;

        const dist = Math.hypot(dx, dy);
        const nx = dist > 0 ? dx / dist : 1;
        const ny = dist > 0 ? dy / dist : 0;

        const wasAlive = enemy.alive;
        enemy.damage(shot.damage_);
        enemy.applyKnockback(nx, ny, shot.knockback);
        enemy.stagger(COMBAT.HIT_STAGGER_TICKS);

        const killed = wasAlive && !enemy.alive;
        this.events.emit(killed ? EventKind.Kill : EventKind.Hit, enemy.x, enemy.y, {
          amount: shot.damage_,
          dirX: nx,
          dirY: ny,
          slot: shot.ownerSlot,
        });

        const owner = this.party[shot.ownerSlot];
        if (owner) {
          owner.player.landedHit();
          if (killed) owner.player.onKill(enemy.x, enemy.y, this.abilityContext);
        }

        if (!shot.piercing) {
          shot.retire();
          break;
        }

        shot.hitIds.push(enemy.id);
        // §4 Pierce is bounded: each body behind the first costs the shot some
        // damage, and once the allowance is spent the shot stops. Charged Shot
        // keeps its unlimited pierce by leaving the limit at -1.
        shot.damage_ *= shot.pierceFalloff;
        if (shot.pierceLimit >= 0 && shot.hitIds.length > shot.pierceLimit) {
          shot.retire();
          break;
        }
      }
    }
  }

  private buildAbilityContext(): AbilityContext {
    return {
      enemies: this.enemies,
      allies: this.playerCache,
      events: this.events,
      spawnProjectile: (x, y, dirX, dirY, speed, damage, ownerSlot, opts) => {
        for (let i = 0; i < this.projectiles.length; i++) {
          const shot = this.projectiles[i]!;
          if (shot.active) continue;
          shot.launch(x, y, dirX, dirY, speed, damage, ownerSlot, opts ?? {});
          return true;
        }
        return false;
      },
    };
  }

  private collectWraiths(): void {
    this.wraiths.length = 0;
    for (let i = 0; i < this.playerCache.length; i++) {
      const p = this.playerCache[i]!;
      if (p.life === LifeState.Wraith) this.wraiths.push(p);
    }
  }

  private resolveRevives(): void {
    for (let i = 0; i < this.party.length; i++) {
      const downed = this.party[i]!.player;
      if (downed.life !== LifeState.Downed) continue;

      let channelling = false;
      for (let j = 0; j < this.party.length; j++) {
        if (i === j) continue;
        const ally = this.party[j]!;
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

  private updateRunState(): void {
    if (this.runOver) return;
    for (let i = 0; i < this.playerCache.length; i++) {
      if (this.playerCache[i]!.life !== LifeState.Wraith) return;
    }
    this.runOver = true;
  }

  // --- checksum ------------------------------------------------------------

  checksum(): string {
    const h = new Hasher();
    h.int(this.tick)
      .int(this.rng.getState())
      .int(this.lootRng.getState())
      .int(this.currentRoom)
      .int(this.transitionTicks)
      .int(this.pendingRoom)
      .int(this.roomsCleared)
      .int(this.arrivedVia ?? -1)
      .int(this.offersOwed)
      .int(this.upgradesTaken)
      .bool(this.runOver)
      .bool(this.floorComplete);

    // Visited flags steer bot navigation, so they decide future inputs.
    for (let i = 0; i < this.floor.rooms.length; i++) {
      h.bool(this.floor.rooms[i]!.visited);
    }

    // Room clear flags decide whether re-entering spawns a wave.
    for (let i = 0; i < this.floor.rooms.length; i++) {
      h.bool(this.floor.rooms[i]!.cleared);
    }

    for (let i = 0; i < this.party.length; i++) {
      const slot = this.party[i]!;
      slot.player.writeChecksum(h);
      slot.controller.writeChecksum?.(h);
      h.int(this.leashTicks[i] ?? 0);

      // A live offer holds the doors shut and decides the next pick, and the
      // offer stream decides which axis is drawn next. Both steer future
      // behaviour, so both belong here.
      const offer = this.offers[i];
      h.int(this.offerRng[i]?.getState() ?? 0)
        .int(this.lastOfferAxis[i] ?? -1)
        .int(offer ? offer.axisIndex : -1)
        .int(offer ? offer.highlight : -1)
        .int(offer ? offer.age : -1);
    }
    for (let i = 0; i < this.enemies.length; i++) this.enemies[i]!.writeChecksum(h);
    for (let i = 0; i < this.projectiles.length; i++) this.projectiles[i]!.writeChecksum(h);
    for (let i = 0; i < this.pickups.length; i++) this.pickups[i]!.writeChecksum(h);
    return h.value;
  }
}

// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** A comparable summary of which §4 transformations a player holds, so a pick
 *  that crossed a breakpoint can be told from one that only moved a number. */
function tierSnapshot(player: Player): string {
  return player.stats.tiers.join(',');
}

/** Centre of the opening on a given wall. */
function doorCentre(dir: Direction, width: number, height: number): [number, number] {
  switch (dir) {
    case Direction.North:
      return [width / 2, 0];
    case Direction.East:
      return [width, height / 2];
    case Direction.South:
      return [width / 2, height];
    default:
      return [0, height / 2];
  }
}

/** Unit vector pointing into the room from a wall. */
function inwardVector(dir: Direction): [number, number] {
  switch (dir) {
    case Direction.North:
      return [0, 1];
    case Direction.East:
      return [-1, 0];
    case Direction.South:
      return [0, -1];
    default:
      return [1, 0];
  }
}

function inDoorway(
  x: number,
  y: number,
  door: DoorInstance,
  width: number,
  height: number,
): boolean {
  const half = DOOR.WIDTH / 2;
  switch (door.direction) {
    case Direction.North:
      return Math.abs(x - door.x) <= half && y <= DOOR.DEPTH;
    case Direction.South:
      return Math.abs(x - door.x) <= half && y >= height - DOOR.DEPTH;
    case Direction.East:
      return Math.abs(y - door.y) <= half && x >= width - DOOR.DEPTH;
    default:
      return Math.abs(y - door.y) <= half && x <= DOOR.DEPTH;
  }
}
