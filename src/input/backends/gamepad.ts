import type { InputBackend } from '../backend';
import type { InputState } from '../input-state';
import { clampToUnit } from '../input-state';

/**
 * Gamepad backend, standard mapping. Manual §16.0:
 *
 *   Move            left stick
 *   Target override right stick flick
 *   Slot 1          A   (button 0)
 *   Slot 2          RT  (button 7, analog — held abilities read `value`)
 *   Slot 3          RB  (button 5)
 *   Slot 4          X   (button 2)
 *   Active item     LB  (button 4)
 *
 * LT, Y and the remaining shoulder stay unbound on purpose. Do not spend them.
 *
 * §16.5b: gamepad support from day one is the early-warning system for a
 * later touch port — a pad is structurally closer to a thumb than a mouse is.
 */

const BUTTON = {
  A: 0,
  X: 2,
  LB: 4,
  RB: 5,
  RT: 7,
} as const;

const AXIS = {
  LEFT_X: 0,
  LEFT_Y: 1,
  RIGHT_X: 2,
  RIGHT_Y: 3,
} as const;

/** Radial deadzone, applied to the magnitude rather than per-axis so that
 *  diagonals aren't clipped into a square. */
const STICK_DEADZONE = 0.24;

/** The right stick must be pushed at least this far to count as an override
 *  flick — resting drift must never steal the auto-target. */
const OVERRIDE_THRESHOLD = 0.5;

/** Analog triggers rest slightly above zero on worn hardware. */
const TRIGGER_THRESHOLD = 0.15;

export class GamepadBackend implements InputBackend {
  readonly id = 'gamepad';

  private activeThisSample = false;

  sample(out: InputState): void {
    this.activeThisSample = false;

    const pad = this.firstConnectedPad();
    if (!pad) return;

    // --- Move -------------------------------------------------------------
    const lx = pad.axes[AXIS.LEFT_X] ?? 0;
    const ly = pad.axes[AXIS.LEFT_Y] ?? 0;
    const moveMag = applyDeadzone(Math.hypot(lx, ly));
    if (moveMag > 0) {
      const raw = Math.hypot(lx, ly) || 1;
      out.moveVector.x = (lx / raw) * moveMag;
      out.moveVector.y = (ly / raw) * moveMag;
      clampToUnit(out.moveVector);
      this.activeThisSample = true;
    }

    // --- Target override --------------------------------------------------
    const rx = pad.axes[AXIS.RIGHT_X] ?? 0;
    const ry = pad.axes[AXIS.RIGHT_Y] ?? 0;
    const aimMag = Math.hypot(rx, ry);
    if (aimMag >= OVERRIDE_THRESHOLD) {
      out.targetOverride.active = true;
      out.targetOverride.direction.x = rx / aimMag;
      out.targetOverride.direction.y = ry / aimMag;
      this.activeThisSample = true;
    }

    // --- Abilities --------------------------------------------------------
    this.setButton(out.ability[0], pad, BUTTON.A);
    this.setAnalog(out.ability[1], pad, BUTTON.RT);
    this.setButton(out.ability[2], pad, BUTTON.RB);
    this.setButton(out.contextAction, pad, BUTTON.X);
    this.setButton(out.activeItem, pad, BUTTON.LB);
  }

  isActive(): boolean {
    return this.activeThisSample;
  }

  destroy(): void {
    /* Nothing to unbind — the Gamepad API is polled, not evented. */
  }

  // --- internals ----------------------------------------------------------

  /**
   * Lowest-index connected pad wins. Deterministic ordering matters: when
   * local multiplayer lands, pads are assigned by index, never by connection
   * order or object iteration.
   */
  private firstConnectedPad(): Gamepad | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (let i = 0; i < pads.length; i++) {
      const pad = pads[i];
      if (pad && pad.connected) return pad;
    }
    return null;
  }

  private setButton(
    target: { down: boolean; value: number },
    pad: Gamepad,
    index: number,
  ): void {
    const button = pad.buttons[index];
    if (!button || !button.pressed) return;
    target.down = true;
    target.value = 1;
    this.activeThisSample = true;
  }

  /** Analog variant — slot 2 needs trigger depth for held abilities. */
  private setAnalog(
    target: { down: boolean; value: number },
    pad: Gamepad,
    index: number,
  ): void {
    const button = pad.buttons[index];
    if (!button) return;
    const value = button.value > 0 ? button.value : button.pressed ? 1 : 0;
    if (value <= TRIGGER_THRESHOLD) return;
    target.down = true;
    target.value = value;
    this.activeThisSample = true;
  }
}

/** Rescale magnitude so input just past the deadzone starts from zero, not
 *  from a step. */
function applyDeadzone(magnitude: number): number {
  if (magnitude <= STICK_DEADZONE) return 0;
  return Math.min(1, (magnitude - STICK_DEADZONE) / (1 - STICK_DEADZONE));
}
