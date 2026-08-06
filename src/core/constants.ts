/**
 * Simulation and presentation constants.
 *
 * Sim units are abstract "world units" — the renderer maps them to pixels.
 * Constraint #5 (resolution-independent UI): nothing outside this file
 * hardcodes a pixel position.
 */

export const SIM = {
  /** Simulation rate. Lockstep peers must agree on this exactly. */
  TICK_RATE: 60,
  STEP_MS: 1000 / 60,
  STEP_SECONDS: 1 / 60,

  /** Largest real-time delta we accept in one frame before discarding the rest. */
  MAX_FRAME_MS: 250,

  /** Hard cap on catch-up steps, so a long stall can't lock the main thread. */
  MAX_STEPS_PER_FRAME: 5,
} as const;

/**
 * Design resolution. The canvas is this size and scales to fit the window, so
 * world units *are* the design resolution and nothing downstream hardcodes a
 * pixel (constraint #5).
 *
 * Rooms are no longer the same size as the view — templates declare their own
 * dimensions and the camera (§2) zooms to fit the party inside them.
 */
export const VIEW = {
  WIDTH: 1280,
  HEIGHT: 720,
} as const;

/** Wall thickness — bodies are clamped inside this margin of a room. */
export const ROOM = {
  WALL: 24,
} as const;

/**
 * Doors — §2: "Doors lock during combat. Keeps the party together; prevents
 * one player speedrunning ahead."
 */
export const DOOR = {
  /** Opening width along the wall. */
  WIDTH: 150,
  /** How deep into the room the trigger reaches. */
  DEPTH: 46,
  /** Seconds a transition takes, so it reads as a move rather than a teleport. */
  TRANSITION: 0.35,
} as const;

/**
 * Shared camera — §2 `[DEFAULT]`: "Shared dynamic camera that zooms to fit,
 * plus a soft leash." Split-screen on separation is `[CUT]`.
 */
export const CAMERA = {
  /** Padding around the party bounds before fitting. */
  PADDING: 260,
  /**
   * Zoom floor. Pillar 3 and §16.5 both say a camera zoomed to fit four
   * scattered players makes each one a few pixels tall — so it stops, and the
   * soft leash takes over from there.
   */
  MIN_ZOOM: 0.62,
  MAX_ZOOM: 1.15,
  /** Exponential follow rate per second. */
  LERP: 6.5,
} as const;

/**
 * Soft leash — §2.
 *
 * Deliberately defined in **world units from the party centroid**, not as
 * "outside the rendered frame". Frame size depends on the window, and a rule
 * that depends on the window is not something two lockstep peers can agree
 * on. This version is identical on every machine.
 */
export const LEASH = {
  /** Beyond this from the party centroid, the leash bites. */
  RADIUS: 620,
  /** Damage per second while outside. "Light" per §2 — a nudge, not a threat. */
  DAMAGE_PER_SECOND: 6,
  /** Grace period before damage starts, so a dash out is never punished. */
  GRACE: 1.2,
} as const;

/** Party size. Four is the design target (§2) and what §13's questions need. */
export const PARTY_SIZE = 4;

export const COLLISION = {
  /**
   * Relaxation passes per tick. Two was enough before knockback existed;
   * payoff abilities now shove whole crowds at 420+ units/second and a pile
   * against a wall needs more passes to unwind. Cheap at ~26 bodies.
   */
  ITERATIONS: 4,
  /** Fraction of the overlap resolved per pass. Below 1 so bodies settle
   *  instead of jittering against each other. */
  STIFFNESS: 0.7,
} as const;

/**
 * Shared player geometry. Everything else that used to live here — HP, speed,
 * attack stats — is per-class now and lives in src/game/classes.ts. One
 * source of truth; §0 says contradictions are worse than gaps.
 */
export const PLAYER = {
  RADIUS: 16,
} as const;

/**
 * Shared combat feel. These are the numbers that decide whether a hit reads
 * as an impact or as a number going down.
 */
