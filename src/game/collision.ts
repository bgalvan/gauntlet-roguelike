import { COLLISION, ROOM } from '../core/constants';
import type { Entity } from './entities/entity';

/**
 * Body separation and room walls.
 *
 * Positional resolution — bodies are pushed apart directly rather than given
 * velocities. For a top-down action game that is the right model: it can't
 * accumulate energy, it can't launch anyone across the room, and it is
 * order-independent enough to stay deterministic.
 *
 * O(n²) over every pair. At Phase 1 counts (4 players + ~21 enemies) that is
 * ~300 pairs a tick, which is nothing. It stops being nothing somewhere
 * around 150 bodies — constraint #4 caps entity counts well below that, but
 * a uniform grid is the fix when it bites.
 */
export function resolveCollisions(bodies: readonly Entity[]): void {
  for (let pass = 0; pass < COLLISION.ITERATIONS; pass++) {
    separate(bodies);
  }
  // Walls last, so nothing is left pushed through one.
  for (let i = 0; i < bodies.length; i++) {
    clampToRoom(bodies[i]!);
  }
}

function separate(bodies: readonly Entity[]): void {
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i]!;
    if (!a.collides) continue;

    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j]!;
      if (!b.collides) continue;

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const minDist = a.radius + b.radius;
      const distSq = dx * dx + dy * dy;
      if (distSq >= minDist * minDist) continue;

      let nx: number;
      let ny: number;
      let overlap: number;

      if (distSq === 0) {
        // Exactly coincident. Any direction is as good as any other, but it
        // must be the *same* direction on every peer — so derive it from the
        // ids rather than from a random roll.
        const angle = ((a.id * 31 + b.id * 17) % 360) * (Math.PI / 180);
        nx = Math.cos(angle);
        ny = Math.sin(angle);
        overlap = minDist;
      } else {
        const dist = Math.sqrt(distSq);
        nx = dx / dist;
        ny = dy / dist;
        overlap = minDist - dist;
      }

      // Split evenly — every body has the same mass in Phase 1. Knockback
      // and heavy enemies are a later, deliberate exception.
      const push = (overlap * COLLISION.STIFFNESS) / 2;
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;
    }
  }
}

function clampToRoom(body: Entity): void {
  const minX = ROOM.WALL + body.radius;
  const maxX = ROOM.WIDTH - ROOM.WALL - body.radius;
  const minY = ROOM.WALL + body.radius;
  const maxY = ROOM.HEIGHT - ROOM.WALL - body.radius;
  if (body.x < minX) body.x = minX;
  if (body.x > maxX) body.x = maxX;
  if (body.y < minY) body.y = minY;
  if (body.y > maxY) body.y = maxY;
}
