/**
 * Bi-directional upgrades — §4, `[LOCKED]` concept.
 *
 * Each upgrade presents two directions; the player picks one. The class
 * evolves by accumulated choice.
 *
 * §4.1 is the whole design and this file exists to honour it. A repeated
 * binary A/B produces **a slider, not a build** — pick AoE-vs-Power six times
 * and the outcome space is just "how many points in AoE". The three fixes the
 * manual asks for, all present here:
 *
 *   1. **Breakpoint transformations** — at 3 and 6 stacks a direction grants a
 *      *new behaviour*, not a bigger number. This is the one that turns a
 *      slider into a commitment.
 *   2. **Rotating axis pairs** — each class has three axes and every offer
 *      draws one of them, so the order can't be precomputed.
 *   3. **Capstone divergence** — the 6-stack breakpoint is named and the
 *      renderer marks it. It is the same mechanism as (1), deliberately: a
 *      separate capstone system would be a fourth thing to balance for the
 *      same payoff.
 *
 * Axes are **data**, exactly as classes are (§3.1). Adding an axis is content
 * work. The seven transformations below are the engineering surface, and they
 * are shared across classes on purpose — §5.2's argument is that depth comes
 * from multiplying a small set of verbs, not from authoring a unique one per
 * direction.
 *
 * Determinism (constraint #3): every function here is pure, stacks live in
 * index-ordered arrays, and derived stats are recomputed **from the class base
 * every time** rather than accumulated in place. That last part is not a
 * style preference — accumulating `value *= 1.06` on every pick is exactly the
 * float drift constraint #3 warns about, and two peers that took the same
 * upgrades in a different frame order would end up with different damage.
 */

import { UPGRADE } from '../core/constants';
import type { ClassDef, ClassId } from './classes';
import { ClassId as ClassIds } from './classes';

// ---------------------------------------------------------------------------
// Transformations — the behaviours breakpoints grant
// ---------------------------------------------------------------------------

/**
 * The behaviour a breakpoint unlocks. Each is held at a **tier**: 0 (absent),
 * 1 (granted at 3 stacks), 2 (compounded at 6).
 *
 * Seven verbs, shared across twenty-four directions. A direction's 3- and
 * 6-stack breakpoints do not have to be the same verb — the Sorcerer's Attack
 * Power line goes pierce → corpse burst, which is what §4.1 specifies
 * literally.
 */
export const Transformation = {
  /** Basic attacks strike more than one body — an arc for melee, a fan of
   *  extra shots for projectiles. */
  Cleave: 'cleave',
  /** Basic attacks carry through the body they hit into the ones behind. */
  Pierce: 'pierce',
  /** Area abilities leave a lingering damage field where they landed. */
  Field: 'field',
  /** A kill detonates the corpse. */
  Burst: 'burst',
  /** Landing a hit shaves ticks off every ability cooldown. */
  Surge: 'surge',
  /** Nearby allies take reduced damage. */
  Aegis: 'aegis',
  /** Bonus damage while meeting a positional condition — moving, or still. */
  Stance: 'stance',
} as const;

export type Transformation = (typeof Transformation)[keyof typeof Transformation];

/** Fixed order. Tier arrays are indexed by this — never by object key order. */
export const TRANSFORMATION_ORDER: readonly Transformation[] = [
  Transformation.Cleave,
  Transformation.Pierce,
  Transformation.Field,
  Transformation.Burst,
  Transformation.Surge,
  Transformation.Aegis,
  Transformation.Stance,
];

const TRANSFORMATION_INDEX: Record<Transformation, number> = {
  [Transformation.Cleave]: 0,
  [Transformation.Pierce]: 1,
  [Transformation.Field]: 2,
  [Transformation.Burst]: 3,
  [Transformation.Surge]: 4,
  [Transformation.Aegis]: 5,
  [Transformation.Stance]: 6,
};