export const COMBAT = {
  /** Knockback impulse from a basic attack, world units per second. */
  BASIC_KNOCKBACK: 190,
  PROJECTILE_KNOCKBACK: 150,
  /** Ticks an enemy is stunned by a normal hit. The local stand-in for
   *  hit-stop — see the note in Entity. */
  HIT_STAGGER_TICKS: 5,
  /** A heavier stagger for payoff abilities, so slot 3 reads as an event. */
  HEAVY_STAGGER_TICKS: 34,

  PROJECTILE_RADIUS: 7,
  /** Safety net so a stray shot cannot live forever. */
  PROJECTILE_LIFE_TICKS: 180,
  /** Pool size. Four Archers at 4 shots/sec with a 3s life would peak near
   *  50; this leaves headroom without unbounded growth (constraint #4). */
  PROJECTILE_POOL: 96,

  /** Seconds an ally shield from Valkyrie's slam lasts. */
  SHIELD_DURATION: 4,
  /** Fraction of incoming damage a shield absorbs. */
  SHIELD_ABSORB: 0.5,
  /** Fraction of damage Valkyrie's block absorbs from the facing cone. */
  BLOCK_CONE: Math.PI / 2.4,
} as const;

/**
 * Act I "Crypt" melee enemy — the teaching enemy (§2). One archetype is
 * enough to make combat real; the roster is content work, not engineering.
 */
export const ENEMY = {
  RADIUS: 14,
  MOVE_SPEED: 132,
  MAX_HP: 30,
  DAMAGE: 8,

  /** Centre-to-centre reach for its swing. */
  ATTACK_RANGE: 38,
  /** Telegraph. Pillar 3 (readable chaos) needs a wind-up you can react to —
   *  an instant hit is unreadable once there are forty of them. */
  WINDUP: 0.35,
  /** Seconds between swings. */
  ATTACK_INTERVAL: 1.1,

  /** Enemies stop closing once this near, so they surround rather than stack. */
  PREFERRED_GAP: 4,
} as const;

/**
 * Wave budget. §2 party scaling: 100 / 165 / 220 / 270% for 1–4 players.
 *
 * Scaled by **party size, not living players** — deliberately. §8's design
 * rule: anything that scales with living players is a death spiral, weakest
 * exactly when you're already losing.
 */
export const WAVE = {
  BASE_COUNT: 8,
  PARTY_SCALING: [1.0, 1.65, 2.2, 2.7],
  /** Seconds after a wave is cleared before the next spawns. */
  RESPAWN_DELAY: 3.0,
  /** Enemies spawn at least this far from any player. */
  SAFE_SPAWN_DISTANCE: 260,
} as const;

/**
 * Heart pickups — §7.2 tier 1: "Gold, hearts, keys, bombs · free-for-all,
 * touch pickup · high frequency, low stakes. Ceremony here is pure friction."
 *
 * These replace `WAVE.CLEAR_HEAL`, which was sandbox scaffolding standing in
 * for a healing economy that did not exist. It does now: rooms pay out on
 * clear, enemies drop on death, and the party has to actually walk to it.
 */
export const PICKUP = {
  RADIUS: 11,
  /** Body-to-pickup distance that counts as a touch. */
  REACH: 26,
  /**
   * Fraction of the picker's **own** max HP a heart restores. A percentage
   * rather than a flat value for the same reason DEATH.REVIVE_HP_PERCENT is —
   * class pools run 82–150 and a flat heal would mean three different things.
   */
  HEART_HEAL: 0.22,
  /** Chance an enemy leaves a heart behind. Rolled on the room's stream. */
  DROP_CHANCE: 0.08,
  /** Hearts a cleared combat room pays out regardless of drops. */
  CLEAR_HEARTS: 2,
  /** How far from the room centre the clear payout is scattered. */
  CLEAR_SCATTER: 96,
  /**
   * A heart is only consumed by someone actually missing health.
   *
   * §7.3 calls accidental pickup in a crowded room the most common source of
   * co-op loot resentment, and it is a UX defect rather than a design
   * tradeoff. Walking over a heart at full HP leaves it for whoever needs it.
   */
  MIN_MISSING_HP: 1,
} as const;

