import Phaser from 'phaser';

import { PARTY_SIZE, PLAYER, ROOM, SIM } from '../core/constants';
import { FixedLoop } from '../core/fixed-loop';
import { InputManager } from '../input/input-manager';
import { GamepadBackend } from '../input/backends/gamepad';
import { KeyboardMouseBackend } from '../input/backends/keyboard-mouse';
import type { Vec2 } from '../input/input-state';
import { World } from '../game/world';
import type { Entity } from '../game/entities/entity';
import type { Player } from '../game/entities/player';

/** Per-slot colours. Slot 0 is the local player. */
const SLOT_COLOR = [0x4f9dff, 0xff7a59, 0x6fd08c, 0xc98bff] as const;
const SLOT_RIM = [0xa8d0ff, 0xffc0ad, 0xb8ecc8, 0xe2c6ff] as const;

const FLASH_SECONDS = 0.12;

/**
 * The only Phaser-aware file in the project besides main.ts.
 *
 * Responsibilities: poll input at the sim rate, drive the fixed loop, and
 * draw. It reads the world; it never mutates it. Everything visual
 * interpolates between the last two sim states using the loop's alpha, which
 * is what lets a 60 Hz simulation look smooth on a 144 Hz display.
 */
export class GameScene extends Phaser.Scene {
  private world!: World;
  private loop!: FixedLoop;
  private input$!: InputManager;
  private kbm!: KeyboardMouseBackend;

  private gfx!: Phaser.GameObjects.Graphics;
  private hud!: Phaser.GameObjects.Text;

  /** Swing flash per party slot. Render-only state. */
  private readonly flashTimer = new Float32Array(PARTY_SIZE);
  private readonly flashX = new Float32Array(PARTY_SIZE);
  private readonly flashY = new Float32Array(PARTY_SIZE);

  constructor() {
    super('game');
  }

