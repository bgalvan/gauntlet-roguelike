/**
 * Synthesized sound. **Render-only** — never touches the simulation.
 *
 * Everything is generated with oscillators rather than loaded from files:
 * zero assets, zero download, and it means the prototype has audio feedback
 * now instead of after someone sources samples. It is placeholder sound and
 * should be replaced, but silence makes combat feel broken in a way that
 * misleads playtesting.
 *
 * Browsers block audio until a user gesture, so `unlock()` is called from the
 * first real input on the select screen.
 */
export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private enabled = true;

  /** Cheap throttle: a Shockwave can emit 20 hit events on one tick, and 20
   *  simultaneous oscillators is noise plus a CPU spike. */
  private lastPlayMs = new Map<string, number>();

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.28;
      this.master.connect(this.ctx.destination);
    } catch {
      // Audio is a nicety. If the context cannot be created, stay silent
      // rather than breaking the game.
      this.ctx = null;
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 0.28 : 0;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  // --- voices --------------------------------------------------------------

  hit(): void {
    this.blip('hit', 30, { type: 'square', from: 320, to: 140, duration: 0.07, gain: 0.32 });
  }

  kill(): void {
    this.blip('kill', 40, { type: 'sawtooth', from: 260, to: 60, duration: 0.19, gain: 0.4 });
    this.noise('killn', 40, 0.16, 0.22);
  }

  shoot(): void {
    this.blip('shoot', 45, { type: 'triangle', from: 720, to: 420, duration: 0.06, gain: 0.16 });
  }

  ability(): void {
    this.blip('ability', 60, { type: 'square', from: 180, to: 620, duration: 0.16, gain: 0.26 });
  }

  payoff(): void {
    this.blip('payoff', 120, { type: 'sawtooth', from: 90, to: 420, duration: 0.42, gain: 0.42 });
    this.noise('payoffn', 120, 0.4, 0.3);
  }

  hurt(): void {
    this.blip('hurt', 90, { type: 'square', from: 190, to: 70, duration: 0.16, gain: 0.34 });
  }

  downed(): void {
    this.blip('downed', 300, { type: 'sawtooth', from: 300, to: 40, duration: 0.6, gain: 0.4 });
  }

  revived(): void {
    this.blip('revived', 200, { type: 'triangle', from: 300, to: 900, duration: 0.35, gain: 0.34 });
  }

  waveClear(): void {
    this.blip('wave', 400, { type: 'triangle', from: 440, to: 880, duration: 0.4, gain: 0.3 });
  }

  uiMove(): void {
    this.blip('ui', 40, { type: 'square', from: 480, to: 560, duration: 0.05, gain: 0.14 });
  }

  uiConfirm(): void {
    this.blip('uiok', 60, { type: 'triangle', from: 520, to: 1040, duration: 0.18, gain: 0.24 });
  }

  // --- internals -----------------------------------------------------------

  private throttled(key: string, minGapMs: number): boolean {
    const ctx = this.ctx;
    if (!ctx) return true;
    const now = ctx.currentTime * 1000;
    const last = this.lastPlayMs.get(key) ?? -Infinity;
    if (now - last < minGapMs) return true;
    this.lastPlayMs.set(key, now);
    return false;
  }

  private blip(
    key: string,
    minGapMs: number,
    opts: { type: OscillatorType; from: number; to: number; duration: number; gain: number },
  ): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.enabled) return;
    if (this.throttled(key, minGapMs)) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = opts.type;
    osc.frequency.setValueAtTime(opts.from, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.to), now + opts.duration);

    // Fast attack, exponential release — a percussive envelope.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(opts.gain, now + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + opts.duration);

    osc.connect(gain);
    gain.connect(master);
    osc.start(now);
    osc.stop(now + opts.duration + 0.02);
  }

  /** Filtered white noise — the body of an impact. */
  private noise(key: string, minGapMs: number, duration: number, gainValue: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.enabled) return;
    if (this.throttled(key, minGapMs)) return;

    const frames = Math.floor(ctx.sampleRate * duration);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      // Decaying noise. Math.random is fine here: this is audio, it can never
      // reach the simulation.
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1100;

    const gain = ctx.createGain();
    gain.gain.value = gainValue;

    src.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    src.start();
  }
}

/** One instance for the whole app — audio contexts are a limited resource. */
export const audio = new GameAudio();
