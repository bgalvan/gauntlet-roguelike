import Phaser from 'phaser';

import { COMBAT, DEATH, ENEMY, PARTY_SIZE, ROOM, SIM } from '../core/constants';
import { FixedLoop } from '../core/fixed-loop';
import { AbilityId, CLASS_ORDER, ClassId } from '../game/classes';
import type { ClassDef } from '../game/classes';
import type { Enemy } from '../game/entities/enemy';
import type { Entity } from '../game/entities/entity';
import type { Player } from '../game/entities/player';
import { EventKind } from '../game/events';
import { LifeState } from '../game/life-state';
import { World } from '../game/world';
import { GamepadBackend } from '../input/backends/gamepad';
import { KeyboardMouseBackend } from '../input/backends/keyboard-mouse';
import { InputManager } from '../input/input-manager';
import type { Vec2 } from '../input/input-state';
import { audio } from '../render/audio';
import { Particles } from '../render/particles';
import { drawFacingPip, drawSilhouette } from '../render/silhouette';

/** Floating combat text. Pooled — kills come in bursts. */
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
 * The only Phaser-aware file besides main.ts and the select scene.
 *
 * It reads the world and never mutates it. Everything visual interpolates
 * between the last two sim states using the loop's alpha, which is what lets
 * a 60 Hz simulation look smooth on a 144 Hz display.
 *
 * All the "juice" lives here — particles, shake, damage numbers, sound —
 * precisely because none of it may affect the simulation. Knockback and
 * stagger, which *do* affect it, live in the sim and are checksummed.
 */
export class GameScene extends Phaser.Scene {
  private world!: World;
  private loop!: FixedLoop;
  private input$!: InputManager;
  private kbm!: KeyboardMouseBackend;

  private worldGfx!: Phaser.GameObjects.Graphics;
  private hudGfx!: Phaser.GameObjects.Graphics;
  private readonly particles = new Particles();

  private hud!: Phaser.GameObjects.Text;
  private banner!: Phaser.GameObjects.Text;
  private waveText!: Phaser.GameObjects.Text;
  private readonly abilityLabels: Phaser.GameObjects.Text[] = [];
  private readonly abilityKeys: Phaser.GameObjects.Text[] = [];
  private readonly damageNumbers: DamageNumber[] = [];

  /** Screen shake, in world units. Render-only. */
  private shake = 0;
  private shakeX = 0;
  private shakeY = 0;

  /** Banner pulse when a wave is cleared. */
  private waveFlash = 0;

