import Phaser from 'phaser';

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

/** Builds (once) every texture the retro renderer needs. Idempotent — safe to
 *  call from every scene's create(). */
export function buildRetroTextures(scene: Phaser.Scene): void {
  buildFloorTile(scene);
  buildWallTile(scene);
  buildTorch(scene, 'torch-0', 0);
  buildTorch(scene, 'torch-1', 1);
  buildDoorOpen(scene);
  buildDoorLocked(scene);
  buildCharacter(scene, 'char-warrior', Silhouette.Blade, 0xc0392b, 0x7a1f1a);
  buildCharacter(scene, 'char-archer', Silhouette.Bow, 0x2e8b57, 0x1b5436);
  buildCharacter(scene, 'char-sorcerer', Silhouette.Orb, 0x4a69bd, 0x27346e);
  buildCharacter(scene, 'char-valkyrie', Silhouette.Shield, 0xd4a017, 0x8a680e);
  buildGhoul(scene);
  buildBolt(scene);
  buildNameplate(scene);
}

function buildFloorTile(scene: Phaser.Scene): void {
  grid(scene, 'tile-floor', 16, 16, (put) => {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const edge = x === 0 || y === 0 || x === 15 || y === 15;
        const speck = (x * 7 + y * 13) % 23 === 0;
        put(x, y, edge ? FLOOR_DARK : speck ? FLOOR_LIGHT : FLOOR_BASE);
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
    // Legs.
    for (let y = 11; y < 15; y++) {
      put(5, y, trim);
      put(8, y, trim);
    }
    // Torso.
    for (let y = 6; y < 11; y++) {
      for (let x = 4; x < 10; x++) put(x, y, body);
    }
    // Head.
    for (let y = 2; y < 6; y++) {
      for (let x = 5; x < 9; x++) put(x, y, skin);
    }

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
    const hide = 0x6b4a6e;
    const hideDark = 0x4a3250;
    for (let y = 3; y < 10; y++) {
      for (let x = 2; x < 10; x++) {
        const rim = x === 2 || x === 9 || y === 9;
        put(x, y, rim ? hideDark : hide);
      }
    }
    // Claws.
    put(1, 8, hideDark);
    put(10, 8, hideDark);
    // Eyes — the only bright thing on the body, so it reads in the dark.
    put(4, 5, 0xff5555);
    put(7, 5, 0xff5555);
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
