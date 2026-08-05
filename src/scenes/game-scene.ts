import Phaser from 'phaser';

import { PLAYER, ROOM, SIM } from '../core/constants';
import { FixedLoop } from '../core/fixed-loop';
import { InputManager } from '../input/input-manager';
import { GamepadBackend } from '../input/backends/gamepad';
import { KeyboardMouseBackend } from '../input/backends/keyboard-mouse';
import type { Vec2 } from '../input/input-state';
import { World } from '../game/world';
import type { Entity } from '../game/entities/entity';

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

  /** Seconds left on the swing flash. Render-only state. */
  private attackFlash = 0;
  private attackTargetX = 0;
  private attackTargetY = 0;

  constructor() {
    super('game');
  }

  create(): void {
    // A run is reproducible from this string. Phase 1 will read it from the
    // URL; for now it is fixed so two launches are visibly identical.
    this.world = new World('phase-0');
    this.loop = new FixedLoop();

    this.kbm = new KeyboardMouseBackend(this.game.canvas, this.playerScreenPosition);
    this.input$ = new InputManager()
      .add(this.kbm)
      .add(new GamepadBackend());

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
      const state = this.input$.sample();
      this.world.step(dt, state);

      if (this.world.player.attackedThisTick) {
        this.attackFlash = 0.12;
        const target = this.world.player.target;
        if (target) {
          this.attackTargetX = target.x;
          this.attackTargetY = target.y;
        }
      }
    });

    if (this.attackFlash > 0) this.attackFlash -= delta / 1000;

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

    const player = this.world.player;
    const px = lerp(player.prevX, player.x, alpha);
    const py = lerp(player.prevY, player.y, alpha);

    this.drawTargetMarker(g, player.target, alpha, player.overrideActive);

    if (this.attackFlash > 0) {
      const t = this.attackFlash / 0.12;
      g.lineStyle(3, 0xffe9a8, t)
        .beginPath()
        .moveTo(px, py)
        .lineTo(this.attackTargetX, this.attackTargetY)
        .strokePath();
    }

    // Attack reach — Phase 0 needs the auto-target rule to be legible.
    g.lineStyle(1, 0x3a4557, 0.6).strokeCircle(px, py, PLAYER.ATTACK_RANGE);

    g.fillStyle(0x4f9dff, 1).fillCircle(px, py, player.radius);
    g.lineStyle(2, 0xa8d0ff, 1).strokeCircle(px, py, player.radius);
    // Facing pip.
    g.fillStyle(0xffffff, 1).fillCircle(
      px + player.facingX * player.radius,
      py + player.facingY * player.radius,
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
    g.lineStyle(2, overridden ? 0xffb347 : 0x6fd08c, 1).strokeCircle(x, y, target.radius + 7);
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
    const player = this.world.player;
    this.hud.setText([
      `seed ${String(this.world.seed)}   tick ${this.world.tick}   rng ${this.world.rng
        .getState()
        .toString(16)}`,
      `sim ${SIM.TICK_RATE}Hz fixed   render ${Math.round(this.game.loop.actualFps)}fps   alpha ${this.loop.alpha.toFixed(2)}`,
      `input ${this.input$.activeBackendId ?? '—'}   move ${s.moveVector.x.toFixed(2)},${s.moveVector.y.toFixed(2)}   override ${player.overrideActive ? 'ON' : 'off'}`,
      `slots [${s.ability[0].down ? '1' : '·'}${s.ability[1].down ? '2' : '·'}${s.ability[2].down ? '3' : '·'}] ctx ${s.contextAction.down ? 'E' : '·'} item ${s.activeItem.down ? 'Q' : '·'}   (unbound in Phase 0)`,
      `WASD move · mouse/RS override · auto-attack`,
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
    return {
      x: rect.left + (this.world.player.x / ROOM.WIDTH) * rect.width,
      y: rect.top + (this.world.player.y / ROOM.HEIGHT) * rect.height,
    };
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
