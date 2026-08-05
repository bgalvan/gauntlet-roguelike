import type { Rng } from '../../core/rng';
import {
  ALL_DIRECTIONS,
  BOSS_TEMPLATE,
  Direction,
  ENTRY_TEMPLATE,
  oppositeDirection,
  templatesWithDoors,
} from './templates';
import type { RoomTemplate } from './templates';

/**
 * Seeded floor generation — §2.
 *
 * A node graph with a critical path plus branches, each node populated from
 * the hand-authored library. The *layout* is random; the *rooms* are designed.
 *
 * Determinism: every choice comes from the run's Rng, and every iteration is
 * over an indexed array. A floor is fully reproducible from its seed, which is
 * what §2 means by "seeded runs from day one" and what dailies and races will
 * later depend on.
 */

export const RoomKind = {
  Entry: 'entry',
  Combat: 'combat',
  Boss: 'boss',
} as const;

export type RoomKind = (typeof RoomKind)[keyof typeof RoomKind];

export interface RoomNode {
  readonly index: number;
  readonly kind: RoomKind;
  readonly template: RoomTemplate;
  /** Grid position, for the minimap. */
  readonly gx: number;
  readonly gy: number;
  /** Neighbour room index per direction, or -1. */
  readonly exits: number[];
  /** Distance from entry along the critical path — drives difficulty ramp. */
  readonly depth: number;
  /** Cleared rooms do not respawn enemies when re-entered. */
  cleared: boolean;
  visited: boolean;
}

export interface Floor {
  readonly rooms: readonly RoomNode[];
  readonly entryIndex: number;
  readonly bossIndex: number;
}

const GRID = 9;
const CENTER = 4;

/** §2: 8–14 combat rooms plus a boss. */
const MIN_PATH = 8;
const MAX_PATH = 12;
/** §2: "a critical path plus 2–3 branches". */
const MIN_BRANCHES = 2;
const MAX_BRANCHES = 3;