/**
 * Bi-directional upgrades — §4.
 *
 * Breakpoints are the load-bearing numbers here: §4.1 calls the 3/6 stack
 * transformations "the important one", because they are what converts a
 * repeated binary choice from a slider into a build.
 */
export const UPGRADE = {
  /** Stacks in one direction that grant its first new behaviour. */
  BREAKPOINT_1: 3,
  /** Stacks that grant the named capstone (§4.1 fix 3). */
  BREAKPOINT_2: 6,
  /** Hard cap per direction — the capstone is the end of the line. */
  MAX_STACKS: 6,

  /**
   * Offers per floor, as a cadence.
   *
   * §4.3 says "~1 per floor plus 1 per boss · 12–14 choices per run", which
   * assumes the six-or-so floors of a full run. The prototype has **one**
   * floor, so that cadence would grant two choices — and a breakpoint at 3
   * stacks would be literally unreachable, leaving §13's question 4 ("does a
   * single binary upgrade choice feel meaningful, or like a stat point?")
   * unanswerable, along with the follow-up about whether breakpoints need to
   * arrive earlier.
   *
   * So the prototype pays out on every cleared combat room. That is roughly
   * 9–12 choices on one floor: enough to reach stack 3–6 and actually see a
   * transformation fire. SANDBOX TUNING — restore the §4.3 cadence when there
   * is more than one floor to spend it over. Flagged for Bobby.
   */
  PER_COMBAT_ROOM: 1,

  /** Ticks a bot spends "deciding", so the party reads as choosing together. */
  BOT_DECISION_TICKS: 24,

  /**
   * Seconds before an unanswered offer takes whatever is highlighted.
   *
   * The offer holds the doors shut so the party chooses together (§4.3 wants
   * the picks visible to each other), and anything that holds the doors shut
   * needs an escape hatch — otherwise one player stepping away from the
   * keyboard ends the run for four people. §7.2 reaches for the same device
   * for shared loot: a claim window that is *skippable*.
   */
  AUTO_CONFIRM_SECONDS: 8,

  // --- transformation tuning ------------------------------------------------

  /** Cleave: arc half-angle and damage share at tier 1; tier 2 is the full
   *  circle, so only the damage share is listed. */
  CLEAVE_HALF_ANGLE: Math.PI / 3,
  CLEAVE_SHARE: [0.55, 0.8],
  /** Cleave, projectile flavour: extra shots either side, and their spread. */
  CLEAVE_EXTRA_SHOTS: [1, 2],
  CLEAVE_SPREAD: 0.16,

  /** Pierce: extra bodies a basic attack carries into. -1 is unlimited. */
  PIERCE_BODIES: [1, -1],
  /** Damage retained by each body behind the first. */
  PIERCE_FALLOFF: 0.7,

  /** Field: fraction of the ability's radius and power, and seconds it burns. */
  FIELD_RADIUS_SHARE: [0.6, 0.85],
  FIELD_POWER_SHARE: [0.18, 0.3],
  FIELD_SECONDS: [2.5, 4.5],
  FIELD_INTERVAL: 0.3,

  /** Burst: radius and damage of a corpse detonation. */
  BURST_RADIUS: [86, 132],
  BURST_POWER: [9, 18],

  /** Surge: ticks shaved off every ability cooldown per landed hit. */
  SURGE_TICKS: [3, 7],

  /** Aegis: radius of the shelter, and the damage it removes. */
  AEGIS_RADIUS: [150, 230],
  AEGIS_REDUCTION: [0.12, 0.25],

  /** Stance: bonus damage while the positional condition holds. */
  STANCE_BONUS: [0.12, 0.26],
  /** Ticks of stillness before the "stationary" flavour counts. Without a
   *  delay the bonus flickers on every frame a stick returns to centre. */
  STANCE_SETTLE_TICKS: 18,
} as const;

