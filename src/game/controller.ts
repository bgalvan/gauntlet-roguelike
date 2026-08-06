import type { Hasher } from '../core/checksum';
import type { InputState } from '../input/input-state';
import { clearInputState, copyInputState } from '../input/input-state';
import type { Entity } from './entities/entity';
import type { Pickup } from './entities/pickup';
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
/**
 * What a controller needs to know about the room it is standing in. Rooms
 * vary in size now (§2 templates), so a controller cannot assume one fixed
 * arena.
 */
export interface RoomBounds {
  readonly width: number;
  readonly height: number;
  /** Nearest open exit, or null while the doors are barred by combat (§2). */
  readonly exit: { readonly x: number; readonly y: number } | null;
  /**
   * True when the party contains no externally-driven player.
   *
   * Bots gather at the exit but do not step through it while a human is
   * present — §2 locks doors specifically so nobody gets dragged ahead, and a
   * bot walking into a doorway would drag the whole party through. With no
   * human in the party there is nobody to wait for, so bots lead.
   */
  readonly botsLead: boolean;
  /** Hearts on the floor (§7.2). Hearts are the only healing in the game, so
   *  a controller that ignored them would have no answer to attrition. */
  readonly pickups: readonly Pickup[];
}

export interface PlayerController {
  readonly kind: 'human' | 'bot';

  /** Write this slot's input for the coming tick into `out`. */
  produceInput(
    self: Player,
    allies: readonly Player[],
    enemies: readonly Entity[],
    room: RoomBounds,
    out: InputState,
  ): void;

  /**
   * Answer a pending §4 upgrade offer: 0 for the first direction, 1 for the
   * second.
   *
   * Optional because a human answers with the input they already produce —
   * the offer reads `moveVector` to move the highlight and the context action
   * to commit, so no fifth binding appears (constraint #2). A bot has no
   * input for a menu, so it decides here instead, from world state plus its
   * own forked PRNG. Same rule as its movement: peers derive the identical
   * choice without exchanging anything.
   */
  chooseUpgrade?(self: Player, optionA: number, optionB: number): number;

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
    _room: RoomBounds,
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