/** One line each, for the HUD. */
export const TRANSFORMATION_BLURB: Record<Transformation, readonly [string, string]> = {
  [Transformation.Cleave]: [
    'Attacks strike a second body.',
    'Attacks strike everything around you.',
  ],
  [Transformation.Pierce]: [
    'Attacks carry through one body behind.',
    'Attacks carry through everything in line.',
  ],
  [Transformation.Field]: [
    'Area abilities leave a burning field.',
    'Fields are wider and burn far longer.',
  ],
  [Transformation.Burst]: ['Kills detonate the corpse.', 'Detonations are larger and stagger.'],
  [Transformation.Surge]: ['Landing a hit refunds cooldown.', 'Landing a hit refunds far more.'],
  [Transformation.Aegis]: ['Nearby allies take less damage.', 'The shelter is stronger and wider.'],
  [Transformation.Stance]: ['Bonus damage in your stance.', 'The stance bonus roughly doubles.'],
};

// ---------------------------------------------------------------------------
// Directions and axes
// ---------------------------------------------------------------------------

/**
 * Per-stack stat deltas, as fractions of the class base.
 *
 * Applied as `base * (1 + delta * stacks)` — linear in stacks, computed from
 * the base every time. Deliberately additive rather than compounding: six
 * compounding picks are hard to reason about at the design table and, more
 * importantly, invite an implementation that multiplies into a stored field.
 */
export interface StatMods {
  readonly maxHp?: number;
  readonly moveSpeed?: number;
  readonly attackDamage?: number;
  /** Negative is faster — this is a delay, not a rate. */
  readonly attackInterval?: number;
  readonly attackRange?: number;
  readonly resourceMax?: number;
  readonly resourceRegen?: number;
  readonly resourceOnHit?: number;
  readonly abilityPower?: number;
  readonly abilityRadius?: number;
  /** Negative is shorter. */
  readonly abilityCooldown?: number;
  /** Negative is tougher. */
  readonly damageTaken?: number;
}

export interface DirectionDef {
  /** Globally unique and stable — it is what a saved build would record. */
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly mods: StatMods;
  /** Granted at UPGRADE.BREAKPOINT_1 stacks. */
  readonly at3: Transformation | null;
  /** Granted at UPGRADE.BREAKPOINT_2 stacks — the named capstone. */
  readonly at6: Transformation | null;
  /** §4.1 fix 3: the capstone has a name, and the renderer shows it. */
  readonly capstone: string;
  /** Only read when this direction grants Stance: true rewards standing
   *  still, false rewards moving. */
  readonly stanceStill?: boolean;
}

export interface AxisDef {
  readonly id: string;
  readonly a: DirectionDef;
  readonly b: DirectionDef;
}

// ---------------------------------------------------------------------------
// §4.2 axis pools
//
// Reach ↔ Force and Blast Radius ↔ Attack Power are Bobby's original axes and
// the model the rest follow. The Sorcerer's breakpoints are transcribed from
// §4.1 exactly: 3 AoE → lingering field, 6 AoE → fields chain, 3 Power →
// blasts pierce, 6 Power → overkill detonates the corpse.
// ---------------------------------------------------------------------------

const WARRIOR_AXES: readonly AxisDef[] = [
  {
    id: 'warrior-reach-force',
    a: {
      id: 'warrior-reach',
      name: 'Reach',
      blurb: 'Longer swings, wider abilities.',
      mods: { attackRange: 0.08, abilityRadius: 0.06 },
      at3: Transformation.Cleave,
      at6: Transformation.Cleave,
      capstone: 'Stormbringer',
    },
    b: {
      id: 'warrior-force',
      name: 'Force',
      blurb: 'Heavier hits on one body.',
      mods: { attackDamage: 0.09, abilityPower: 0.05 },
      at3: Transformation.Burst,
      at6: Transformation.Burst,
      capstone: 'Executioner',
    },
  },
  {
    id: 'warrior-rage',
    a: {
      id: 'warrior-rage-generation',
      name: 'Rage Generation',
      blurb: 'Rage builds faster; you swing faster.',
      mods: { resourceOnHit: 0.18, attackInterval: -0.04 },
      at3: Transformation.Surge,
      at6: Transformation.Surge,
      capstone: 'Berserker',
    },
    b: {
      id: 'warrior-rage-capacity',
      name: 'Rage Capacity',
      blurb: 'A deeper pool, and a heavier payoff.',
      mods: { resourceMax: 0.14, abilityPower: 0.07 },
      at3: Transformation.Field,
      at6: Transformation.Field,
      capstone: 'Warbringer',
    },
  },
  {
    id: 'warrior-armor-aggression',
    a: {
      id: 'warrior-armor',
      name: 'Armor',
      blurb: 'Take less, and hold more.',
      mods: { damageTaken: -0.07, maxHp: 0.06 },
      at3: Transformation.Aegis,
      at6: Transformation.Aegis,
      capstone: 'Bulwark',
    },
    b: {
      id: 'warrior-aggression',
      name: 'Aggression',
      blurb: 'Hit harder and move faster — and take more.',
      mods: { attackDamage: 0.07, moveSpeed: 0.05, damageTaken: 0.04 },
      at3: Transformation.Pierce,
      at6: Transformation.Pierce,
      capstone: 'Reaver',
    },
  },
];

