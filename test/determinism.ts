/**
 * Determinism harness.
 *
 * Constraint #3 is the one that fails silently. Nothing breaks the day it is
 * violated — the game keeps running, and months later peers desync with no
 * way to tell which commit did it. These checks fail loudly on the commit
 * that does it.
 *
 * The simulation imports no Phaser and touches no DOM, so this runs headless.
 * That is not an accident of the layout; it is the reason for it.
 */

import { Hasher } from '../src/core/checksum';
import {
  DEATH,
  ENEMY,
  LEASH,
  PARTY_SIZE,
  PLAYER,
  ROOM,
  SIM,
  UPGRADE,
} from '../src/core/constants';
import { FixedLoop } from '../src/core/fixed-loop';
import { Rng } from '../src/core/rng';
import { CLASS_ORDER, ClassId, getClass } from '../src/game/classes';
import { Enemy } from '../src/game/entities/enemy';
import { Pickup, PickupKind } from '../src/game/entities/pickup';
import { EventKind } from '../src/game/events';
import { LifeState, lifeStateName } from '../src/game/life-state';
import {
  allDirections,
  axesFor,
  deriveStats,
  directionsFor,
  tierOf,
} from '../src/game/upgrades';
import { World } from '../src/game/world';
import type { InputState } from '../src/input/input-state';
import { clampToUnit, makeInputState } from '../src/input/input-state';

/** Minimal ambient declaration — avoids pulling in @types/node for one field. */
declare const process: { exitCode?: number } | undefined;

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Scripted input — a recorded player.
//
// This is deliberately the same shape a lockstep input log takes: one
// InputState per tick, indexed by tick. Replaying a run means replaying this
// array against a seed.
// ---------------------------------------------------------------------------

export function makeInputScript(seed: string, ticks: number): InputState[] {
  const rng = new Rng(seed);
  const script: InputState[] = [];

  let moveX = 0;
  let moveY = 0;
  let overrideX = 1;
  let overrideY = 0;

  for (let t = 0; t < ticks; t++) {
    // Change direction occasionally rather than every tick, so the player
    // actually traverses the room instead of vibrating in place.
    if (t % 20 === 0) {
      const angle = rng.range(0, Math.PI * 2);
      moveX = Math.cos(angle);
      moveY = Math.sin(angle);
    }
    if (t % 97 === 0) {
      const angle = rng.range(0, Math.PI * 2);
      overrideX = Math.cos(angle);
      overrideY = Math.sin(angle);
    }

    const state = makeInputState();
    state.moveVector.x = moveX;
    state.moveVector.y = moveY;
    clampToUnit(state.moveVector);

    // Override on for stretches, off for others — exercises both the manual
    // pick and the decay back to auto-target.
    const overrideOn = Math.floor(t / 97) % 2 === 1;
    state.targetOverride.active = overrideOn;
    state.targetOverride.direction.x = overrideX;
    state.targetOverride.direction.y = overrideY;

    script.push(state);
  }

  return script;
}

const NEUTRAL = makeInputState();

/**
 * Reads `life` through a call so TypeScript's control-flow narrowing resets.
 * Stepping the world mutates the field, but the compiler cannot see that
 * through a method call and would otherwise "prove" later comparisons dead.
 */
function lifeOf(p: { life: LifeState }): LifeState {
  return p.life;
}

/**
 * Clear the room for a focused mechanic check. Without this, a rescuer who
 * stands still for a 3s channel is beaten down mid-channel and the check
 * fails for a reason that has nothing to do with what it is testing.
 *
 * Call before every step — waves respawn on their own.
 */
function suppressEnemies(world: World): void {
  for (const enemy of world.enemies) {
    enemy.hp = 0;
    enemy.alive = false;
  }
}

/**
 * Walk the party out of the enemy-free entry room into the first real fight.
 *
 * Floors start in an entry room with no spawns (Act I teaches), so any check
 * about combat, collision or abilities has to get out of it first or it
 * measures an empty room. Drives slot 0 at the open door like a player would.
 */
function advanceToCombat(world: World, maxTicks = 1200): boolean {
  const input = makeInputState();
  for (let t = 0; t < maxTicks; t++) {
    input.moveVector.x = 0;
    input.moveVector.y = 0;
    const exit = world.roomBounds.exit;
    if (exit) {
      const dx = exit.x - world.localPlayer.x;
      const dy = exit.y - world.localPlayer.y;
      const d = Math.hypot(dx, dy) || 1;
      input.moveVector.x = dx / d;
      input.moveVector.y = dy / d;
    }
    world.setInput(0, input);
    world.step(SIM.STEP_SECONDS);
    if (world.enemiesRemaining > 0) return true;
  }
  return false;
}

/** Step a world straight through a script, one tick per entry. The three bot
 *  slots drive themselves inside the step. */
function runDirect(seed: string, script: readonly InputState[], humanSlots = 1): World {
  const world = new World(seed, humanSlots);
  advanceToCombat(world);
  for (let t = 0; t < script.length; t++) {
    world.setInput(0, script[t] ?? NEUTRAL);
    world.step(SIM.STEP_SECONDS);
  }
  return world;
}

/**
 * Step a world through the real FixedLoop, fed an irregular stream of frame
 * deltas — the thing an actual browser hands you.
 */
function runThroughLoop(
  seed: string,
  script: readonly InputState[],
  frameDeltas: readonly number[],
): World {
  const world = new World(seed);
  // Same head start the direct runner takes, so both compare like for like.
  // Without this the reference had walked to a combat room and this one had
  // not, and the tick counts could never match.
  advanceToCombat(world);
  const start = world.tick;

  const loop = new FixedLoop();
  const targetTicks = start + script.length;

  let frame = 0;
  // Bounded so a bug in the loop can't hang the harness.
  const maxFrames = script.length * 10 + 1000;

  while (world.tick < targetTicks && frame < maxFrames) {
    const delta = frameDeltas[frame % frameDeltas.length]!;
    // Use the dt the loop hands us rather than assuming SIM.STEP_SECONDS —
    // otherwise a loop that started leaking real frame time into dt would
    // sail straight through this check.
    loop.advance(delta, (dt) => {
      if (world.tick >= targetTicks) return; // ignore overshoot past the target
      world.setInput(0, script[world.tick - start] ?? NEUTRAL);
      world.step(dt);
    });
    frame++;
  }

  return world;
}

/** Step a run, evaluating `probe` after every tick. Checking only the final
 *  state misses anything transient — a pile that forms and clears, a body
 *  shoved through a wall and pushed back. */
function runWithProbe(
  seed: string,
  script: readonly InputState[],
  probe: (world: World) => void,
): World {
  const world = new World(seed);
  advanceToCombat(world);
  for (let t = 0; t < script.length; t++) {
    world.setInput(0, script[t] ?? NEUTRAL);
    world.step(SIM.STEP_SECONDS);
    probe(world);
  }
  return world;
}

/** Full per-tick trace, not just the end state — catches divergence that
 *  happens to converge again by the last tick. */
