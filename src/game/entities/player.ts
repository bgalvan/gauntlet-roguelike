import type { Hasher } from '../../core/checksum';
import { COMBAT, DEATH, PLAYER, SIM } from '../../core/constants';
import type { InputState } from '../../input/input-state';
import { applyHit, damageArea, executeAbility } from '../abilities';
import type { AbilityContext } from '../abilities';
import { AttackStyle, ResourceKind, getClass } from '../classes';
import type { ClassDef, ClassId } from '../classes';
import { EventKind } from '../events';
import { LifeState } from '../life-state';
import { overrideHoldTicks, selectTarget } from '../targeting';
import { Entity } from './entity';

const BLEED_OUT_TICKS = Math.round(DEATH.BLEED_OUT * SIM.TICK_RATE);
const REVIVE_CHANNEL_TICKS = Math.round(DEATH.REVIVE_CHANNEL * SIM.TICK_RATE);

/** A lingering damage zone — Archer's Volley. */
interface Zone {
  x: number;
  y: number;
  radius: number;
  power: number;
  ticksLeft: number;
  interval: number;
  sinceLastTick: number;
}

/**
 * A party member.
 *
 * Everything that differs between classes comes from the ClassDef (§3.1 —
 * class definitions are data). This file holds the machinery all classes
 * share: movement, auto-attack, the resource, the three ability slots, and
 * the §8 death state machine.
 */
export class Player extends Entity {
  readonly def: ClassDef;

  /** Facing, kept as a unit vector so it survives standing still. */
  facingX = 0;
  facingY = 1;

  private attackCooldown = 0;

  target: Entity | null = null;

  private overrideTicks = 0;
  private overrideX = 0;
  private overrideY = 0;

  attackedThisTick = false;

  readonly slot: number;
  readonly botControlled: boolean;

  // --- resource (§3.2) -----------------------------------------------------

  resource = 0;

  /** Per-slot cooldowns, in ticks. Index matches the ability tuple. */
  private readonly cooldowns = [0, 0, 0];

  /** True for the tick a held ability (Valkyrie block) is active. */
  blocking = false;

  /** Ticks of ally shield remaining (Valkyrie slam). */
  shieldTicks = 0;

  /** Render-only flourish for Blink. */
  blinkTicks = 0;

  // --- dash state ----------------------------------------------------------

  private dashTicks = 0;
  private dashX = 0;
  private dashY = 0;
  private dashSpeed = 0;
  private dashDamage = 0;
  private dashRadius = 0;
  private dashKnockback = 0;
  /** Enemies already struck by the current dash. A dash is a moving hitbox
   *  swept every tick — without this it hits the same enemy every tick it
   *  overlaps them (~11× the listed damage over a 0.18s dash). */
  private readonly dashHitIds: number[] = [];

  /** Lingering zones this player owns. At most a couple at a time. */
  private readonly zones: Zone[] = [];

  // --- §8 death state ------------------------------------------------------

  life: LifeState = LifeState.Alive;
  bleedOutTicks = 0;
  reviveTicks = 0;
  revivedThisTick = false;
  downedThisTick = false;

  constructor(id: number, slot: number, x: number, y: number, botControlled: boolean, classId: ClassId) {
    const def = getClass(classId);
    super(id, x, y, PLAYER.RADIUS, def.maxHp);
    this.def = def;
    this.slot = slot;
    this.botControlled = botControlled;
    // Rage starts empty and is earned; mana and stamina start full.
    this.resource = def.resource.kind === ResourceKind.Rage ? 0 : def.resource.max;
  }

  override get collides(): boolean {
    return this.life !== LifeState.Wraith;
  }

  get isDashing(): boolean {
    return this.dashTicks > 0;
  }

  /** 0..1 for the HUD. Classes with no resource report 0. */
  get resourceFraction(): number {
    return this.def.resource.max > 0 ? this.resource / this.def.resource.max : 0;
  }

  cooldownFraction(slot: number): number {
    const def = this.def.abilities[slot];
    if (!def || def.cooldown <= 0) return 0;
    return (this.cooldowns[slot] ?? 0) / (def.cooldown * SIM.TICK_RATE);
  }

