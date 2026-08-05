import type { InputState } from './input-state';

/**
 * A source of input. Backends translate one physical device family into the
 * abstract state and know nothing about the game.
 *
 * Adding touch later means adding a file here — no gameplay code changes.
 */
export interface InputBackend {
  readonly id: string;

  /**
   * Write this backend's contribution into `out`.
   *
   * Called once per *simulation tick*, not per render frame — sampling at the
   * sim rate is what makes an input stream replayable and what a lockstep
   * peer will later serialize.
   *
   * Only set `down`/`value` and the vectors; edge flags are derived centrally.
   */
  sample(out: InputState): void;

  /** True if the device produced any input this tick — used to pick the
   *  active backend for UI prompts (show "Space" vs. show "A"). */
  isActive(): boolean;

  destroy(): void;
}
