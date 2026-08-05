import type { InputBackend } from './backend';
import type { ButtonState, InputState } from './input-state';
import { applyEdges, clampToUnit, clearInputState, makeInputState } from './input-state';

/**
 * Owns the backends and produces the single abstract InputState the game
 * reads. Backends are merged rather than switched, so a player can hold WASD
 * and flick the right stick in the same tick without anything breaking.
 *
 * `sample()` is called once per *simulation tick*. That is deliberate: the
 * resulting state is the exact per-tick input frame that lockstep will later
 * serialize and send to peers.
 */
export class InputManager {
  private readonly backends: InputBackend[] = [];
  private readonly state: InputState = makeInputState();

  /** Previous tick's `down` flags, for deriving pressed/released centrally. */
  private readonly wasDown = {
    ability: [false, false, false] as [boolean, boolean, boolean],
    contextAction: false,
    activeItem: false,
  };

  /** Which device the player last actually used — drives button prompts. */
  private lastActiveId: string | null = null;

  add(backend: InputBackend): this {
    this.backends.push(backend);
    return this;
  }

  /** The state for this tick. Read-only from the game's point of view. */
  get current(): InputState {
    return this.state;
  }

  get activeBackendId(): string | null {
    return this.lastActiveId;
  }

  sample(): InputState {
    const s = this.state;

    this.wasDown.ability[0] = s.ability[0].down;
    this.wasDown.ability[1] = s.ability[1].down;
    this.wasDown.ability[2] = s.ability[2].down;
    this.wasDown.contextAction = s.contextAction.down;
    this.wasDown.activeItem = s.activeItem.down;

    clearInputState(s);

    // Fixed iteration order over an array — never a Set or object keys.
    for (let i = 0; i < this.backends.length; i++) {
      const backend = this.backends[i]!;
      backend.sample(s);
      if (backend.isActive()) this.lastActiveId = backend.id;
    }

    // Two backends both contributing movement can exceed unit length.
    clampToUnit(s.moveVector);

    applyEdges(s.ability[0], this.wasDown.ability[0]);
    applyEdges(s.ability[1], this.wasDown.ability[1]);
    applyEdges(s.ability[2], this.wasDown.ability[2]);
    applyEdges(s.contextAction, this.wasDown.contextAction);
    applyEdges(s.activeItem, this.wasDown.activeItem);

    return s;
  }

  destroy(): void {
    for (const backend of this.backends) backend.destroy();
    this.backends.length = 0;
  }
}

/** Convenience for debug overlays. */
export function buttonLabel(b: ButtonState): string {
  if (b.pressed) return 'PRESS';
  if (b.down) return b.value < 1 ? b.value.toFixed(2) : 'HELD';
  return '·';
}
