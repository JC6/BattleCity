import { expect, test } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import { attachPcmFailure, audioEventTime, audioReady, installPcmProbe, pcmAssert } from './audio-probe';
import { nativePixels } from './native-pixels';
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
  await expect(page).toHaveTitle('坦克大战');
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
  expect(await page.evaluate(() => typeof window.__BATTLECITY__)).toBe('undefined');
  // Include lazy chunks and the Worklet, not just scripts linked by index.html.
  const assets = await readdir(new URL('../../dist/assets/', import.meta.url), { withFileTypes: true });
  expect(assets.length).toBeGreaterThan(0);
  for (const asset of assets) {
    expect(asset.isFile(), asset.name).toBe(true);
    expect(asset.name).toMatch(/^[a-zA-Z0-9._-]+$/);
    const response = await page.request.get(`/assets/${asset.name}`);
    expect(response.ok(), asset.name).toBe(true);
    const bytes = await response.body();
    expect(bytes.length, asset.name).toBeGreaterThan(0);
    if (asset.name.endsWith('.js')) expect(bytes.toString('utf8'), asset.name)
      .not.toMatch(/__BATTLECITY__|setEditorTile|getEditorTiles|renderScene/);
  }
  for (const [published, source] of [
    ['LICENSE.txt', '../../../LICENSE'],
    ['THIRD_PARTY_NOTICES.md', '../../THIRD_PARTY_NOTICES.md'],
  ]) {
    const response = await page.request.get(published);
    expect(response.ok(), published).toBe(true);
    expect((await response.body()).equals(await readFile(new URL(source, import.meta.url))), published).toBe(true);
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

test('cooperative play starts two players from the keyboard', async ({ page }) => {
  await readyCanvasWithClock(page);
  await controllerKey(page, 'ShiftRight');
  await controllerKey(page, 'Enter');
  expect((await probeCanvas(page)).stageSelect).toBe(1);
  await controllerKey(page, 'j');
  await controllerKey(page, 'Enter');
  const battle = await renderedStageTwo(page);
  expect(battle.player).not.toBeNull();
  const pixels = await nativePixels(page);
  let green = 0, darkGreen = 0;
  // The second player's cleared spawn block contains its green tank, while
  // spawn stars and the shield cannot supply the two required tank colors.
  for (let y = 208; y < 224; y++) for (let x = 144; x < 160; x++) {
    const offset = (y * 256 + x) * 4;
    const color = pixels[offset] << 16 | pixels[offset + 1] << 8 | pixels[offset + 2];
    green += Number(color === 0x80d010); darkGreen += Number(color === 0x005800);
  }
  expect(green).toBeGreaterThanOrEqual(40); expect(darkGreen).toBeGreaterThanOrEqual(15);
});

test('the production Worklet plays audible opening PCM after keyboard Start', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  await installPcmProbe(page);
  await page.goto('./'); await page.bringToFront(); await waitForCanvasMenu(page);
  await page.keyboard.press('Enter'); await audioReady(page);
  await expect.poll(async () => (await probeCanvas(page)).stageSelect).toBe(1);
  await page.keyboard.press('Enter'); const keyAt = await audioEventTime(page, 'Enter');
  await pcmAssert(page, keyAt, keyAt + 1, [], value => {
    expect(value.onset).not.toBeNull();
    expect(value.rms).toBeGreaterThan(0.001); expect(value.peak).toBeLessThan(0.5);
  }, failure => attachPcmFailure(testInfo, failure, 'production opening', { keyAt }));
  expect(await page.evaluate(() => '__BATTLECITY__' in window)).toBe(false);
});