const ARCHER_AXES: readonly AxisDef[] = [
  {
    id: 'archer-cadence',
    a: {
      id: 'archer-fire-rate',
      name: 'Fire Rate',
      blurb: 'Shoot faster.',
      mods: { attackInterval: -0.07 },
      at3: Transformation.Surge,
      at6: Transformation.Surge,
      capstone: 'Stormfletcher',
    },
    b: {
      id: 'archer-charge-damage',
      name: 'Charge Damage',
      blurb: 'Abilities hit far harder.',
      mods: { abilityPower: 0.11, attackDamage: 0.05 },
      at3: Transformation.Burst,
      at6: Transformation.Burst,
      capstone: 'Siegebreaker',
    },
  },
  {
    id: 'archer-shot-shape',
    a: {
      id: 'archer-pierce',
      name: 'Pierce',
      blurb: 'Arrows punch through.',
      mods: { attackDamage: 0.06, attackRange: 0.04 },
      at3: Transformation.Pierce,
      at6: Transformation.Pierce,
      capstone: 'Spinewalker',
    },
    b: {
      id: 'archer-multishot',
      name: 'Multishot',
      blurb: 'More arrows, spread wider.',
      mods: { attackDamage: 0.05, abilityRadius: 0.04 },
      at3: Transformation.Cleave,
      at6: Transformation.Cleave,
      capstone: 'Skydarkener',
    },
  },
  {
    id: 'archer-footwork',
    a: {
      id: 'archer-mobility',
      name: 'Mobility',
      blurb: 'Faster, with shorter cooldowns.',
      mods: { moveSpeed: 0.06, abilityCooldown: -0.05 },
      at3: Transformation.Stance,
      at6: Transformation.Stance,
      capstone: 'Windrunner',
      stanceStill: false,
    },
    b: {
      id: 'archer-stability',
      name: 'Stability',
      blurb: 'Reward for holding a firing line.',
      mods: { attackDamage: 0.07, attackRange: 0.05 },
      at3: Transformation.Stance,
      at6: Transformation.Stance,
      capstone: 'Deadeye',
      stanceStill: true,
    },
  },
];

