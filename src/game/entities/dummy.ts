import type { Hasher } from '../../core/checksum';
import { DUMMY, SIM } from '../../core/constants';
import { Entity } from './entity';

/**
 * Training dummy. Does not move, does not fight back — Phase 0 only needs a
 * thing to auto-attack and a health bar to watch drain.
 */
export class Dummy extends Entity {
  /** Counted in ticks, not seconds: an integer counter cannot drift, whereas
   *  a float timer accumulating dt every step eventually can. */
  private respawnTicks = 0;

  /** Ticks remaining on the "was just hit" flash. Render-only. */
  hitFlashTicks = 0;

  constructor(id: number, x: number, y: number) {
    super(id, x, y, DUMMY.RADIUS, DUMMY.MAX_HP);
  }

  step(): void {
    if (this.hitFlashTicks > 0) this.hitFlashTicks--;

    if (!this.alive) {
      this.respawnTicks--;
      if (this.respawnTicks <= 0) {
        this.alive = true;
        this.hp = this.maxHp;
      }
    }
  }

  override damage(amount: number): void {
    const wasAlive = this.alive;
    super.damage(amount);
    this.hitFlashTicks = 6;
    if (wasAlive && !this.alive) {
      this.respawnTicks = Math.round(DUMMY.RESPAWN_DELAY * SIM.TICK_RATE);
    }
  }

  override writeChecksum(h: Hasher): void {
    super.writeChecksum(h);
    h.int(this.respawnTicks).int(this.hitFlashTicks);
  }
}
