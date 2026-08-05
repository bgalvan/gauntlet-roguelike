import Phaser from 'phaser';

import { ROOM } from './core/constants';
import { GameScene } from './scenes/game-scene';

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: ROOM.WIDTH,
  height: ROOM.HEIGHT,
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
  scene: [GameScene],
});