const SORCERER_AXES: readonly AxisDef[] = [
  {
    id: 'sorcerer-blast',
    a: {
      id: 'sorcerer-blast-radius',
      name: 'Blast Radius',
      blurb: 'Wider blasts.',
      mods: { abilityRadius: 0.09, attackRange: 0.04 },
      // §4.1, verbatim: 3 AoE → blasts leave a lingering damage field.
      // 6 AoE → the fields grow into one another.
      at3: Transformation.Field,
      at6: Transformation.Field,
      capstone: 'Zone Controller',
    },
    b: {
      id: 'sorcerer-attack-power',
      name: 'Attack Power',
      blurb: 'Denser, deadlier magic.',
      mods: { attackDamage: 0.1, abilityPower: 0.07 },
      // §4.1, verbatim: 3 Power → blasts pierce the first enemy.
      // 6 Power → overkill damage detonates the corpse.
      at3: Transformation.Pierce,
      at6: Transformation.Burst,
      capstone: 'Nuker',
    },
  },
  {
    id: 'sorcerer-mana',
    a: {
      id: 'sorcerer-cast-speed',
      name: 'Cast Speed',
      blurb: 'Cast and recover faster.',
      mods: { attackInterval: -0.07, abilityCooldown: -0.05 },
      at3: Transformation.Surge,
      at6: Transformation.Surge,
      capstone: 'Channeler',
    },
    b: {
      id: 'sorcerer-mana-pool',
      name: 'Mana Pool',
      blurb: 'A deeper well, refilling faster.',
      mods: { resourceMax: 0.13, resourceRegen: 0.09 },
      at3: Transformation.Burst,
      at6: Transformation.Burst,
      capstone: 'Wellspring',
    },
  },
  {
    id: 'sorcerer-shape',
    a: {
      id: 'sorcerer-duration',
      name: 'Duration',
      blurb: 'Effects linger and spread.',
      mods: { abilityRadius: 0.08, abilityPower: 0.06 },
      at3: Transformation.Field,
      at6: Transformation.Field,
      capstone: 'Everburn',
    },
    b: {
      id: 'sorcerer-burst',
      name: 'Burst',
      blurb: 'Everything at once, as hard as possible.',
      mods: { abilityPower: 0.12, attackDamage: 0.04 },
      at3: Transformation.Burst,
      at6: Transformation.Burst,
      capstone: 'Cataclysm',
    },
  },
];

const VALKYRIE_AXES: readonly AxisDef[] = [
  {
    id: 'valkyrie-shield',
    a: {
      id: 'valkyrie-cone-width',
      name: 'Cone Width',
      blurb: 'A broader shield face.',
      mods: { abilityRadius: 0.09, attackRange: 0.05 },
      at3: Transformation.Cleave,
      at6: Transformation.Cleave,
      capstone: 'Stormwall',
    },
    b: {
      id: 'valkyrie-absorption',
      name: 'Absorption',
      blurb: 'Soak far more of what lands.',
      mods: { damageTaken: -0.08, resourceMax: 0.05 },
      at3: Transformation.Aegis,
      at6: Transformation.Aegis,
      capstone: 'Aegis Eternal',
    },
  },
  {
    id: 'valkyrie-stamina',
    a: {
      id: 'valkyrie-retaliation',
      name: 'Retaliation',
      blurb: 'Answer every blow.',
      mods: { attackDamage: 0.09, abilityPower: 0.05 },
      at3: Transformation.Burst,
      at6: Transformation.Burst,
      capstone: 'Thornguard',
    },
    b: {
      id: 'valkyrie-endurance',
      name: 'Endurance',
      blurb: 'Block for longer, stand for longer.',
      mods: { resourceRegen: 0.09, maxHp: 0.05 },
      at3: Transformation.Surge,
      at6: Transformation.Surge,
      capstone: 'Unbroken',
    },
  },
  {
    id: 'valkyrie-who',
    a: {
      id: 'valkyrie-self',
      name: 'Self',
      blurb: 'The block protects you, and you alone.',
      mods: { maxHp: 0.07, damageTaken: -0.05, moveSpeed: 0.04 },
      at3: Transformation.Stance,
      at6: Transformation.Stance,
      capstone: 'Lone Bastion',
      stanceStill: true,
    },
    b: {
      id: 'valkyrie-party',
      name: 'Party',
      blurb: 'The block protects whoever stands with you.',
      mods: { abilityRadius: 0.05, maxHp: 0.04 },
      at3: Transformation.Aegis,
      at6: Transformation.Aegis,
      capstone: 'Shieldmother',
    },
  },
];

const AXES: Record<ClassId, readonly AxisDef[]> = {
  [ClassIds.Warrior]: WARRIOR_AXES,
  [ClassIds.Archer]: ARCHER_AXES,
  [ClassIds.Sorcerer]: SORCERER_AXES,
  [ClassIds.Valkyrie]: VALKYRIE_AXES,
};

export function axesFor(classId: ClassId): readonly AxisDef[] {
  return AXES[classId];
}

/**
 * A class's directions, flattened in a fixed order: [a0, b0, a1, b1, a2, b2].
 *
 * A player's stack array is indexed by position in *this* list. Flattening in
 * axis order rather than sorting by id keeps the index stable against a
 * rename, and keeps the two halves of an axis adjacent for the HUD.
 */