function traceChecksums(seed: string, script: readonly InputState[]): string[] {
  const world = new World(seed);
  const trace: string[] = [];
  for (let t = 0; t < script.length; t++) {
    world.setInput(0, script[t] ?? NEUTRAL);
    world.step(SIM.STEP_SECONDS);
    trace.push(world.checksum());
  }
  return trace;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const TICKS = 1800; // 30 seconds of simulation at 60 Hz

export function checkRepeatability(): CheckResult {
  const script = makeInputScript('script-a', TICKS);
  const a = traceChecksums('run-seed', script);
  const b = traceChecksums('run-seed', script);

  for (let t = 0; t < a.length; t++) {
    if (a[t] !== b[t]) {
      return {
        name: 'same seed + same inputs → identical state',
        pass: false,
        detail: `diverged at tick ${t}: ${a[t]} vs ${b[t]}`,
      };
    }
  }
  return {
    name: 'same seed + same inputs → identical state',
    pass: true,
    detail: `${a.length} ticks identical, final ${a[a.length - 1]}`,
  };
}

export function checkFramerateIndependence(): CheckResult {
  const script = makeInputScript('script-b', TICKS);
  const reference = runDirect('run-seed', script);

  // A steady 60 fps, a steady 144 fps, a stuttering machine, and a machine
  // slower than the sim rate. All must land on the same state.
  const patterns: Array<{ label: string; deltas: number[] }> = [
    { label: '60fps', deltas: [1000 / 60] },
    { label: '144fps', deltas: [1000 / 144] },
    { label: '30fps', deltas: [1000 / 30] },
    { label: 'stutter', deltas: [8, 33.3, 4, 51, 16.7, 120, 2] },
  ];

  for (const pattern of patterns) {
    const world = runThroughLoop('run-seed', script, pattern.deltas);
    if (world.tick !== reference.tick) {
      return {
        name: 'render framerate does not affect simulation',
        pass: false,
        detail: `${pattern.label} ran ${world.tick} ticks, expected ${reference.tick}`,
      };
    }
    if (world.checksum() !== reference.checksum()) {
      return {
        name: 'render framerate does not affect simulation',
        pass: false,
        detail: `${pattern.label} → ${world.checksum()}, expected ${reference.checksum()}`,
      };
    }
  }

  return {
    name: 'render framerate does not affect simulation',
    pass: true,
    detail: `4 frame patterns agree on ${reference.checksum()} after ${reference.tick} ticks`,
  };
}

export function checkSeedMatters(): CheckResult {
  const script = makeInputScript('script-c', 300);
  const a = runDirect('seed-one', script).checksum();
  const b = runDirect('seed-two', script).checksum();
  return {
    name: 'different seed → different run',
    pass: a !== b,
    detail: a !== b ? `${a} ≠ ${b}` : `both seeds produced ${a} — seeding is not wired through`,
  };
}

export function checkNoMathRandom(): CheckResult {
  const script = makeInputScript('script-d', 600);
  const original = Math.random;
  let leaked = false;

  Math.random = () => {
    leaked = true;
    return 0.5;
  };

  try {
    runDirect('run-seed', script);
  } finally {
    Math.random = original;
  }

  return {
    name: 'simulation never calls Math.random',
    pass: !leaked,
    detail: leaked
      ? 'Math.random was called during a sim run — constraint #3 is broken'
      : `${script.length} ticks with Math.random trapped, never hit`,
  };
}

export function checkRngContract(): CheckResult {
  const a = new Rng('abc');
  const b = new Rng('abc');
  for (let i = 0; i < 1000; i++) {
    if (a.next() !== b.next()) {
      return { name: 'PRNG contract', pass: false, detail: `sequences differ at roll ${i}` };
    }
  }

  // State round-trip: this is what a mid-run save or a rollback restore does.
  const rng = new Rng('xyz');
  for (let i = 0; i < 50; i++) rng.next();
  const saved = rng.getState();
  const expected = [rng.next(), rng.next(), rng.next()];
  rng.setState(saved);
  const replayed = [rng.next(), rng.next(), rng.next()];
  for (let i = 0; i < 3; i++) {
    if (expected[i] !== replayed[i]) {
      return { name: 'PRNG contract', pass: false, detail: 'setState did not restore the stream' };
    }
  }

  // Forks must not alias the parent.
  const parent = new Rng('fork-test');
  const childA = parent.fork();
  const childB = parent.fork();
  if (childA.getState() === childB.getState()) {
    return { name: 'PRNG contract', pass: false, detail: 'fork() returned two identical streams' };
  }

  // Range bounds.
  const bounded = new Rng('bounds');
  for (let i = 0; i < 10000; i++) {
    const v = bounded.int(3, 7);
    if (v < 3 || v > 7 || !Number.isInteger(v)) {
      return { name: 'PRNG contract', pass: false, detail: `int(3,7) produced ${v}` };
    }
  }

  return {
    name: 'PRNG contract',
    pass: true,
    detail: 'reproducible, state round-trips, forks diverge, bounds hold',
  };
}

export function checkChecksumSensitivity(): CheckResult {
  // A checksum that ignores fields is worse than none — it reports agreement
  // while peers diverge. Nudge one float by one ULP and it must notice.
  const script = makeInputScript('script-e', 200);
  const world = runDirect('run-seed', script);
  const before = world.checksum();

  world.localPlayer.x = nextAfter(world.localPlayer.x);
  const afterPosition = world.checksum();

  const restored = runDirect('run-seed', script);
  restored.rng.setState(restored.rng.getState() + 1);
  const afterRng = restored.checksum();

  const positionCaught = before !== afterPosition;
  const rngCaught = before !== afterRng;

  return {
    name: 'checksum detects one-ULP drift',
    pass: positionCaught && rngCaught,
    detail:
      positionCaught && rngCaught
        ? 'position and RNG state both change the hash'
        : `position caught: ${positionCaught}, rng caught: ${rngCaught}`,
  };
}

export function checkHasherStability(): CheckResult {
  // Same inputs, same digest — and order must matter.
  const a = new Hasher().int(1).float(2.5).bool(true).value;
  const b = new Hasher().int(1).float(2.5).bool(true).value;
  const c = new Hasher().float(2.5).int(1).bool(true).value;
  return {
    name: 'hasher is stable and order-sensitive',
    pass: a === b && a !== c,
    detail: a === b && a !== c ? `${a} stable, reordering yields ${c}` : `a=${a} b=${b} c=${c}`,
  };
}

export function checkBotDeterminism(): CheckResult {
  // Bots are simulation code now. If a bot decision depended on wall time,
  // Math.random, or iteration order, this is where it shows.
  const script = makeInputScript('script-f', TICKS);
  const a = runDirect('bot-seed', script);
  const b = runDirect('bot-seed', script);

  if (a.checksum() !== b.checksum()) {
    return {
      name: 'bot party replays identically',
      pass: false,
      detail: `${a.checksum()} vs ${b.checksum()} after ${TICKS} ticks`,
    };
  }

  // And the bots must actually have done something — a party of statues
  // would pass every determinism check ever written. Measured against the
  // room's safe pocket, which is where the party is placed on entry.
  const pocket = a.room.template.safePocket;
  let moved = 0;
  for (let i = 1; i < a.party.length; i++) {
    const player = a.party[i]!.player;
    const spawnDrift = Math.hypot(player.x - pocket.x, player.y - pocket.y);
    if (spawnDrift > PLAYER.RADIUS * 7) moved++;
  }

  return {
    name: 'bot party replays identically',
    pass: moved > 0,
    detail:
      moved > 0
        ? `3 bots, ${TICKS} ticks, identical ${a.checksum()} (${moved} left the spawn ring)`
        : 'checksums match but no bot moved — the check is vacuous',
  };
}

export function checkBotsDoNotDesyncOnFramerate(): CheckResult {
  const script = makeInputScript('script-g', 900);
  const reference = runDirect('bot-seed', script);
  const stuttered = runThroughLoop('bot-seed', script, [8, 33.3, 4, 51, 16.7, 120, 2]);

  return {
    name: 'bot decisions are framerate-independent',
    pass: reference.checksum() === stuttered.checksum(),
    detail:
      reference.checksum() === stuttered.checksum()
        ? `steady and stuttering frames agree on ${reference.checksum()}`
        : `${reference.checksum()} vs ${stuttered.checksum()}`,
  };
}

export function checkBotsFightAndSeparate(): CheckResult {
  // Behavioural, not determinism: bots that pile onto one pixel make §13's
  // readability question unanswerable, and bots that never engage make the
  // dummy irrelevant. Both are silent failures without a check.
  const script = makeInputScript('script-h', 1200);
  const world = runDirect('bot-seed', script);

  let minPairDistance = Infinity;
  const players = world.players.filter((p) => p.life !== LifeState.Wraith);
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      minPairDistance = Math.min(minPairDistance, Math.hypot(
        players[i]!.x - players[j]!.x,
        players[i]!.y - players[j]!.y,
      ));
    }
  }

  // Waves respawn, so "did they fight" means kills happened, not "is the
  // room empty right now".
  const engaged = world.roomsCleared > 0 || world.enemiesRemaining < world.enemies.length;

  // Collision keeps bodies from overlapping; steering keeps them from piling.
  const separated = minPairDistance >= PLAYER.RADIUS * 2 - 1;

  return {
    name: 'bots engage and stay separated',
    pass: separated && engaged,
    detail:
      separated && engaged
        ? `closest pair ${minPairDistance.toFixed(0)}u apart, ${world.roomsCleared} waves cleared`
        : `separated: ${separated} (closest ${minPairDistance.toFixed(0)}u), engaged: ${engaged}`,
  };
}