export function generateFloor(rng: Rng, act = 1): Floor {
  // Occupancy grid — a room per cell at most, so the layout never overlaps.
  const cells = new Map<string, number>();
  const nodes: MutableNode[] = [];

  const key = (gx: number, gy: number): string => `${gx},${gy}`;

  const place = (gx: number, gy: number, kind: RoomKind, depth: number): MutableNode => {
    const node: MutableNode = {
      index: nodes.length,
      kind,
      template: ENTRY_TEMPLATE, // provisional; chosen once doors are known
      gx,
      gy,
      exits: [-1, -1, -1, -1],
      depth,
      cleared: kind === RoomKind.Entry,
      visited: false,
    };
    nodes.push(node);
    cells.set(key(gx, gy), node.index);
    return node;
  };

  const connect = (a: MutableNode, b: MutableNode, dir: Direction): void => {
    a.exits[dir] = b.index;
    b.exits[oppositeDirection(dir)] = a.index;
  };

  // --- critical path -------------------------------------------------------
  const pathLength = rng.int(MIN_PATH, MAX_PATH);
  let cursor = place(CENTER, CENTER, RoomKind.Entry, 0);
  const path: MutableNode[] = [cursor];

  for (let step = 1; step <= pathLength; step++) {
    // The entry template is authored with a single east door, so the first
    // step must go east or the exit gets stripped below and the entire floor
    // is severed from its own entrance. Measured: 12 of 13 rooms unreachable.
    const dir =
      step === 1
        ? Direction.East
        : pickWalkableDirection(rng, cells, cursor.gx, cursor.gy);
    if (dir === null) break; // boxed in; the path is long enough already

    const [nx, ny] = offset(cursor.gx, cursor.gy, dir);
    const next = place(nx, ny, RoomKind.Combat, step);
    connect(cursor, next, dir);
    cursor = next;
    path.push(next);
  }

  // --- branches ------------------------------------------------------------
  // Hung off the path, never off each other, so a branch is always a short
  // detour rather than a second maze.
  const branchCount = rng.int(MIN_BRANCHES, MAX_BRANCHES);
  for (let b = 0; b < branchCount; b++) {
    // Never branch from the entry or the last path room — the first would let
    // the party skip the teaching room, the second would compete with the boss.
    if (path.length < 4) break;
    const from = path[rng.int(1, path.length - 2)]!;
    const dir = pickWalkableDirection(rng, cells, from.gx, from.gy);
    if (dir === null) continue;

    const [nx, ny] = offset(from.gx, from.gy, dir);
    const branch = place(nx, ny, RoomKind.Combat, from.depth + 1);
    connect(from, branch, dir);
  }

  // --- boss ----------------------------------------------------------------
  // The arena template has exactly one door, on its west wall, so the boss
  // must be attached to its neighbour's *east* side. Anything else would be
  // stripped by the template-agreement pass and orphan the boss.
  //
  // Walk back along the critical path until a room with a free eastern
  // neighbour turns up — the far end of the path is preferred, but a boss
  // that cannot be reached is worse than one placed a room early.
  let bossNode: MutableNode | null = null;
  let bossHost = path[path.length - 1]!;
  for (let i = path.length - 1; i >= 1; i--) {
    const candidate = path[i]!;
    const [bx, by] = offset(candidate.gx, candidate.gy, Direction.East);
    if (bx < 0 || by < 0 || bx >= GRID || by >= GRID) continue;
    if (cells.has(`${bx},${by}`)) continue;
    bossHost = candidate;
    bossNode = place(bx, by, RoomKind.Boss, candidate.depth + 1);
    connect(candidate, bossNode, Direction.East);
    break;
  }

  // --- populate with templates --------------------------------------------
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.kind === RoomKind.Entry) {
      node.template = ENTRY_TEMPLATE;
      continue;
    }
    if (node.kind === RoomKind.Boss) {
      node.template = BOSS_TEMPLATE;
      continue;
    }

    const required: Direction[] = [];
    for (const dir of ALL_DIRECTIONS) if (node.exits[dir] !== -1) required.push(dir);

    const candidates = templatesWithDoors(required).filter((t) => t.act === act);
    // Every template offers at least two doors, and the graph never gives a
    // node more exits than a template can carry — but if authoring ever
    // breaks that, fall back rather than crash the run.
    node.template = candidates.length > 0 ? rng.pick(candidates) : templatesWithDoors([])[0]!;
  }

  // The entry and boss templates declare only one door each; the graph must
  // agree with them, so drop any exit the chosen template cannot express.
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    for (const dir of ALL_DIRECTIONS) {
      const neighbour = node.exits[dir];
      if (neighbour === undefined || neighbour === -1) continue;
      if (node.template.doors.includes(dir)) continue;
      node.exits[dir] = -1;
      nodes[neighbour]!.exits[oppositeDirection(dir)] = -1;
    }
  }

  return {
    rooms: nodes,
    entryIndex: 0,
    bossIndex: bossNode ? bossNode.index : bossHost.index,
  };
}

interface MutableNode extends Omit<RoomNode, 'template'> {
  template: RoomTemplate;
}

function offset(gx: number, gy: number, dir: Direction): [number, number] {
  switch (dir) {
    case Direction.North:
      return [gx, gy - 1];
    case Direction.East:
      return [gx + 1, gy];
    case Direction.South:
      return [gx, gy + 1];
    default:
      return [gx - 1, gy];
  }
}

/**
 * A free neighbouring cell, chosen from the seeded stream.
 *
 * `preferred` is tried first when supplied — the boss uses it so the party
 * always enters its arena from the west. Candidates are gathered in a fixed
 * direction order and then shuffled by the run's Rng, never by array order.
 */
function pickWalkableDirection(
  rng: Rng,
  cells: ReadonlyMap<string, number>,
  gx: number,
  gy: number,
  preferred?: Direction,
): Direction | null {
  const open: Direction[] = [];
  for (const dir of ALL_DIRECTIONS) {
    const [nx, ny] = offset(gx, gy, dir);
    if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
    if (cells.has(`${nx},${ny}`)) continue;
    open.push(dir);
  }
  if (open.length === 0) return null;
  if (preferred !== undefined && open.includes(preferred)) return preferred;
  return rng.pick(open);
}

/** Rooms the party has seen, for the minimap. */
export function floorBounds(floor: Floor): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < floor.rooms.length; i++) {
    const r = floor.rooms[i]!;
    minX = Math.min(minX, r.gx);
    minY = Math.min(minY, r.gy);
    maxX = Math.max(maxX, r.gx);
    maxY = Math.max(maxY, r.gy);
  }
  return { minX, minY, maxX, maxY };
}