  step(dt: number, input: InputState, ctx: AbilityContext): void {
    this.attackedThisTick = false;
    this.revivedThisTick = false;
    this.downedThisTick = false;
    this.blocking = false;

    if (this.blinkTicks > 0) this.blinkTicks--;
    if (this.shieldTicks > 0) this.shieldTicks--;
    for (let i = 0; i < 3; i++) {
      if (this.cooldowns[i]! > 0) this.cooldowns[i]!--;
    }

    if (this.life === LifeState.Alive) {
      this.updateOverride(input);
      this.stepZones(dt, ctx);

      // A staggered player still gets carried by knockback but cannot act.
      if (this.staggerTicks === 0) {
        this.tryAbilities(input, ctx);
        this.moveOrDash(dt, input, ctx);
        this.acquireTarget(ctx.enemies);
        this.attack(ctx);
      }

      // Regen AFTER abilities, because tryAbilities is what sets `blocking`
      // this tick. Regenerating first meant stamina regened straight through
      // a held block, cutting its cost to nearly nothing.
      this.regenerate(dt);
    } else {
      this.target = null;
      this.overrideTicks = 0;
      this.move(dt, input);
      if (this.life === LifeState.Downed) this.bleedOut();
    }
  }

  // --- movement ------------------------------------------------------------

  private moveOrDash(dt: number, input: InputState, ctx: AbilityContext): void {
    if (this.dashTicks > 0) {
      this.dashTicks--;
      this.x += this.dashX * this.dashSpeed * dt;
      this.y += this.dashY * this.dashSpeed * dt;

      // A damaging dash is a moving hitbox — swept every tick so it connects
      // with everything it actually passed through, but each enemy at most
      // once per dash.
      if (this.dashDamage > 0) this.dashSweep(ctx);
      return;
    }
    this.move(dt, input);
  }

  private move(dt: number, input: InputState): void {
    const mx = input.moveVector.x;
    const my = input.moveVector.y;
    if (mx === 0 && my === 0) return;

    let speed: number;
    if (this.life === LifeState.Alive) {
      // Blocking roots you in place-ish — the cost of the Valkyrie's mitigation.
      speed = this.blocking ? this.def.moveSpeed * 0.45 : this.def.moveSpeed;
    } else if (this.life === LifeState.Downed) {
      speed = DEATH.CRAWL_SPEED;
    } else {
      speed = DEATH.WRAITH_SPEED;
    }

    this.x += mx * speed * dt;
    this.y += my * speed * dt;

    const len = Math.hypot(mx, my);
    if (len > 0) {
      this.facingX = mx / len;
      this.facingY = my / len;
    }
  }

  beginDash(
    dirX: number,
    dirY: number,
    distance: number,
    opts: { damage?: number; radius?: number; knockback?: number },
  ): void {
    const ticks = Math.max(1, Math.round(0.18 * SIM.TICK_RATE));
    this.dashTicks = ticks;
    this.dashX = dirX;
    this.dashY = dirY;
    this.dashSpeed = distance / (ticks * SIM.STEP_SECONDS);
    this.dashDamage = opts.damage ?? 0;
    this.dashRadius = opts.radius ?? 0;
    this.dashKnockback = opts.knockback ?? 260;
    this.dashHitIds.length = 0;
    this.facingX = dirX;
    this.facingY = dirY;
  }

  /** One tick of a damaging dash: hit everything in reach not already hit. */
  private dashSweep(ctx: AbilityContext): void {
    const reach = this.dashRadius + this.radius;
    for (let i = 0; i < ctx.enemies.length; i++) {
      const enemy = ctx.enemies[i]!;
      if (!enemy.alive) continue;

      let seen = false;
      for (let j = 0; j < this.dashHitIds.length; j++) {
        if (this.dashHitIds[j] === enemy.id) {
          seen = true;
          break;
        }
      }
      if (seen) continue;

      const dx = enemy.x - this.x;
      const dy = enemy.y - this.y;
      const hitReach = reach + enemy.radius;
      const distSq = dx * dx + dy * dy;
      if (distSq > hitReach * hitReach) continue;

      this.dashHitIds.push(enemy.id);
      applyHit(this, enemy, this.dashDamage, dx, dy, Math.sqrt(distSq), ctx, {
        knockback: this.dashKnockback,
        stagger: COMBAT.HIT_STAGGER_TICKS,
      });
      this.gainOnHit();
    }
  }

