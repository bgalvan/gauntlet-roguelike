import Phaser from 'phaser';

import { VIEW } from '../core/constants';
import { Silhouette } from '../game/classes';

/**
 * Procedural pixel-art texture generation.
 *
 * **Render-only**, same contract as the rest of `src/render/` — nothing here
 * is read by the simulation. There is no art pipeline (no external assets),
 * so every texture is built at runtime from a tiny grid of blocks, baked once
 * into a GPU texture with nearest-neighbour filtering, and reused for the
 * rest of the session. That is what gives the chunky 1985-arcade look without
 * downloading a single file.
 *
 * Each texture is drawn on an abstract `cols × rows` grid at `unit` pixels per
 * cell, so the "pixel" is a deliberate block rather than a smoothed curve.
 */

const UNIT = 4; // size of one "chunky pixel" in real pixels before baking

function grid(
  scene: Phaser.Scene,
  key: string,
  cols: number,
  rows: number,
  paint: (put: (cx: number, cy: number, color: number, alpha?: number) => void) => void,
): void {
  if (scene.textures.exists(key)) return;
  const g = scene.add.graphics();
  const put = (cx: number, cy: number, color: number, alpha = 1): void => {
    g.fillStyle(color, alpha);
    g.fillRect(cx * UNIT, cy * UNIT, UNIT, UNIT);
  };
  paint(put);
  g.generateTexture(key, cols * UNIT, rows * UNIT);
  g.destroy();
  scene.textures.get(key).setFilter(Phaser.Textures.FilterMode.NEAREST);
}

// ---------------------------------------------------------------------------
// Palette — flat, saturated, high-contrast. Classic-cabinet colours rather
// than the desaturated/abstract palette the previous look used.
// ---------------------------------------------------------------------------

const STONE_DARK = 0x2a2016;
const STONE_MID = 0x4a3826;
const STONE_LIGHT = 0x6b5438;
const STONE_HILIGHT = 0x8a6f4a;
const MORTAR = 0x1a1410;
const FLOOR_BASE = 0x3a3024;
const FLOOR_LIGHT = 0x4a3e2e;
const FLOOR_DARK = 0x2e2519;
const FLAME_CORE = 0xfff2a8;
const FLAME_MID = 0xffb347;
const FLAME_OUTER = 0xd4541e;
const IRON = 0x1e1a18;

/** Near-black outline every sprite gets, and the single bright highlight tone
 *  used for the top-left rim-light pixel row — the two things that read as
 *  "Vampire-Survivors chunky" rather than "flat retro cabinet". */
const OUTLINE = 0x0b0a0c;
const RIM_LIGHT = 0xffffff;

/** Converts a 0xRRGGBB int + alpha to a CSS colour string, for the canvas-2D
 *  radial gradients used by the glow pools and vignette — those need a true
 *  gradient, which a block `Graphics` grid cannot produce cheaply. */
