import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { Textures } from 'phaser';
import type { ArenaPresentation } from '../../src/app/presentation';
import type { ArenaScene } from '../../src/game/arena';
import type { GameState, Tile } from '../../src/core/types';
import { renderFixtures } from '../game/render-fixtures';
import { readyWithClock } from './helpers';
import { nativePixels, pixelsSHA256 } from './native-pixels';

const golden = JSON.parse(readFileSync(new URL('../game/fixtures/native-golden.json', import.meta.url), 'utf8')) as {
  scenes: Record<string, string>; hiscore: string[];
  menuHeaders: Record<string, { playerScores: number[]; highScore: number; sha256: string }>;
};
interface Fixture { presentation: ArenaPresentation; state: GameState | null; hudState: GameState | null; draft: Tile[] | null }
function fixture(name: string): Fixture {
  const result: Fixture = { presentation: { kind: 'game' }, state: null, hudState: null, draft: null };
  renderFixtures().find(value => value.name === name)!.apply(result as ArenaScene);
  return result;
}
async function draw(page: Page, value: Fixture): Promise<void> {
  await page.evaluate(value => {
    const scene = window.__BATTLECITY__!.renderScene();
    scene.onFrame = () => {}; scene.resetAnimation(); Object.assign(scene, value);
    if (scene.state) scene.observeStep(scene.state);
  }, value);
  // Allow several animation-frame callbacks for Phaser depth sorting and WebKit's
  // compositor to publish the replaced fixture. The simulation stays frozen.
  await page.clock.runFor(67);
}
async function check(page: Page, name: string): Promise<void> {
  await draw(page, fixture(name));
  await expectFrame(page, golden.scenes[name], name);
}
async function expectFrame(page: Page, expected: string, label: string, integerBlocks = false,
  bounds?: readonly [number, number, number, number]): Promise<void> {
  // WebKit may capture the previous compositor buffer after the scene has
  // rendered. Advance the frozen fixture until its actual screenshot arrives;
  // keep the default assertion budget and exact independent pixel hash.
  await expect.poll(async () => {
    await page.clock.runFor(34);
    const pixels = await nativePixels(page, integerBlocks);
    if (!bounds) return pixelsSHA256(pixels);
    const [x, y, width, height] = bounds, region = Buffer.alloc(width * height * 4);
    for (let row = 0; row < height; row++) {
      const start = ((y + row) * 256 + x) * 4;
      pixels.copy(region, row * width * 4, start, start + width * 4);
    }
    return pixelsSHA256(region);
  }, { message: label }).toBe(expected);
}
async function checkMenuHeaders(page: Page, integerBlocks = false): Promise<void> {
  // Keep browser coverage focused; all formatting boundaries run in unit tests.
  for (const name of ['coop-six', 'coop-million-tail', 'single-million']) {
    const expected = golden.menuHeaders[name], value = fixture('menu-0');
    value.presentation = { kind: 'menu', selection: 0, highScore: expected.highScore, playerScores: expected.playerScores };
    await draw(page, value);
    await expectFrame(page, expected.sha256, name, integerBlocks, [16, 24, 216, 8]);
  }
}

test.use({ viewport: { width: 1280, height: 720 } });
test('static pages preserve independent native pixel goldens', async ({ page }) => {
  await readyWithClock(page);
  for (const name of ['menu-0', 'menu-1', 'menu-2', 'stage-35', 'gameover']) await check(page, name);
  await checkMenuHeaders(page);
});
test('intro curtains and PAUSE retain their pixels and layer order', async ({ page }) => {
  await readyWithClock(page);
  for (const elapsed of [0, 1000, 1500, 2000]) for (const paused of [false, true]) await check(page, `intro-${elapsed}-${paused}`);
});
test('single and cooperative score pages retain labels and complete counts', async ({ page }) => {
  await readyWithClock(page);
  for (const mode of ['single', 'coop']) for (const elapsed of [0, 6000]) await check(page, `score-${mode}-${elapsed}`);
});
test('both water phases preserve damaged walls and entity sprites', async ({ page }) => {
  await readyWithClock(page);
  for (const name of ['entities-0', 'entities-16']) await check(page, name);
});
test('forest, locked HUD, result banner and editor keep their overlap order', async ({ page }) => {
  await readyWithClock(page);
  for (const name of ['locked-hud', 'editor']) await check(page, name);
});
test('HISCORE uses four source-derived palettes without uploading each flash', async ({ page }) => {
  await readyWithClock(page);
  const value = fixture('gameover');
  value.presentation = { kind: 'hiscore', highScore: 206300, tick: 0 };
  await draw(page, value);
  await expectFrame(page, golden.hiscore[0], 'initial palette');
  await page.evaluate(() => {
    const manager = window.__BATTLECITY__!.renderScene().textures;
    Object.assign(window, { __textureRefreshes: 0 });
    for (const key of manager.getTextureKeys().filter(key => key.startsWith('arena-'))) {
      const texture = manager.get(key) as Textures.CanvasTexture, refresh = texture.refresh.bind(texture);
      texture.refresh = () => { (window as unknown as { __textureRefreshes: number }).__textureRefreshes++; return refresh(); };
    }
  });
  for (let tick = 0; tick < 4; tick++) {
    value.presentation.tick = tick;
    await draw(page, value);
    await expectFrame(page, golden.hiscore[tick], `palette ${tick}`);
  }
  expect(await page.evaluate(() => (window as unknown as { __textureRefreshes: number }).__textureRefreshes)).toBe(0);
});
test('texture count and image pools remain bounded across ids and scene restarts', async ({ page }) => {
  await readyWithClock(page);
  await draw(page, fixture('entities-0'));
  const resources = () => page.evaluate(() => {
    const scene = window.__BATTLECITY__!.renderScene();
    const textures = scene.textures.getTextureKeys().filter(key => key.startsWith('arena-'));
    return { textures: textures.length, bytes: textures.reduce((sum, key) => {
      const image = scene.textures.get(key).getSourceImage() as HTMLCanvasElement;
      return sum + image.width * image.height * 4;
    }, 0), objects: scene.children.list.length,
    graphics: scene.children.list.filter(child => child.type === 'Graphics').length };
  });
  const before = await resources();
  expect(before.textures).toBe(10); expect(before.bytes).toBeLessThan(2.7 * 1024 * 1024); expect(before.graphics).toBe(0);
  await page.evaluate(() => {
    const scene = window.__BATTLECITY__!.renderScene();
    for (let cycle = 0; cycle < 100; cycle++) {
      for (const tank of scene.state!.tanks) tank.id += 100;
      for (const bullet of scene.state!.bullets) bullet.id += 100;
      scene.update(0, 16);
    }
  });
  expect(await resources()).toEqual(before);
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.evaluate(() => { window.__BATTLECITY__!.renderScene().scene.restart(); });
    await page.clock.runFor(34);
    await draw(page, fixture('entities-0'));
    expect(await resources()).toEqual(before);
    await expectFrame(page, golden.scenes['entities-0'], `restart ${cycle}`);
  }
});
test('unavailable WebGL preserves every golden native pixel on its integer block', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: Parameters<typeof original>) {
      if (['webgl', 'webgl2', 'experimental-webgl'].includes(String(args[0]))) return null;
      return original.apply(this, args);
    } as typeof original;
  });
  await readyWithClock(page);
  expect(await page.evaluate(() => window.__BATTLECITY__!.renderScene().game.renderer.type)).toBe(1);
  for (const name of ['menu-0', 'entities-16']) {
    await draw(page, fixture(name));
    await expectFrame(page, golden.scenes[name], name, true);
  }
  await checkMenuHeaders(page, true);
});
