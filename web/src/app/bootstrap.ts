import Phaser from 'phaser';
import { ArenaScene, CANVAS_HEIGHT, CANVAS_WIDTH } from '../game/arena';
import { GameAudio } from '../platform/audio';
import { InputManager } from '../platform/input';
import { storage } from '../platform/storage';
import { AppController } from './controller';

/** Owns browser resources and their listeners for exactly one mounted game. */
export function mountBattleCity(app: HTMLElement) {
  app.innerHTML = '<main class="site-shell"><div class="screen-wrap"><div id="game-canvas" role="img" ' +
    'aria-label="Battle City。Enter：Start，右 Shift：Select。1P：WASD、J/K。2P：方向键、N/M。"></div></div></main>';
  const scene = new ArenaScene(), audio = new GameAudio(0.3);
  const input = new InputManager(() => controller.startKey(), () => controller.selectKey(), () => audio.unlock());
  const controller = new AppController({ input, audio, render: scene, records: storage,
    seed: () => crypto.getRandomValues(new Uint32Array(1))[0] });
  scene.onFrame = delta => controller.frame(delta, !document.hidden && document.hasFocus());
  const resize = () => {
    const scale = Math.max(1, Math.floor(Math.min(window.innerWidth / CANVAS_WIDTH, window.innerHeight / CANVAS_HEIGHT)));
    const wrapper = app.querySelector<HTMLElement>('.screen-wrap')!;
    wrapper.style.width = CANVAS_WIDTH * scale + 'px'; wrapper.style.height = CANVAS_HEIGHT * scale + 'px';
    // FIT uses cached parent dimensions; measure the new wrapper first.
    scene.scale?.getParentBounds(); scene.scale?.refresh();
  };
  resize();
  const game = new Phaser.Game({
    type: Phaser.CANVAS, width: CANVAS_WIDTH, height: CANVAS_HEIGHT,
    parent: 'game-canvas', backgroundColor: '#000000', pixelArt: true,
    roundPixels: true, antialias: false, scene: [scene],
    audio: { noAudio: true }, input: { mouse: false, touch: false },
    // Native animation frames supply elapsed time to the bounded fixed-step accumulator.
    fps: { smoothStep: false },
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  });
  const inactive = () => controller.inactive();
  const visibility = () => { if (document.hidden) inactive(); };
  window.addEventListener('resize', resize); window.addEventListener('blur', inactive);
  document.addEventListener('visibilitychange', visibility);
  let detachHarness = () => {};
  if (import.meta.env.MODE === 'test') {
    const harness = { ...controller.testing!, renderScene: () => scene };
    Object.assign(window, { __BATTLECITY__: harness });
    detachHarness = () => {
      if (Reflect.get(window, '__BATTLECITY__') === harness) Reflect.deleteProperty(window, '__BATTLECITY__');
    };
  }
  let disposed: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposed) return disposed;
    window.removeEventListener('resize', resize); window.removeEventListener('blur', inactive);
    window.removeEventListener('pagehide', pagehide); document.removeEventListener('visibilitychange', visibility);
    scene.onFrame = () => {}; controller.dispose(); input.dispose(); detachHarness();
    game.destroy(true);
    disposed = audio.dispose();
    return disposed;
  };
  const pagehide = (event: PageTransitionEvent) => {
    if (event.persisted) controller.inactive();
    else void dispose();
  };
  window.addEventListener('pagehide', pagehide);
  return { dispose };
}
