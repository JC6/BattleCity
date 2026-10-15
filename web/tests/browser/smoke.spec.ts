import { expect, test } from '@playwright/test';
import type {} from './helpers';
import { controllerKey, probeCanvas, readyCanvasWithClock, renderedStageTwo, waitForCanvasMenu } from './visual-probes';

test('production entry loads assets and responds to controller keys without errors', async ({ page }) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  const failedAssets: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (new URL(response.url()).pathname.startsWith('/assets/') && response.status() >= 400) failedAssets.push(response.url());
  });
  const menu = await readyCanvasWithClock(page);
  await expect(page).toHaveTitle('BattleCity · 坦克大战');
  const canvas = page.locator('#game-canvas canvas');
  await expect(canvas).toBeVisible();
  await expect(page.locator('button, select, input')).toHaveCount(0);
  const assetUrls = await page.locator('script[src], link[rel="stylesheet"][href], link[rel="modulepreload"][href]')
    .evaluateAll(elements => elements.map(element =>
      new URL(element.getAttribute('src') ?? element.getAttribute('href')!, document.baseURI).href));
  expect(assetUrls.length).toBeGreaterThan(0);
  expect(assetUrls.every(url => new URL(url).pathname.startsWith('/assets/'))).toBe(true);

  await controllerKey(page, 'Enter');
  expect((await probeCanvas(page)).stageSelect).toBe(1);
  await controllerKey(page, 'j');
  const stageTwo = await probeCanvas(page);
  expect(stageTwo.stageSelect).toBe(2);
  // A frozen selection or opaque intro must not satisfy the battle probe.
  expect(stageTwo.battleStage).toBeNull();
  expect(stageTwo.player).toBeNull();
  await controllerKey(page, 'Enter');
  const battle = await renderedStageTwo(page);
  expect(battle.player).toMatchObject({ x: 81, y: 210, width: 13, height: 13 });
  expect(battle.bullet, 'The empty shot corridor is a negative bullet sample').toBe(false);
  await controllerKey(page, 'w', 320);
  const moved = await probeCanvas(page);
  expect(moved.battleStage).toBe(2);
  expect(moved.player).not.toBeNull();
  expect(moved.player!.x).toBe(battle.player!.x);
  const travelled = battle.player!.y - moved.player!.y;
  expect(travelled).toBeGreaterThanOrEqual(12);
  expect(travelled).toBeLessThanOrEqual(16);
  expect(moved.bullet, 'Movement alone must not look like a shot').toBe(false);
  await controllerKey(page, 'j', 100);
  expect((await probeCanvas(page)).bullet, 'J must render an upward projectile in the empty corridor').toBe(true);
  if (process.env.BATTLECITY_PRODUCTION === '1') {
    expect(await page.evaluate(() => typeof window.__BATTLECITY__)).toBe('undefined');
    const scripts = await page.locator('script[src]').evaluateAll(elements => elements.map(element => (element as HTMLScriptElement).src));
    for (const script of scripts) {
      const javascript = await (await page.request.get(script)).text();
      expect(javascript).not.toMatch(/__BATTLECITY__|setEditorTile|getEditorTiles/);
    }
    const license = await page.request.get('LICENSE.txt');
    expect(license.ok()).toBe(true);
    expect(await license.text()).toContain('GNU GENERAL PUBLIC LICENSE');
    const notices = await page.request.get('THIRD_PARTY_NOTICES.md');
    expect(notices.ok()).toBe(true);
    expect(await notices.text()).toContain('Arnout Kazemier');
  } else {
    expect(await page.evaluate(() => window.__BATTLECITY__!.state())).toMatchObject({ stage: 2, phase: 'playing' });
  }
  await page.clock.resume();
  await page.reload();
  await page.bringToFront();
  await expect(canvas).toBeVisible();
  await waitForCanvasMenu(page);
  await page.clock.pauseAt(new Date('2026-01-01T02:00:00Z'));
  await page.clock.runFor(34);
  const refreshed = await probeCanvas(page);
  expect(refreshed.menu).toBe(true);
  expect(refreshed.pixelsSHA256).toBe(menu.pixelsSHA256);
  expect(errors).toEqual([]);
  expect(failedAssets).toEqual([]);
});