export function directionsFor(classId: ClassId): readonly DirectionDef[] {
  const out: DirectionDef[] = [];
  const axes = AXES[classId];
  for (let i = 0; i < axes.length; i++) {
    out.push(axes[i]!.a, axes[i]!.b);
  }
  return out;
}

/** Every direction in the game, for the harness's non-vacuous coverage check. */
export function allDirections(): readonly DirectionDef[] {
  const out: DirectionDef[] = [];
  for (const classId of Object.keys(AXES) as ClassId[]) {
    const dirs = directionsFor(classId);
    for (let i = 0; i < dirs.length; i++) out.push(dirs[i]!);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Derived stats
// ---------------------------------------------------------------------------

/**
 * A class's live numbers: the ClassDef base with every stack applied.
 *
 * Nothing outside this module writes one. Player holds the current value and
 * recomputes it whenever its stacks change — which is the only time it can
 * change, since stats are a pure function of (class, stacks).
 */
export interface DerivedStats {
  readonly maxHp: number;
  readonly moveSpeed: number;
  readonly attackInterval: number;
  readonly attackDamage: number;
  readonly attackRange: number;
  readonly resourceMax: number;
  readonly resourceRegen: number;
  readonly resourceOnHit: number;
  /** Multipliers applied to the AbilityDef's authored values at use time. */
  readonly abilityPower: number;
  readonly abilityRadius: number;
  readonly abilityCooldown: number;
  /** Multiplier on incoming damage. */
  readonly damageTaken: number;
  /** Tier per transformation, indexed by TRANSFORMATION_ORDER. */
  readonly tiers: readonly number[];
  /** Which way the Stance transformation points, when it is held at all. */
  readonly stanceStill: boolean;
}

/**
 * Lower bounds. A stat that can reach zero is a stat that can produce a
 * divide-by-zero or an infinite fire rate six picks into a run; these are the
 * floors that keep the linear model safe at the top of its range.
 */
const MIN_INTERVAL_FACTOR = 0.35;
const MIN_DAMAGE_TAKEN = 0.3;
const MIN_COOLDOWN_FACTOR = 0.45;

export function deriveStats(def: ClassDef, stacks: readonly number[]): DerivedStats {
  const dirs = directionsFor(def.id);

  let maxHp = 0;
  let moveSpeed = 0;
  let attackDamage = 0;
  let attackInterval = 0;
  let attackRange = 0;
  let resourceMax = 0;
  let resourceRegen = 0;
  let resourceOnHit = 0;
  let abilityPower = 0;
  let abilityRadius = 0;
  let abilityCooldown = 0;
  let damageTaken = 0;

  const tiers: number[] = [0, 0, 0, 0, 0, 0, 0];

  // Which direction is currently dictating the Stance flavour, and with how
  // many stacks. Ties go to the earlier direction, so the answer never depends
  // on iteration luck.
  let stanceStacks = 0;
  let stanceStill = false;

  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]!;
    const n = stacks[i] ?? 0;
    if (n <= 0) continue;

    const m = dir.mods;
    maxHp += (m.maxHp ?? 0) * n;
    moveSpeed += (m.moveSpeed ?? 0) * n;
    attackDamage += (m.attackDamage ?? 0) * n;
    attackInterval += (m.attackInterval ?? 0) * n;
    attackRange += (m.attackRange ?? 0) * n;
    resourceMax += (m.resourceMax ?? 0) * n;
    resourceRegen += (m.resourceRegen ?? 0) * n;
    resourceOnHit += (m.resourceOnHit ?? 0) * n;
    abilityPower += (m.abilityPower ?? 0) * n;
    abilityRadius += (m.abilityRadius ?? 0) * n;
    abilityCooldown += (m.abilityCooldown ?? 0) * n;
    damageTaken += (m.damageTaken ?? 0) * n;

    // §4.1: investment is not linear. At 3 and 6 the direction hands over a
    // behaviour. Two directions granting the same verb take the higher tier —
    // complementary axes compound rather than cancelling.
    if (n >= UPGRADE.BREAKPOINT_1 && dir.at3) {
      const idx = TRANSFORMATION_INDEX[dir.at3];
      if (tiers[idx]! < 1) tiers[idx] = 1;
    }
    if (n >= UPGRADE.BREAKPOINT_2 && dir.at6) {
      const idx = TRANSFORMATION_INDEX[dir.at6];
      if (tiers[idx]! < 2) tiers[idx] = 2;
    }

    if ((dir.at3 === Transformation.Stance || dir.at6 === Transformation.Stance) && n > stanceStacks) {
      stanceStacks = n;
      stanceStill = dir.stanceStill === true;
    }
  }

  return {
    maxHp: def.maxHp * (1 + maxHp),
    moveSpeed: def.moveSpeed * (1 + moveSpeed),
    attackInterval: def.attackInterval * Math.max(MIN_INTERVAL_FACTOR, 1 + attackInterval),
    attackDamage: def.attackDamage * (1 + attackDamage),
    attackRange: def.attackRange * (1 + attackRange),
    resourceMax: def.resource.max * (1 + resourceMax),
    resourceRegen: def.resource.regen * (1 + resourceRegen),
    resourceOnHit: def.resource.onHit * (1 + resourceOnHit),
    abilityPower: 1 + abilityPower,
    abilityRadius: 1 + abilityRadius,
    abilityCooldown: Math.max(MIN_COOLDOWN_FACTOR, 1 + abilityCooldown),
    damageTaken: Math.max(MIN_DAMAGE_TAKEN, 1 + damageTaken),
    tiers,
    stanceStill,
  };
}

