import Phaser from 'phaser';

import { COMBAT, DEATH, DOOR, ENEMY, LEASH, PARTY_SIZE, ROOM, SIM, VIEW } from '../core/constants';
import { FixedLoop } from '../core/fixed-loop';
import { AbilityId, CLASS_ORDER, ClassId } from '../game/classes';
import type { ClassDef } from '../game/classes';
import type { Enemy } from '../game/entities/enemy';
import type { Entity } from '../game/entities/entity';
import type { Player } from '../game/entities/player';
import { EventKind } from '../game/events';
import { LifeState } from '../game/life-state';
import { RoomKind } from '../game/rooms/floor';
import { Direction } from '../game/rooms/templates';
import type { DoorInstance } from '../game/world';
import { World } from '../game/world';
import { GamepadBackend } from '../input/backends/gamepad';
import { KeyboardMouseBackend } from '../input/backends/keyboard-mouse';
import { InputManager } from '../input/input-manager';
import type { Vec2 } from '../input/input-state';
import { audio } from '../render/audio';
import { PartyCamera } from '../render/camera';
import { Particles } from '../render/particles';
import { drawFacingPip, drawSilhouette } from '../render/silhouette';

interface DamageNumber {
  x: number;
  y: number;
  vy: number;
  life: number;
  maxLife: number;
  text: Phaser.GameObjects.Text;
  active: boolean;
}

const RESTART_DELAY = 4.5;

/**
 * The game scene.
 *
 * Two cameras, deliberately: the **world camera** zooms and scrolls to follow
 * the party (§2), and a separate **HUD camera** stays at zoom 1 so the
 * interface does not shrink when the party spreads out. Each ignores the
 * other's objects.
 *
 * It reads the world and never mutates it. Everything cosmetic lives here,
 * because none of it may affect the simulation.
 */
export class GameScene extends Phaser.Scene {
  private world!: World;
  private loop!: FixedLoop;
  private input$!: InputManager;
  private kbm!: KeyboardMouseBackend;
  private readonly partyCamera = new PartyCamera();

  private worldGfx!: Phaser.GameObjects.Graphics;
  private hudGfx!: Phaser.GameObjects.Graphics;
  private hudCamera!: Phaser.Cameras.Scene2D.Camera;
  private readonly particles = new Particles();

  private hud!: Phaser.GameObjects.Text;
  private banner!: Phaser.GameObjects.Text;
  private roomText!: Phaser.GameObjects.Text;
  private readonly abilityLabels: Phaser.GameObjects.Text[] = [];
  private readonly abilityKeys: Phaser.GameObjects.Text[] = [];
  private readonly damageNumbers: DamageNumber[] = [];

  private shake = 0;
  private shakeX = 0;
  private shakeY = 0;

  private clearFlash = 0;
  private hurtFlash = 0;
  private lastLocalHp = Infinity;
  private lastRoom = -1;

  private restartTimer = 0;
  private generation = 0;
  private chosenClass: ClassId = ClassId.Warrior;

  constructor() {
    super('game');
  }

  init(data: { classId?: ClassId }): void {
    if (data?.classId) this.chosenClass = data.classId;
  }

