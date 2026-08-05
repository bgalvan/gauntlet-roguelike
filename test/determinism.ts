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
import { SIM } from '../src/core/constants';
import { FixedLoop } from '../src/core/fixed-loop';
import { Rng } from '../src/core/rng';
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

/** Step a world straight through a script, one tick per entry. */
function runDirect(seed: string, script: readonly InputState[]): World {
  const world = new World(seed);
  for (let t = 0; t < script.length; t++) {
    world.step(SIM.STEP_SECONDS, script[t] ?? NEUTRAL);
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
      world.step(dt, script[world.tick] ?? NEUTRAL);
    });
    frame++;
  }

  return world;
}

/** Full per-tick trace, not just the end state — catches divergence that
 *  happens to converge again by the last tick. */
function traceChecksums(seed: string, script: readonly InputState[]): string[] {
  const world = new World(seed);
  const trace: string[] = [];
  for (let t = 0; t < script.length; t++) {
    world.step(SIM.STEP_SECONDS, script[t] ?? NEUTRAL);
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

  world.player.x = nextAfter(world.player.x);
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
