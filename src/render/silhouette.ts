import type Phaser from 'phaser';

import { Silhouette } from '../game/classes';

/**
 * Class silhouettes — Pillar 1, `[LOCKED]`: "identify each class by shape and
 * screen effect alone."
 *
 * These are genuinely different outlines, not one circle in four colours.
 * Colour alone fails the pillar as written, and fails colourblind players
 * outright. Placeholder geometry, but the *shape language* is the thing being
 * prototyped, so it has to differ from day one.
 *
 * Drawn with path commands rather than `fillPoints`, which would need a fresh
 * array of Vector2 objects per body per frame — 4 players × 60fps of garbage
 * for no benefit (constraint #4).
 */

/** Scratch buffer for polygon points; reused across every call. */
const pts: number[] = [];

export function drawSilhouette(
  g: Phaser.GameObjects.Graphics,
  shape: Silhouette,
  x: number,
  y: number,
  radius: number,
  facingX: number,
  facingY: number,
  fill: number,
  rim: number,
  alpha = 1,
): void {
  const angle = Math.atan2(facingY, facingX);
  pts.length = 0;

  switch (shape) {
    case Silhouette.Blade: {
      // Warrior: an aggressive forward wedge.
      push(pts, x, y, angle, radius * 1.55);
      push(pts, x, y, angle + 2.4, radius * 1.0);
      push(pts, x, y, angle + Math.PI, radius * 0.52);
      push(pts, x, y, angle - 2.4, radius * 1.0);
      polygon(g, pts, fill, rim, alpha, 2);
      break;
    }

    case Silhouette.Bow: {
      // Archer: a lean chevron — reads fast and light.
      push(pts, x, y, angle, radius * 1.5);
      push(pts, x, y, angle + 2.05, radius * 1.25);
      push(pts, x, y, angle + Math.PI, radius * 0.25);
      push(pts, x, y, angle - 2.05, radius * 1.25);
      polygon(g, pts, fill, rim, alpha, 2);
      break;
    }

    case Silhouette.Orb: {
      // Sorcerer: a floating core inside a loose halo. The only round one.
      g.fillStyle(fill, alpha);
      g.fillCircle(x, y, radius * 0.72);
      g.lineStyle(2, rim, alpha);
      g.strokeCircle(x, y, radius * 0.72);
      g.lineStyle(2, rim, alpha * 0.5);
      g.strokeCircle(x, y, radius * 1.3);
      break;
    }

    case Silhouette.Shield: {
      // Valkyrie: a broad hexagon, widened across the facing axis so it reads
      // as a wall rather than a generic blob.
      for (let i = 0; i < 6; i++) {
        const a = angle + (i / 6) * Math.PI * 2;
        push(pts, x, y, a, radius * (1.0 + 0.28 * Math.abs(Math.cos(a - angle))));
      }
      polygon(g, pts, fill, rim, alpha, 2.5);
      break;
    }
  }
}

/** Small facing pip — which way the body is pointed, at a glance. */
export function drawFacingPip(
  g: Phaser.GameObjects.Graphics,
  x: number,
  y: number,
  radius: number,
  facingX: number,
  facingY: number,
  color = 0xffffff,
  alpha = 1,
): void {
  g.fillStyle(color, alpha);
  g.fillCircle(x + facingX * radius * 1.1, y + facingY * radius * 1.1, 3);
}

function push(out: number[], x: number, y: number, angle: number, r: number): void {
  out.push(x + Math.cos(angle) * r, y + Math.sin(angle) * r);
}

function polygon(
  g: Phaser.GameObjects.Graphics,
  flat: readonly number[],
  fill: number,
  rim: number,
  alpha: number,
  lineWidth: number,
): void {
  if (flat.length < 6) return;

  g.fillStyle(fill, alpha);
  g.beginPath();
  g.moveTo(flat[0]!, flat[1]!);
  for (let i = 2; i < flat.length; i += 2) g.lineTo(flat[i]!, flat[i + 1]!);
  g.closePath();
  g.fillPath();

  g.lineStyle(lineWidth, rim, alpha);
  g.beginPath();
  g.moveTo(flat[0]!, flat[1]!);
  for (let i = 2; i < flat.length; i += 2) g.lineTo(flat[i]!, flat[i + 1]!);
  g.closePath();
  g.strokePath();
}
