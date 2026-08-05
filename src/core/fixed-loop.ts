import { SIM } from './constants';

/**
 * Fixed-timestep accumulator. Hard constraint #3: the simulation advances in
 * identical discrete steps regardless of framerate, so two machines running
 * the same inputs produce the same state.
 *
 * Render is decoupled: `alpha` is the fraction of the way into the next
 * pending step, for interpolating visuals between sim states.
 */
export class FixedLoop {
  /** Accumulated unconsumed real time, in milliseconds. */
  private accumulator = 0;

  /** Monotonic count of simulation steps run since start. This is the tick a
   *  lockstep peer would agree on. */
  private tick = 0;

  /** Interpolation factor in [0, 1) between the last and next sim state. */
  private alphaValue = 0;

  /**
   * Feed real elapsed time and run as many fixed steps as it buys.
   *
   * @param deltaMs real time since the previous frame, in ms
   * @param step    called once per simulation step
   */
  advance(deltaMs: number, step: (dt: number, tick: number) => void): void {
    // Spiral-of-death guard: a stalled tab or a breakpoint can hand us a
    // multi-second delta. Drop the excess rather than trying to catch up —
    // in lockstep the peers would stall anyway.
    this.accumulator += Math.min(deltaMs, SIM.MAX_FRAME_MS);

    let steps = 0;
    while (this.accumulator >= SIM.STEP_MS && steps < SIM.MAX_STEPS_PER_FRAME) {
      step(SIM.STEP_SECONDS, this.tick);
      this.tick++;
      this.accumulator -= SIM.STEP_MS;
      steps++;
    }

    this.alphaValue = this.accumulator / SIM.STEP_MS;
  }

  get alpha(): number {
    return this.alphaValue;
  }

  get currentTick(): number {
    return this.tick;
  }
}
