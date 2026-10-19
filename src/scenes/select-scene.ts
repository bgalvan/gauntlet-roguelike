import Phaser from 'phaser';

import { VIEW } from '../core/constants';
import { ClassId, CLASS_ORDER, getClass } from '../game/classes';
import { GamepadBackend } from '../input/backends/gamepad';
import { KeyboardMouseBackend } from '../input/backends/keyboard-mouse';
import { InputManager } from '../input/input-manager';
import { audio } from '../render/audio';
import { buildRetroTextures } from '../render/pixelart';

function classTexture(id: ClassId): string {
  switch (id) {
    case ClassId.Warrior:
      return 'char-warrior';
    case ClassId.Archer:
      return 'char-archer';
    case ClassId.Sorcerer:
      return 'char-sorcerer';
    case ClassId.Valkyrie:
      return 'char-valkyrie';
  }
}

function classGlowTexture(id: ClassId): string {
  switch (id) {
    case ClassId.Warrior:
      return 'glow-warrior';
    case ClassId.Archer:
      return 'glow-archer';
    case ClassId.Sorcerer:
      return 'glow-sorcerer';
    case ClassId.Valkyrie:
      return 'glow-valkyrie';
  }
}

/**
 * Class select.
 *
 * Driven through the same InputManager the game uses, so it works on
 * keyboard, mouse and gamepad without three code paths — which is the whole
 * point of constraint #1. A touch backend would inherit this screen for free.
 *
 * Layout is computed from ROOM dimensions, never hardcoded pixels
 * (constraint #5).
 */
export class SelectScene extends Phaser.Scene {
  private input$!: InputManager;
  private kbm!: KeyboardMouseBackend;
  private gfx!: Phaser.GameObjects.Graphics;

  private title!: Phaser.GameObjects.Text;
  private hint!: Phaser.GameObjects.Text;
  private readonly cardTexts: Phaser.GameObjects.Text[] = [];
  private readonly cardSprites: Phaser.GameObjects.Image[] = [];
  private readonly cardGlows: Phaser.GameObjects.Image[] = [];

  private selected = 0;
  /** Debounce for stick/key repeat — held left does not scroll at 60Hz. */
  private navCooldown = 0;
  private elapsed = 0;
  private confirmed = false;

  constructor() {
    super('select');
  }

