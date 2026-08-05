import Phaser from 'phaser';

import { VIEW } from './core/constants';
import { GameScene } from './scenes/game-scene';
import { SelectScene } from './scenes/select-scene';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: VIEW.WIDTH,
  height: VIEW.HEIGHT,
  backgroundColor: '#0d0d12',
  scale: {
    // Constraint #5: the canvas scales to the window, nothing is positioned
    // in device pixels.
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  render: { pixelArt: false, antialias: true },
  // No Phaser physics or Phaser timers: the simulation is ours and runs on a
  // fixed timestep (constraint #3).
  scene: [SelectScene, GameScene],
});

// Dev-only inspection hook. Stripped from production builds by the
// `import.meta.env.DEV` guard. Lets a debugger read live simulation state
// from the console instead of inferring it from pixels.
if (import.meta.env.DEV) {
  (globalThis as Record<string, unknown>)['__game'] = game;
}
