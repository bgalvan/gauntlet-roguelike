/**
 * Class definitions — §3.
 *
 * §3.1: "Build the class definition as data so adding one later is content
 * work, not engineering work." So everything that distinguishes a class lives
 * in this file. Ability *implementations* are keyed by id in abilities.ts;
 * adding a class that reuses existing ability kinds touches only this file.
 *
 * §3.2 requires each class to differ on at least four levers, not just damage.
 * The four in play here are movement speed, attack cadence, resource system,
 * and traversal. The fifth (relationship to pickups) needs pickups.
 */

export const ClassId = {
  Warrior: 'warrior',
  Archer: 'archer',
  Sorcerer: 'sorcerer',
  Valkyrie: 'valkyrie',
} as const;

export type ClassId = (typeof ClassId)[keyof typeof ClassId];

/** Every class in launch order. Deterministic iteration order (constraint #3). */
export const CLASS_ORDER: readonly ClassId[] = [
  ClassId.Warrior,
  ClassId.Archer,
  ClassId.Sorcerer,
  ClassId.Valkyrie,
];

/**
 * Pillar 1 — four distinct silhouettes, identifiable by shape alone. The
 * renderer draws these as actual different outlines rather than recolouring
 * one circle, because "identify by shape and screen effect alone" is a
 * `[LOCKED]` pillar and recolouring fails it for colourblind players too.
 */
export const Silhouette = {
  Blade: 'blade',
  Bow: 'bow',
  Orb: 'orb',
  Shield: 'shield',
} as const;

export type Silhouette = (typeof Silhouette)[keyof typeof Silhouette];

/** §3.2 resource systems. Archer deliberately has none — "pure skill". */
export const ResourceKind = {
  None: 'none',
  /** Warrior — built by landing hits. */
  Rage: 'rage',
  /** Sorcerer — regenerates over time. */
  Mana: 'mana',
  /** Valkyrie — drains while blocking, regenerates when not. */
  Stamina: 'stamina',
} as const;

export type ResourceKind = (typeof ResourceKind)[keyof typeof ResourceKind];

export interface ResourceDef {
  readonly kind: ResourceKind;
  readonly max: number;
  /** Passive regeneration per second. */
  readonly regen: number;
  /** Gained per landed basic attack (Rage). */
  readonly onHit: number;
  /** Drained per second while a held ability is active (Stamina). */
  readonly drain: number;
}

const NO_RESOURCE: ResourceDef = {
  kind: ResourceKind.None,
  max: 0,
  regen: 0,
  onHit: 0,
  drain: 0,
};

/** How a basic attack reaches its target. */
export const AttackStyle = {
  /** Instant hit inside range — Warrior, Valkyrie. */
  Melee: 'melee',
  /** Spawns a travelling projectile — Archer, Sorcerer. */
  Projectile: 'projectile',
} as const;

export type AttackStyle = (typeof AttackStyle)[keyof typeof AttackStyle];

export const AbilityId = {
  // Slot 1 — Traversal. Always slot 1, every class (§3.3).
  Charge: 'charge',
  Dash: 'dash',
  Blink: 'blink',
  Plow: 'plow',
  // Slot 2 — Signature.
  Whirlwind: 'whirlwind',
  ChargedShot: 'chargedShot',
  Blast: 'blast',
  Block: 'block',
  // Slot 3 — Payoff.
  Shockwave: 'shockwave',
  Volley: 'volley',
  Freeze: 'freeze',
  Slam: 'slam',
} as const;

export type AbilityId = (typeof AbilityId)[keyof typeof AbilityId];

