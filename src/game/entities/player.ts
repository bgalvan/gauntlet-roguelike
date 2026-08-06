import type { Hasher } from '../../core/checksum';
import { COMBAT, DEATH, PLAYER, SIM, UPGRADE } from '../../core/constants';
import type { InputState } from '../../input/input-state';
import { applyHit, damageArea, executeAbility } from '../abilities';
import type { AbilityContext } from '../abilities';
import { AttackStyle, ResourceKind, getClass } from '../classes';
import type { ClassDef, ClassId } from '../classes';
import { EventKind } from '../events';
import { LifeState } from '../life-state';
import { overrideHoldTicks, selectTarget } from '../targeting';
import { Transformation, deriveStats, directionsFor, tierOf } from '../upgrades';
import type { DerivedStats } from '../upgrades';
import type { Enemy } from './enemy';
import { Entity } from './entity';

const BLEED_OUT_TICKS = Math.round(DEATH.BLEED_OUT * SIM.TICK_RATE);
const REVIVE_CHANNEL_TICKS = Math.round(DEATH.REVIVE_CHANNEL * SIM.TICK_RATE);

/** A lingering damage zone — Archer's Volley, and the §4 Field breakpoint. */
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
 * share: movement, auto-attack, the resource, the three ability slots, the §8
 * death state machine, and the §4 upgrade stacks.
 *
 * **The stat rule (§4).** Nothing here reads a number off the ClassDef during
 * play. `def` is the base; `stats` is the base with every upgrade stack
 * applied, recomputed from the base whenever the stacks change. Reading
 * `def.attackDamage` at a call site would silently ignore every upgrade the
 * player ever picked, and would do so without failing any test that did not
 * already know to look.
 */
export class Player extends Entity {
  readonly def: ClassDef;

  /** Facing, kept as a unit vector so it survives standing still. */
  facingX = 0;
  facingY = 1;

  private attackCooldown = 0;

  /** Typed as Enemy rather than Entity: everything a basic attack can hit is
   *  one, and the follow-through transformations need `Enemy` to land a hit. */
  target: Enemy | null = null;

  private overrideTicks = 0;
  private overrideX = 0;
  private overrideY = 0;

  attackedThisTick = false;

  readonly slot: number;
  readonly botControlled: boolean;

  // --- §4 upgrades ---------------------------------------------------------

  /** Stacks per direction, indexed by `directionsFor(classId)` order. */
  readonly stacks: number[];

  /** The live numbers. Never assigned outside `recomputeStats`. */
  stats: DerivedStats;

  /** Set the tick a pick lands, so the renderer can flash the capstone. */
  upgradedThisTick = false;

  /**
   * Damage multiplier granted by allies' Aegis (§4). The World computes it
   * each tick from everyone's tiers and writes it here, because `takeDamage`
   * is called from three different places and none of them holds the party
   * list. Simulation state — it changes how much damage lands, so it is
   * checksummed.
   */
  auraDamageFactor = 1;

  /** Ticks spent standing still, for the Stance transformation. */
  private stillTicks = 0;

  /** Re-entrancy guard: a corpse detonation that kills detonates again. */
  private bursting = false;

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

    this.stacks = new Array<number>(directionsFor(classId).length).fill(0);
    this.stats = deriveStats(def, this.stacks);

