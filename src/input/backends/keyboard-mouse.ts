import type { InputBackend } from '../backend';
import type { InputState, Vec2 } from '../input-state';
import { clampToUnit } from '../input-state';

/**
 * Mouse + keyboard backend. Mapping is manual §16.0 and is not to be extended
 * — the free keys are deliberately free (constraint #2).
 *
 *   Move            WASD / arrows
 *   Target override cursor / LMB
 *   Slot 1          Space
 *   Slot 2          RMB
 *   Slot 3          Shift
 *   Slot 4          E
 *   Active item     Q
 */

/** How long after the last cursor movement the pointer still counts as an
 *  intentional override. Feel constant, not a design decision. */
const CURSOR_ACTIVE_MS = 800;

/** Where the local player currently is, in *screen* pixels. The mouse gives a
 *  position; the abstract contract wants a direction, so the backend needs a
 *  reference point to subtract. Supplied by the renderer, which is the only
 *  thing that knows about pixels. */
export type ScreenOriginProvider = () => Vec2 | null;

export class KeyboardMouseBackend implements InputBackend {
  readonly id = 'keyboard-mouse';

  private readonly held = new Set<string>();
  /** Keys that went down *and* up between two samples — without this, a tap
   *  shorter than one sim tick is silently dropped. */
  private readonly tapped = new Set<string>();

  private pointerX = 0;
  private pointerY = 0;
  private lastPointerMoveMs = -Infinity;
  private leftDown = false;
  private rightDown = false;
  private rightTapped = false;
  private leftTapped = false;

  private activeThisSample = false;
  private nowMs = 0;

  constructor(
    private readonly target: HTMLElement,
    private readonly originProvider: ScreenOriginProvider,
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    target.addEventListener('pointermove', this.onPointerMove);
    target.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    // The right mouse button is slot 2; the browser menu would eat it.
    target.addEventListener('contextmenu', this.onContextMenu);
  }

  /** Called by the manager before sampling, so the backend never reads a clock
   *  the sim doesn't control. */
  setNow(nowMs: number): void {
    this.nowMs = nowMs;
  }

  sample(out: InputState): void {
    this.activeThisSample = false;

    // --- Move -------------------------------------------------------------
    const up = this.key('KeyW') || this.key('ArrowUp');
    const down = this.key('KeyS') || this.key('ArrowDown');
    const left = this.key('KeyA') || this.key('ArrowLeft');
    const right = this.key('KeyD') || this.key('ArrowRight');

    const mx = (right ? 1 : 0) - (left ? 1 : 0);
    const my = (down ? 1 : 0) - (up ? 1 : 0);
    if (mx !== 0 || my !== 0) {
      out.moveVector.x = mx;
      out.moveVector.y = my;
      clampToUnit(out.moveVector);
      this.activeThisSample = true;
    }

    // --- Target override --------------------------------------------------
    const cursorFresh = this.nowMs - this.lastPointerMoveMs < CURSOR_ACTIVE_MS;
    const clicked = this.leftDown || this.leftTapped;
    if (cursorFresh || clicked) {
      const origin = this.originProvider();
      if (origin) {
        const dx = this.pointerX - origin.x;
        const dy = this.pointerY - origin.y;
        const len = Math.hypot(dx, dy);
        if (len > 1) {
          out.targetOverride.active = true;
          out.targetOverride.direction.x = dx / len;
          out.targetOverride.direction.y = dy / len;
        }
      }
      if (clicked) this.activeThisSample = true;
    }

    // --- Abilities (§16.0) ------------------------------------------------
    this.setDigital(out.ability[0], this.key('Space'));
    this.setDigital(out.ability[1], this.rightDown || this.rightTapped);
    this.setDigital(out.ability[2], this.key('ShiftLeft') || this.key('ShiftRight'));
    this.setDigital(out.contextAction, this.key('KeyE'));
    this.setDigital(out.activeItem, this.key('KeyQ'));

    this.tapped.clear();
    this.rightTapped = false;
    this.leftTapped = false;
  }

  isActive(): boolean {
    return this.activeThisSample;
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.target.removeEventListener('pointermove', this.onPointerMove);
    this.target.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.target.removeEventListener('contextmenu', this.onContextMenu);
  }

  // --- internals ----------------------------------------------------------

  private key(code: string): boolean {
    return this.held.has(code) || this.tapped.has(code);
  }

  private setDigital(button: { down: boolean; value: number }, isDown: boolean): void {
    if (!isDown) return;
    button.down = true;
    button.value = 1;
    this.activeThisSample = true;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    this.held.add(e.code);
    this.tapped.add(e.code);
    // Space and arrows scroll the page otherwise.
    if (SWALLOWED_KEYS.has(e.code)) e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  /** Losing focus with keys held would leave the player walking forever. */
  private readonly onBlur = (): void => {
    this.held.clear();
    this.leftDown = false;
    this.rightDown = false;
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    this.pointerX = e.clientX;
    this.pointerY = e.clientY;
    this.lastPointerMoveMs = this.nowMs;
  };

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    this.pointerX = e.clientX;
    this.pointerY = e.clientY;
    if (e.button === 0) {
      this.leftDown = true;
      this.leftTapped = true;
    }
    if (e.button === 2) {
      this.rightDown = true;
      this.rightTapped = true;
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    if (e.button === 0) this.leftDown = false;
    if (e.button === 2) this.rightDown = false;
  };

  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault();
  };
}

const SWALLOWED_KEYS = new Set([
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);