export function checkCollisionSeparatesBodies(): CheckResult {
  // Collision is what stops twenty enemies occupying one pixel. Without it
  // Pillar 3 is unreachable no matter how good the art is.
  const script = makeInputScript('script-i', 900);

  let worstOverlap = 0;
  let worstPair = '';
  let peakBodies = 0;

  // Sampled every tick. The final tick is often a cleared room, which would
  // make this check pass by having nothing to measure.
  runWithProbe('combat-seed', script, (world) => {
    const bodies = [
      ...world.players.filter((p) => p.life !== LifeState.Wraith),
      ...world.enemies.filter((e) => e.alive),
    ];
    peakBodies = Math.max(peakBodies, bodies.length);

    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i]!;
        const b = bodies[j]!;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const overlap = a.radius + b.radius - dist;
        if (overlap > worstOverlap) {
          worstOverlap = overlap;
          worstPair = `#${a.id}/#${b.id}`;
        }
      }
    }
  });

  // Positional relaxation leaves a little residual overlap by design — it is
  // soft on purpose so bodies settle instead of jittering. A few units is
  // healthy; half a body is not.
  const tolerance = ENEMY.RADIUS * 0.6;

  return {
    name: 'collision keeps bodies apart',
    pass: worstOverlap <= tolerance && peakBodies > PARTY_SIZE,
    detail:
      worstOverlap <= tolerance && peakBodies > PARTY_SIZE
        ? `peak ${peakBodies} bodies over 900 ticks, worst overlap ${worstOverlap.toFixed(1)}u (tolerance ${tolerance.toFixed(1)}u)`
        : `peak ${peakBodies} bodies; ${worstPair} overlap ${worstOverlap.toFixed(1)}u vs tolerance ${tolerance.toFixed(1)}u`,
  };
}

export function checkNothingEscapesTheRoom(): CheckResult {
  const script = makeInputScript('script-j', 900);
  let escapee = '';
  let checked = 0;

  // Every tick: collision resolution runs after movement, so a body squeezed
  // between a wall and a crowd is exactly the case that could pop through.
  runWithProbe('combat-seed', script, (world) => {
    if (escapee) return;
    const bodies = [...world.players, ...world.enemies];
    for (const b of bodies) {
      checked++;
      const minX = ROOM.WALL + b.radius;
      const maxX = world.roomWidth - ROOM.WALL - b.radius;
      const minY = ROOM.WALL + b.radius;
      const maxY = world.roomHeight - ROOM.WALL - b.radius;
      if (b.x < minX - 0.001 || b.x > maxX + 0.001 || b.y < minY - 0.001 || b.y > maxY + 0.001) {
        escapee = `entity #${b.id} at ${b.x.toFixed(1)},${b.y.toFixed(1)} on tick ${world.tick}`;
        return;
      }
    }
  });

  return {
    name: 'no body escapes the room',
    pass: escapee === '',
    detail: escapee === '' ? `${checked} body-ticks all inside the walls` : escapee,
  };
}

export function checkDeathSystem(): CheckResult {
  // §8 stage 1 → stage 2, driven directly rather than waiting for combat to
  // produce it: the transitions must be exercised, not hoped for.
  // All slots human and fed nothing. Bots would rescue the victim — correctly,
  // as the bot-revive check below proves — which would make this check
  // untestable rather than passing.
  const world = new World('death-seed', PARTY_SIZE);
  const victim = world.party[1]!.player;

  victim.takeDamage(victim.maxHp);
  if (victim.life !== LifeState.Downed) {
    return { name: '§8 death system', pass: false, detail: 'lethal damage did not down the player' };
  }
  if (!victim.alive) {
    return {
      name: '§8 death system',
      pass: false,
      detail: 'a downed player must still be a body allies can reach',
    };
  }

  // Downed players cannot be hurt further — §8's anti-death-spiral rule.
  const hpWhileDowned = victim.hp;
  victim.takeDamage(50);
  if (victim.hp !== hpWhileDowned || victim.life !== LifeState.Downed) {
    return { name: '§8 death system', pass: false, detail: 'a downed player took further damage' };
  }

  // Bleed out to Wraith. No ally is channelling here because the other bots
  // are elsewhere; step until the clock runs out.
  const bleedTicks = Math.round(DEATH.BLEED_OUT * SIM.TICK_RATE);
  for (let t = 0; t < bleedTicks + 5 && lifeOf(victim) === LifeState.Downed; t++) {
    suppressEnemies(world);
    world.setInput(0, NEUTRAL);
    world.step(SIM.STEP_SECONDS);
  }
  if (lifeOf(victim) !== LifeState.Wraith) {
    return {
      name: '§8 death system',
      pass: false,
      detail: `bleed-out did not reach Wraith (still ${lifeStateName(lifeOf(victim))})`,
    };
  }
  if (victim.collides) {
    return { name: '§8 death system', pass: false, detail: 'a Wraith must not collide' };
  }

  return {
    name: '§8 death system',
    pass: true,
    detail: 'alive → downed (still a body, immune to further damage) → wraith (no collision)',
  };
}

export function checkReviveRequiresSustainedChannel(): CheckResult {
  // The 3s channel is a commitment (§8). If it could be chipped away between
  // dodges it would not be one.
  // All slots human: only the rescuer we drive is channelling, so an
  // interrupt is genuinely an interrupt.
  const world = new World('revive-seed', PARTY_SIZE);
  const victim = world.party[0]!.player;
  const rescuer = world.party[1]!.player;

  victim.takeDamage(victim.maxHp);
  rescuer.x = victim.x + 10;
  rescuer.y = victim.y;

  const channelTicks = Math.round(DEATH.REVIVE_CHANNEL * SIM.TICK_RATE);

  const channelling = makeInputState();
  channelling.contextAction.down = true;
  channelling.contextAction.value = 1;

  // Channel most of the way, then let go for one tick.
  for (let t = 0; t < channelTicks - 10; t++) {
    suppressEnemies(world);
    world.setInput(1, channelling);
    world.step(SIM.STEP_SECONDS);
  }
  const progressBeforeInterrupt = victim.reviveTicks;
  suppressEnemies(world);
  world.setInput(1, NEUTRAL);
  world.step(SIM.STEP_SECONDS);

  if (victim.reviveTicks !== 0) {
    return {
      name: 'revive needs an unbroken channel',
      pass: false,
      detail: `interrupt left ${victim.reviveTicks} ticks of progress standing`,
    };
  }
  if (victim.life !== LifeState.Downed) {
    return {
      name: 'revive needs an unbroken channel',
      pass: false,
      detail: 'victim left the downed state without a completed channel',
    };
  }

  // Now channel all the way through.
  for (let t = 0; t < channelTicks + 2 && lifeOf(victim) === LifeState.Downed; t++) {
    suppressEnemies(world);
    world.setInput(1, channelling);
    world.step(SIM.STEP_SECONDS);
  }

  // Revive HP is a fraction of the class's own pool now (§3 class HP ranges
  // 82–150), not a flat number.
  const expectedHp = victim.maxHp * (DEATH.REVIVE_HP_PERCENT / 100);
  const revived = lifeOf(victim) === LifeState.Alive && victim.hp === expectedHp;
  return {
    name: 'revive needs an unbroken channel',
    pass: revived,
    detail: revived
      ? `interrupt reset ${progressBeforeInterrupt} ticks; an unbroken 3s channel revived at ${expectedHp.toFixed(0)}hp`
      : `after a full channel: ${lifeStateName(lifeOf(victim))} at ${victim.hp}hp`,
  };
}

export function checkBotsReviveEachOther(): CheckResult {
  // The context action (slot 4, §3.3) is the first real consumer of the
  // four-input budget. A bot pressing it proves the input abstraction carries
  // a gameplay verb end to end, not just movement.
  const world = new World('rescue-seed', 0); // all four slots are bots
  const victim = world.party[2]!.player;

  // Park the party together so a rescuer is plausibly nearby.
  for (const slot of world.party) {
    slot.player.x = world.roomWidth / 2;
    slot.player.y = world.roomHeight / 2;
  }
  victim.takeDamage(victim.maxHp);

  let sawChannel = false;
  const deadline = Math.round(DEATH.BLEED_OUT * SIM.TICK_RATE);
  for (let t = 0; t < deadline && lifeOf(victim) === LifeState.Downed; t++) {
    suppressEnemies(world);
    world.step(SIM.STEP_SECONDS);
    for (let i = 0; i < world.party.length; i++) {
      if (i !== 2 && world.party[i]!.input.contextAction.down) sawChannel = true;
    }
  }

  const rescued = lifeOf(victim) === LifeState.Alive;
  return {
    name: 'bots revive a downed ally',
    pass: rescued && sawChannel,
    detail: rescued
      ? 'a bot pressed the context action and completed the channel'
      : `victim ended ${lifeStateName(lifeOf(victim))}; any bot channelled: ${sawChannel}`,
  };
}

