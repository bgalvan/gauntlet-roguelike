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

  /**
   * Fraction of max HP restored to living players when a wave is cleared.
   *
   * SANDBOX SCAFFOLDING, not a design decision. Nothing in the game heals yet
   * — no pickups, no shop, no items — so continuous waves guarantee a wipe by
   * attrition regardless of play. Measured: without this the party wipes in
   * ~46s having cleared one wave. This stands in for §2's room-clear rewards
   * until those exist, and should be deleted when they do. Real healing
   * economy is Bobby's call.
   */
  CLEAR_HEAL: 0.35,
  /** Enemies spawn at least this far from any player. */
  SAFE_SPAWN_DISTANCE: 260,
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