  create(): void {
    // A run is reproducible from this string. Phase 1 will read it from the
    // URL; for now it is fixed so two launches are visibly identical.
    // One human slot, three bots — bots are how co-op gets tested solo
    // (CLAUDE.md conventions).
    this.world = new World('phase-0', 1);
    this.loop = new FixedLoop();

    this.kbm = new KeyboardMouseBackend(this.game.canvas, this.playerScreenPosition);
    this.input$ = new InputManager().add(this.kbm).add(new GamepadBackend());

    this.gfx = this.add.graphics();
    this.hud = this.add
      .text(ROOM.WALL + 8, ROOM.WALL + 8, '', {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '14px',
        color: '#8b9bb4',
        lineSpacing: 3,
      })
      .setDepth(10);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.input$.destroy());
  }

  override update(time: number, delta: number): void {
    this.kbm.setNow(time);

    this.loop.advance(delta, (dt) => {
      // Input is sampled once per *simulation* step, not per frame. This is
      // the per-tick input frame lockstep will serialize later.
      this.world.setInput(0, this.input$.sample());
      this.world.step(dt);

      const party = this.world.party;
      for (let i = 0; i < party.length; i++) {
        const player = party[i]!.player;
        if (!player.attackedThisTick) continue;
        this.flashTimer[i] = FLASH_SECONDS;
        const target = player.target;
        if (target) {
          this.flashX[i] = target.x;
          this.flashY[i] = target.y;
        }
      }
    });

    const decay = delta / 1000;
    for (let i = 0; i < this.flashTimer.length; i++) {
      if (this.flashTimer[i]! > 0) this.flashTimer[i] = this.flashTimer[i]! - decay;
    }

    this.draw(this.loop.alpha);
    this.drawHud();
  }

  // --- rendering ----------------------------------------------------------

  private draw(alpha: number): void {
    const g = this.gfx;
    g.clear();

    this.drawRoom(g);

    for (const dummy of this.world.dummies) {
      const x = lerp(dummy.prevX, dummy.x, alpha);
      const y = lerp(dummy.prevY, dummy.y, alpha);

      if (!dummy.alive) {
        g.fillStyle(0x2a2f3a, 1).fillCircle(x, y, dummy.radius * 0.6);
        continue;
      }

      const body = dummy.hitFlashTicks > 0 ? 0xf0e6d2 : 0x8a7f6b;
      g.fillStyle(body, 1).fillCircle(x, y, dummy.radius);
      g.lineStyle(2, 0x5a5245, 1).strokeCircle(x, y, dummy.radius);
      this.drawHealthBar(g, x, y - dummy.radius - 12, dummy.hp / dummy.maxHp);
    }

    const party = this.world.party;

    // Swing lines under the bodies, so four overlapping attacks don't bury
    // the players themselves — this is §13 question 3 in miniature.
    for (let i = 0; i < party.length; i++) {
      const timer = this.flashTimer[i]!;
      if (timer <= 0) continue;
      const player = party[i]!.player;
      const px = lerp(player.prevX, player.x, alpha);
      const py = lerp(player.prevY, player.y, alpha);
      g.lineStyle(3, SLOT_RIM[player.slot % SLOT_RIM.length]!, timer / FLASH_SECONDS)
        .beginPath()
        .moveTo(px, py)
        .lineTo(this.flashX[i]!, this.flashY[i]!)
        .strokePath();
    }

    for (let i = 0; i < party.length; i++) {
      const slot = party[i]!;
      this.drawPlayer(g, slot.player, alpha, slot.controller.kind === 'bot');
    }
  }

  private drawPlayer(
    g: Phaser.GameObjects.Graphics,
    player: Player,
    alpha: number,
    isBot: boolean,
  ): void {
    const x = lerp(player.prevX, player.x, alpha);
    const y = lerp(player.prevY, player.y, alpha);
    const fill = SLOT_COLOR[player.slot % SLOT_COLOR.length]!;
    const rim = SLOT_RIM[player.slot % SLOT_RIM.length]!;

    this.drawTargetMarker(g, player.target, alpha, player.overrideActive);

    // Attack reach for the local player only — four range circles is noise.
    if (!isBot) {
      g.lineStyle(1, 0x3a4557, 0.6).strokeCircle(x, y, PLAYER.ATTACK_RANGE);
    }

    g.fillStyle(fill, 1).fillCircle(x, y, player.radius);
    g.lineStyle(2, rim, 1).strokeCircle(x, y, player.radius);

    // Bots read as hollow, so it's never ambiguous which body is yours.
    if (isBot) {
      g.fillStyle(0x14161d, 1).fillCircle(x, y, player.radius * 0.45);
    }

    g.fillStyle(0xffffff, 1).fillCircle(
      x + player.facingX * player.radius,
      y + player.facingY * player.radius,
      4,
    );
  }

  private drawRoom(g: Phaser.GameObjects.Graphics): void {
    g.fillStyle(0x14161d, 1).fillRect(0, 0, ROOM.WIDTH, ROOM.HEIGHT);
    g.fillStyle(0x1b1f29, 1).fillRect(
      ROOM.WALL,
      ROOM.WALL,
      ROOM.WIDTH - ROOM.WALL * 2,
      ROOM.HEIGHT - ROOM.WALL * 2,
    );
    g.lineStyle(2, 0x2c3342, 1).strokeRect(
      ROOM.WALL,
      ROOM.WALL,
      ROOM.WIDTH - ROOM.WALL * 2,
      ROOM.HEIGHT - ROOM.WALL * 2,
    );
  }

  private drawTargetMarker(
    g: Phaser.GameObjects.Graphics,
    target: Entity | null,
    alpha: number,
    overridden: boolean,
  ): void {
    if (!target || !target.alive) return;
    const x = lerp(target.prevX, target.x, alpha);
    const y = lerp(target.prevY, target.y, alpha);
    // Amber when the player overrode the auto-pick, so the distinction the
    // manual cares about (§16.5b) is visible on screen.
    g.lineStyle(2, overridden ? 0xffb347 : 0x6fd08c, overridden ? 1 : 0.35).strokeCircle(
      x,
      y,
      target.radius + 7,
    );
  }

  private drawHealthBar(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    fraction: number,
  ): void {
    const width = 44;
    const height = 5;
    g.fillStyle(0x000000, 0.5).fillRect(x - width / 2, y, width, height);
    g.fillStyle(0xd05a5a, 1).fillRect(x - width / 2, y, width * fraction, height);
  }

  private drawHud(): void {
    const s = this.input$.current;
    const player = this.world.localPlayer;
    const bots = this.world.party.filter((slot) => slot.controller.kind === 'bot').length;

    this.hud.setText([
      `seed ${String(this.world.seed)}   tick ${this.world.tick}   checksum ${this.world.checksum()}`,
      `sim ${SIM.TICK_RATE}Hz fixed   render ${Math.round(this.game.loop.actualFps)}fps   alpha ${this.loop.alpha.toFixed(2)}`,
      `party ${this.world.party.length} (1 human + ${bots} bots)   input ${this.input$.activeBackendId ?? '—'}`,
      `move ${s.moveVector.x.toFixed(2)},${s.moveVector.y.toFixed(2)}   override ${player.overrideActive ? 'ON' : 'off'}`,
      `slots [${s.ability[0].down ? '1' : '·'}${s.ability[1].down ? '2' : '·'}${s.ability[2].down ? '3' : '·'}] ctx ${s.contextAction.down ? 'E' : '·'} item ${s.activeItem.down ? 'Q' : '·'}   (unbound in Phase 0)`,
      `WASD move · mouse/RS override · auto-attack · you are the filled blue circle`,
    ]);
  }

  // --- input plumbing -----------------------------------------------------

  /**
   * The mouse backend needs a screen-space origin to turn a cursor position
   * into a direction. This is the only place world units meet pixels, and it
   * lives on the render side by design.
   */
  private readonly playerScreenPosition = (): Vec2 | null => {
    if (!this.world) return null;
    const rect = this.game.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const player = this.world.localPlayer;
    return {
      x: rect.left + (player.x / ROOM.WIDTH) * rect.width,
      y: rect.top + (player.y / ROOM.HEIGHT) * rect.height,
    };
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
