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

export const DUMMY = {
  RADIUS: 18,
  MAX_HP: 60,
  /** Seconds a destroyed dummy stays down before it resets, so testing continues. */
  RESPAWN_DELAY: 2.0,
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