    // Rage starts empty and is earned; mana and stamina start full.
    this.resource = def.resource.kind === ResourceKind.Rage ? 0 : this.stats.resourceMax;
  }

  override get collides(): boolean {
    return this.life !== LifeState.Wraith;
  }

  get isDashing(): boolean {
    return this.dashTicks > 0;
  }

  /** 0..1 for the HUD. Classes with no resource report 0. */
  get resourceFraction(): number {
    return this.stats.resourceMax > 0 ? this.resource / this.stats.resourceMax : 0;
  }

  /** What slot `i` actually costs after upgrades. */
  abilityCost(slot: number): number {
    const def = this.def.abilities[slot];
    if (!def) return 0;
    return def.spendsAll ? this.stats.resourceMax : def.cost;
  }

  cooldownFraction(slot: number): number {
    const def = this.def.abilities[slot];
    if (!def || def.cooldown <= 0) return 0;
    const max = def.cooldown * this.stats.abilityCooldown * SIM.TICK_RATE;
    return max > 0 ? (this.cooldowns[slot] ?? 0) / max : 0;
  }

  // --- §4 upgrades ---------------------------------------------------------

  /**
   * Take one stack in a direction and rebuild the stat block.
   *
   * Max HP moves with the pick, and the *missing* health is preserved rather
   * than the fraction: scaling current HP with max would hand a hurt player a
   * free partial heal for choosing Armor, which turns a build decision into a
   * healing decision.
   */
  applyUpgrade(directionIndex: number): void {
    if (directionIndex < 0 || directionIndex >= this.stacks.length) return;
    if ((this.stacks[directionIndex] ?? 0) >= UPGRADE.MAX_STACKS) return;

    const missing = this.maxHp - this.hp;
    this.stacks[directionIndex] = (this.stacks[directionIndex] ?? 0) + 1;
    this.recomputeStats();
    this.hp = Math.max(1, Math.min(this.maxHp, this.maxHp - missing));
    this.upgradedThisTick = true;
  }

  private recomputeStats(): void {
    this.stats = deriveStats(this.def, this.stacks);
    this.maxHp = this.stats.maxHp;
    if (this.resource > this.stats.resourceMax) this.resource = this.stats.resourceMax;
  }

  /**
   * Outgoing damage multiplier from the Stance transformation (§4).
   *
   * Two directions in the game grant it and they point opposite ways —
   * Mobility rewards moving, Stability and the Valkyrie's Self line reward
   * holding ground. One mechanism, two play patterns, which is what an axis is
   * supposed to produce.
   */
  private get stanceMultiplier(): number {
    const tier = tierOf(this.stats, Transformation.Stance);
    if (tier === 0) return 1;
    const holding = this.stats.stanceStill
      ? this.stillTicks >= UPGRADE.STANCE_SETTLE_TICKS
      : this.stillTicks === 0;
    if (!holding) return 1;
    return 1 + (UPGRADE.STANCE_BONUS[tier - 1] ?? 0);
  }

  /** True while a stance bonus is live. Render-only. */
  get stanceActive(): boolean {
    return this.stanceMultiplier > 1;
  }

  step(dt: number, input: InputState, ctx: AbilityContext): void {
    this.attackedThisTick = false;
    this.revivedThisTick = false;
    this.downedThisTick = false;
    this.upgradedThisTick = false;
    this.blocking = false;

    if (this.blinkTicks > 0) this.blinkTicks--;
    if (this.shieldTicks > 0) this.shieldTicks--;
    for (let i = 0; i < 3; i++) {
      if (this.cooldowns[i]! > 0) this.cooldowns[i]!--;
    }

    // Stillness is tracked from intent rather than from displacement, so being
    // shoved by knockback does not break a Stability build's stance.
    if (input.moveVector.x === 0 && input.moveVector.y === 0) this.stillTicks++;
    else this.stillTicks = 0;

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
      speed = this.blocking ? this.stats.moveSpeed * 0.45 : this.stats.moveSpeed;
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
      this.landedHit();
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
    // Bounded so a Field build cycling abilities cannot grow the list without
    // limit — constraint #4 budgets for a mid-range phone.
    if (this.zones.length >= 6) this.zones.shift();
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

      const cost = this.abilityCost(slot);
      if (cost > 0 && this.resource < cost) continue;

      if (def.held) {
        // Held abilities drain rather than pay up front.
        const drain = this.def.resource.drain * SIM.STEP_SECONDS;
        if (this.resource < drain) continue;
        this.resource -= drain;
      } else if (cost > 0) {
        this.resource -= cost;
      }

      if (def.cooldown > 0) {
        this.cooldowns[slot] = Math.round(
          def.cooldown * this.stats.abilityCooldown * SIM.TICK_RATE,
        );
      }

      const [dirX, dirY] = this.aimDirection();

      // Block's `power` is a mitigation *fraction*, not damage — scaling it
      // would make blocking worse the more Attack Power you took. It is read
      // straight off the def in takeDamage and never scaled here.
      const power = def.held ? def.power : def.power * this.stats.abilityPower * this.stanceMultiplier;
      const radius = def.radius * this.stats.abilityRadius;

      const impact = executeAbility(def, this, dirX, dirY, ctx, power, radius);
      if (impact) this.leaveField(impact.x, impact.y, impact.radius, power);
    }
  }

  /**
   * §4.1: "Sorcerer, 3 AoE → blasts leave a lingering damage field. 6 AoE →
   * fields chain between each other."
   *
   * Chaining is expressed as reach: at tier 2 the field is wide enough and
   * lasts long enough that consecutive blasts overlap into one burning zone.
   * A literal graph of chained fields would be a second spatial system to keep
   * deterministic for the same read on screen.
   */
  private leaveField(x: number, y: number, radius: number, power: number): void {
    const tier = tierOf(this.stats, Transformation.Field);
    if (tier === 0 || radius <= 0) return;

    this.beginZone(
      x,
      y,
      radius * (UPGRADE.FIELD_RADIUS_SHARE[tier - 1] ?? 0),
      power * (UPGRADE.FIELD_POWER_SHARE[tier - 1] ?? 0),
      Math.round((UPGRADE.FIELD_SECONDS[tier - 1] ?? 0) * SIM.TICK_RATE),
      Math.round(UPGRADE.FIELD_INTERVAL * SIM.TICK_RATE),
    );
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
    if (this.stats.resourceMax <= 0) return;
    // Stamina only regenerates when not blocking; mana always does.
    if (this.stats.resourceRegen > 0 && !this.blocking) {
      this.resource = Math.min(this.stats.resourceMax, this.resource + this.stats.resourceRegen * dt);
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

  private acquireTarget(enemies: readonly Enemy[]): void {
    this.target = selectTarget(
      this,
      enemies,
      this.overrideTicks > 0,
      this.overrideX,
      this.overrideY,
      this.stats.attackRange * this.stats.attackRange,
    );
  }

  private attack(ctx: AbilityContext): void {
    if (this.attackCooldown > 0) this.attackCooldown--;

    const target = this.target;
    if (!target || !target.alive) return;
    if (this.attackCooldown > 0) return;

    const range = this.stats.attackRange;
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const distSq = dx * dx + dy * dy;
    if (distSq > range * range) return;

    const dist = Math.sqrt(distSq);
    if (dist > 0) {
      this.facingX = dx / dist;
      this.facingY = dy / dist;
    }

    const damage = this.stats.attackDamage * this.stanceMultiplier;

    if (this.def.attackStyle === AttackStyle.Projectile) {
      this.fireBasicShot(ctx, this.facingX, this.facingY, damage);
      this.fanExtraShots(ctx, damage);
    } else {
      applyHit(this, target, damage, dx, dy, dist, ctx, {
        knockback: COMBAT.BASIC_KNOCKBACK,
        stagger: COMBAT.HIT_STAGGER_TICKS,
      });
      this.cleaveMelee(ctx, target, damage);
      this.pierceMelee(ctx, target, damage, range);
    }

    this.landedHit();
    this.attackCooldown = Math.round(this.stats.attackInterval * SIM.TICK_RATE);
    this.attackedThisTick = true;
  }

  /** One basic shot, carrying whatever Pierce this build has earned. */
  private fireBasicShot(ctx: AbilityContext, dirX: number, dirY: number, damage: number): void {
    const tier = tierOf(this.stats, Transformation.Pierce);
    const opts =
      tier > 0
        ? {
            piercing: true,
            pierceLimit: UPGRADE.PIERCE_BODIES[tier - 1] ?? 0,
            pierceFalloff: UPGRADE.PIERCE_FALLOFF,
          }
        : {};

    ctx.spawnProjectile(
      this.x,
      this.y,
      dirX,
      dirY,
      this.def.projectileSpeed,
      damage,
      this.slot,
      opts,
    );
  }

  /**
   * Cleave, projectile flavour (§4): the Archer's Multishot line.
   *
   * Melee gets an arc; a bow gets a fan. Same verb — "your basic attack hits
   * more than one body" — expressed in the idiom of the weapon, which is what
   * §5.1 asks of anything that claims to change the verb.
   */
  private fanExtraShots(ctx: AbilityContext, damage: number): void {
    const tier = tierOf(this.stats, Transformation.Cleave);
    if (tier === 0) return;

    const pairs = UPGRADE.CLEAVE_EXTRA_SHOTS[tier - 1] ?? 0;
    const share = UPGRADE.CLEAVE_SHARE[tier - 1] ?? 0;
    const base = Math.atan2(this.facingY, this.facingX);

    for (let i = 1; i <= pairs; i++) {
      const spread = UPGRADE.CLEAVE_SPREAD * i;
      for (const sign of [-1, 1]) {
        const angle = base + spread * sign;
        this.fireBasicShot(ctx, Math.cos(angle), Math.sin(angle), damage * share);
      }
    }
  }

  /** Cleave, melee flavour: an arc at tier 1, the full circle at tier 2. */
  private cleaveMelee(ctx: AbilityContext, primary: Enemy, damage: number): void {
    const tier = tierOf(this.stats, Transformation.Cleave);
    if (tier === 0) return;

    const share = UPGRADE.CLEAVE_SHARE[tier - 1] ?? 0;
    const range = this.stats.attackRange;
    const minDot = tier >= 2 ? -1.1 : Math.cos(UPGRADE.CLEAVE_HALF_ANGLE);

    for (let i = 0; i < ctx.enemies.length; i++) {
      const enemy = ctx.enemies[i]!;
      if (!enemy.alive || enemy.id === primary.id) continue;

      const dx = enemy.x - this.x;
      const dy = enemy.y - this.y;
      const dist = Math.hypot(dx, dy);
      if (dist > range + enemy.radius) continue;
      if (dist > 0 && (dx / dist) * this.facingX + (dy / dist) * this.facingY < minDot) continue;

      applyHit(this, enemy, damage * share, dx, dy, dist, ctx, {
        knockback: COMBAT.BASIC_KNOCKBACK * 0.6,
        stagger: COMBAT.HIT_STAGGER_TICKS,
      });
    }
  }

  /** Pierce, melee flavour: the swing carries into the bodies behind. */
  private pierceMelee(ctx: AbilityContext, primary: Enemy, damage: number, range: number): void {
    const tier = tierOf(this.stats, Transformation.Pierce);
    if (tier === 0) return;

    const limit = UPGRADE.PIERCE_BODIES[tier - 1] ?? 0;
    let carried = 0;

    for (let i = 0; i < ctx.enemies.length; i++) {
      if (limit >= 0 && carried >= limit) break;
      const enemy = ctx.enemies[i]!;
      if (!enemy.alive || enemy.id === primary.id) continue;

      const dx = enemy.x - this.x;
      const dy = enemy.y - this.y;
      const dist = Math.hypot(dx, dy);
      // Behind the target, roughly in line: a follow-through, not a second
      // cleave. The two transformations must not collapse into each other.
      if (dist > range * 1.15 + enemy.radius) continue;
      if (dist <= 0) continue;
      if ((dx / dist) * this.facingX + (dy / dist) * this.facingY < 0.86) continue;

      applyHit(this, enemy, damage * UPGRADE.PIERCE_FALLOFF, dx, dy, dist, ctx, {
        knockback: COMBAT.BASIC_KNOCKBACK * 0.5,
        stagger: COMBAT.HIT_STAGGER_TICKS,
      });
      carried++;
    }
  }

  /**
   * A basic attack landed.
   *
   * Rage is built by landing hits (§3.2), and the §4 Surge transformation
   * takes its refund here too. Called for projectile impacts from the World,
   * which is why it is public.
   *
   * Deliberately *not* called from ability hits: refunding an ability's own
   * cooldown out of the hits it just dealt is a feedback loop, and Whirlwind
   * hitting eight bodies would return more cooldown than it spent.
   */
  landedHit(): void {
    const onHit = this.stats.resourceOnHit;
    if (onHit > 0) {
      this.resource = Math.min(this.stats.resourceMax, this.resource + onHit);
    }

    const tier = tierOf(this.stats, Transformation.Surge);
    if (tier === 0) return;
    const refund = UPGRADE.SURGE_TICKS[tier - 1] ?? 0;
    for (let i = 0; i < 3; i++) {
      this.cooldowns[i] = Math.max(0, this.cooldowns[i]! - refund);
    }
  }

  /**
   * Something this player killed (§4 Burst).
   *
   * §4.1: "6 Power → overkill damage detonates the corpse." Called from
   * `applyHit` and from the World's projectile loop — the two places a kill
   * can be attributed to a player.
   */
  onKill(x: number, y: number, ctx: AbilityContext): void {
    const tier = tierOf(this.stats, Transformation.Burst);
    if (tier === 0) return;
    // A detonation that kills would otherwise detonate, and so on down the
    // pile. One level deep is the effect; a chain reaction is a stack overflow.
    if (this.bursting) return;

    this.bursting = true;
    const radius = UPGRADE.BURST_RADIUS[tier - 1] ?? 0;
    const power = (UPGRADE.BURST_POWER[tier - 1] ?? 0) * this.stats.abilityPower;
    damageArea(this, x, y, radius, power, ctx, {
      knockback: 120,
      stagger: tier >= 2 ? COMBAT.HIT_STAGGER_TICKS * 3 : COMBAT.HIT_STAGGER_TICKS,
      falloff: true,
    });
    ctx.events.emit(EventKind.Ability, x, y, { slot: this.slot, radius });
    this.bursting = false;
  }

  // --- §8 transitions ------------------------------------------------------

  takeDamage(amount: number, fromX = this.x, fromY = this.y): number {
    if (this.life !== LifeState.Alive) return 0;

    // §4 Armor / Absorption lines, then any ally's Aegis shelter. Both are
    // multipliers on the way in rather than flat subtractions, so neither can
    // reduce a hit to zero and make a build immortal.
    let final = amount * this.stats.damageTaken * this.auraDamageFactor;

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

  /** Heal by a fraction of max HP. Returns what actually landed, so a heart
   *  that would be wasted can be left on the floor (§7.3). */
  heal(amount: number): number {
    if (this.life !== LifeState.Alive) return 0;
    const before = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    return this.hp - before;
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

    // §4 state. Stacks decide every derived number, `stillTicks` decides
    // whether a Stance build's damage bonus is live this tick, and the aura
    // factor decides how much of the next hit lands. A peer that agreed on
    // positions but disagreed on any of these has already diverged.
    for (let i = 0; i < this.stacks.length; i++) h.int(this.stacks[i]!);
    h.int(this.stillTicks).float(this.auraDamageFactor).float(this.maxHp);

    // Zone internals decide future damage ticks — a peer whose volley is one
    // tick ahead has already diverged.
    for (let i = 0; i < this.zones.length; i++) {
      const zone = this.zones[i]!;
      h.float(zone.x).float(zone.y).int(zone.ticksLeft).int(zone.sinceLastTick);
    }
  }
}