function rgba(color: number, alpha: number): string {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * A soft pre-rendered radial-gradient glow, baked once per colour onto a
 * CanvasTexture. This is the "fake it, don't light it" answer to ambient
 * lighting feel (torches, class auras) without a real-time lighting system —
 * one extra additive-blended sprite per light source stays well inside the
 * mobile draw-call budget (constraint #4).
 */
function buildGlow(scene: Phaser.Scene, key: string, color: number, size = 160): void {
  if (scene.textures.exists(key)) return;
  const canvas = scene.textures.createCanvas(key, size, size);
  if (!canvas) return;
  const ctx = canvas.getContext();
  const r = size / 2;
  const grad = ctx.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, rgba(color, 0.65));
  grad.addColorStop(0.35, rgba(color, 0.32));
  grad.addColorStop(0.7, rgba(color, 0.1));
  grad.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  canvas.refresh();
}

/** Builds (once) every texture the retro renderer needs. Idempotent — safe to
 *  call from every scene's create(). */
export function buildRetroTextures(scene: Phaser.Scene): void {
  buildFloorTile(scene);
  buildWallTile(scene);
  buildTorch(scene, 'torch-0', 0);
  buildTorch(scene, 'torch-1', 1);
  buildDoorOpen(scene);
  buildDoorLocked(scene);
  // Saturated, punchier than the previous classic-cabinet palette — each
  // class reads as a distinct, strongly-coloured shape at a glance.
  buildCharacter(scene, 'char-warrior', Silhouette.Blade, 0xe0352b, 0x7a1f1a);
  buildCharacter(scene, 'char-archer', Silhouette.Bow, 0x2ecc71, 0x1b5436);
  buildCharacter(scene, 'char-sorcerer', Silhouette.Orb, 0x3f6fe0, 0x27346e);
  buildCharacter(scene, 'char-valkyrie', Silhouette.Shield, 0xffc914, 0x8a680e);
  buildGhoul(scene);
  buildBolt(scene);
  buildNameplate(scene);

  // Pre-rendered glow pools — the "fake lighting" layer. One per warm torch
  // tone and one per class accent, reused across every instance of that
  // colour rather than baked per-entity.
  buildGlow(scene, 'glow-torch', 0xffb347, 200);
  buildGlow(scene, 'glow-warrior', 0xe0352b);
  buildGlow(scene, 'glow-archer', 0x2ecc71);
  buildGlow(scene, 'glow-sorcerer', 0x3f6fe0);
  buildGlow(scene, 'glow-valkyrie', 0xffc914);
  buildGlow(scene, 'glow-white', 0xffffff, 96);
  buildVignette(scene);
}

/** A full design-resolution vignette: a soft dark gradient toward the edges,
 *  pre-baked as a canvas texture rather than computed per frame. Drawn by the
 *  scene at a fixed depth over the world and under the HUD text — screen-
 *  space framing, not a world object, so it needs no world coordinates. */
function buildVignette(scene: Phaser.Scene): void {
  const key = 'fx-vignette';
  if (scene.textures.exists(key)) return;
  const w = VIEW.WIDTH;
  const h = VIEW.HEIGHT;
  const canvas = scene.textures.createCanvas(key, w, h);
  if (!canvas) return;
  const ctx = canvas.getContext();
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.hypot(cx, cy);
  const grad = ctx.createRadialGradient(cx, cy, r * 0.45, cx, cy, r);
  grad.addColorStop(0, 'rgba(5,4,8,0)');
  grad.addColorStop(0.75, 'rgba(5,4,8,0.25)');
  grad.addColorStop(1, 'rgba(5,4,8,0.62)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  canvas.refresh();
}

function buildFloorTile(scene: Phaser.Scene): void {
  grid(scene, 'tile-floor', 16, 16, (put) => {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const edge = x === 0 || y === 0 || x === 15 || y === 15;
        const speck = (x * 7 + y * 13) % 23 === 0;
        const warmSpeck = (x * 11 + y * 5) % 29 === 0;
        put(x, y, edge ? FLOOR_DARK : speck ? FLOOR_LIGHT : warmSpeck ? 0x55402a : FLOOR_BASE);
      }
    }
  });
}

function buildWallTile(scene: Phaser.Scene): void {
  // Brick courses, offset every other row — the classic dungeon brick wall.
  grid(scene, 'tile-wall', 16, 16, (put) => {
    const brickH = 4;
    const brickW = 8;
    for (let y = 0; y < 16; y++) {
      const course = Math.floor(y / brickH);
      const offset = course % 2 === 0 ? 0 : brickW / 2;
      for (let x = 0; x < 16; x++) {
        const onMortarRow = y % brickH === brickH - 1;
        const onMortarCol = Math.floor((x + offset) % brickW) === 0;
        if (onMortarRow || onMortarCol) {
          put(x, y, MORTAR);
          continue;
        }
        const shade = (x * 5 + y * 3 + course) % 5;
        put(x, y, shade === 0 ? STONE_HILIGHT : shade === 1 ? STONE_LIGHT : shade >= 3 ? STONE_DARK : STONE_MID);
      }
    }
  });
}

