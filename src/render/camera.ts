import { CAMERA, VIEW } from '../core/constants';
import type { Player } from '../game/entities/player';
import { LifeState } from '../game/life-state';

/**
 * Shared dynamic camera — §2 `[DEFAULT]`.
 *
 * "Shared dynamic camera that zooms to fit, plus a soft leash." Split-screen
 * on separation is `[CUT]` — expensive and unreadable at four.
 *
 * **This is render-only.** It reads the world and never writes to it. The
 * leash that actually damages a straggler lives in the simulation and is
 * defined in world units, precisely so it cannot depend on window size — see
 * LEASH in constants.ts. The camera and the leash both follow the same
 * `World.centroid`, so what you see and what the rules do agree.
 *
 * The zoom floor is the important number. §16.5 and Pillar 3 both say a
 * camera zoomed to fit four scattered players makes each one a few pixels
 * tall. So the zoom stops at CAMERA.MIN_ZOOM and the leash takes over.
 */
export class PartyCamera {
  private x = 0;
  private y = 0;
  private zoom = 1;
  private initialised = false;

  /** Current values, for the renderer to apply. */
  get scrollX(): number {
    return this.x;
  }
  get scrollY(): number {
    return this.y;
  }
  get scale(): number {
    return this.zoom;
  }

  reset(): void {
    this.initialised = false;
  }

  /**
   * @param players   the party
   * @param centroidX sim-side centroid; shared with the leash
   * @param roomW     room dimensions, for clamping
   */
  update(
    players: readonly Player[],
    centroidX: number,
    centroidY: number,
    roomW: number,
    roomH: number,
    dt: number,
  ): void {
    // Fit the living party. Wraiths are excluded for the same reason the
    // centroid excludes them: a dead player drifting the room would drag the
    // frame off the fight.
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let counted = 0;

    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      if (p.life === LifeState.Wraith) continue;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
      counted++;
    }

    if (counted === 0) {
      minX = maxX = centroidX;
      minY = maxY = centroidY;
    }

    const spanX = maxX - minX + CAMERA.PADDING * 2;
    const spanY = maxY - minY + CAMERA.PADDING * 2;

    // Zoom to fit the party, then clamp. Below MIN_ZOOM the characters stop
    // being readable, which Pillar 3 vetoes, so the frame simply refuses to
    // pull back further and the straggler goes off-screen.
    let targetZoom = Math.min(VIEW.WIDTH / spanX, VIEW.HEIGHT / spanY);
    targetZoom = Math.max(CAMERA.MIN_ZOOM, Math.min(CAMERA.MAX_ZOOM, targetZoom));

    // A room smaller than the frame should never letterbox the walls away.
    const fitRoom = Math.min(VIEW.WIDTH / roomW, VIEW.HEIGHT / roomH);
    if (fitRoom > targetZoom) targetZoom = Math.min(CAMERA.MAX_ZOOM, fitRoom);

    const viewW = VIEW.WIDTH / targetZoom;
    const viewH = VIEW.HEIGHT / targetZoom;

    let targetX = centroidX - viewW / 2;
    let targetY = centroidY - viewH / 2;

    // Clamp to the room, or centre it when the room is smaller than the view.
    targetX = viewW >= roomW ? (roomW - viewW) / 2 : clamp(targetX, 0, roomW - viewW);
    targetY = viewH >= roomH ? (roomH - viewH) / 2 : clamp(targetY, 0, roomH - viewH);

    if (!this.initialised) {
      this.x = targetX;
      this.y = targetY;
      this.zoom = targetZoom;
      this.initialised = true;
      return;
    }

    // Frame-rate independent exponential smoothing. Using a fixed per-frame
    // factor would make the camera feel different at 60 and 144fps.
    const t = 1 - Math.exp(-CAMERA.LERP * dt);
    this.x += (targetX - this.x) * t;
    this.y += (targetY - this.y) * t;
    this.zoom += (targetZoom - this.zoom) * t;
  }

  /** Snap without smoothing — used on a room transition, where easing across
   *  the cut would read as the camera flying through a wall. */
  snap(): void {
    this.initialised = false;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