export function checkControllerInputIsCleared(): CheckResult {
  // Regression: controllers write only the fields they care about, so the
  // world must hand them a cleared buffer. Without that a button pressed once
  // stays held for the rest of the run — a downed bot was still reporting the
  // context action held. Only the context action is bound today, so this is
  // currently benign; it would silently break every ability slot the moment
  // §3.3 lands.
  const world = new World('input-clear', 0); // all bots
  const victim = world.party[1]!.player;

  for (const slot of world.party) {
    slot.player.x = world.roomWidth / 2;
    slot.player.y = world.roomHeight / 2;
  }
  victim.takeDamage(victim.maxHp);

  // Run until someone has pressed the context action to revive.
  let everPressed = false;
  for (let t = 0; t < 600 && lifeOf(victim) === LifeState.Downed; t++) {
    suppressEnemies(world);
    world.step(SIM.STEP_SECONDS);
    if (world.party.some((s) => s.input.contextAction.down)) everPressed = true;
  }

  if (!everPressed) {
    return {
      name: 'controller input is cleared each tick',
      pass: false,
      detail: 'no bot ever pressed the context action — the check proves nothing',
    };
  }

  // Nobody is downed now, so nobody should still be holding the button.
  for (let t = 0; t < 120; t++) {
    suppressEnemies(world);
    world.step(SIM.STEP_SECONDS);
  }

  const stuck = world.party.filter((s) => s.input.contextAction.down).map((s) => s.player.slot);
  return {
    name: 'controller input is cleared each tick',
    pass: stuck.length === 0,
    detail:
      stuck.length === 0
        ? 'context action released once no ally needed reviving'
        : `slots ${stuck.join(',')} still report the context action held`,
  };
}

export function checkRescuerDoesNotThrash(): CheckResult {
  // Regression for the reported bug: revives worked twice, then stopped.
  //
  // Cause: the rescuer was re-elected every tick. Channelling means standing
  // still, standing still means taking hits, and taking hits disqualified the
  // current rescuer — handing the job to a healthy bot across the room and
  // resetting the 3s channel. Here the channelling bot is damaged every tick
  // to force exactly that.
  const world = new World('thrash', 1); // slot 0 human and never presses E
  const victim = world.localPlayer;

  victim.x = world.roomWidth / 2;
  victim.y = world.roomHeight / 2;
  // One bot close, two far — the far ones are the tempting re-elections.
  const offsets = [70, 260, 430];
  world.party.slice(1).forEach((slot, i) => {
    slot.player.x = world.roomWidth / 2 + offsets[i]!;
    slot.player.y = world.roomHeight / 2;
  });
  victim.takeDamage(victim.maxHp);

  const channelTicks = Math.round(DEATH.REVIVE_CHANNEL * SIM.TICK_RATE);
  // One channel, plus a generous allowance for the walk. Before the fix this
  // never completed at all.
  const deadline = channelTicks + 300;

  let channeller = -1;
  let switches = 0;

  for (let t = 0; t < deadline && lifeOf(victim) === LifeState.Downed; t++) {
    suppressEnemies(world);
    world.setInput(0, NEUTRAL);
    world.step(SIM.STEP_SECONDS);

    const active = world.party.find(
      (s) =>
        s.player.botControlled &&
        s.player.life === LifeState.Alive &&
        s.input.contextAction.down &&
        Math.hypot(s.player.x - victim.x, s.player.y - victim.y) <= DEATH.REVIVE_RANGE,
    );
    if (active) {
      if (channeller !== -1 && active.player.id !== channeller) switches++;
      channeller = active.player.id;
      // Standing still in a fight costs health. This is what disqualified the
      // rescuer under the old every-tick election.
      active.player.takeDamage(0.4);
    }
  }

  const revived = lifeOf(victim) === LifeState.Alive;
  return {
    name: 'a committed rescuer does not hand off mid-channel',
    pass: revived && switches === 0,
    detail: revived
      ? `revived in ${world.tick} ticks with ${switches} hand-offs`
      : `victim still ${lifeStateName(lifeOf(victim))} after ${deadline} ticks, ${switches} hand-offs`,
  };
}

export function checkAllAbilitiesFire(): CheckResult {
  // Twelve abilities across four classes. If a bot never presses one, that
  // ability is untested — and untested is exactly where the revive bugs were
  // hiding. This watches the event stream for each id actually executing.
  const seen = new Set<string>();
  const script = makeInputScript('abilities', 5400);

  // All four slots bot-driven so every class is exercised, and a long enough
  // run for the resource-gated payoffs to come up. With no human in the party
  // the bots lead themselves through doors, which is what makes an all-bot
  // world able to progress a floor at all.
  const world = new World('ability-coverage', 0);
  for (let t = 0; t < script.length && !world.runOver; t++) {
    world.step(SIM.STEP_SECONDS);
    for (let i = 0; i < world.events.length; i++) {
      const event = world.events.at(i);
      if (event.kind === EventKind.Ability && event.ability) seen.add(event.ability);
    }
  }

  const expected: string[] = [];
  for (const id of CLASS_ORDER) {
    for (const ability of getClass(id).abilities) expected.push(ability.id);
  }
  const missing = expected.filter((id) => !seen.has(id));

  return {
    name: 'bots fire every class ability',
    pass: missing.length === 0,
    detail:
      missing.length === 0
        ? `all ${expected.length} abilities fired within ${world.tick} ticks`
        : `never fired: ${missing.join(', ')}`,
  };
}

export function checkClassesActuallyDiffer(): CheckResult {
  // §3.2 requires differentiation on at least four levers, not just damage.
  // A regression here would be silent: four classes that play identically
  // still pass every other check in this file.
  const stats = CLASS_ORDER.map((id) => getClass(id));

  const distinct = (values: readonly unknown[]): number => new Set(values).size;
  const levers = {
    moveSpeed: distinct(stats.map((s) => s.moveSpeed)),
    cadence: distinct(stats.map((s) => s.attackInterval)),
    resource: distinct(stats.map((s) => s.resource.kind)),
    range: distinct(stats.map((s) => s.attackRange)),
    traversal: distinct(stats.map((s) => s.abilities[0]!.id)),
    silhouette: distinct(stats.map((s) => s.silhouette)),
  };

  // Every lever must genuinely separate all four, or it is not a lever.
  const failed = Object.entries(levers).filter(([, count]) => count < CLASS_ORDER.length);

  return {
    name: '§3.2 classes differ on every lever',
    pass: failed.length === 0,
    detail:
      failed.length === 0
        ? `${Object.keys(levers).length} levers each separate all 4 classes`
        : `not distinct: ${failed.map(([k, v]) => `${k}(${v}/4)`).join(', ')}`,
  };
}

export function checkDashHitsEachEnemyOnce(): CheckResult {
  // Regression: a dash is a moving hitbox swept every tick. Without per-dash
  // dedup it re-hit the same body on all ~11 ticks of the sweep, making
  // Charge do an order of magnitude more damage than its listed power.
  const world = new World('dash-dedup', PARTY_SIZE, [
    ClassId.Warrior,
    ClassId.Warrior,
    ClassId.Warrior,
    ClassId.Warrior,
  ]);
  const user = world.localPlayer;
  const charge = user.def.abilities[0]!;

  // One enemy, parked directly in the dash path. Placed explicitly rather
  // than borrowing whatever the room spawned — the entry room has no enemies
  // at all now that floors exist, and a room-dependent fixture makes the
  // check fragile for reasons unrelated to dashes.
  suppressEnemies(world);
  world.step(SIM.STEP_SECONDS);
  world.enemies.length = 0;
  const victim = new Enemy(9999, user.x + 120, user.y);
  victim.hp = 100000; // survive the hit so we can measure it exactly
  victim.maxHp = 100000;
  world.enemies.push(victim);
  user.facingX = 1;
  user.facingY = 0;

  const press = makeInputState();
  press.ability[0]!.down = true;
  press.ability[0]!.pressed = true;

  // Count hit events carrying the dash's damage. Measuring the victim's total
  // HP loss would also catch the Warrior's basic attacks, which land on the
  // same body during the dash — the first version of this check failed for
  // exactly that reason (14 dash + 13 + 13 basic = 40).
  let dashHits = 0;
  const countDashHits = (): void => {
    for (let i = 0; i < world.events.length; i++) {
      const e = world.events.at(i);
      if (e.kind !== EventKind.Hit && e.kind !== EventKind.Kill) continue;
      if (Math.abs(e.amount - charge.power) < 0.0001) dashHits++;
    }
  };

  world.setInput(0, press);
  world.step(SIM.STEP_SECONDS);
  countDashHits();

  // Run out the whole dash without re-pressing.
  for (let t = 0; t < 30; t++) {
    world.setInput(0, NEUTRAL);
    world.step(SIM.STEP_SECONDS);
    countDashHits();
  }

  const pass = dashHits === 1;
  return {
    name: 'a dash hits each enemy once',
    pass,
    detail: pass
      ? 'Charge connected with the swept body exactly once'
      : `Charge landed ${dashHits} hits on one body — the sweep is re-hitting per tick`,
  };
}