function buildTorch(scene: Phaser.Scene, key: string, frame: 0 | 1): void {
  grid(scene, key, 8, 12, (put) => {
    // Iron bracket.
    for (let y = 7; y < 11; y++) {
      put(3, y, IRON);
      put(4, y, IRON);
    }
    put(2, 6, IRON);
    put(5, 6, IRON);
    // Flame — two frames flicker between a taller/shorter core.
    const tip = frame === 0 ? 1 : 2;
    for (let y = tip; y < 7; y++) {
      const width = 7 - y;
      const half = Math.floor(width / 2);
      for (let x = 4 - half; x <= 4 + half; x++) {
        const outer = x === 4 - half || x === 4 + half || y === tip;
        put(x, y, outer ? FLAME_OUTER : y < 3 ? FLAME_CORE : FLAME_MID);
      }
    }
  });
}

function buildDoorOpen(scene: Phaser.Scene): void {
  grid(scene, 'door-open', 12, 16, (put) => {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 12; x++) {
        const edge = x === 0 || x === 11;
        put(x, y, edge ? STONE_DARK : 0x0a1a10);
      }
    }
    // Glowing threshold arrow.
    for (let i = 0; i < 4; i++) put(5, 6 + i, 0x6fd08c);
    put(4, 7, 0x6fd08c);
    put(6, 7, 0x6fd08c);
    put(4, 8, 0x9ae8b2);
    put(6, 8, 0x9ae8b2);
  });
}

function buildDoorLocked(scene: Phaser.Scene): void {
  grid(scene, 'door-locked', 12, 16, (put) => {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 12; x++) {
        const edge = x === 0 || x === 11;
        put(x, y, edge ? STONE_DARK : 0x1c0f0f);
      }
    }
    // Iron portcullis bars.
    for (let x = 2; x < 10; x += 3) {
      for (let y = 1; y < 15; y++) put(x, y, IRON);
    }
    for (let y = 3; y < 13; y += 4) {
      for (let x = 1; x < 11; x++) put(x, y, 0x3a1f1f);
    }
  });
}

/**
 * One frontal pixel-art character per class, built from the existing
 * `Silhouette` identity (Pillar 1) so the shape language survives the visual
 * rebuild — only the rendering technique changes, not the design decision.
 */
function buildCharacter(
  scene: Phaser.Scene,
  key: string,
  shape: Silhouette,
  body: number,
  trim: number,
): void {
  const skin = 0xe8b48a;
  grid(scene, key, 14, 16, (put) => {
    // Outline pass first — one cell larger than every fill shape that follows,
    // so the fill paints over the inside and only the border survives. That
    // dark border plus the highlight row below is what reads as "chunky
    // outlined sprite" instead of a flat colour blob.
    for (let y = 10; y < 15; y++) put(5, y, OUTLINE), put(8, y, OUTLINE);
    for (let y = 5; y < 12; y++) for (let x = 3; x < 11; x++) put(x, y, OUTLINE);
    for (let y = 1; y < 7; y++) for (let x = 4; x < 10; x++) put(x, y, OUTLINE);

    // Legs.
    for (let y = 11; y < 15; y++) {
      put(5, y, trim);
      put(8, y, trim);
    }
    // Torso.
    for (let y = 6; y < 11; y++) {
      for (let x = 4; x < 10; x++) put(x, y, body);
    }
    // Rim-light: a single bright row along the torso's top-left edge, as if
    // lit from the torch above-left. Vampire-Survivors-style sprites lean on
    // exactly this one-row highlight to sell volume on a flat fill.
    for (let x = 4; x < 7; x++) put(x, 6, RIM_LIGHT, 0.55);
    // Head.
    for (let y = 2; y < 6; y++) {
      for (let x = 5; x < 9; x++) put(x, y, skin);
    }
    put(5, 2, RIM_LIGHT, 0.4);
    put(6, 2, RIM_LIGHT, 0.4);

    switch (shape) {
      case Silhouette.Blade: {
        // Warrior — horned helm, sword arm raised.
        put(4, 1, trim);
        put(9, 1, trim);
        for (let y = 2; y < 4; y++) for (let x = 4; x < 10; x++) put(x, y, trim);
        for (let y = 0; y < 8; y++) put(11, y + 1, 0xd8d8d8);
        put(11, 0, 0xffffff);
        break;
      }
      case Silhouette.Bow: {
        // Archer — hood, bow arm extended.
        for (let y = 1; y < 4; y++) for (let x = 4; x < 10; x++) put(x, y, trim);
        for (let y = 3; y < 11; y++) put(11, y, 0x8a5a2e);
        put(11, 3, 0xd9c08a);
        put(11, 10, 0xd9c08a);
        break;
      }
      case Silhouette.Orb: {
        // Sorcerer — peaked hat, floating orb above the free hand.
        for (let x = 5; x < 9; x++) put(x, 1, trim);
        put(6, 0, trim);
        put(7, 0, trim);
        put(11, 5, 0xbad4ff);
        put(11, 6, 0xffffff);
        put(10, 5, 0x8ab4ff);
        put(12, 6, 0x8ab4ff);
        break;
      }
      case Silhouette.Shield: {
        // Valkyrie — winged helm, broad shield arm.
        for (let y = 2; y < 4; y++) for (let x = 4; x < 10; x++) put(x, y, trim);
        put(3, 1, 0xf2e6c8);
        put(10, 1, 0xf2e6c8);
        for (let y = 5; y < 11; y++) for (let x = 10; x < 13; x++) put(x, y, trim);
        for (let y = 6; y < 10; y++) put(11, y, 0xf2e6c8);
        break;
      }
    }

    // Eyes — always present, last, so they never get painted over.
    put(5, 4, 0x1a1414);
    put(8, 4, 0x1a1414);
  });
}

