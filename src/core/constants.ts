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
 * Target-override cone (§16.5b). Override is a *tactical* pick, not a
 * precision test — the input points a direction and the nearest enemy inside
 * this half-angle wins. Identical expressiveness on mouse, stick, or thumb.
 */
export const TARGETING = {
  OVERRIDE_HALF_ANGLE: Math.PI / 4,
  /** Seconds an override selection persists after the input stops. */
  OVERRIDE_HOLD: 1.5,
} as const;
