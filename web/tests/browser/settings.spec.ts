import { expect, test } from '@playwright/test';
import { begin, completeLoss, openWithKeyboard, presentation, ready, readyWithClock, snapshot, startWithKeyboard } from './helpers';

test('legacy stored preferences are ignored and a page starts with the original default record', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('battlecity.web.v1', JSON.stringify({ highScore: 999999, volume: 0, map: Array(676).fill(2) }));
  });
  await readyWithClock(page);
  expect(await presentation(page)).toMatchObject({ kind: 'menu', highScore: 20000 });
  await openWithKeyboard(page);
  expect(await page.evaluate(() => window.__BATTLECITY__!.getEditorTiles())).not.toEqual(Array(676).fill(2));
});

test('a new record remains within the session and resets to 20000 on refresh', async ({ page }) => {
  test.setTimeout(60000);
  await readyWithClock(page);
  await begin(page);
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    const players = api.state()!.players;
    players[0].score = 34500;
    api.debug({ players });
  });
  await completeLoss(page);
  expect(await presentation(page)).toMatchObject({ kind: 'menu', highScore: 34500 });
  // Resume only after observing all terminal scenes, so the fresh page can load.
  await page.clock.resume();
  await page.reload();
  await page.waitForFunction(() => !!window.__BATTLECITY__);
  expect(await presentation(page)).toMatchObject({ kind: 'menu', highScore: 20000 });
});

test('unavailable storage does not prevent keyboard play or Construction', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage unavailable'); } });
  });
  await ready(page);
  await openWithKeyboard(page);
  const draft = await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    api.setEditorTile(270, 2);
    return api.getEditorTiles();
  });
  await page.keyboard.press('Enter');
  await startWithKeyboard(page);
  expect((await snapshot(page))!.tiles[270]).toBe(draft[270]);
  expect(errors).toEqual([]);
});

test('separate tabs keep their Construction maps independent', async ({ page, context }) => {
  await ready(page);
  await page.evaluate(() => {
    window.__BATTLECITY__!.openEditor();
    window.__BATTLECITY__!.setEditorTile(270, 2);
  });
  const other = await context.newPage();
  await ready(other);
  await other.evaluate(() => {
    window.__BATTLECITY__!.openEditor();
    window.__BATTLECITY__!.setEditorTile(270, 4);
  });
  expect(await other.evaluate(() => window.__BATTLECITY__!.getEditorTiles()[270])).toBe(4);
  expect(await page.evaluate(() => window.__BATTLECITY__!.getEditorTiles()[270])).toBe(2);
  await page.bringToFront();
  // Headless tab activation need not dispatch a window blur. Exercise the
  // suspended editor explicitly before checking its session remains separate.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.keyboard.press('Enter');
  expect(await presentation(page)).toMatchObject({ kind: 'editor' });
  await page.keyboard.press('Enter');
  expect(await presentation(page)).toMatchObject({ kind: 'menu', highScore: 20000 });
  await other.close();
});