function buildGhoul(scene: Phaser.Scene): void {
  grid(scene, 'char-ghoul', 12, 12, (put) => {
    const hide = 0x8a4ea3;
    const hideDark = 0x4a3250;
    // Dark outline, one cell larger than the body — same recipe as the
    // player sprites, so enemies read with the same bold-silhouette language.
    for (let y = 2; y < 11; y++) for (let x = 1; x < 11; x++) put(x, y, OUTLINE);
    // Back spikes — a "threat" silhouette cue (jagged, not round) that reads
    // as hostile even before the eyes register.
    put(3, 1, OUTLINE);
    put(5, 0, OUTLINE);
    put(8, 1, OUTLINE);

    for (let y = 3; y < 10; y++) {
      for (let x = 2; x < 10; x++) {
        const rim = x === 2 || x === 9 || y === 9;
        put(x, y, rim ? hideDark : hide);
      }
    }
    put(3, 1, hideDark);
    put(5, 0, 0xb46ec9);
    put(8, 1, hideDark);
    // Rim-light along the top-left, matching the hero sprites' lighting.
    put(3, 3, RIM_LIGHT, 0.3);
    put(4, 3, RIM_LIGHT, 0.3);
    // Claws.
    put(1, 8, hideDark);
    put(10, 8, hideDark);
    // Eyes — the only bright thing on the body, so it reads in the dark.
    put(4, 5, 0xff3838);
    put(7, 5, 0xff3838);
  });
}

function buildBolt(scene: Phaser.Scene): void {
  grid(scene, 'proj-bolt', 6, 6, (put) => {
    put(2, 1, 0xffffff);
    put(3, 1, 0xffffff);
    put(1, 2, 0xffffff);
    put(2, 2, 0xffffff);
    put(3, 2, 0xffffff);
    put(4, 2, 0xffffff);
    put(1, 3, 0xffffff);
    put(2, 3, 0xffffff);
    put(3, 3, 0xffffff);
    put(4, 3, 0xffffff);
    put(2, 4, 0xffffff);
    put(3, 4, 0xffffff);
  });
}

/** A small stone nameplate backing — tinted per class at draw time. */
function buildNameplate(scene: Phaser.Scene): void {
  grid(scene, 'nameplate', 28, 7, (put) => {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 28; x++) {
        const edge = x === 0 || y === 0 || x === 27 || y === 6;
        put(x, y, edge ? 0x0a0806 : STONE_DARK);
      }
    }
  });
}
