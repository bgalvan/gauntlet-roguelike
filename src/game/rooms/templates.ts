/**
 * Hand-authored room templates — §2 generation.
 *
 * "Room-graph, not tile-noise. Isaac feels good because the *rooms* are
 * designed and the *layout* is random." So the layout graph is seeded and
 * procedural; everything in this file is authored by hand.
 *
 * §2 requires a template to declare door positions, spawn anchors with a
 * budget cost, hazard slots, and a **safe pocket** so four players can enter
 * without instantly eating damage. Hazards have no implementation yet, so the
 * slots are declared and left unused rather than omitted — the schema is the
 * point (§0: follow the existing schema exactly).
 *
 * Target library is ~150 templates (~40/act). This is eight, enough to prove
 * the graph and give a floor visible variety. Adding more is content work.
 */

export const Direction = {
  North: 0,
  East: 1,
  South: 2,
  West: 3,
} as const;

export type Direction = (typeof Direction)[keyof typeof Direction];

export const ALL_DIRECTIONS: readonly Direction[] = [
  Direction.North,
  Direction.East,
  Direction.South,
  Direction.West,
];

export function oppositeDirection(d: Direction): Direction {
  return ((d + 2) % 4) as Direction;
}

export function directionName(d: Direction): string {
  return ['north', 'east', 'south', 'west'][d] ?? '?';
}

/** A spawn point, with what it costs against the room's enemy budget. */
export interface SpawnAnchor {
  readonly x: number;
  readonly y: number;
  /** Budget cost. Cheap anchors are trash; expensive ones are for elites
   *  once elites exist (§2 Act III). */
  readonly cost: number;
}

export interface RoomTemplate {
  readonly id: string;
  /** Act 1 = Crypt. Used to filter the library as later acts are authored. */
  readonly act: number;
  readonly width: number;
  readonly height: number;

  /**
   * Which edges *may* carry a door. The layout graph decides which are
   * actually used; a template offering all four is the most placeable.
   */
  readonly doors: readonly Direction[];

  readonly spawnAnchors: readonly SpawnAnchor[];

  /**
   * Somewhere the party can stand on entry without being on top of a spawn.
   * Enemies are never placed within `radius` of it.
   */
  readonly safePocket: { readonly x: number; readonly y: number; readonly radius: number };

  /** Declared for the schema; no hazard system exists yet (§2 Act II). */
  readonly hazardSlots: readonly { readonly x: number; readonly y: number }[];

  /** Total enemy budget this room's shape can hold legibly (Pillar 3). */
  readonly budget: number;
}

const W = 1200;
const H = 660;
const WIDE = 1520;
const TALL = 860;

/**
 * Anchors are laid out by hand per template. They deliberately avoid the safe
 * pocket and cluster in ways that suit each room's shape — that is the whole
 * argument for authoring rooms rather than scattering spawns randomly.
 */
