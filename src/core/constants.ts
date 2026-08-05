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
 * The single Phase 0 room, in world units. The canvas is sized to the room
 * and scaled to fit the window, so world units *are* the design resolution
 * and nothing downstream hardcodes a pixel (constraint #5).
 */
export const ROOM = {
  WIDTH: 1200,
  HEIGHT: 660,
  /** Wall thickness — players are clamped inside this margin. */
  WALL: 24,
} as const;

/** Party size. Four is the design target (§2) and what §13's questions need. */
export const PARTY_SIZE = 4;

export const COLLISION = {
  /** Relaxation passes per tick. One pass leaves residual overlap in a pile;
   *  two is enough at these entity counts and stays cheap. */
  ITERATIONS: 2,
  /** Fraction of the overlap resolved per pass. Below 1 so bodies settle
   *  instead of jittering against each other. */
  STIFFNESS: 0.6,
} as const;

export const PLAYER = {
  RADIUS: 16,
  /** World units per second. */
  MOVE_SPEED: 260,
  MAX_HP: 100,
  /** Auto-attack reach, measured centre to centre. */
  ATTACK_RANGE: 190,
  /** Seconds between auto-attacks. */
  ATTACK_INTERVAL: 0.45,
  ATTACK_DAMAGE: 7,
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
  /** HP a revived player stands up with. */
  REVIVE_HP: 35,

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