/** Convenience for the places that ask about one verb. */
export function tierOf(stats: DerivedStats, t: Transformation): number {
  return stats.tiers[TRANSFORMATION_INDEX[t]] ?? 0;
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

/** One live "pick a direction" prompt, held by the World for a slot. */
export interface UpgradeOffer {
  /** Which of the class's axes this draw landed on. */
  readonly axisIndex: number;
  /** Direction indices into `directionsFor(classId)`. */
  readonly a: number;
  readonly b: number;
  /** 0 = the first direction is highlighted, 1 = the second. */
  highlight: number;
  /** Ticks the offer has been open — drives the bot's pause and the
   *  anti-stall auto-confirm. */
  age: number;
}

/**
 * Draw an offer — §4.1 fix 2, rotating axis pairs.
 *
 * `avoidAxis` is the axis this player was offered last time. Two identical
 * prompts in a row is the shape §4.1 warns about: "players can't precompute a
 * fixed order, and the run generates its own shape." It is a preference, not
 * a rule — with one axis left unmaxed, repeating it beats offering nothing.
 *
 * Returns null once every direction is capped, which is the honest answer:
 * there is nothing left to choose.
 */
export function rollOffer(
  classId: ClassId,
  stacks: readonly number[],
  rng: { int(min: number, max: number): number },
  avoidAxis: number,
): UpgradeOffer | null {
  const axes = AXES[classId];

  const open: number[] = [];
  const fallback: number[] = [];
  for (let i = 0; i < axes.length; i++) {
    const a = stacks[i * 2] ?? 0;
    const b = stacks[i * 2 + 1] ?? 0;
    if (a >= UPGRADE.MAX_STACKS && b >= UPGRADE.MAX_STACKS) continue;
    fallback.push(i);
    if (i !== avoidAxis) open.push(i);
  }

  const pool = open.length > 0 ? open : fallback;
  if (pool.length === 0) return null;

  const axisIndex = pool[rng.int(0, pool.length - 1)]!;
  return { axisIndex, a: axisIndex * 2, b: axisIndex * 2 + 1, highlight: 0, age: 0 };
}

/**
 * The capstone a class has reached, or null.
 *
 * §4.3 asks for choices to be visible to the party, and a capstone is the part
 * worth reading across the room. When two directions are both maxed the
 * earlier one wins, so the label is stable rather than flickering.
 */
export function capstoneOf(classId: ClassId, stacks: readonly number[]): string | null {
  const dirs = directionsFor(classId);
  for (let i = 0; i < dirs.length; i++) {
    if ((stacks[i] ?? 0) >= UPGRADE.BREAKPOINT_2) return dirs[i]!.capstone;
  }
  return null;
}