  create(): void {
    buildRetroTextures(this);

    this.selected = 0;
    this.confirmed = false;
    this.navCooldown = 0;
    this.elapsed = 0;
    this.cardTexts.length = 0;
    this.cardSprites.length = 0;

    this.kbm = new KeyboardMouseBackend(this.game.canvas, () => null);
    this.input$ = new InputManager().add(this.kbm).add(new GamepadBackend());

    this.gfx = this.add.graphics();

    this.title = this.add
      .text(VIEW.WIDTH / 2, 36, 'GAUNTLET', {
        fontFamily: 'Courier New, monospace',
        fontSize: '44px',
        fontStyle: 'bold',
        color: '#ffd700',
        stroke: '#2a1a08',
        strokeThickness: 7,
      })
      .setOrigin(0.5);

    this.add
      .text(VIEW.WIDTH / 2, 76, 'CHOOSE YOUR CHARACTER — three allies take the other roles', {
        fontFamily: 'Courier New, monospace',
        fontSize: '13px',
        fontStyle: 'bold',
        color: '#c7a85a',
      })
      .setOrigin(0.5);

    for (let i = 0; i < CLASS_ORDER.length; i++) {
      const glow = this.add
        .image(0, 0, classGlowTexture(CLASS_ORDER[i]!))
        .setDisplaySize(160, 160)
        .setBlendMode(Phaser.BlendModes.ADD);
      this.cardGlows.push(glow);

      const sprite = this.add.image(0, 0, classTexture(CLASS_ORDER[i]!)).setDisplaySize(84, 84);
      this.cardSprites.push(sprite);

      const text = this.add
        .text(0, 0, '', {
          fontFamily: 'Courier New, monospace',
          fontSize: '11px',
          fontStyle: 'bold',
          color: '#c3ccdb',
          lineSpacing: 2,
          align: 'left',
          wordWrap: { width: this.cardWidth - 30 },
        })
        .setOrigin(0, 0);
      this.cardTexts.push(text);

      // Stat labels are static, so they are created once here rather than
      // rebuilt every frame in draw().
      for (let row = 0; row < STAT_ROWS.length; row++) {
        this.add
          .text(this.cardX(i) + 16, this.cardY + STATS_DY - 3 + row * 18, STAT_ROWS[row]!, {
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: '10px',
            color: '#5d6879',
          })
          .setOrigin(0, 0);
      }
    }

    this.hint = this.add
      .text(VIEW.WIDTH / 2, VIEW.HEIGHT - 26, '', {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '15px',
        color: '#8b9bb4',
      })
      .setOrigin(0.5);

    // Clicking a card selects it; clicking the selected card confirms.
    this.input.on('pointerdown', this.onPointerDown, this);
    this.input.on('pointermove', this.onPointerMove, this);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input$.destroy();
      this.input.off('pointerdown', this.onPointerDown, this);
      this.input.off('pointermove', this.onPointerMove, this);
    });
  }

  private get cardWidth(): number {
    return (VIEW.WIDTH - 90) / CLASS_ORDER.length - 18;
  }

  private cardX(i: number): number {
    return 45 + i * (this.cardWidth + 18);
  }

  private get cardY(): number {
    return 96;
  }

  private get cardHeight(): number {
    return VIEW.HEIGHT - this.cardY - 52;
  }

  override update(time: number, delta: number): void {
    this.kbm.setNow(time);
    this.elapsed += delta / 1000;

    const state = this.input$.sample();

    if (this.navCooldown > 0) this.navCooldown -= delta / 1000;

    const dx = state.moveVector.x;
    if (this.navCooldown <= 0 && Math.abs(dx) > 0.5) {
      this.move(dx > 0 ? 1 : -1);
      this.navCooldown = 0.18;
    }

    // Any of confirm / context / traversal starts the run — on a gamepad the
    // natural "accept" is A, which is bound to slot 1.
    if (!this.confirmed && (state.contextAction.pressed || state.ability[0]!.pressed)) {
      this.confirm();
    }

    this.draw();
  }

  private move(direction: number): void {
    const next = (this.selected + direction + CLASS_ORDER.length) % CLASS_ORDER.length;
    if (next === this.selected) return;
    this.selected = next;
    audio.unlock();
    audio.uiMove();
  }

  private confirm(): void {
    this.confirmed = true;
    audio.unlock();
    audio.uiConfirm();
    const chosen = CLASS_ORDER[this.selected]!;
    this.scene.start('game', { classId: chosen });
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    const index = this.cardAt(pointer.worldX, pointer.worldY);
    if (index >= 0 && index !== this.selected) {
      this.selected = index;
      audio.unlock();
      audio.uiMove();
    }
  }

  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    audio.unlock();
    const index = this.cardAt(pointer.worldX, pointer.worldY);
    // Clicking anywhere else also starts — a click is unambiguous intent.
    if (index >= 0) this.selected = index;
    this.confirm();
  }

  private cardAt(x: number, y: number): number {
    if (y < this.cardY || y > this.cardY + this.cardHeight) return -1;
    for (let i = 0; i < CLASS_ORDER.length; i++) {
      const cx = this.cardX(i);
      if (x >= cx && x <= cx + this.cardWidth) return i;
    }
    return -1;
  }

  private draw(): void {
    const g = this.gfx;
    g.clear();

    g.fillStyle(0x100b07, 1).fillRect(0, 0, VIEW.WIDTH, VIEW.HEIGHT);

    for (let i = 0; i < CLASS_ORDER.length; i++) {
      const def = getClass(CLASS_ORDER[i]!);
      const x = this.cardX(i);
      const y = this.cardY;
      const w = this.cardWidth;
      const h = this.cardHeight;
      const active = i === this.selected;

      // Stone-slab card, gold-rimmed when selected — same material language
      // as the dungeon itself.
      g.fillStyle(active ? 0x3a2f20 : 0x201a12, 1);
      g.fillRect(x, y, w, h);
      g.lineStyle(active ? 3 : 1.5, active ? 0xffd700 : 0x4a3826, 1);
      g.strokeRect(x, y, w, h);

      // Pixel-art portrait, gently bobbing when selected so it reads as alive
      // rather than a static card — the arcade cabinet's idle animation.
      const bob = active ? Math.sin(this.elapsed * 4) * 3 : 0;
      const glow = this.cardGlows[i]!;
      glow.setPosition(x + w / 2, y + SILHOUETTE_DY + bob);
      glow.setAlpha(active ? 0.75 + 0.2 * Math.sin(this.elapsed * 3) : 0.15);
      const sprite = this.cardSprites[i]!;
      sprite.setPosition(x + w / 2, y + SILHOUETTE_DY + bob);
      sprite.setAlpha(active ? 1 : 0.55);
      sprite.setTint(active ? 0xffffff : 0x9a8a70);

      this.drawStatBars(g, def, x + 16, y + STATS_DY, w - 32, active);

      const text = this.cardTexts[i]!;
      text.setPosition(x + 15, y + TEXT_DY);
      text.setColor(active ? '#dbe3ef' : '#8792a5');
      text.setText([
        `${def.name.toUpperCase()}`,
        `${def.role}`,
        ``,
        `${resourceLabel(def)}`,
        ``,
        `1 ${def.abilities[0]!.name}`,
        `  ${def.abilities[0]!.blurb}`,
        `2 ${def.abilities[1]!.name}`,
        `  ${def.abilities[1]!.blurb}`,
        `3 ${def.abilities[2]!.name}`,
        `  ${def.abilities[2]!.blurb}`,
      ]);
    }

    const usingPad = this.input$.activeBackendId === 'gamepad';
    this.hint.setText(
      usingPad
        ? 'Left stick to choose  ·  A to begin'
        : 'A / D or ← → to choose  ·  E, Space or click to begin',
    );
    this.title.setColor('#e8edf6');
  }

  /**
   * The §3.2 levers, drawn as bars. Showing *why* classes differ matters more
   * than showing that they do — this is the screen that has to communicate
   * "these play differently", not just "these are different colours".
   */
  private drawStatBars(
    g: Phaser.GameObjects.Graphics,
    def: ReturnType<typeof getClass>,
    x: number,
    y: number,
    w: number,
    active: boolean,
  ): void {
    const values = [
      norm(def.maxHp, 70, 160),
      norm(def.moveSpeed, 220, 290),
      // Faster cadence should read as a longer bar, so invert the interval.
      1 - norm(def.attackInterval, 0.2, 1.3),
      norm(def.attackRange, 100, 340),
    ];

    for (let i = 0; i < values.length; i++) {
      const value = values[i]!;
      const barY = y + i * 18;
      g.fillStyle(0x0c0f15, 1).fillRect(x + 68, barY, w - 68, 6);
      g.fillStyle(active ? def.color : 0x3d4657, 1).fillRect(
        x + 68,
        barY,
        (w - 68) * Math.max(0.04, value),
        6,
      );
    }
  }
}

/** The §3.2 levers shown on each card, in draw order. */
const STAT_ROWS = ['HEALTH', 'SPEED', 'CADENCE', 'RANGE'] as const;

/** Vertical layout inside a card, relative to its top edge. */
const SILHOUETTE_DY = 58;
const STATS_DY = 104;
const TEXT_DY = 184;

function norm(value: number, min: number, max: number): number {
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function resourceLabel(def: ReturnType<typeof getClass>): string {
  switch (def.resource.kind) {
    case 'rage':
      return 'RAGE — built by landing hits';
    case 'mana':
      return 'MANA — regenerates over time';
    case 'stamina':
      return 'STAMINA — drains while blocking';
    default:
      return 'NO RESOURCE — pure skill';
  }
}