  /** Red edge vignette when the local player takes a hit. */
  private hurtFlash = 0;
  private lastLocalHp = Infinity;

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
    }

    // Debug read-out lives top-left: the bottom band is crowded with the
    // vitals panel and the ability row, and they overlapped there.
    this.hud = this.add
      .text(14, 12, '', {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '11px',
        color: '#5d6879',
        lineSpacing: 3,
      })
      .setDepth(21);

    for (let i = 0; i < 3; i++) {
      // Key hint inside the box, ability name underneath. One label per slot
      // holding both would need two positions.
      this.abilityKeys.push(
        this.add
          .text(0, 0, '', {
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: '11px',
            color: '#e8edf6',
          })
          .setOrigin(0.5)
          .setDepth(22),
      );
      this.abilityLabels.push(
        this.add
          .text(0, 0, '', {
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: '9px',
            color: '#c3ccdb',
          })
          .setOrigin(0.5)
          .setDepth(22),
      );
    }

    this.waveText = this.add
      .text(ROOM.WIDTH / 2, 44, '', {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '17px',
        color: '#8b9bb4',
      })
      .setOrigin(0.5)
      .setDepth(21);

    this.banner = this.add
      .text(ROOM.WIDTH / 2, ROOM.HEIGHT / 2, '', {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '34px',
        color: '#ff8080',
        align: 'center',
      })
      .setOrigin(0.5)
      .setDepth(30);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.input$.destroy());
  }

  /**
   * A run is reproducible from its seed. The generation suffix exists only so
   * the sandbox can restart after a wipe without replaying the identical run.
   */
  private newRun(): void {
    // The player takes slot 0 with their chosen class; the three bots fill the
    // remaining classes, so every run is a full party of four distinct roles.
    const roster: ClassId[] = [this.chosenClass];
    for (const id of CLASS_ORDER) if (id !== this.chosenClass) roster.push(id);

    this.world = new World(`phase-1#${this.generation}`, 1, roster);
    this.restartTimer = 0;
    this.shake = 0;
    this.waveFlash = 0;
    this.hurtFlash = 0;
    // Seeded from the new party so the first tick doesn't read as a hit.
    this.lastLocalHp = this.world.localPlayer.hp;
    this.particles.clear();
    for (const d of this.damageNumbers) {
      d.active = false;
      d.text.setVisible(false);
    }
  }

  override update(time: number, delta: number): void {
    this.kbm.setNow(time);
    const dt = delta / 1000;

    const previousWaves = this.world.wavesCleared;

    this.loop.advance(delta, (step) => {
      this.world.setInput(0, this.input$.sample());
      this.world.step(step);
      this.consumeEvents();
    });

    if (this.world.wavesCleared > previousWaves) {
      this.waveFlash = 1.6;
      audio.waveClear();
    }

    this.particles.update(dt);
    this.updateDamageNumbers(dt);
    this.updateShake(dt);
    if (this.waveFlash > 0) this.waveFlash -= dt;
    if (this.hurtFlash > 0) this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.2);

    if (this.world.runOver) {
      this.restartTimer += dt;
      this.banner.setText(
        `PARTY WIPED\nwaves cleared ${this.world.wavesCleared}\n\nrestarting…`,
      );
      if (this.restartTimer >= RESTART_DELAY) {
        this.generation++;
        this.newRun();
      }
    } else {
      this.banner.setText('');
    }

    this.draw(this.loop.alpha);
    this.drawHud();
  }

  // --- events → juice ------------------------------------------------------

  /**
   * Turn this tick's simulation events into particles, shake and sound.
   *
   * This is the one-way valve: the sim emits what happened, the renderer
   * decides how loud it looks. Nothing here writes back.
   */
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

        // Downed and Revived are driven off the per-player flags below rather
        // than the event stream — handling both would double the effect.
        case EventKind.Blocked:
          this.particles.burst(e.x, e.y, e.dirX, e.dirY, 6, { color: 0xa8d0ff, speed: 160 });
          break;
      }
    }

    // Taking damage yourself needs its own cue — without one, losing health
    // in a busy fight is genuinely easy to miss.
    const local = this.world.localPlayer;
    if (local.hp < this.lastLocalHp) {
      this.hurtFlash = Math.min(1, this.hurtFlash + 0.55);
      this.addShake(3);
      audio.hurt();
    }
    this.lastLocalHp = local.hp;

    // Per-player reactions the event stream doesn't carry.
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
      if (p.isDashing) {
        this.particles.trail(p.x, p.y, this.slotColor(p.slot), 5, 0.3);
      }
      if (p.attackedThisTick && p.def.attackStyle === 'projectile') audio.shoot();
    }

    for (const shot of this.world.projectiles) {
      if (shot.active) this.particles.trail(shot.x, shot.y, this.slotColor(shot.ownerSlot), 3, 0.18);
    }
  }

  private addShake(amount: number): void {
    // Saturating rather than additive — twenty hits on one tick should not
    // launch the camera into orbit.
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
    if (amount <= 0) return;
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
      d.text.setPosition(d.x + this.shakeX, d.y + this.shakeY);
      d.text.setAlpha(Math.min(1, t * 1.8));
      d.text.setScale(0.85 + (1 - t) * 0.25);
    }
  }

  private slotColor(slot: number): number {
    const player = this.world.party[slot]?.player;
    return player ? player.def.color : 0xffffff;
  }

  // --- rendering ----------------------------------------------------------

  private draw(alpha: number): void {
    const g = this.worldGfx;
    g.clear();

    const ox = this.shakeX;
    const oy = this.shakeY;

    this.drawRoom(g, ox, oy);

    // Volley zones, under everything — they are ground effects.
    for (const slot of this.world.party) {
      for (const zone of slot.player.activeZones) {
        const pulse = 0.16 + 0.1 * Math.sin(this.time.now * 0.012);
        g.fillStyle(slot.player.def.color, pulse);
        g.fillCircle(zone.x + ox, zone.y + oy, zone.radius);
        g.lineStyle(1.5, slot.player.def.color, 0.5);
        g.strokeCircle(zone.x + ox, zone.y + oy, zone.radius);
      }
    }

    this.particles.draw(g);

    for (const enemy of this.world.enemies) this.drawEnemy(g, enemy, alpha, ox, oy);

    for (const shot of this.world.projectiles) {
      if (!shot.active) continue;
      const x = lerp(shot.prevX, shot.x, alpha) + ox;
      const y = lerp(shot.prevY, shot.y, alpha) + oy;
      const color = this.slotColor(shot.ownerSlot);
      g.fillStyle(0xffffff, 0.9).fillCircle(x, y, shot.radius * 0.55);
      g.lineStyle(2, color, 0.9).strokeCircle(x, y, shot.radius);
    }

    for (const slot of this.world.party) {
      this.drawPlayer(g, slot.player, alpha, ox, oy);
    }
  }

  private drawEnemy(
    g: Phaser.GameObjects.Graphics,
    enemy: Enemy,
    alpha: number,
    ox: number,
    oy: number,
  ): void {
    const x = lerp(enemy.prevX, enemy.x, alpha) + ox;
    const y = lerp(enemy.prevY, enemy.y, alpha) + oy;

    if (!enemy.alive) return;

    // The telegraph. Pillar 3 — an attack you cannot see coming is an attack
    // you cannot read, and the wind-up is the counterplay.
    if (enemy.isWindingUp) {
      const p = enemy.windupProgress;
      g.lineStyle(2 + p * 3, 0xff5555, 0.3 + p * 0.7);
      g.strokeCircle(x, y, (ENEMY.ATTACK_RANGE + 10) * (0.5 + p * 0.5));
    }

    // Frozen or staggered reads cold and still — the Sorcerer's control has
    // to be visible or it feels like nothing happened.
    const frozen = enemy.staggerTicks > COMBAT.HIT_STAGGER_TICKS * 2;
    const body = enemy.hitFlashTicks > 0 ? 0xffffff : frozen ? 0x6fa8d0 : 0x9c5f5f;

    g.fillStyle(body, 1).fillCircle(x, y, enemy.radius);
    g.lineStyle(2, frozen ? 0xa8d8ff : 0x6b3d3d, 1).strokeCircle(x, y, enemy.radius);
    // Facing nub, so a crowd doesn't read as identical blobs.
    g.fillStyle(0x2a1a1a, 1).fillCircle(
      x + enemy.facingX * enemy.radius * 0.55,
      y + enemy.facingY * enemy.radius * 0.55,
      3,
    );

    if (enemy.hp < enemy.maxHp) {
      this.drawBar(g, x, y - enemy.radius - 11, 28, enemy.hp / enemy.maxHp, 0xd05a5a);
    }
  }

  private drawPlayer(
    g: Phaser.GameObjects.Graphics,
    player: Player,
    alpha: number,
    ox: number,
    oy: number,
  ): void {
    const x = lerp(player.prevX, player.x, alpha) + ox;
    const y = lerp(player.prevY, player.y, alpha) + oy;
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

    // Target ring — amber when the player overrode the auto-pick (§16.5b).
    this.drawTargetMarker(g, player.target, alpha, player.overrideActive, ox, oy);

    if (isLocal) {
      g.lineStyle(1, 0x3a4557, 0.45).strokeCircle(x, y, def.attackRange);
    }

    // Valkyrie's block arc — directional mitigation has to be legible or it
    // is a stat, not a decision.
    if (player.blocking) {
      const facing = Math.atan2(player.facingY, player.facingX);
      g.lineStyle(5, 0xa8d0ff, 0.75);
      g.beginPath();
      g.arc(x, y, player.radius + 13, facing - COMBAT.BLOCK_CONE, facing + COMBAT.BLOCK_CONE);
      g.strokePath();
    }

    if (player.shieldTicks > 0) {
      g.lineStyle(2, 0xa8d0ff, 0.5).strokeCircle(x, y, player.radius + 7);
    }

    if (player.blinkTicks > 0) {
      g.lineStyle(2, def.rim, player.blinkTicks / 8).strokeCircle(
        x,
        y,
        player.radius + (8 - player.blinkTicks) * 4,
      );
    }

    drawSilhouette(g, def.silhouette, x, y, player.radius, player.facingX, player.facingY, def.color, def.rim, 1);
    drawFacingPip(g, x, y, player.radius, player.facingX, player.facingY, 0xffffff, 0.9);

    // Only the local player gets a ground ring — four of them is noise.
    if (isLocal) {
      g.lineStyle(2, 0xffffff, 0.28).strokeCircle(x, y, player.radius + 4);
    }

    this.drawBar(g, x, y - player.radius - 14, 38, player.hp / player.maxHp, 0x6fd08c);
  }

  private drawRoom(g: Phaser.GameObjects.Graphics, ox: number, oy: number): void {
    g.fillStyle(0x0f1218, 1).fillRect(0, 0, ROOM.WIDTH, ROOM.HEIGHT);
    g.fillStyle(0x171b24, 1).fillRect(
      ROOM.WALL + ox,
      ROOM.WALL + oy,
      ROOM.WIDTH - ROOM.WALL * 2,
      ROOM.HEIGHT - ROOM.WALL * 2,
    );

    // Floor grid — motion needs a reference or the room reads as a void.
    g.lineStyle(1, 0x1e2430, 1);
    for (let x = ROOM.WALL; x <= ROOM.WIDTH - ROOM.WALL; x += 60) {
      g.lineBetween(x + ox, ROOM.WALL + oy, x + ox, ROOM.HEIGHT - ROOM.WALL + oy);
    }
    for (let y = ROOM.WALL; y <= ROOM.HEIGHT - ROOM.WALL; y += 60) {
      g.lineBetween(ROOM.WALL + ox, y + oy, ROOM.WIDTH - ROOM.WALL + ox, y + oy);
    }

    g.lineStyle(2, 0x2c3342, 1).strokeRect(
      ROOM.WALL + ox,
      ROOM.WALL + oy,
      ROOM.WIDTH - ROOM.WALL * 2,
      ROOM.HEIGHT - ROOM.WALL * 2,
    );
  }

  private drawTargetMarker(
    g: Phaser.GameObjects.Graphics,
    target: Entity | null,
    alpha: number,
    overridden: boolean,
    ox: number,
    oy: number,
  ): void {
    if (!target || !target.alive) return;
    const x = lerp(target.prevX, target.x, alpha) + ox;
    const y = lerp(target.prevY, target.y, alpha) + oy;
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

    // Damage vignette — four concentric edge bands rather than a full-screen
    // wash, so it never obscures the fight it is reporting on.
    if (this.hurtFlash > 0) {
      for (let i = 0; i < 4; i++) {
        const inset = i * 9;
        g.lineStyle(10, 0xff3b3b, this.hurtFlash * 0.16 * (1 - i / 4));
        g.strokeRect(inset, inset, ROOM.WIDTH - inset * 2, ROOM.HEIGHT - inset * 2);
      }
    }

    // --- bottom-left: your vitals ---
    const barX = 16;
    const barY = ROOM.HEIGHT - 40;
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

    // --- bottom-centre: ability slots ---
    // Pitch has to clear the widest ability name ("Charged Shot") at 9px, or
    // the labels run into each other.
    const slotSize = 50;
    const gap = 30;
    const totalW = slotSize * 3 + gap * 2;
    const slotY = ROOM.HEIGHT - 74;
    const startX = ROOM.WIDTH / 2 - totalW / 2;

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

      // Cooldown drains downward; unaffordable dims instead.
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

    // --- top: party strip ---
    const stripW = 118;
    const stripStart = ROOM.WIDTH / 2 - (stripW * PARTY_SIZE + 8 * (PARTY_SIZE - 1)) / 2;
    for (let i = 0; i < this.world.party.length; i++) {
      const p = this.world.party[i]!.player;
      const x = stripStart + i * (stripW + 8);
      const y = 66;

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
    }

    const waveAlpha = this.waveFlash > 0 ? 1 : 0.55;
    this.waveText.setAlpha(waveAlpha);
    this.waveText.setText(
      this.waveFlash > 0
        ? `WAVE ${this.world.wavesCleared} CLEARED`
        : `WAVE ${this.world.wavesCleared + 1}   ·   ${this.world.enemiesRemaining} LEFT`,
    );

    this.hud.setText([
      `${def.name.toUpperCase()}  ·  ${def.role}`,
      `seed ${String(this.world.seed)}  tick ${this.world.tick}  ${Math.round(this.game.loop.actualFps)}fps  sim ${SIM.TICK_RATE}Hz`,
      ``,
      `WASD  move`,
      `mouse / right-stick  retarget`,
      `E  revive a downed ally`,
    ]);
  }

  // --- input plumbing -----------------------------------------------------

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

const KEY_HINTS = ['SPACE', 'RMB', 'SHIFT'] as const;

/** Slot 3 payoffs get the loud treatment (§3.3 — punctuation, not rhythm). */
const PAYOFF_IDS: ReadonlySet<string> = new Set([
  AbilityId.Shockwave,
  AbilityId.Volley,
  AbilityId.Freeze,
  AbilityId.Slam,
]);

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