export function checkFloorGenerationIsSeeded(): CheckResult {
  // §2: "Seeded runs from day one. Trivial early, impossible to retrofit."
  // A floor must be a pure function of the seed — dailies and races depend
  // on it, and so does any replay.
  const shape = (w: World): string =>
    w.floor.rooms
      .map((r) => `${r.gx},${r.gy},${r.kind},${r.template.id},${r.exits.join('|')}`)
      .join(';');

  const a = shape(new World('floor-seed', 1));
  const b = shape(new World('floor-seed', 1));
  if (a !== b) {
    return { name: '§2 floor generation is seeded', pass: false, detail: 'same seed gave two different floors' };
  }

  const other = shape(new World('floor-other', 1));
  if (a === other) {
    return {
      name: '§2 floor generation is seeded',
      pass: false,
      detail: 'two different seeds produced the identical floor',
    };
  }

  // Structural sanity across many seeds: §2 asks for 8–14 combat rooms plus a
  // boss, every room reachable, and every door reciprocated.
  for (let s = 0; s < 40; s++) {
    const w = new World(`floor-${s}`, 1);
    const rooms = w.floor.rooms;

    // Reciprocity: A links to B north ⇒ B links to A south. A one-way door
    // would strand the party.
    for (const r of rooms) {
      for (let dir = 0; dir < 4; dir++) {
        const target = r.exits[dir];
        if (target === undefined || target === -1) continue;
        const back = rooms[target]!.exits[(dir + 2) % 4];
        if (back !== r.index) {
          return {
            name: '§2 floor generation is seeded',
            pass: false,
            detail: `seed ${s}: room ${r.index} links to ${target} but not back`,
          };
        }
      }
    }

    // Reachability from the entry.
    const seen = new Set<number>([w.floor.entryIndex]);
    const queue = [w.floor.entryIndex];
    while (queue.length > 0) {
      const at = rooms[queue.pop()!]!;
      for (let dir = 0; dir < 4; dir++) {
        const target = at.exits[dir];
        if (target === undefined || target === -1 || seen.has(target)) continue;
        seen.add(target);
        queue.push(target);
      }
    }
    if (seen.size !== rooms.length) {
      return {
        name: '§2 floor generation is seeded',
        pass: false,
        detail: `seed ${s}: ${rooms.length - seen.size} of ${rooms.length} rooms unreachable from the entry`,
      };
    }

    // A room must not offer a door its template cannot draw.
    for (const r of rooms) {
      for (let dir = 0; dir < 4; dir++) {
        const target = r.exits[dir];
        if (target === undefined || target === -1) continue;
        if (!r.template.doors.includes(dir as 0 | 1 | 2 | 3)) {
          return {
            name: '§2 floor generation is seeded',
            pass: false,
            detail: `seed ${s}: room ${r.index} (${r.template.id}) has an exit its template has no door for`,
          };
        }
      }
    }
  }

  return {
    name: '§2 floor generation is seeded',
    pass: true,
    detail: '40 floors: reproducible, fully reachable, doors reciprocal and template-backed',
  };
}

export function checkDoorsLockDuringCombat(): CheckResult {
  // §2 `[DEFAULT]`: "Doors lock during combat. Keeps the party together;
  // prevents one player speedrunning ahead."
  const world = new World('doors', PARTY_SIZE);

  // Walk out of the entry (which has no enemies) into the first combat room.
  const script = makeInputScript('door-walk', 2400);
  let sawLockedInCombat = false;
  let sawOpenWhenClear = false;
  let everInCombat = false;
  let roomsSeen = 1;
  let lastRoom = world.currentRoom;

  for (let t = 0; t < script.length; t++) {
    // Drive slot 0 straight at whichever door exists.
    const input = makeInputState();
    const door = world.doors[0];
    if (door) {
      const dx = door.x - world.localPlayer.x;
      const dy = door.y - world.localPlayer.y;
      const d = Math.hypot(dx, dy) || 1;
      input.moveVector.x = dx / d;
      input.moveVector.y = dy / d;
    }
    world.setInput(0, input);
    world.step(SIM.STEP_SECONDS);

    if (world.currentRoom !== lastRoom) {
      lastRoom = world.currentRoom;
      roomsSeen++;
    }

    if (world.inCombat) {
      everInCombat = true;
      if (world.doors.every((dr) => !dr.open)) sawLockedInCombat = true;
      // The rule that matters: no transition may start while fighting.
      if (world.transitionTicks > 0) {
        return {
          name: '§2 doors lock during combat',
          pass: false,
          detail: `a transition began at tick ${world.tick} with ${world.enemiesRemaining} enemies alive`,
        };
      }
    } else if (world.doors.length > 0 && world.doors.every((dr) => dr.open)) {
      sawOpenWhenClear = true;
    }
  }

  const pass = everInCombat && sawLockedInCombat && sawOpenWhenClear && roomsSeen > 1;
  return {
    name: '§2 doors lock during combat',
    pass,
    detail: pass
      ? `${roomsSeen} rooms entered; doors barred while fighting, open once clear`
      : `combat seen: ${everInCombat}, locked: ${sawLockedInCombat}, opened: ${sawOpenWhenClear}, rooms: ${roomsSeen}`,
  };
}

export function checkPartyMakesFloorProgress(): CheckResult {
  // Regression: navigation used to return the first open door in direction
  // order, which is frequently the one the party just walked in through. The
  // party ping-ponged between two rooms every 35 ticks, forever. Bots use the
  // same hint, so it stranded an all-bot party too.
  //
  // An all-bot world leads itself, so this is also the end-to-end check that
  // a floor can actually be played from entry to boss.
  const world = new World('progress', 0);
  const seen = new Set<number>([world.currentRoom]);
  let transitions = 0;
  let lastRoom = world.currentRoom;

  for (let t = 0; t < 60000 && !world.runOver && !world.floorComplete; t++) {
    world.step(SIM.STEP_SECONDS);
    if (world.currentRoom !== lastRoom) {
      lastRoom = world.currentRoom;
      transitions++;
      seen.add(lastRoom);
    }
  }

  // Backtracking is legitimate — branches are dead ends, and the party has to
  // come back. But revisiting far more often than there are rooms means the
  // party is oscillating rather than exploring.
  const thrashing = transitions > world.floor.rooms.length * 4;
  const progressed = seen.size >= 4;

  return {
    name: 'the party makes floor progress',
    pass: progressed && !thrashing,
    detail:
      progressed && !thrashing
        ? `${seen.size}/${world.floor.rooms.length} rooms reached in ${transitions} transitions` +
          `${world.floorComplete ? ', floor cleared' : ''}`
        : `reached ${seen.size} rooms in ${transitions} transitions (thrashing: ${thrashing})`,
  };
}

export function checkLeashIsWindowIndependent(): CheckResult {
  // §2's soft leash. The rule is defined in world units from the party
  // centroid, deliberately *not* as "off the rendered frame" — frame size
  // depends on the window, and a rule that depends on the window is not
  // something two lockstep peers can agree on.
  const world = new World('leash', PARTY_SIZE);
  suppressEnemies(world);
  world.step(SIM.STEP_SECONDS);

  const stray = world.party[1]!.player;
  const before = stray.hp;

  // Park three players against one wall and the fourth against the other.
  // Positions are derived from the room rather than hardcoded: the first
  // version used absolute coordinates that fell outside the entry room, so
  // collision clamped the stray back inside and it was never actually out.
  const huddleX = ROOM.WALL + 40;
  const strayX = world.roomWidth - ROOM.WALL - 40;
  const midY = world.roomHeight / 2;

  const hold = (): void => {
    for (let i = 0; i < world.party.length; i++) {
      const p = world.party[i]!.player;
      p.x = huddleX;
      p.y = midY;
    }
    stray.x = strayX;
    stray.y = midY;
  };

  hold();
  world.step(SIM.STEP_SECONDS);

  // The geometry has to actually put the stray outside, or the check is
  // vacuous. Centroid sits between the huddle and the stray.
  const overshoot = world.leashOvershoot(1);
  if (overshoot <= 0) {
    return {
      name: '§2 soft leash bites, gently',
      pass: false,
      detail: `room ${world.roomWidth}×${world.roomHeight} is too small to separate the party past a ${LEASH.RADIUS}u leash`,
    };
  }

  const graceTicks = Math.round(LEASH.GRACE * SIM.TICK_RATE);
  for (let t = 0; t < graceTicks; t++) {
    suppressEnemies(world);
    hold();
    world.step(SIM.STEP_SECONDS);
  }
  const afterGrace = stray.hp;

  for (let t = 0; t < SIM.TICK_RATE * 2; t++) {
    suppressEnemies(world);
    hold();
    world.step(SIM.STEP_SECONDS);
  }
  const afterLeash = stray.hp;

  const graceHeld = afterGrace === before;
  const bit = afterLeash < afterGrace;
  // "Light" damage per §2 — a nudge home, not a threat.
  const light = before - afterLeash < stray.maxHp * 0.3;

  return {
    name: '§2 soft leash bites, gently',
    pass: graceHeld && bit && light,
    detail:
      graceHeld && bit && light
        ? `grace held ${before}hp, then ${(afterGrace - afterLeash).toFixed(0)} damage over 2s outside`
        : `grace held: ${graceHeld}, damaged: ${bit}, light: ${light} (${before} → ${afterLeash})`,
  };
}