export interface AbilityDef {
  readonly id: AbilityId;
  readonly name: string;
  /** Seconds. Slot 1 is always cooldown-gated (§3.3). */
  readonly cooldown: number;
  /** Resource spent on use. 0 for cooldown-only abilities. */
  readonly cost: number;
  /** Spends the entire resource pool rather than a fixed cost (§3.3 slot 3). */
  readonly spendsAll: boolean;
  /** Held rather than pressed — Valkyrie's block reads the analog trigger. */
  readonly held: boolean;
  /** Damage, radius, distance — meaning depends on the ability. */
  readonly power: number;
  readonly radius: number;
  readonly distance: number;
  /** One line, shown on the class select screen. */
  readonly blurb: string;
}

export interface ClassDef {
  readonly id: ClassId;
  readonly name: string;
  readonly role: string;
  readonly silhouette: Silhouette;
  readonly color: number;
  readonly rim: number;

  readonly maxHp: number;
  readonly moveSpeed: number;
  /** §3.2 cadence table — this is a primary differentiator, not a tweak. */
  readonly attackInterval: number;
  readonly attackDamage: number;
  readonly attackRange: number;
  readonly attackStyle: AttackStyle;
  /** Projectile speed, ignored for melee. */
  readonly projectileSpeed: number;

  readonly resource: ResourceDef;
  /** Exactly three: traversal, signature, payoff. The four-input budget
   *  (constraint #2) is enforced by this being a fixed-length tuple. */
  readonly abilities: readonly [AbilityDef, AbilityDef, AbilityDef];
}

// ---------------------------------------------------------------------------

const WARRIOR: ClassDef = {
  id: ClassId.Warrior,
  name: 'Warrior',
  role: 'Melee DPS',
  silhouette: Silhouette.Blade,
  color: 0xff7a59,
  rim: 0xffc0ad,

  maxHp: 130,
  moveSpeed: 250,
  attackInterval: 0.5,
  attackDamage: 13,
  attackRange: 116,
  attackStyle: AttackStyle.Melee,
  projectileSpeed: 0,

  resource: { kind: ResourceKind.Rage, max: 100, regen: 0, onHit: 11, drain: 0 },

  abilities: [
    {
      id: AbilityId.Charge,
      name: 'Charge',
      cooldown: 5,
      cost: 0,
      spendsAll: false,
      held: false,
      power: 14,
      radius: 30,
      distance: 300,
      blurb: 'Barrel forward, hitting everything on the way.',
    },
    {
      id: AbilityId.Whirlwind,
      name: 'Whirlwind',
      cooldown: 6,
      cost: 0,
      spendsAll: false,
      held: false,
      power: 20,
      radius: 130,
      distance: 0,
      blurb: 'Cleave every enemy around you.',
    },
    {
      id: AbilityId.Shockwave,
      name: 'Shockwave',
      cooldown: 1,
      cost: 100,
      spendsAll: true,
      held: false,
      power: 26,
      radius: 340,
      distance: 0,
      blurb: 'Spend all rage — stagger the room.',
    },
  ],
};

const ARCHER: ClassDef = {
  id: ClassId.Archer,
  name: 'Archer',
  role: 'Ranged DPS',
  silhouette: Silhouette.Bow,
  color: 0x6fd08c,
  rim: 0xb8ecc8,

  maxHp: 88,
  moveSpeed: 278,
  attackInterval: 0.25,
  attackDamage: 6,
  attackRange: 330,
  attackStyle: AttackStyle.Projectile,
  projectileSpeed: 620,

  // §3.2: "Archer none (pure skill)". §3.3 says slot 3 is resource-gated,
  // which the Archer cannot satisfy — so its payoff runs on a long cooldown
  // instead. Flagged in the manual as an open contradiction.
  resource: NO_RESOURCE,

  abilities: [
    {
      id: AbilityId.Dash,
      name: 'Dash',
      cooldown: 3.5,
      cost: 0,
      spendsAll: false,
      held: false,
      power: 0,
      radius: 0,
      distance: 250,
      blurb: 'Short burst of movement. No damage.',
    },
    {
      id: AbilityId.ChargedShot,
      name: 'Charged Shot',
      cooldown: 4,
      cost: 0,
      spendsAll: false,
      held: false,
      power: 30,
      radius: 12,
      distance: 640,
      blurb: 'A heavy arrow that pierces everything in a line.',
    },
    {
      id: AbilityId.Volley,
      name: 'Volley',
      cooldown: 16,
      cost: 0,
      spendsAll: false,
      held: false,
      power: 9,
      radius: 165,
      distance: 300,
      blurb: 'Arrows rain over an area for several seconds.',
    },
  ],
};