  create(): void {
    this.loop = new FixedLoop();
    this.newRun();

    this.kbm = new KeyboardMouseBackend(this.game.canvas, this.playerScreenPosition);
    this.input$ = new InputManager().add(this.kbm).add(new GamepadBackend());

    this.worldGfx = this.add.graphics().setDepth(1);
    this.hudGfx = this.add.graphics().setDepth(20);

    const worldObjects: Phaser.GameObjects.GameObject[] = [this.worldGfx];
    const hudObjects: Phaser.GameObjects.GameObject[] = [this.hudGfx];

    for (let i = 0; i < 48; i++) {
      const text = this.add
        .text(0, 0, '', {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '15px',
          color: '#ffffff',
        })
        .setOrigin(0.5)
        .setDepth(15)
        .setVisible(false);
      this.damageNumbers.push({ x: 0, y: 0, vy: 0, life: 0, maxLife: 1, text, active: false });
      worldObjects.push(text);
    }

    this.hud = this.add
      .text(14, 12, '', {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '11px',
        color: '#5d6879',
        lineSpacing: 3,
      })
      .setDepth(21);
    hudObjects.push(this.hud);

    for (let i = 0; i < 3; i++) {
      const key = this.add
        .text(0, 0, '', {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '11px',
          color: '#e8edf6',
        })
        .setOrigin(0.5)
        .setDepth(22);
      const label = this.add
        .text(0, 0, '', {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '9px',
          color: '#c3ccdb',
        })
        .setOrigin(0.5)
        .setDepth(22);
      this.abilityKeys.push(key);
      this.abilityLabels.push(label);
      hudObjects.push(key, label);
    }

    this.roomText = this.add
      .text(VIEW.WIDTH / 2, 22, '', {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '16px',
        color: '#8b9bb4',
      })
      .setOrigin(0.5)
      .setDepth(21);
    hudObjects.push(this.roomText);

    this.banner = this.add
      .text(VIEW.WIDTH / 2, VIEW.HEIGHT / 2, '', {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '32px',
        color: '#ff8080',
        align: 'center',
      })
      .setOrigin(0.5)
      .setDepth(30);
    hudObjects.push(this.banner);

    // A second camera at zoom 1 for the interface. Without it the HUD would
    // shrink and drift every time the party spread out.
    this.hudCamera = this.cameras.add(0, 0, VIEW.WIDTH, VIEW.HEIGHT);
    this.hudCamera.setScroll(0, 0);
    this.cameras.main.ignore(hudObjects);
    this.hudCamera.ignore(worldObjects);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.input$.destroy());
  }

  private newRun(): void {
    // The player takes slot 0 with their chosen class; the bots fill the rest,
    // so every run is a full party of four distinct roles.
    const roster: ClassId[] = [this.chosenClass];
    for (const id of CLASS_ORDER) if (id !== this.chosenClass) roster.push(id);

    this.world = new World(`crypt-${this.generation}`, 1, roster);
    this.restartTimer = 0;
    this.shake = 0;
    this.clearFlash = 0;
    this.hurtFlash = 0;
    this.lastLocalHp = this.world.localPlayer.hp;
    this.lastRoom = this.world.currentRoom;
    this.partyCamera.reset();
    this.particles.clear();
    for (const d of this.damageNumbers) {
      d.active = false;
      d.text.setVisible(false);
    }
  }

  override update(time: number, delta: number): void {
    this.kbm.setNow(time);
    const dt = delta / 1000;

    const roomsBefore = this.world.roomsCleared;

    this.loop.advance(delta, (step) => {
      this.world.setInput(0, this.input$.sample());
      this.world.step(step);
      this.consumeEvents();
    });

    if (this.world.roomsCleared > roomsBefore) {
      this.clearFlash = 1.8;
      audio.waveClear();
    }

    // Snap rather than ease across a room change — easing would read as the
    // camera flying through a wall.
    if (this.world.currentRoom !== this.lastRoom) {
      this.lastRoom = this.world.currentRoom;
      this.partyCamera.snap();
      this.particles.clear();
      this.lastLocalHp = this.world.localPlayer.hp;
    }

    this.particles.update(dt);
    this.updateDamageNumbers(dt);
    this.updateShake(dt);
    if (this.clearFlash > 0) this.clearFlash -= dt;
    if (this.hurtFlash > 0) this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.2);

    this.partyCamera.update(
      this.world.players,
      this.world.centroidX,
      this.world.centroidY,
      this.world.roomWidth,
      this.world.roomHeight,
      dt,
    );
    const cam = this.cameras.main;
    cam.setZoom(this.partyCamera.scale);
    cam.setScroll(this.partyCamera.scrollX + this.shakeX, this.partyCamera.scrollY + this.shakeY);

    if (this.world.runOver) {
      this.restartTimer += dt;
      this.banner.setText(`PARTY WIPED\nrooms cleared ${this.world.roomsCleared}\n\nrestarting…`);
      if (this.restartTimer >= RESTART_DELAY) {
        this.generation++;
        this.newRun();
      }
    } else if (this.world.floorComplete) {
      this.banner.setText('FLOOR CLEARED');
    } else {
      this.banner.setText('');
    }

    this.draw(this.loop.alpha);
    this.drawHud();
  }

  // --- events → juice ------------------------------------------------------

  private consumeEvents(): void {
    const events = this.world.events;

    for (let i = 0; i < events.length; i++) {
      const e = events.at(i);

      switch (e.kind) {
        case EventKind.Hit: {
          const color = e.slot >= 0 ? this.slotColor(e.slot) : 0xffd9a0;
          this.particles.burst(e.x, e.y, e.dirX, e.dirY, 5, { color, speed: 210 });
          if (e.amount > 0) {
            this.spawnDamageNumber(e.x, e.y, Math.round(e.amount), color);
            this.addShake(0.7);
            audio.hit();
          }
          break;
        }

        case EventKind.Kill: {
          const color = e.slot >= 0 ? this.slotColor(e.slot) : 0xffffff;
          this.particles.ring(e.x, e.y, 14, { color: 0xff9a7a, speed: 240, life: 0.5 });
          this.particles.burst(e.x, e.y, e.dirX, e.dirY, 8, { color, speed: 300 });
          if (e.amount > 0) this.spawnDamageNumber(e.x, e.y, Math.round(e.amount), color);
          this.addShake(2.4);
          audio.kill();
          break;
        }

        case EventKind.Ability: {
          const color = this.slotColor(e.slot);
          const isPayoff = PAYOFF_IDS.has(e.ability ?? '');
          if (e.radius > 0) this.particles.shockRing(e.x, e.y, e.radius, color, isPayoff ? 0.6 : 0.4);
          this.particles.ring(e.x, e.y, isPayoff ? 22 : 10, {
            color,
            speed: isPayoff ? 320 : 190,
            life: isPayoff ? 0.6 : 0.38,
          });
          this.addShake(isPayoff ? 7 : 1.6);
          if (isPayoff) audio.payoff();
          else audio.ability();
          break;
        }

        // Downed and Revived come from the per-player flags below rather than
        // the event stream — handling both would double the effect.
        case EventKind.Blocked:
          this.particles.burst(e.x, e.y, e.dirX, e.dirY, 6, { color: 0xa8d0ff, speed: 160 });
          break;
      }
    }

    const local = this.world.localPlayer;
    if (local.hp < this.lastLocalHp) {
      this.hurtFlash = Math.min(1, this.hurtFlash + 0.55);
      this.addShake(3);
      audio.hurt();
    }
    this.lastLocalHp = local.hp;

    for (const slot of this.world.party) {
      const p = slot.player;
      if (p.downedThisTick) {
        this.particles.ring(p.x, p.y, 20, { color: 0xff6b6b, speed: 150, life: 0.7 });
        this.addShake(6);
        audio.downed();
      }
      if (p.revivedThisTick) {
        this.particles.ring(p.x, p.y, 24, { color: 0x6fd08c, speed: 220, life: 0.8 });
        audio.revived();
      }
      if (p.isDashing) this.particles.trail(p.x, p.y, this.slotColor(p.slot), 5, 0.3);
      if (p.attackedThisTick && p.def.attackStyle === 'projectile') audio.shoot();
    }

    for (const shot of this.world.projectiles) {
      if (shot.active) this.particles.trail(shot.x, shot.y, this.slotColor(shot.ownerSlot), 3, 0.18);
    }
  }

  private addShake(amount: number): void {
    this.shake = Math.min(16, this.shake + amount);
  }

  private updateShake(dt: number): void {
    if (this.shake <= 0.01) {
      this.shake = 0;
      this.shakeX = 0;
      this.shakeY = 0;
      return;
    }
    this.shake *= Math.pow(0.0016, dt);
    const angle = this.time.now * 0.05;
    this.shakeX = Math.cos(angle * 1.7) * this.shake;
    this.shakeY = Math.sin(angle * 2.3) * this.shake;
  }

  private spawnDamageNumber(x: number, y: number, amount: number, color: number): void {
    // Falloff at the rim of a big AoE can round to zero. A floating "0" reads
    // as a bug rather than as a graze.
    if (amount < 1) return;
    for (const d of this.damageNumbers) {
      if (d.active) continue;
      d.x = x + (this.world.tick % 7) - 3;
      d.y = y - 14;
      d.vy = -46;
      d.maxLife = 0.75;
      d.life = d.maxLife;
      d.active = true;
      d.text.setText(String(amount));
      d.text.setColor(`#${color.toString(16).padStart(6, '0')}`);
      d.text.setVisible(true);
      return;
    }
  }

  private updateDamageNumbers(dt: number): void {
    for (const d of this.damageNumbers) {
      if (!d.active) continue;
      d.life -= dt;
      if (d.life <= 0) {
        d.active = false;
        d.text.setVisible(false);
        continue;
      }
      d.y += d.vy * dt;
      d.vy += 74 * dt;
      const t = d.life / d.maxLife;
      // World-space now: the camera moves them, so no shake offset here.
      d.text.setPosition(d.x, d.y);
      d.text.setAlpha(Math.min(1, t * 1.8));
      d.text.setScale(0.85 + (1 - t) * 0.25);
    }
  }

  private slotColor(slot: number): number {
    const player = this.world.party[slot]?.player;
    return player ? player.def.color : 0xffffff;
  }

  // --- world rendering -----------------------------------------------------

  private draw(alpha: number): void {
    const g = this.worldGfx;
    g.clear();

    this.drawRoom(g);

    for (const slot of this.world.party) {
      for (const zone of slot.player.activeZones) {
        const pulse = 0.16 + 0.1 * Math.sin(this.time.now * 0.012);
        g.fillStyle(slot.player.def.color, pulse);
        g.fillCircle(zone.x, zone.y, zone.radius);
        g.lineStyle(1.5, slot.player.def.color, 0.5);
        g.strokeCircle(zone.x, zone.y, zone.radius);
      }
    }

    this.particles.draw(g);

    for (const enemy of this.world.enemies) this.drawEnemy(g, enemy, alpha);

    for (const shot of this.world.projectiles) {
      if (!shot.active) continue;
      const x = lerp(shot.prevX, shot.x, alpha);
      const y = lerp(shot.prevY, shot.y, alpha);
      const color = this.slotColor(shot.ownerSlot);
      g.fillStyle(0xffffff, 0.9).fillCircle(x, y, shot.radius * 0.55);
      g.lineStyle(2, color, 0.9).strokeCircle(x, y, shot.radius);
    }

    for (const slot of this.world.party) this.drawPlayer(g, slot.player, alpha);

    this.drawLeash(g);
  }

  private drawRoom(g: Phaser.GameObjects.Graphics): void {
    const w = this.world.roomWidth;
    const h = this.world.roomHeight;

    g.fillStyle(0x171b24, 1).fillRect(0, 0, w, h);

    g.lineStyle(1, 0x1e2430, 1);
    for (let x = ROOM.WALL; x <= w - ROOM.WALL; x += 60) g.lineBetween(x, ROOM.WALL, x, h - ROOM.WALL);
    for (let y = ROOM.WALL; y <= h - ROOM.WALL; y += 60) g.lineBetween(ROOM.WALL, y, w - ROOM.WALL, y);

    g.lineStyle(3, 0x2c3342, 1).strokeRect(ROOM.WALL, ROOM.WALL, w - ROOM.WALL * 2, h - ROOM.WALL * 2);

    // Safe pocket, faintly — it is authored, so showing it makes template
    // work legible while the library is still being built.
    const pocket = this.world.room.template.safePocket;
    g.lineStyle(1, 0x2e3a4c, 0.5).strokeCircle(pocket.x, pocket.y, pocket.radius);

    for (const door of this.world.doors) this.drawDoor(g, door, w, h);
  }

  /**
   * §2: doors lock during combat. A locked door reads as barred and red; an
   * open one glows and pulls the eye, because it is the only exit.
   */
  private drawDoor(
    g: Phaser.GameObjects.Graphics,
    door: DoorInstance,
    w: number,
    h: number,
  ): void {
    const half = DOOR.WIDTH / 2;
    const horizontal = door.direction === Direction.North || door.direction === Direction.South;
    const x = door.direction === Direction.East ? w - ROOM.WALL : door.direction === Direction.West ? 0 : door.x - half;
    const y = door.direction === Direction.South ? h - ROOM.WALL : door.direction === Direction.North ? 0 : door.y - half;
    const dw = horizontal ? DOOR.WIDTH : ROOM.WALL;
    const dh = horizontal ? ROOM.WALL : DOOR.WIDTH;

    if (door.open) {
      const pulse = 0.55 + 0.45 * Math.sin(this.time.now * 0.005);
      g.fillStyle(0x0f1218, 1).fillRect(x, y, dw, dh);
      g.lineStyle(3, 0x6fd08c, pulse).strokeRect(x, y, dw, dh);
      // Arrow through the opening.
      const [ix, iy] = inward(door.direction);
      const cx = x + dw / 2;
      const cy = y + dh / 2;
      g.lineStyle(3, 0x6fd08c, pulse * 0.9);
      g.lineBetween(cx - ix * 12, cy - iy * 12, cx + ix * 14, cy + iy * 14);
    } else {
      g.fillStyle(0x2a1c1c, 1).fillRect(x, y, dw, dh);
      g.lineStyle(2, 0x8a4444, 1).strokeRect(x, y, dw, dh);
      // Bars.
      const bars = 4;
      g.lineStyle(3, 0xb45a5a, 0.85);
      for (let i = 1; i < bars; i++) {
        const t = i / bars;
        if (horizontal) g.lineBetween(x + dw * t, y, x + dw * t, y + dh);
        else g.lineBetween(x, y + dh * t, x + dw, y + dh * t);
      }
    }
  }

  private drawEnemy(g: Phaser.GameObjects.Graphics, enemy: Enemy, alpha: number): void {
    const x = lerp(enemy.prevX, enemy.x, alpha);
    const y = lerp(enemy.prevY, enemy.y, alpha);
    if (!enemy.alive) return;

    if (enemy.isWindingUp) {
      const p = enemy.windupProgress;
      g.lineStyle(2 + p * 3, 0xff5555, 0.3 + p * 0.7);
      g.strokeCircle(x, y, (ENEMY.ATTACK_RANGE + 10) * (0.5 + p * 0.5));
    }

    const frozen = enemy.staggerTicks > COMBAT.HIT_STAGGER_TICKS * 2;
    const body = enemy.hitFlashTicks > 0 ? 0xffffff : frozen ? 0x6fa8d0 : 0x9c5f5f;

    g.fillStyle(body, 1).fillCircle(x, y, enemy.radius);
    g.lineStyle(2, frozen ? 0xa8d8ff : 0x6b3d3d, 1).strokeCircle(x, y, enemy.radius);
    g.fillStyle(0x2a1a1a, 1).fillCircle(
      x + enemy.facingX * enemy.radius * 0.55,
      y + enemy.facingY * enemy.radius * 0.55,
      3,
    );

    if (enemy.hp < enemy.maxHp) {
      this.drawBar(g, x, y - enemy.radius - 11, 28, enemy.hp / enemy.maxHp, 0xd05a5a);
    }
  }

  private drawPlayer(g: Phaser.GameObjects.Graphics, player: Player, alpha: number): void {
    const x = lerp(player.prevX, player.x, alpha);
    const y = lerp(player.prevY, player.y, alpha);
    const def = player.def;
    const isLocal = !player.botControlled;

    if (player.life === LifeState.Wraith) {
      drawSilhouette(g, def.silhouette, x, y, player.radius, player.facingX, player.facingY, def.color, def.rim, 0.22);
      g.lineStyle(1, def.rim, 0.14).strokeCircle(x, y, DEATH.WRAITH_SLOW_RADIUS);
      return;
    }

    if (player.life === LifeState.Downed) {
      drawSilhouette(g, def.silhouette, x, y, player.radius * 0.78, player.facingX, player.facingY, def.color, 0xff6b6b, 0.5);
      this.drawBar(g, x, y - player.radius - 15, 46, player.bleedOutRemaining, 0xff6b6b);
      if (player.reviveProgress > 0) {
        this.drawBar(g, x, y - player.radius - 24, 46, player.reviveProgress, 0x6fd08c);
      }
      g.lineStyle(1.5, 0x6fd08c, 0.35).strokeCircle(x, y, DEATH.REVIVE_RANGE);
      return;
    }

    this.drawTargetMarker(g, player.target, alpha, player.overrideActive);

    if (isLocal) g.lineStyle(1, 0x3a4557, 0.45).strokeCircle(x, y, def.attackRange);

    if (player.blocking) {
      const facing = Math.atan2(player.facingY, player.facingX);
      g.lineStyle(5, 0xa8d0ff, 0.75);
      g.beginPath();
      g.arc(x, y, player.radius + 13, facing - COMBAT.BLOCK_CONE, facing + COMBAT.BLOCK_CONE);
      g.strokePath();
    }

    if (player.shieldTicks > 0) g.lineStyle(2, 0xa8d0ff, 0.5).strokeCircle(x, y, player.radius + 7);

    if (player.blinkTicks > 0) {
      g.lineStyle(2, def.rim, player.blinkTicks / 8).strokeCircle(
        x,
        y,
        player.radius + (8 - player.blinkTicks) * 4,
      );
    }

    drawSilhouette(g, def.silhouette, x, y, player.radius, player.facingX, player.facingY, def.color, def.rim, 1);
    drawFacingPip(g, x, y, player.radius, player.facingX, player.facingY, 0xffffff, 0.9);

    if (isLocal) g.lineStyle(2, 0xffffff, 0.28).strokeCircle(x, y, player.radius + 4);

    this.drawBar(g, x, y - player.radius - 14, 38, player.hp / player.maxHp, 0x6fd08c);
  }

  /**
   * The soft leash, drawn where it actually bites (§2).
   *
   * The circle is the sim's leash radius in world units — not the frame edge.
   * Drawing the real rule rather than an approximation of it is the only way
   * a player can learn where the boundary is.
   */
  private drawLeash(g: Phaser.GameObjects.Graphics): void {
    let anyOut = false;
    for (let i = 0; i < this.world.party.length; i++) {
      if (this.world.leashOvershoot(i) > 0) {
        anyOut = true;
        break;
      }
    }
    if (!anyOut) return;

    const pulse = 0.25 + 0.2 * Math.sin(this.time.now * 0.008);
    g.lineStyle(2, 0xffb347, pulse);
    g.strokeCircle(this.world.centroidX, this.world.centroidY, LEASH.RADIUS);

    for (let i = 0; i < this.world.party.length; i++) {
      const over = this.world.leashOvershoot(i);
      if (over <= 0) continue;
      const p = this.world.party[i]!.player;

      // A line home, plus an arrow on the straggler. §2 asks for a directional
      // arrow; pointing it back at the party is the actionable direction.
      const dx = this.world.centroidX - p.x;
      const dy = this.world.centroidY - p.y;
      const d = Math.hypot(dx, dy) || 1;
      g.lineStyle(2, 0xffb347, 0.5);
      g.lineBetween(p.x, p.y, p.x + (dx / d) * 60, p.y + (dy / d) * 60);
      g.fillStyle(0xffb347, 0.9);
      g.fillCircle(p.x + (dx / d) * 68, p.y + (dy / d) * 68, 5);
    }
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
    g.lineStyle(2, overridden ? 0xffb347 : 0x6fd08c, overridden ? 0.95 : 0.3).strokeCircle(
      x,
      y,
      target.radius + 6,
    );
  }

  private drawBar(
    g: Phaser.GameObjects.Graphics,
    x: number,
    y: number,
    width: number,
    fraction: number,
    color: number,
  ): void {
    const height = 4;
    const clamped = Math.max(0, Math.min(1, fraction));
    g.fillStyle(0x000000, 0.55).fillRect(x - width / 2, y, width, height);
    g.fillStyle(color, 1).fillRect(x - width / 2, y, width * clamped, height);
  }

  // --- HUD -----------------------------------------------------------------

  private drawHud(): void {
    const g = this.hudGfx;
    g.clear();

    const player = this.world.localPlayer;
    const def = player.def;

    if (this.hurtFlash > 0) {
      for (let i = 0; i < 4; i++) {
        const inset = i * 9;
        g.lineStyle(10, 0xff3b3b, this.hurtFlash * 0.16 * (1 - i / 4));
        g.strokeRect(inset, inset, VIEW.WIDTH - inset * 2, VIEW.HEIGHT - inset * 2);
      }
    }

    // Transition wipe — a bar sweeping from the direction of travel.
    if (this.world.transitionTicks > 0) {
      const t = this.world.transitionTicks / (DOOR.TRANSITION * SIM.TICK_RATE);
      g.fillStyle(0x0d0d12, Math.min(1, t * 1.6));
      g.fillRect(0, 0, VIEW.WIDTH, VIEW.HEIGHT);
    }

    const barX = 16;
    const barY = VIEW.HEIGHT - 40;
    const barW = 236;

    g.fillStyle(0x000000, 0.5).fillRoundedRect(barX - 8, barY - 10, barW + 16, 44, 6);
    g.fillStyle(0x1b2029, 1).fillRect(barX, barY, barW, 12);
    g.fillStyle(0x6fd08c, 1).fillRect(barX, barY, barW * Math.max(0, player.hp / player.maxHp), 12);
    g.lineStyle(1, 0x3a4557, 1).strokeRect(barX, barY, barW, 12);

    if (def.resource.max > 0) {
      g.fillStyle(0x1b2029, 1).fillRect(barX, barY + 16, barW, 7);
      g.fillStyle(resourceColor(def), 1).fillRect(barX, barY + 16, barW * player.resourceFraction, 7);
      g.lineStyle(1, 0x3a4557, 1).strokeRect(barX, barY + 16, barW, 7);
    }

    const slotSize = 50;
    const gap = 30;
    const totalW = slotSize * 3 + gap * 2;
    const slotY = VIEW.HEIGHT - 74;
    const startX = VIEW.WIDTH / 2 - totalW / 2;

    for (let i = 0; i < 3; i++) {
      const ability = def.abilities[i]!;
      const x = startX + i * (slotSize + gap);
      const cd = player.cooldownFraction(i);
      const cost = ability.spendsAll ? def.resource.max : ability.cost;
      const affordable = cost === 0 || player.resource >= cost;
      const ready = cd <= 0 && affordable;

      g.fillStyle(0x0e1219, 0.92).fillRoundedRect(x, slotY, slotSize, slotSize, 7);
      g.lineStyle(ready ? 2.5 : 1.5, ready ? def.rim : 0x2b3242, 1);
      g.strokeRoundedRect(x, slotY, slotSize, slotSize, 7);

      if (cd > 0) {
        g.fillStyle(0x000000, 0.62).fillRect(x + 2, slotY + 2, slotSize - 4, (slotSize - 4) * cd);
      } else if (!affordable) {
        g.fillStyle(0x000000, 0.5).fillRect(x + 2, slotY + 2, slotSize - 4, slotSize - 4);
      }

      const key = this.abilityKeys[i]!;
      key.setPosition(x + slotSize / 2, slotY + slotSize / 2);
      key.setText(KEY_HINTS[i]!);
      key.setColor(ready ? '#e8edf6' : '#5d6879');

      const label = this.abilityLabels[i]!;
      label.setPosition(x + slotSize / 2, slotY + slotSize + 9);
      label.setText(ability.name);
      label.setColor(ready ? '#c3ccdb' : '#5d6879');
    }

    this.drawPartyStrip(g);
    this.drawMinimap(g);

    const node = this.world.room;
    const kindLabel =
      node.kind === RoomKind.Boss ? 'BOSS ARENA' : node.kind === RoomKind.Entry ? 'ENTRANCE' : node.template.id.replace('crypt-', '').toUpperCase();

    this.roomText.setAlpha(this.clearFlash > 0 ? 1 : 0.65);
    this.roomText.setText(
      this.clearFlash > 0
        ? 'ROOM CLEARED — DOORS OPEN'
        : this.world.inCombat
          ? `${kindLabel}  ·  ${this.world.enemiesRemaining} LEFT  ·  DOORS LOCKED`
          : `${kindLabel}  ·  CLEAR  ·  TAKE A DOOR`,
    );

    this.hud.setText([
      `${def.name.toUpperCase()}  ·  ${def.role}`,
      `seed ${String(this.world.seed)}  room ${this.world.currentRoom}/${this.world.floor.rooms.length - 1}  tick ${this.world.tick}  ${Math.round(this.game.loop.actualFps)}fps`,
      ``,
      `WASD  move`,
      `mouse / right-stick  retarget`,
      `E  revive a downed ally`,
    ]);
  }

  private drawPartyStrip(g: Phaser.GameObjects.Graphics): void {
    const stripW = 118;
    const start = VIEW.WIDTH / 2 - (stripW * PARTY_SIZE + 8 * (PARTY_SIZE - 1)) / 2;
    for (let i = 0; i < this.world.party.length; i++) {
      const p = this.world.party[i]!.player;
      const x = start + i * (stripW + 8);
      const y = 42;

      g.fillStyle(0x000000, 0.4).fillRoundedRect(x, y, stripW, 26, 5);
      const isLocal = !p.botControlled;
      g.lineStyle(isLocal ? 2 : 1, isLocal ? 0xffffff : 0x2b3242, isLocal ? 0.7 : 1);
      g.strokeRoundedRect(x, y, stripW, 26, 5);

      drawSilhouette(g, p.def.silhouette, x + 15, y + 13, 8, 1, 0, p.def.color, p.def.rim,
        p.life === LifeState.Alive ? 1 : 0.35);

      const w = stripW - 32;
      const frac = p.life === LifeState.Downed ? p.bleedOutRemaining : p.hp / p.maxHp;
      const color =
        p.life === LifeState.Wraith ? 0x555f70 : p.life === LifeState.Downed ? 0xff6b6b : 0x6fd08c;
      g.fillStyle(0x151a22, 1).fillRect(x + 27, y + 10, w, 7);
      g.fillStyle(color, 1).fillRect(x + 27, y + 10, w * Math.max(0, frac), 7);

      // Leash warning on the strip, so you can tell *who* is straying.
      if (this.world.leashOvershoot(i) > 0) {
        g.lineStyle(2, 0xffb347, 0.9).strokeRoundedRect(x, y, stripW, 26, 5);
      }
    }
  }

  /** Floor map (§2): the graph, with visited rooms filled and the boss marked. */
  private drawMinimap(g: Phaser.GameObjects.Graphics): void {
    const rooms = this.world.floor.rooms;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const r of rooms) {
      minX = Math.min(minX, r.gx);
      minY = Math.min(minY, r.gy);
      maxX = Math.max(maxX, r.gx);
      maxY = Math.max(maxY, r.gy);
    }

    const cell = 15;
    const pad = 8;
    const cols = maxX - minX + 1;
    const rows = maxY - minY + 1;
    const mapW = cols * cell + pad * 2;
    const mapH = rows * cell + pad * 2;
    const originX = VIEW.WIDTH - mapW - 14;
    const originY = 14;

    g.fillStyle(0x000000, 0.45).fillRoundedRect(originX, originY, mapW, mapH, 5);

    for (const r of rooms) {
      const x = originX + pad + (r.gx - minX) * cell;
      const y = originY + pad + (r.gy - minY) * cell;
      const isCurrent = r.index === this.world.currentRoom;

      // Corridors between linked rooms, so the graph reads as a graph.
      for (let dir = 0; dir < 4; dir++) {
        const link = r.exits[dir];
        if (link === undefined || link === -1) continue;
        const other = rooms[link]!;
        const ox = originX + pad + (other.gx - minX) * cell;
        const oy = originY + pad + (other.gy - minY) * cell;
        g.lineStyle(1, 0x39445a, 1);
        g.lineBetween(x + cell / 2, y + cell / 2, ox + cell / 2, oy + cell / 2);
      }

      let fill = 0x232a36;
      if (r.kind === RoomKind.Boss) fill = r.visited ? 0x6b2f2f : 0x3a2027;
      else if (r.cleared) fill = 0x2f4a38;
      else if (r.visited) fill = 0x2c3446;

      g.fillStyle(fill, r.visited || r.cleared ? 1 : 0.55);
      g.fillRect(x + 2, y + 2, cell - 4, cell - 4);
      if (isCurrent) {
        g.lineStyle(2, 0xffffff, 0.9).strokeRect(x + 1, y + 1, cell - 2, cell - 2);
      }
    }
  }

  private readonly playerScreenPosition = (): Vec2 | null => {
    if (!this.world) return null;
    const rect = this.game.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const cam = this.cameras.main;
    const player = this.world.localPlayer;
    // World → camera → canvas → page. The camera transform has to be included
    // now that it zooms and scrolls, or the cursor direction would be wrong
    // everywhere except at zoom 1.
    const viewX = (player.x - cam.scrollX) * cam.zoom;
    const viewY = (player.y - cam.scrollY) * cam.zoom;
    return {
      x: rect.left + (viewX / VIEW.WIDTH) * rect.width,
      y: rect.top + (viewY / VIEW.HEIGHT) * rect.height,
    };
  };
}

const KEY_HINTS = ['SPACE', 'RMB', 'SHIFT'] as const;

const PAYOFF_IDS: ReadonlySet<string> = new Set([
  AbilityId.Shockwave,
  AbilityId.Volley,
  AbilityId.Freeze,
  AbilityId.Slam,
]);

function inward(dir: Direction): [number, number] {
  switch (dir) {
    case Direction.North:
      return [0, 1];
    case Direction.East:
      return [-1, 0];
    case Direction.South:
      return [0, -1];
    default:
      return [1, 0];
  }
}

function resourceColor(def: ClassDef): number {
  switch (def.resource.kind) {
    case 'rage':
      return 0xff7a59;
    case 'mana':
      return 0x8bb8ff;
    case 'stamina':
      return 0xffd98b;
    default:
      return 0x555f70;
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