export function checkPartyWipeEndsRun(): CheckResult {
  // §8 `[LOCKED]`: total party wipe ends the run. No compromise.
  const world = new World('wipe-seed', 0);
  if (world.runOver) {
    return { name: 'party wipe ends the run', pass: false, detail: 'run started already over' };
  }

  for (const slot of world.party) slot.player.takeDamage(slot.player.maxHp);

  const bleedTicks = Math.round(DEATH.BLEED_OUT * SIM.TICK_RATE);
  for (let t = 0; t < bleedTicks + 10 && !world.runOver; t++) {
    world.step(SIM.STEP_SECONDS);
  }

  return {
    name: 'party wipe ends the run',
    pass: world.runOver,
    detail: world.runOver
      ? `run ended after all four reached wraith (tick ${world.tick})`
      : 'four wraiths did not end the run',
  };
}

/** Smallest representable increase — one unit in the last place. */
// ---------------------------------------------------------------------------
// §4 — bi-directional upgrades
// ---------------------------------------------------------------------------

/** Give a player `n` stacks in one direction, the way the game would. */
function stack(player: { applyUpgrade(i: number): void }, index: number, n: number): void {
  for (let i = 0; i < n; i++) player.applyUpgrade(index);
}

/** A room with exactly the bodies a check wants, and nothing else. */
function clearRoom(world: World): void {
  suppressEnemies(world);
  world.step(SIM.STEP_SECONDS);
  world.enemies.length = 0;
  world.pickups.length = 0;
}

function addDummy(world: World, id: number, x: number, y: number, hp = 100000): Enemy {
  const e = new Enemy(id, x, y);
  e.hp = hp;
  e.maxHp = hp;
  world.enemies.push(e);
  return e;
}

function countHitEvents(world: World): number {
  let n = 0;
  for (let i = 0; i < world.events.length; i++) {
    const kind = world.events.at(i).kind;
    if (kind === EventKind.Hit || kind === EventKind.Kill) n++;
  }
  return n;
}

export function checkPartyReachesBreakpoints(): CheckResult {
  // The end-to-end one, and deliberately non-vacuous: a party that was offered
  // upgrades but never answered them, or answered them by spreading picks
  // evenly across an axis, would satisfy every other check in this section
  // while §4.1's breakpoints stayed dead code for the whole run.
  const world = new World('upgrade-progress', 0);

  let peakStack = 0;
  let transformed = 0;
  for (let t = 0; t < 12000 && !world.runOver && !world.floorComplete; t++) {
    world.step(SIM.STEP_SECONDS);
  }

  for (const p of world.players) {
    for (let i = 0; i < p.stacks.length; i++) peakStack = Math.max(peakStack, p.stacks[i]!);
    for (const t of p.stats.tiers) if (t > 0) transformed++;
  }

  const pass = world.upgradesTaken > 0 && peakStack >= UPGRADE.BREAKPOINT_1 && transformed > 0;
  return {
    name: '§4 the party picks upgrades and crosses breakpoints',
    pass,
    detail: pass
      ? `${world.upgradesTaken} picks over ${world.roomsCleared} rooms; deepest line ${peakStack} stacks, ${transformed} transformations live`
      : `${world.upgradesTaken} picks, deepest line ${peakStack} stacks, ${transformed} transformations — no build formed`,
  };
}

export function checkEveryDirectionGrantsItsBreakpoints(): CheckResult {
  // §4.1's breakpoints are the mechanism that turns a slider into a build. A
  // direction whose at3/at6 never reached the stat block would look like a
  // working upgrade and quietly be a stat point.
  //
  // Enumerated from the axis data rather than a hardcoded list, so a direction
  // added later cannot be silently untested — the same reason the ability
  // check reads the class table.
  const broken: string[] = [];
  let checked = 0;

  for (const classId of CLASS_ORDER) {
    const def = getClass(classId);
    const dirs = directionsFor(classId);

    for (let i = 0; i < dirs.length; i++) {
      const dir = dirs[i]!;
      checked++;

      const at1: number[] = new Array<number>(dirs.length).fill(0);
      at1[i] = UPGRADE.BREAKPOINT_1;
      const at2: number[] = new Array<number>(dirs.length).fill(0);
      at2[i] = UPGRADE.BREAKPOINT_2;

      const below: number[] = new Array<number>(dirs.length).fill(0);
      below[i] = UPGRADE.BREAKPOINT_1 - 1;

      const s0 = deriveStats(def, below);
      const s1 = deriveStats(def, at1);
      const s2 = deriveStats(def, at2);

      if (dir.at3) {
        if (tierOf(s0, dir.at3) !== 0) broken.push(`${dir.id} granted ${dir.at3} early`);
        if (tierOf(s1, dir.at3) < 1) broken.push(`${dir.id} missing ${dir.at3} at 3`);
      }
      if (dir.at6 && tierOf(s2, dir.at6) < 2) {
        broken.push(`${dir.id} missing capstone ${dir.at6} at 6`);
      }
      if (!dir.capstone) broken.push(`${dir.id} has no capstone name`);
    }
  }

  return {
    name: '§4.1 every direction grants its breakpoints',
    pass: broken.length === 0,
    detail:
      broken.length === 0
        ? `${checked} directions across ${CLASS_ORDER.length} classes reach 3 and 6`
        : broken.slice(0, 3).join('; '),
  };
}

export function checkAxisPoolsRotate(): CheckResult {
  // §4.1 fix 2. Three axes per class, both halves distinct, and every axis
  // reachable from a draw — a pool that always returned the same pair is the
  // slider the whole section exists to avoid.
  const problems: string[] = [];

  for (const classId of CLASS_ORDER) {
    const axes = axesFor(classId);
    if (axes.length < 3) problems.push(`${classId} has ${axes.length} axes`);

    const ids = new Set<string>();
    for (const axis of axes) {
      if (axis.a.id === axis.b.id) problems.push(`${axis.id} offers the same direction twice`);
      ids.add(axis.a.id);
      ids.add(axis.b.id);
    }
    if (ids.size !== axes.length * 2) problems.push(`${classId} reuses a direction id`);
  }

  // Every direction id in the game must be globally unique — they index a
  // player's stack array, and a collision would silently merge two builds.
  const all = allDirections();
  const unique = new Set(all.map((d) => d.id));
  if (unique.size !== all.length) problems.push(`${all.length - unique.size} duplicate ids`);

  // A run's offers must actually visit more than one axis, or the rotation is
  // decorative. Measured over a real floor rather than by inspecting rollOffer.
  const world = new World('axis-rotation', 0);
  const seenAxes = new Set<string>();
  const before = world.players.map((p) => p.stacks.slice());
  for (let t = 0; t < 12000 && !world.runOver && !world.floorComplete; t++) {
    world.step(SIM.STEP_SECONDS);
  }
  for (let i = 0; i < world.players.length; i++) {
    const p = world.players[i]!;
    const axes = axesFor(p.def.id);
    for (let a = 0; a < axes.length; a++) {
      const moved =
        p.stacks[a * 2]! !== before[i]![a * 2]! || p.stacks[a * 2 + 1]! !== before[i]![a * 2 + 1]!;
      if (moved) seenAxes.add(`${p.def.id}:${axes[a]!.id}`);
    }
  }
  if (seenAxes.size < 2) problems.push(`offers only ever landed on ${seenAxes.size} axis`);

  return {
    name: '§4.1 axis pools are distinct and rotate',
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? `${all.length} unique directions; a floor drew ${seenAxes.size} different axes`
        : problems.slice(0, 3).join('; '),
  };
}