const SORCERER: ClassDef = {
  id: ClassId.Sorcerer,
  name: 'Sorcerer',
  role: 'AoE / Control',
  silhouette: Silhouette.Orb,
  color: 0xc98bff,
  rim: 0xe2c6ff,

  maxHp: 82,
  moveSpeed: 236,
  attackInterval: 1.2,
  attackDamage: 26,
  attackRange: 300,
  attackStyle: AttackStyle.Projectile,
  projectileSpeed: 400,

  resource: { kind: ResourceKind.Mana, max: 100, regen: 9, onHit: 0, drain: 0 },

  abilities: [
    {
      id: AbilityId.Blink,
      name: 'Blink',
      cooldown: 4,
      cost: 0,
      spendsAll: false,
      held: false,
      power: 0,
      radius: 0,
      distance: 260,
      blurb: 'Teleport. Passes through anything in the way.',
    },
    {
      id: AbilityId.Blast,
      name: 'Heavy Blast',
      cooldown: 1.2,
      cost: 32,
      spendsAll: false,
      held: false,
      power: 34,
      radius: 118,
      distance: 320,
      blurb: 'Detonate a chosen spot. Costs mana.',
    },
    {
      id: AbilityId.Freeze,
      name: 'Deep Freeze',
      cooldown: 1,
      cost: 100,
      spendsAll: true,
      held: false,
      power: 0,
      radius: 400,
      distance: 0,
      blurb: 'Spend the pool — freeze the room solid.',
    },
  ],
};

const VALKYRIE: ClassDef = {
  id: ClassId.Valkyrie,
  name: 'Valkyrie',
  role: 'Frontline / Protection',
  silhouette: Silhouette.Shield,
  color: 0x4f9dff,
  rim: 0xa8d0ff,

  maxHp: 150,
  moveSpeed: 244,
  attackInterval: 0.7,
  attackDamage: 12,
  attackRange: 126,
  attackStyle: AttackStyle.Melee,
  projectileSpeed: 0,

  resource: { kind: ResourceKind.Stamina, max: 100, regen: 16, onHit: 0, drain: 26 },

  abilities: [
    {
      id: AbilityId.Plow,
      name: 'Shield Plow',
      cooldown: 5,
      cost: 0,
      spendsAll: false,
      held: false,
      power: 8,
      radius: 34,
      distance: 280,
      blurb: 'Shove forward, pushing enemies aside.',
    },
    {
      id: AbilityId.Block,
      name: 'Block',
      cooldown: 0,
      cost: 0,
      spendsAll: false,
      held: true,
      power: 0.15,
      radius: 0,
      distance: 0,
      blurb: 'Hold to absorb damage from the way you face. Drains stamina.',
    },
    {
      id: AbilityId.Slam,
      name: 'Shield Slam',
      cooldown: 1,
      cost: 100,
      spendsAll: true,
      held: false,
      power: 18,
      radius: 210,
      distance: 0,
      blurb: 'Spend stamina — knock back the cone and shield allies.',
    },
  ],
};

const CLASSES: Record<ClassId, ClassDef> = {
  [ClassId.Warrior]: WARRIOR,
  [ClassId.Archer]: ARCHER,
  [ClassId.Sorcerer]: SORCERER,
  [ClassId.Valkyrie]: VALKYRIE,
};

export function getClass(id: ClassId): ClassDef {
  return CLASSES[id];
}
