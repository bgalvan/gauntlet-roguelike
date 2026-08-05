/**
 * The three stages of §8, `[LOCKED]` direction.
 *
 * Death is a core identity in this design, not a fail state — a dead player
 * is still playing, weakly. That is why this is a state machine on the
 * player rather than an `alive` boolean.
 */
export const LifeState = {
  /** Fighting normally. */
  Alive: 0,
  /** Stage 1 — crawling, cannot attack, bleeding out. Any ally can revive. */
  Downed: 1,
  /** Stage 2 — a Wraith: moves freely, cannot be hurt, one weak utility.
   *  Stage 3 (resurrection) needs bosses and shops; not built yet. */
  Wraith: 2,
} as const;

export type LifeState = (typeof LifeState)[keyof typeof LifeState];

export function lifeStateName(state: LifeState): string {
  switch (state) {
    case LifeState.Alive:
      return 'alive';
    case LifeState.Downed:
      return 'downed';
    case LifeState.Wraith:
      return 'wraith';
  }
}