export function checkDerivedStatsAreRecomputed(): CheckResult {
  // Constraint #3, the quiet half. Stats are recomputed from the class base
  // every time rather than multiplied into a stored field. Accumulating
  // `value *= 1.09` six times is a float-drift source, and two peers who took
  // the same upgrades in a different frame order would end up with genuinely
  // different damage — a desync that positions alone would never reveal.
  const def = getClass(ClassId.Warrior);
  const dirs = directionsFor(ClassId.Warrior);

  // Applied one pick at a time through the real path...
  const player = new World('stat-drift', PARTY_SIZE).localPlayer;
  stack(player, 1, UPGRADE.BREAKPOINT_2);
  stack(player, 4, 2);

  // ...against the same stacks derived in one shot.
  const stacks: number[] = new Array<number>(dirs.length).fill(0);
  stacks[1] = UPGRADE.BREAKPOINT_2;
  stacks[4] = 2;
  const oneShot = deriveStats(def, stacks);

  const exact =
    player.stats.attackDamage === oneShot.attackDamage &&
    player.stats.maxHp === oneShot.maxHp &&
    player.stats.abilityPower === oneShot.abilityPower &&
    player.stats.damageTaken === oneShot.damageTaken;

  // And deriving twice must be bit-identical, not merely close.
  const again = deriveStats(def, stacks);
  const stable =
    again.attackDamage === oneShot.attackDamage && again.attackRange === oneShot.attackRange;

  // Non-vacuous: the stacks have to have moved something in the first place.
  const moved = oneShot.attackDamage > def.attackDamage;

  const pass = exact && stable && moved;
  return {
    name: '§4 derived stats are recomputed, never accumulated',
    pass,
    detail: pass
      ? `8 sequential picks match a single derive exactly (${def.attackDamage} → ${oneShot.attackDamage.toFixed(4)} damage)`
      : `incremental ${player.stats.attackDamage} vs one-shot ${oneShot.attackDamage} (stable ${stable}, moved ${moved})`,
  };
}

export function checkTransformationsChangeCombat(): CheckResult {
  // Every one of the seven §4 verbs has to *do* something. A transformation
  // that reached the stat block but was never read at a call site is the worst
  // kind of dead content: the HUD announces a new behaviour and nothing
  // happens. One focused scenario per verb, each measuring the behaviour
  // rather than the flag.
  const dead: string[] = [];
  const evidence: string[] = [];

  // --- Cleave, melee: one swing, three bodies in the arc -------------------
  {
    const world = new World('tf-cleave', PARTY_SIZE, [ClassId.Warrior, ClassId.Warrior, ClassId.Warrior, ClassId.Warrior]);
    const user = world.localPlayer;
    clearRoom(world);
    user.facingX = 1;
    user.facingY = 0;
    addDummy(world, 9001, user.x + 60, user.y);
    addDummy(world, 9002, user.x + 55, user.y - 40);
    addDummy(world, 9003, user.x + 55, user.y + 40);

    world.setInput(0, NEUTRAL);
    world.step(SIM.STEP_SECONDS);
    const baseline = countHitEvents(world);

    stack(user, 0, UPGRADE.BREAKPOINT_1); // Warrior Reach
    let cleaved = 0;
    for (let t = 0; t < 90 && cleaved <= baseline; t++) {
      world.setInput(0, NEUTRAL);
      world.step(SIM.STEP_SECONDS);
      cleaved = Math.max(cleaved, countHitEvents(world));
    }
    if (cleaved > baseline) evidence.push(`cleave ${baseline}→${cleaved} bodies`);
    else dead.push('cleave');
  }

  // --- Cleave, projectile: the Archer's Multishot fans extra shots ---------
  {
    const world = new World('tf-fan', PARTY_SIZE, [ClassId.Archer, ClassId.Archer, ClassId.Archer, ClassId.Archer]);
    const user = world.localPlayer;
    clearRoom(world);
    addDummy(world, 9101, user.x + 150, user.y);
    stack(user, 3, UPGRADE.BREAKPOINT_1); // Archer Multishot

    let peak = 0;
    for (let t = 0; t < 60; t++) {
      world.setInput(0, NEUTRAL);
      world.step(SIM.STEP_SECONDS);
      let live = 0;
      for (const shot of world.projectiles) if (shot.active && shot.ownerSlot === 0) live++;
      peak = Math.max(peak, live);
    }
    if (peak >= 3) evidence.push(`multishot ${peak} arrows in flight`);
    else dead.push('cleave/projectile');
  }

  // --- Pierce: one arrow, two bodies ---------------------------------------
  {
    const world = new World('tf-pierce', PARTY_SIZE, [ClassId.Archer, ClassId.Archer, ClassId.Archer, ClassId.Archer]);
    const user = world.localPlayer;
    clearRoom(world);
    const near = addDummy(world, 9201, user.x + 120, user.y);
    const far = addDummy(world, 9202, user.x + 200, user.y);
    user.facingX = 1;
    user.facingY = 0;
    stack(user, 2, UPGRADE.BREAKPOINT_1); // Archer Pierce

    for (let t = 0; t < 90; t++) {
      world.setInput(0, NEUTRAL);
      world.step(SIM.STEP_SECONDS);
    }
    const both = near.hp < near.maxHp && far.hp < far.maxHp;
    if (both) evidence.push('pierce reached the body behind');
    else dead.push('pierce');
  }

  // --- Field: an area ability leaves a burning zone ------------------------
  {
    const world = new World('tf-field', PARTY_SIZE, [ClassId.Sorcerer, ClassId.Sorcerer, ClassId.Sorcerer, ClassId.Sorcerer]);
    const user = world.localPlayer;
    clearRoom(world);
    addDummy(world, 9301, user.x + 100, user.y);
    stack(user, 0, UPGRADE.BREAKPOINT_1); // Sorcerer Blast Radius

    const press = makeInputState();
    press.ability[1]!.down = true;
    press.ability[1]!.pressed = true;
    world.setInput(0, press);
    world.step(SIM.STEP_SECONDS);

    if (user.activeZones.length > 0) evidence.push('field left behind a blast');
    else dead.push('field');
  }

  // --- Burst: a kill damages the bodies around the corpse ------------------
  {
    const world = new World('tf-burst', PARTY_SIZE, [ClassId.Warrior, ClassId.Warrior, ClassId.Warrior, ClassId.Warrior]);
    const user = world.localPlayer;
    clearRoom(world);
    user.facingX = 1;
    user.facingY = 0;
    stack(user, 1, UPGRADE.BREAKPOINT_1); // Warrior Force

    // The bystander sits **outside** the Warrior's own reach and inside the
    // detonation radius, so any damage it takes can only have come from the
    // corpse. Measuring "more than a basic attack" instead would compare two
    // numbers the upgrade moves at the same time.
    const doomed = addDummy(world, 9401, user.x + 90, user.y, 1);
    const bystander = addDummy(world, 9402, user.x + 90 + UPGRADE.BURST_RADIUS[0]! * 0.6, user.y);
    const outOfReach = bystander.x - user.x > user.stats.attackRange + bystander.radius;

    for (let t = 0; t < 120 && doomed.alive; t++) {
      world.setInput(0, NEUTRAL);
      world.step(SIM.STEP_SECONDS);
    }
    const splash = bystander.maxHp - bystander.hp;
    if (outOfReach && splash > 0) evidence.push(`burst splashed ${splash.toFixed(1)} past the corpse`);
    else dead.push('burst');
  }

  // --- Surge: landing hits shortens the ability cooldown -------------------
  {
    // Run the identical scenario with and without the stacks and compare, so
    // the measurement does not depend on knowing how many swings land in the
    // window. Surge also shortens the attack interval, which is exactly the
    // kind of second-order help an absolute threshold would misread.
    const remaining = (stacks: number): number => {
      const world = new World('tf-surge', PARTY_SIZE, [ClassId.Warrior, ClassId.Warrior, ClassId.Warrior, ClassId.Warrior]);
      const user = world.localPlayer;
      clearRoom(world);
      user.facingX = 1;
      user.facingY = 0;
      addDummy(world, 9501, user.x + 60, user.y);
      if (stacks > 0) stack(user, 2, stacks); // Warrior Rage Generation

      const press = makeInputState();
      press.ability[1]!.down = true;
      press.ability[1]!.pressed = true;
      world.setInput(0, press);
      world.step(SIM.STEP_SECONDS);

      for (let t = 0; t < 120; t++) {
        world.setInput(0, NEUTRAL);
        world.step(SIM.STEP_SECONDS);
      }
      return user.cooldownFraction(1);
    };

    const base = remaining(0);
    const surged = remaining(UPGRADE.BREAKPOINT_2);
    if (surged < base - 0.02) {
      evidence.push(`surge left ${(surged * 100).toFixed(0)}% of a cooldown where base left ${(base * 100).toFixed(0)}%`);
    } else {
      dead.push('surge');
    }
  }

  // --- Aegis: an ally standing close takes less --------------------------
  {
    const world = new World('tf-aegis', PARTY_SIZE, [ClassId.Warrior, ClassId.Warrior, ClassId.Warrior, ClassId.Warrior]);
    const shelter = world.localPlayer;
    const ally = world.party[1]!.player;
    clearRoom(world);
    stack(shelter, 4, UPGRADE.BREAKPOINT_1); // Warrior Armor

    ally.x = shelter.x + 30;
    ally.y = shelter.y;
    world.setInput(0, NEUTRAL);
    world.step(SIM.STEP_SECONDS);
    const sheltered = ally.auraDamageFactor;

    ally.x = shelter.x + UPGRADE.AEGIS_RADIUS[0]! * 3;
    world.setInput(0, NEUTRAL);
    world.step(SIM.STEP_SECONDS);
    const exposed = ally.auraDamageFactor;

    if (sheltered < 1 && exposed === 1) {
      evidence.push(`aegis ${(1 - sheltered) * 100}% inside the radius, nothing outside`);
    } else {
      dead.push('aegis');
    }
  }

  // --- Stance: holding still is worth damage -------------------------------
  {
    // Melee rather than the Archer: a projectile in flight carries the damage
    // it was launched with, so a shot fired while walking can land during the
    // stationary phase and be read as the stationary number.
    const world = new World('tf-stance', PARTY_SIZE, [ClassId.Valkyrie, ClassId.Valkyrie, ClassId.Valkyrie, ClassId.Valkyrie]);
    const user = world.localPlayer;
    clearRoom(world);
    const dummy = addDummy(world, 9701, user.x + 70, user.y);
    stack(user, 4, UPGRADE.BREAKPOINT_1); // Valkyrie Self — the stationary side

    const lastHit = (): number => {
      let amount = 0;
      for (let i = 0; i < world.events.length; i++) {
        const e = world.events.at(i);
        if (e.kind === EventKind.Hit && e.slot === 0 && e.amount > 0) amount = e.amount;
      }
      return amount;
    };

    const walking = makeInputState();
    walking.moveVector.x = -1;
    let movingDamage = 0;
    for (let t = 0; t < 180 && movingDamage === 0; t++) {
      // Held in place so the dummy stays in reach; only the *intent* to move
      // matters, which is what the stance reads.
      user.x = dummy.x - 70;
      user.y = dummy.y;
      world.setInput(0, walking);
      world.step(SIM.STEP_SECONDS);
      movingDamage = lastHit() || movingDamage;
    }

    let stillDamage = 0;
    for (let t = 0; t < 240 && stillDamage === 0; t++) {
      user.x = dummy.x - 70;
      user.y = dummy.y;
      world.setInput(0, NEUTRAL);
      world.step(SIM.STEP_SECONDS);
      if (t >= UPGRADE.STANCE_SETTLE_TICKS) stillDamage = lastHit() || stillDamage;
    }

    if (movingDamage > 0 && stillDamage > movingDamage) {
      evidence.push(`stance ${movingDamage.toFixed(1)}→${stillDamage.toFixed(1)} standing still`);
    } else {
      dead.push('stance');
    }
  }

  return {
    name: '§4 every transformation changes combat',
    pass: dead.length === 0,
    detail:
      dead.length === 0
        ? evidence.join(' · ')
        : `no observable effect: ${dead.join(', ')}`,
  };
}

