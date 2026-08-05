/**
 * The abstract input contract. Hard constraint #1: game code reads this and
 * nothing else. No key codes, no mouse coordinates, no gamepad axes past this
 * boundary — that is what lets a touch backend be added later without
 * touching gameplay.
 *
 * Constraint #2 — four-input budget: three combat abilities plus one context
 * action. `ability` is fixed at length 3 by the type, deliberately. Adding a
 * fourth combat binding is a design decision (manual §3.3), not a code change.
 */

/** A direction in world space, magnitude clamped to [0, 1]. */
export interface Vec2 {
  x: number;
  y: number;
}

/** Ability slots, per manual §16.0. */
export const enum AbilitySlot {
  /** Slot 1 — Traversal. Space / A. */
  Traversal = 0,
  /** Slot 2 — Signature. RMB / RT. Analog: supports held abilities. */
  Signature = 1,
  /** Slot 3 — Payoff. Shift / RB. */
  Payoff = 2,
}

/** Per-button state. `pressed`/`released` are true only on the tick of the edge. */
export interface ButtonState {
  /** Held this tick. */
  down: boolean;
  /** Went down on this tick. */
  pressed: boolean;
  /** Came up on this tick. */
  released: boolean;
  /** Analog depth in [0, 1]. Digital sources report 0 or 1. */
  value: number;
}

export interface InputState {
  /** Movement direction, magnitude 0..1. Never a raw key or axis. */
  moveVector: Vec2;

  /**
   * Target override (§16.5b). A *direction* the player wants to focus, not a
   * point to aim at. `active` is false when the player is letting auto-target
   * do its job.
   */
  targetOverride: { active: boolean; direction: Vec2 };

  /** Exactly three combat abilities. See constraint #2. */
  ability: [ButtonState, ButtonState, ButtonState];

  /** Slot 4 — context action (pick up, revive, interact). E / X. */
  contextAction: ButtonState;

  /** Conditional active item. Q / LB. Not part of the four-input budget. */
  activeItem: ButtonState;
}

export function makeButtonState(): ButtonState {
  return { down: false, pressed: false, released: false, value: 0 };
}

export function makeInputState(): InputState {
  return {
    moveVector: { x: 0, y: 0 },
    targetOverride: { active: false, direction: { x: 0, y: 0 } },
    ability: [makeButtonState(), makeButtonState(), makeButtonState()],
    contextAction: makeButtonState(),
    activeItem: makeButtonState(),
  };
}

/** Copy without reallocating. Used to hand a controller's input to the sim. */
export function copyInputState(src: InputState, dst: InputState): void {
  dst.moveVector.x = src.moveVector.x;
  dst.moveVector.y = src.moveVector.y;
  dst.targetOverride.active = src.targetOverride.active;
  dst.targetOverride.direction.x = src.targetOverride.direction.x;
  dst.targetOverride.direction.y = src.targetOverride.direction.y;
  copyButton(src.ability[0], dst.ability[0]);
  copyButton(src.ability[1], dst.ability[1]);
  copyButton(src.ability[2], dst.ability[2]);
  copyButton(src.contextAction, dst.contextAction);
  copyButton(src.activeItem, dst.activeItem);
}

function copyButton(src: ButtonState, dst: ButtonState): void {
  dst.down = src.down;
  dst.pressed = src.pressed;
  dst.released = src.released;
  dst.value = src.value;
}

/** Reset to neutral without reallocating — the sim reads this every tick. */
export function clearInputState(s: InputState): void {
  s.moveVector.x = 0;
  s.moveVector.y = 0;
  s.targetOverride.active = false;
  s.targetOverride.direction.x = 0;
  s.targetOverride.direction.y = 0;
  clearButton(s.ability[0]);
  clearButton(s.ability[1]);
  clearButton(s.ability[2]);
  clearButton(s.contextAction);
  clearButton(s.activeItem);
}

function clearButton(b: ButtonState): void {
  b.down = false;
  b.pressed = false;
  b.released = false;
  b.value = 0;
}

/**
 * Derive edge flags by comparing this tick's `down` against the previous
 * tick's. Backends only report `down` and `value`; edges are computed once,
 * here, so every backend gets identical semantics.
 */
export function applyEdges(current: ButtonState, wasDown: boolean): void {
  current.pressed = current.down && !wasDown;
  current.released = !current.down && wasDown;
}

/** Clamp a vector to unit length, preserving direction. */
export function clampToUnit(v: Vec2): void {
  const lenSq = v.x * v.x + v.y * v.y;
  if (lenSq > 1) {
    const len = Math.sqrt(lenSq);
    v.x /= len;
    v.y /= len;
  }
}
