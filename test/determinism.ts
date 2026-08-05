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
import { DEATH, ENEMY, PARTY_SIZE, PLAYER, ROOM, SIM } from '../src/core/constants';
import { FixedLoop } from '../src/core/fixed-loop';
import { Rng } from '../src/core/rng';
import { LifeState, lifeStateName } from '../src/game/life-state';
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

/** Step a world straight through a script, one tick per entry. The three bot
 *  slots drive themselves inside the step. */
function runDirect(seed: string, script: readonly InputState[], humanSlots = 1): World {
  const world = new World(seed, humanSlots);
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
  const loop = new FixedLoop();
  const targetTicks = script.length;

  let frame = 0;
  // Bounded so a bug in the loop can't hang the harness.
  const maxFrames = targetTicks * 10 + 1000;

  while (world.tick < targetTicks && frame < maxFrames) {
    const delta = frameDeltas[frame % frameDeltas.length]!;
    // Use the dt the loop hands us rather than assuming SIM.STEP_SECONDS —
    // otherwise a loop that started leaking real frame time into dt would
    // sail straight through this check.
    loop.advance(delta, (dt) => {
      if (world.tick >= targetTicks) return; // ignore overshoot past the target
      world.setInput(0, script[world.tick] ?? NEUTRAL);
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
  // would pass every determinism check ever written.
  let moved = 0;
  for (let i = 1; i < a.party.length; i++) {
    const player = a.party[i]!.player;
    const spawnDrift = Math.hypot(player.x - ROOM.WIDTH / 2, player.y - ROOM.HEIGHT / 2);
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
  const engaged = world.wavesCleared > 0 || world.enemiesRemaining < world.enemies.length;

  // Collision keeps bodies from overlapping; steering keeps them from piling.
  const separated = minPairDistance >= PLAYER.RADIUS * 2 - 1;

  return {
    name: 'bots engage and stay separated',
    pass: separated && engaged,
    detail:
      separated && engaged
        ? `closest pair ${minPairDistance.toFixed(0)}u apart, ${world.wavesCleared} waves cleared`
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
      const maxX = ROOM.WIDTH - ROOM.WALL - b.radius;
      const minY = ROOM.WALL + b.radius;
      const maxY = ROOM.HEIGHT - ROOM.WALL - b.radius;
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

  victim.takeDamage(PLAYER.MAX_HP);
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

  victim.takeDamage(PLAYER.MAX_HP);
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

  const revived = lifeOf(victim) === LifeState.Alive && victim.hp === DEATH.REVIVE_HP;
  return {
    name: 'revive needs an unbroken channel',
    pass: revived,
    detail: revived
      ? `interrupt reset ${progressBeforeInterrupt} ticks; an unbroken 3s channel revived at ${DEATH.REVIVE_HP}hp`
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
    slot.player.x = ROOM.WIDTH / 2;
    slot.player.y = ROOM.HEIGHT / 2;
  }
  victim.takeDamage(PLAYER.MAX_HP);

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
    slot.player.x = ROOM.WIDTH / 2;
    slot.player.y = ROOM.HEIGHT / 2;
  }
  victim.takeDamage(PLAYER.MAX_HP);

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

  victim.x = ROOM.WIDTH / 2;
  victim.y = ROOM.HEIGHT / 2;
  // One bot close, two far — the far ones are the tempting re-elections.
  const offsets = [70, 260, 430];
  world.party.slice(1).forEach((slot, i) => {
    slot.player.x = ROOM.WIDTH / 2 + offsets[i]!;
    slot.player.y = ROOM.HEIGHT / 2;
  });
  victim.takeDamage(PLAYER.MAX_HP);

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

export function checkPartyWipeEndsRun(): CheckResult {
  // §8 `[LOCKED]`: total party wipe ends the run. No compromise.
  const world = new World('wipe-seed', 0);
  if (world.runOver) {
    return { name: 'party wipe ends the run', pass: false, detail: 'run started already over' };
  }

  for (const slot of world.party) slot.player.takeDamage(PLAYER.MAX_HP);

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
  checkControllerInputIsCleared,
  checkRescuerDoesNotThrash,
  checkPartyWipeEndsRun,
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