  beginZone(
    x: number,
    y: number,
    radius: number,
    power: number,
    ticks: number,
    interval: number,
  ): void {
    this.zones.push({ x, y, radius, power, ticksLeft: ticks, interval, sinceLastTick: 0 });
  }

  private stepZones(_dt: number, ctx: AbilityContext): void {
    for (let i = this.zones.length - 1; i >= 0; i--) {
      const zone = this.zones[i]!;
      zone.ticksLeft--;
      zone.sinceLastTick++;
      if (zone.sinceLastTick >= zone.interval) {
        zone.sinceLastTick = 0;
        damageArea(this, zone.x, zone.y, zone.radius, zone.power, ctx, { knockback: 40 });
      }
      if (zone.ticksLeft <= 0) this.zones.splice(i, 1);
    }
  }

  /** Read-only view for the renderer. */
  get activeZones(): readonly Zone[] {
    return this.zones;
  }

  // --- abilities -----------------------------------------------------------

  private tryAbilities(input: InputState, ctx: AbilityContext): void {
    for (let slot = 0; slot < 3; slot++) {
      const def = this.def.abilities[slot]!;
      const button = input.ability[slot]!;

      // Held abilities fire every tick they are down; pressed ones only on
      // the edge, which is why the input layer derives edges centrally.
      const wants = def.held ? button.down : button.pressed;
      if (!wants) continue;
      if (this.cooldowns[slot]! > 0) continue;

      const cost = def.spendsAll ? this.def.resource.max : def.cost;
      if (cost > 0 && this.resource < cost) continue;

      if (def.held) {
        // Held abilities drain rather than pay up front.
        const drain = this.def.resource.drain * SIM.STEP_SECONDS;
        if (this.resource < drain) continue;
        this.resource -= drain;
      } else if (cost > 0) {
        this.resource -= cost;
      }

      if (def.cooldown > 0) this.cooldowns[slot] = Math.round(def.cooldown * SIM.TICK_RATE);

      const [dirX, dirY] = this.aimDirection();
      executeAbility(def, this, dirX, dirY, ctx);
    }
  }

  /**
   * Where a directional ability points (§16.5b).
   *
   * The override direction when the player is expressing one, otherwise
   * facing. Never a cursor position — abilities are directional, and that is
   * what keeps mouse, stick and thumb equally expressive.
   */
  private aimDirection(): [number, number] {
    if (this.overrideTicks > 0) return [this.overrideX, this.overrideY];
    return [this.facingX, this.facingY];
  }

  private regenerate(dt: number): void {
    const res = this.def.resource;
    if (res.max <= 0) return;
    // Stamina only regenerates when not blocking; mana always does.
    if (res.regen > 0 && !this.blocking) {
      this.resource = Math.min(res.max, this.resource + res.regen * dt);
    }
  }

  // --- attacking -----------------------------------------------------------

  private updateOverride(input: InputState): void {
    if (input.targetOverride.active) {
      this.overrideX = input.targetOverride.direction.x;
      this.overrideY = input.targetOverride.direction.y;
      this.overrideTicks = overrideHoldTicks(SIM.TICK_RATE);
    } else if (this.overrideTicks > 0) {
      this.overrideTicks--;
    }
  }

  private acquireTarget(enemies: readonly Entity[]): void {
    this.target = selectTarget(
      this,
      enemies,
      this.overrideTicks > 0,
      this.overrideX,
      this.overrideY,
      this.def.attackRange * this.def.attackRange,
    );
  }

  private attack(ctx: AbilityContext): void {
    if (this.attackCooldown > 0) this.attackCooldown--;

    const target = this.target;
    if (!target || !target.alive) return;
    if (this.attackCooldown > 0) return;

    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const distSq = dx * dx + dy * dy;
    if (distSq > this.def.attackRange * this.def.attackRange) return;

    const dist = Math.sqrt(distSq);
    if (dist > 0) {
      this.facingX = dx / dist;
      this.facingY = dy / dist;
    }

    if (this.def.attackStyle === AttackStyle.Projectile) {
      ctx.spawnProjectile(
        this.x,
        this.y,
        this.facingX,
        this.facingY,
        this.def.projectileSpeed,
        this.def.attackDamage,
        this.slot,
      );
    } else {
      const wasAlive = target.alive;
      target.damage(this.def.attackDamage);
      target.applyKnockback(this.facingX, this.facingY, COMBAT.BASIC_KNOCKBACK);
      target.stagger(COMBAT.HIT_STAGGER_TICKS);
      ctx.events.emit(wasAlive && !target.alive ? EventKind.Kill : EventKind.Hit, target.x, target.y, {
        amount: this.def.attackDamage,
        dirX: this.facingX,
        dirY: this.facingY,
        slot: this.slot,
      });
    }

    this.gainOnHit();
    this.attackCooldown = Math.round(this.def.attackInterval * SIM.TICK_RATE);
    this.attackedThisTick = true;
  }