/**
 * Death system — §8, `[LOCKED]` direction, `[DEFAULT]` implementation.
 *
 * Stage 3 (resurrection at a boss, shop shrine, or via a revive item) needs
 * bosses and shops, so it is not built yet.
 */
export const DEATH = {
  /** Stage 1 — Downed: crawling, cannot attack, bleeds out. */
  BLEED_OUT: 20.0,
  CRAWL_SPEED: 88,

  /** Any ally revives with a 3s channel. Free. */
  REVIVE_CHANNEL: 3.0,
  REVIVE_RANGE: 62,
  /** Percent of max HP a revived player stands up with. A percentage rather
   *  than a flat value because class HP pools differ (82–150). */
  REVIVE_HP_PERCENT: 35,

  /** Stage 2 — Wraith: moves freely, cannot be hurt, one weak utility. */
  WRAITH_SPEED: 300,
  /** The Wraith's utility: enemies inside this radius are slowed. */
  WRAITH_SLOW_RADIUS: 150,
  WRAITH_SLOW_FACTOR: 0.55,
} as const;

/**
 * Bot tuning. Bots are testing infrastructure (CLAUDE.md conventions) — the
 * goal is a party that behaves plausibly enough to answer §13's readability
 * and camera questions, not a good AI.
 */
export const BOT = {
  /** Preferred standoff, as a fraction of attack range. Bots hold the edge of
   *  their reach rather than piling onto the target — otherwise four players
   *  stack on one pixel and the readability question can't be asked. */
  STANDOFF: 0.72,
  /** Dead band around the standoff distance, so bots don't oscillate. */
  TOLERANCE: 18,

  /** Bots steer away from allies inside this radius. Stands in for the
   *  collision that arrives in Phase 1. */
  SEPARATION_RADIUS: 76,
  SEPARATION_WEIGHT: 1.15,

  /** Lateral drift while in position — keeps the party moving so VFX overlap
   *  is actually exercised. */
  STRAFE_WEIGHT: 0.55,
  /** Ticks between strafe-direction flips. */
  STRAFE_FLIP_TICKS: 150,

  /** Seeded wobble, so four bots don't move as one rigid body. */
  JITTER: 0.16,
  JITTER_INTERVAL_TICKS: 24,

  /**
   * Below this fraction of max HP a bot disengages and kites. Without it bots
   * stand in a swarm trading hits until they drop — which measures nothing
   * except that bots are bad, and makes the sandbox unplayable long before
   * any design question can be asked.
   */
  RETREAT_HP: 0.4,
  /** Re-engage above this. The gap is hysteresis — a single threshold makes
   *  bots oscillate on the boundary. */
  REENGAGE_HP: 0.7,
  /** How far a retreating bot wants to be from the nearest enemy. */
  RETREAT_DISTANCE: 260,

  /** How far from an open door bots gather while waiting for the human. Far
   *  enough that collision jostling cannot shove one into the trigger. */
  DOOR_STANDOFF: 165,

  /**
   * A hurt bot burns its escape (dash / blink) when something is this close.
   *
   * An absolute distance, deliberately not a fraction of attack range: the
   * Archer's standoff is 238 and 70% of its range is 231, so a range-relative
   * threshold could never fire — the bot was always already further away than
   * its own escape condition required.
   */
  ESCAPE_DISTANCE: 150,
} as const;

/**
 * Target-override cone (§16.5b). Override is a *tactical* pick, not a
 * precision test — the input points a direction and the nearest enemy inside
 * this half-angle wins. Identical expressiveness on mouse, stick, or thumb.
 */
export const TARGETING = {
  OVERRIDE_HALF_ANGLE: Math.PI / 4,
  /** Seconds an override selection persists after the input stops. */
  OVERRIDE_HOLD: 1.5,
} as const;