export const TEMPLATES: readonly RoomTemplate[] = [
  {
    id: 'crypt-hall',
    act: 1,
    width: W,
    height: H,
    doors: [Direction.North, Direction.East, Direction.South, Direction.West],
    safePocket: { x: W / 2, y: H / 2, radius: 190 },
    spawnAnchors: [
      { x: 220, y: 150, cost: 1 }, { x: 220, y: H - 150, cost: 1 },
      { x: W - 220, y: 150, cost: 1 }, { x: W - 220, y: H - 150, cost: 1 },
      { x: 150, y: H / 2, cost: 1 }, { x: W - 150, y: H / 2, cost: 1 },
      { x: W / 2, y: 110, cost: 1 }, { x: W / 2, y: H - 110, cost: 1 },
      { x: 360, y: 260, cost: 2 }, { x: W - 360, y: H - 260, cost: 2 },
    ],
    hazardSlots: [],
    budget: 12,
  },
  {
    id: 'crypt-pillars',
    act: 1,
    width: W,
    height: H,
    doors: [Direction.North, Direction.East, Direction.South, Direction.West],
    // Off-centre pocket: entering does not mean standing in the middle.
    safePocket: { x: 260, y: H / 2, radius: 165 },
    spawnAnchors: [
      { x: 620, y: 140, cost: 1 }, { x: 620, y: H - 140, cost: 1 },
      { x: 820, y: 240, cost: 1 }, { x: 820, y: H - 240, cost: 1 },
      { x: W - 170, y: 180, cost: 1 }, { x: W - 170, y: H - 180, cost: 1 },
      { x: W - 300, y: H / 2, cost: 2 }, { x: 980, y: H / 2, cost: 2 },
    ],
    hazardSlots: [
      { x: 500, y: 220 }, { x: 500, y: H - 220 },
      { x: 900, y: 220 }, { x: 900, y: H - 220 },
    ],
    budget: 10,
  },
  {
    id: 'crypt-long',
    act: 1,
    width: WIDE,
    height: H,
    doors: [Direction.East, Direction.West],
    safePocket: { x: 210, y: H / 2, radius: 175 },
    spawnAnchors: [
      { x: 560, y: 140, cost: 1 }, { x: 560, y: H - 140, cost: 1 },
      { x: 780, y: H / 2, cost: 1 },
      { x: 1000, y: 170, cost: 1 }, { x: 1000, y: H - 170, cost: 1 },
      { x: WIDE - 190, y: 200, cost: 1 }, { x: WIDE - 190, y: H - 200, cost: 1 },
      { x: WIDE - 330, y: H / 2, cost: 2 },
    ],
    hazardSlots: [],
    budget: 13,
  },
  {
    id: 'crypt-vault',
    act: 1,
    width: W,
    height: TALL,
    doors: [Direction.North, Direction.South, Direction.West],
    safePocket: { x: W / 2, y: TALL - 170, radius: 180 },
    spawnAnchors: [
      { x: 230, y: 160, cost: 1 }, { x: W - 230, y: 160, cost: 1 },
      { x: W / 2, y: 130, cost: 1 },
      { x: 200, y: 420, cost: 1 }, { x: W - 200, y: 420, cost: 1 },
      { x: 430, y: 300, cost: 2 }, { x: W - 430, y: 300, cost: 2 },
      { x: W / 2, y: 470, cost: 2 },
    ],
    hazardSlots: [{ x: W / 2, y: 300 }],
    budget: 12,
  },
  {
    id: 'crypt-crossing',
    act: 1,
    width: W,
    height: H,
    doors: [Direction.North, Direction.East, Direction.South, Direction.West],
    safePocket: { x: W / 2, y: H - 150, radius: 160 },
    spawnAnchors: [
      { x: 180, y: 130, cost: 1 }, { x: W - 180, y: 130, cost: 1 },
      { x: 180, y: 330, cost: 1 }, { x: W - 180, y: 330, cost: 1 },
      { x: W / 2, y: 130, cost: 2 },
      { x: 420, y: 230, cost: 1 }, { x: W - 420, y: 230, cost: 1 },
    ],
    hazardSlots: [{ x: 340, y: H / 2 }, { x: W - 340, y: H / 2 }],
    budget: 9,
  },
  {
    id: 'crypt-antechamber',
    act: 1,
    width: 980,
    height: H,
    doors: [Direction.East, Direction.West, Direction.South],
    safePocket: { x: 490, y: H / 2, radius: 200 },
    spawnAnchors: [
      { x: 150, y: 140, cost: 1 }, { x: 150, y: H - 140, cost: 1 },
      { x: 830, y: 140, cost: 1 }, { x: 830, y: H - 140, cost: 1 },
      { x: 490, y: 110, cost: 1 }, { x: 490, y: H - 110, cost: 1 },
    ],
    hazardSlots: [],
    budget: 7,
  },
  {
    id: 'crypt-gallery',
    act: 1,
    width: WIDE,
    height: TALL,
    doors: [Direction.North, Direction.East, Direction.South, Direction.West],
    safePocket: { x: 250, y: TALL - 200, radius: 190 },
    spawnAnchors: [
      { x: 620, y: 170, cost: 1 }, { x: 1000, y: 170, cost: 1 },
      { x: 620, y: TALL - 170, cost: 1 }, { x: 1000, y: TALL - 170, cost: 1 },
      { x: WIDE - 190, y: 300, cost: 1 }, { x: WIDE - 190, y: TALL - 300, cost: 1 },
      { x: 810, y: TALL / 2, cost: 2 }, { x: WIDE - 350, y: TALL / 2, cost: 2 },
      { x: 400, y: 220, cost: 1 },
    ],
    hazardSlots: [{ x: 810, y: 260 }, { x: 810, y: TALL - 260 }],
    budget: 16,
  },
  {
    id: 'crypt-cells',
    act: 1,
    width: W,
    height: H,
    doors: [Direction.North, Direction.East, Direction.West],
    safePocket: { x: W / 2, y: H / 2, radius: 155 },
    spawnAnchors: [
      { x: 140, y: 120, cost: 1 }, { x: 140, y: H - 120, cost: 1 },
      { x: W - 140, y: 120, cost: 1 }, { x: W - 140, y: H - 120, cost: 1 },
      { x: 330, y: H / 2, cost: 1 }, { x: W - 330, y: H / 2, cost: 1 },
      { x: W / 2, y: 105, cost: 2 }, { x: W / 2, y: H - 105, cost: 2 },
    ],
    hazardSlots: [],
    budget: 11,
  },
];

/**
 * The boss arena. Deliberately its own template with a single entrance and no
 * cover — §11's bosses need space and a clean read (Pillar 3). There is no
 * boss *entity* yet, so it currently hosts an oversized wave.
 */
export const BOSS_TEMPLATE: RoomTemplate = {
  id: 'crypt-boss',
  act: 1,
  width: WIDE,
  height: TALL,
  doors: [Direction.West],
  safePocket: { x: 240, y: TALL / 2, radius: 220 },
  spawnAnchors: [
    { x: WIDE / 2, y: TALL / 2, cost: 4 },
    { x: WIDE - 260, y: 220, cost: 2 }, { x: WIDE - 260, y: TALL - 220, cost: 2 },
    { x: WIDE / 2, y: 190, cost: 1 }, { x: WIDE / 2, y: TALL - 190, cost: 1 },
    { x: 780, y: 300, cost: 1 }, { x: 780, y: TALL - 300, cost: 1 },
  ],
  hazardSlots: [],
  budget: 18,
};

/** Entry room — no enemies, so the party can find its feet (Act I teaches). */
export const ENTRY_TEMPLATE: RoomTemplate = {
  id: 'crypt-entry',
  act: 1,
  width: 980,
  height: H,
  doors: [Direction.East],
  safePocket: { x: 300, y: H / 2, radius: 240 },
  spawnAnchors: [],
  hazardSlots: [],
  budget: 0,
};

/** Templates that can serve as an ordinary combat node, given required doors. */
export function templatesWithDoors(required: readonly Direction[]): readonly RoomTemplate[] {
  return TEMPLATES.filter((t) => required.every((d) => t.doors.includes(d)));
}
