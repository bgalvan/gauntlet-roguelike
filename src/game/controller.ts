import type { Hasher } from '../core/checksum';
import type { InputState } from '../input/input-state';
import { clearInputState, copyInputState } from '../input/input-state';
import type { Entity } from './entities/entity';
import type { Player } from './entities/player';

/**
 * Something that drives a player slot.
 *
 * The important property: a controller produces an **InputState**, exactly
 * like a human at a keyboard. It never touches entity positions directly.
 *
 * That is what makes bots useful as testing infrastructure rather than a
 * parallel code path — a bot exercises the same `Player.step` a human does,
 * so anything a bot proves about movement or targeting is a fact about the
 * real game. It also means a bot can be swapped for a human, a replay, or a
 * remote peer's input stream without the simulation noticing.
 */
export interface PlayerController {
  readonly kind: 'human' | 'bot';

  /** Write this slot's input for the coming tick into `out`. */
  produceInput(
    self: Player,
    allies: readonly Player[],
    enemies: readonly Entity[],
    out: InputState,
  ): void;

  /** Contribute any state that affects future input to the desync checksum.
   *  A bot's RNG belongs here; a human's does not exist. */
  writeChecksum?(h: Hasher): void;
}

/**
 * A slot fed from outside the simulation — a local player at a keyboard, and
 * later a remote peer's input frame or a replay log. All three are the same
 * thing from the sim's point of view.
 */
export class HumanController implements PlayerController {
  readonly kind = 'human';

  /** The most recent input handed in for this slot. */
  private readonly pending: InputState;

  constructor(pending: InputState) {
    this.pending = pending;
  }

  produceInput(
    _self: Player,
    _allies: readonly Player[],
    _enemies: readonly Entity[],
    out: InputState,
  ): void {
    copyInputState(this.pending, out);
  }

  /** Called from outside the sim, before the step. */
  set(state: InputState): void {
    copyInputState(state, this.pending);
  }

  /** Drop held inputs — window blur, disconnect, pause. */
  clear(): void {
    clearInputState(this.pending);
  }
}