test('Construction can be entered, edited and left entirely with the keyboard', async ({ page }) => {
  test.setTimeout(60000);
  const menu = await readyCanvasWithClock(page);
  await controllerKey(page, 'ShiftRight');
  await controllerKey(page, 'ShiftRight');
  const selectedMenu = await probeCanvas(page);
  expect(selectedMenu.menu).toBe(true);
  expect(selectedMenu.editorOrigin, 'A menu cursor change must not count as entering Construction').toBe(false);
  await controllerKey(page, 'Enter');
  expect((await probeCanvas(page)).editorOrigin).toBe(true);
  for (const key of ['d', 'd', 's', 's']) await controllerKey(page, key);
  expect((await probeCanvas(page)).halfSteel, 'The unpainted block is a negative steel sample').toBe(false);
  for (let i = 0; i < 6; i++) await controllerKey(page, 'j');
  await controllerKey(page, 'd'); // Expose the painted block without the cursor.
  const painted = await probeCanvas(page);
  expect(painted.editorPaintCursor).toBe(true);
  expect(painted.halfSteel, 'J must paint the right half of block (2, 2) with steel').toBe(true);
  await controllerKey(page, 'Enter');
  const returned = await probeCanvas(page);
  expect(returned.menu).toBe(true);
  expect(returned.pixelsSHA256).toBe(menu.pixelsSHA256);
});

test('desktop resizing recalculates integer scale without clipping the canvas', async ({ page }) => {
  await page.goto('./');
  const canvas = page.locator('#game-canvas canvas');
  await expect(canvas).toBeVisible();
  for (const viewport of [{ width: 1280, height: 720 }, { width: 320, height: 240 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const scale = Math.floor(Math.min(viewport.width / 256, viewport.height / 240));
    await expect.poll(async () => {
      const box = (await canvas.boundingBox())!;
      return { width: Math.round(box.width), height: Math.round(box.height) };
    }).toEqual({ width: 256 * scale, height: 240 * scale });
    const box = (await canvas.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.y).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  }
});

for (const size of [
  { name: 'short desktop', width: 560, height: 320 },
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'narrow desktop', width: 390, height: 844 },
]) {
  for (const deviceScaleFactor of [1, 2]) {
    test.describe(`${size.name}, DPR ${deviceScaleFactor}`, () => {
      test.use({ viewport: { width: size.width, height: size.height }, deviceScaleFactor });
      test('retains the native pixel ratio and keeps the whole canvas in the viewport', async ({ page }) => {
        await page.goto('./');
        const canvas = page.locator('#game-canvas canvas');
        await expect(canvas).toBeVisible();
        const dimensions = await canvas.evaluate(element => {
          const canvas = element as HTMLCanvasElement;
          const rect = canvas.getBoundingClientRect();
          return { width: rect.width, height: rect.height, x: rect.x, y: rect.y,
            backingWidth: canvas.width, backingHeight: canvas.height,
            scrollWidth: document.documentElement.scrollWidth,
            scrollHeight: document.documentElement.scrollHeight };
        });
        expect(dimensions.width / dimensions.height).toBeCloseTo(256 / 240, 3);
        expect(dimensions.backingWidth / dimensions.backingHeight).toBeCloseTo(256 / 240, 3);
        expect(dimensions.width / 256).toBeCloseTo(Math.round(dimensions.width / 256), 3);
        expect(dimensions.x).toBeGreaterThanOrEqual(-1);
        expect(dimensions.y).toBeGreaterThanOrEqual(-1);
        expect(dimensions.x + dimensions.width).toBeLessThanOrEqual(size.width + 1);
        expect(dimensions.y + dimensions.height).toBeLessThanOrEqual(size.height + 1);
        expect(dimensions.scrollWidth).toBeLessThanOrEqual(size.width + 1);
        expect(dimensions.scrollHeight).toBeLessThanOrEqual(size.height + 1);
      });
    });
  }
}