export function checkOffersHoldTheDoors(): CheckResult {
  // §4.3 wants the picks visible to the party, which only works if everyone is
  // looking at the same moment — so a pending offer keeps the doors shut, the
  // same lever §2 uses for combat. And because it holds the doors, it must be
  // impossible for it to hold them forever: one player stepping away from the
  // keyboard cannot be allowed to end a run for four people.
  // One human slot that never answers, three bots that do. The bots clear the
  // room; the human's unanswered pick is what holds the doors.
  const world = new World('offer-doors', 1);
  advanceToCombat(world);
  let sawOffer = false;
  let doorOpenDuringOffer = false;
  let transitionDuringOffer = false;
  let resolvedAtTick = -1;

  for (let t = 0; t < 6000 && resolvedAtTick < 0; t++) {
    world.setInput(0, NEUTRAL);
    world.step(SIM.STEP_SECONDS);

    if (world.offerPending) {
      sawOffer = true;
      for (const door of world.doors) if (door.open) doorOpenDuringOffer = true;
      if (world.transitionTicks > 0) transitionDuringOffer = true;
    } else if (sawOffer) {
      resolvedAtTick = world.tick;
    }
  }

  const timedOut = resolvedAtTick > 0;
  const pass = sawOffer && !doorOpenDuringOffer && !transitionDuringOffer && timedOut;

  return {
    name: '§4 a pending offer bars the doors, and cannot stall the run',
    pass,
    detail: pass
      ? `doors stayed barred through the offer; an unanswered pick auto-confirmed and reopened them`
      : `saw offer ${sawOffer}, door opened ${doorOpenDuringOffer}, transitioned ${transitionDuringOffer}, resolved ${timedOut}`,
  };
}

export function checkHeartsGoToTheHurt(): CheckResult {
  // §7.2 puts hearts in the free-for-all, touch-pickup tier — no ceremony.
  // §7.3 then asks for the one piece of friction that matters: accidental
  // pickup in a crowded room is the most common source of co-op loot
  // resentment, and it is a UX defect rather than a design tradeoff. So a
  // player at full health walks over a heart and leaves it.
  //
  // This also stands in for WAVE.CLEAR_HEAL, which healed the party a flat 35%
  // the instant a room fell because nothing else could heal at all.
  const world = new World('hearts', PARTY_SIZE);
  clearRoom(world);

  const healthy = world.localPlayer;
  const hurt = world.party[1]!.player;
  hurt.hp = hurt.maxHp * 0.4;
  const hurtBefore = hurt.hp;

  // Park a heart under the player who does not need it.
  const heart = new Pickup(9800, PickupKind.Heart, healthy.x, healthy.y);
  world.pickups.push(heart);
  for (let t = 0; t < 12; t++) {
    world.setInput(0, NEUTRAL);
    world.step(SIM.STEP_SECONDS);
  }
  const survivedFullHp = !heart.taken && healthy.hp === healthy.maxHp;

  // Now walk the hurt one onto it.
  hurt.x = heart.x;
  hurt.y = heart.y;
  for (let t = 0; t < 12 && !heart.taken; t++) {
    world.setInput(0, NEUTRAL);
    world.step(SIM.STEP_SECONDS);
  }
  const healed = hurt.hp - hurtBefore;
  const takenByHurt = heart.taken && heart.takenBy === hurt.slot && healed > 0;

  // And a cleared room actually pays out, since that is what replaced the
  // scaffolding heal.
  const floor = new World('heart-payout', 0);
  let dropped = 0;
  for (let t = 0; t < 12000 && dropped === 0 && !floor.runOver; t++) {
    floor.step(SIM.STEP_SECONDS);
    if (floor.roomsCleared > 0) dropped = floor.pickups.length;
  }

  const pass = survivedFullHp && takenByHurt && dropped > 0;
  return {
    name: '§7.2 hearts are free-for-all, and only the hurt take them',
    pass,
    detail: pass
      ? `a full-health player walked over it; the hurt one healed ${healed.toFixed(0)}hp; a cleared room dropped ${dropped}`
      : `left at full hp ${survivedFullHp}, taken by the hurt ${takenByHurt}, room payout ${dropped}`,
  };
}

function nextAfter(value: number): number {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, value);
  const bits = buf.getBigUint64(0);
  buf.setBigUint64(0, bits + 1n);
  return buf.getFloat64(0);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export const CHECKS = [
  checkRepeatability,
  checkFramerateIndependence,
  checkSeedMatters,
  checkNoMathRandom,
  checkRngContract,
  checkChecksumSensitivity,
  checkHasherStability,
  checkBotDeterminism,
  checkBotsDoNotDesyncOnFramerate,
  checkBotsFightAndSeparate,
  checkCollisionSeparatesBodies,
  checkNothingEscapesTheRoom,
  checkDeathSystem,
  checkReviveRequiresSustainedChannel,
  checkBotsReviveEachOther,
  checkFloorGenerationIsSeeded,
  checkDoorsLockDuringCombat,
  checkPartyMakesFloorProgress,
  checkLeashIsWindowIndependent,
  checkAllAbilitiesFire,
  checkClassesActuallyDiffer,
  checkDashHitsEachEnemyOnce,
  checkControllerInputIsCleared,
  checkRescuerDoesNotThrash,
  checkPartyWipeEndsRun,
  checkPartyReachesBreakpoints,
  checkEveryDirectionGrantsItsBreakpoints,
  checkAxisPoolsRotate,
  checkDerivedStatsAreRecomputed,
  checkTransformationsChangeCombat,
  checkOffersHoldTheDoors,
  checkHeartsGoToTheHurt,
] as const;

export function runAll(): CheckResult[] {
  return CHECKS.map((check) => check());
}

function main(): void {
  const results = runAll();
  let failed = 0;

  console.log('\ndeterminism harness\n');
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n        ${r.detail}`);
  }
  console.log(
    `\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ''}\n`,
  );

  if (failed > 0 && typeof process !== 'undefined') process.exitCode = 1;
}

main();