  /** Rage is built by landing hits (§3.2). Called for projectile impacts too. */
  gainOnHit(): void {
    const res = this.def.resource;
    if (res.onHit <= 0) return;
    this.resource = Math.min(res.max, this.resource + res.onHit);
  }

  // --- §8 transitions ------------------------------------------------------

  takeDamage(amount: number, fromX = this.x, fromY = this.y): number {
    if (this.life !== LifeState.Alive) return 0;

    let final = amount;

    // Valkyrie's block: mitigation from the cone she is facing. Directional,
    // so it is a positioning decision rather than a reaction test.
    if (this.blocking) {
      const dx = fromX - this.x;
      const dy = fromY - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0) {
        const dot = (dx / dist) * this.facingX + (dy / dist) * this.facingY;
        if (dot >= Math.cos(COMBAT.BLOCK_CONE)) {
          final *= this.def.abilities[1]!.power;
        }
      }
    }

    if (this.shieldTicks > 0) final *= 1 - COMBAT.SHIELD_ABSORB;

    this.hp -= final;
    if (this.hp > 0) return final;

    this.hp = 0;
    this.life = LifeState.Downed;
    this.bleedOutTicks = BLEED_OUT_TICKS;
    this.reviveTicks = 0;
    this.downedThisTick = true;
    this.target = null;
    this.dashTicks = 0;
    this.zones.length = 0;
    return final;
  }

  private bleedOut(): void {
    this.bleedOutTicks--;
    if (this.bleedOutTicks <= 0) {
      this.bleedOutTicks = 0;
      this.life = LifeState.Wraith;
      this.reviveTicks = 0;
    }
  }

  advanceRevive(channelling: boolean): void {
    if (this.life !== LifeState.Downed) return;

    if (!channelling) {
      this.reviveTicks = 0;
      return;
    }

    this.reviveTicks++;
    if (this.reviveTicks < REVIVE_CHANNEL_TICKS) return;

    this.life = LifeState.Alive;
    this.hp = this.maxHp * (DEATH.REVIVE_HP_PERCENT / 100);
    this.bleedOutTicks = 0;
    this.reviveTicks = 0;
    this.revivedThisTick = true;
  }

  get reviveProgress(): number {
    return this.reviveTicks / REVIVE_CHANNEL_TICKS;
  }

  get bleedOutRemaining(): number {
    return this.bleedOutTicks / BLEED_OUT_TICKS;
  }

  get overrideActive(): boolean {
    return this.overrideTicks > 0;
  }

  override writeChecksum(h: Hasher): void {
    super.writeChecksum(h);
    h.float(this.facingX)
      .float(this.facingY)
      .int(this.attackCooldown)
      .int(this.overrideTicks)
      .float(this.overrideX)
      .float(this.overrideY)
      .int(this.life)
      .int(this.bleedOutTicks)
      .int(this.reviveTicks)
      .float(this.resource)
      .int(this.cooldowns[0]!)
      .int(this.cooldowns[1]!)
      .int(this.cooldowns[2]!)
      .bool(this.blocking)
      .int(this.shieldTicks)
      .int(this.dashTicks)
      .int(this.dashHitIds.length)
      .int(this.zones.length)
      .int(this.target ? this.target.id : -1);
    // Zone internals decide future damage ticks — a peer whose volley is one
    // tick ahead has already diverged.
    for (let i = 0; i < this.zones.length; i++) {
      const zone = this.zones[i]!;
      h.float(zone.x).float(zone.y).int(zone.ticksLeft).int(zone.sinceLastTick);
    }
  }
}
