import { expect, test, type Page } from '@playwright/test';
import { ready, snapshot } from './helpers';

async function trackEditorWrites(page: Page): Promise<void> {
  await page.evaluate(() => {
    let writes = 0;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'battlecity.web.v1') writes++;
      return original.call(this, key, value);
    };
    Object.defineProperty(window, '__editorWrites', { get: () => writes });
  });
}

async function canvasPoint(page: Page, tileX: number, tileY: number): Promise<{ x: number; y: number }> {
  const canvas = page.locator('#game-canvas canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  return {
    x: box.x + (8 + tileX * 8 + 4) / 256 * box.width,
    y: box.y + (16 + tileY * 8 + 4) / 240 * box.height,
  };
}

test('painting and gameplay mutations stay isolated from the editor draft', async ({ page }) => {
  await ready(page);
  const draft = await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    api.openEditor();
    api.setEditorTile(270, 1);
    api.setEditorTile(271, 1);
    return api.getEditorTiles();
  });
  await page.getByRole('button', { name: /单人试玩/ }).click();
  expect((await snapshot(page))!.tiles).toEqual(draft);
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    const tiles = api.state()!.tiles;
    tiles[270] = 0;
    api.debug({ tiles });
    api.openEditor();
  });
  expect(await page.evaluate(() => window.__BATTLECITY__!.getEditorTiles())).toEqual(draft);
  await page.reload();
  await page.waitForFunction(() => !!window.__BATTLECITY__);
  expect(await page.evaluate(() => window.__BATTLECITY__!.getEditorTiles())).toEqual(draft);
});

test('editor protects base and starting positions', async ({ page }) => {
  await ready(page);
  const values = await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    api.openEditor();
    const protectedCells = [0, 12, 24, 24 * 26 + 8, 24 * 26 + 12, 24 * 26 + 16];
    const before = api.getEditorTiles();
    protectedCells.forEach(index => api.setEditorTile(index, 2));
    const after = api.getEditorTiles();
    return protectedCells.map(index => [before[index], after[index]]);
  });
  expect(values.every(([before, after]) => before === after)).toBe(true);
});

test('terrain palette paints canvas blocks without saving unchanged or protected blocks again', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: /地图编辑/ }).click();
  await page.getByRole('button', { name: '绘制水面' }).click();
  await trackEditorWrites(page);
  const box = (await page.locator('#game-canvas canvas').boundingBox())!;
  const paint = (x: number, y: number) => page.mouse.click(box.x + x / 256 * box.width, box.y + y / 240 * box.height);
  await paint(80, 88);
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__editorWrites'))).toBe(1);
  const tiles = await page.evaluate(() => window.__BATTLECITY__!.getEditorTiles());
  expect([8 * 26 + 8, 8 * 26 + 9, 9 * 26 + 8, 9 * 26 + 9].map(index => tiles[index])).toEqual([3, 3, 3, 3]);
  await paint(80, 88);
  await paint(81, 89);
  await paint(12, 20); // Protected top-left enemy birth block.
  expect(await page.evaluate(() => ({
    tiles: window.__BATTLECITY__!.getEditorTiles(), writes: Reflect.get(window, '__editorWrites'),
  }))).toEqual({ tiles, writes: 1 });
});

test('editor stops painting after blur, resumes on a new press, and ignores the right button', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Mouse button acceptance uses desktop projects; native touch is covered separately.');
  await ready(page);
  await page.getByRole('button', { name: /地图编辑/ }).click();
  await page.getByRole('button', { name: '绘制钢墙' }).click();
  await trackEditorWrites(page);
  const first = await canvasPoint(page, 6, 8);
  const second = await canvasPoint(page, 14, 8);
  const third = await canvasPoint(page, 18, 8);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => window.__BATTLECITY__!.getEditorTiles()[8 * 26 + 6])).toBe(2);
  const saved = await page.evaluate(() => localStorage.getItem('battlecity.web.v1'));

  // Model a release outside the window: no mouseup reaches this page, and
  // a subsequent mousemove reports that no button is held.
  const afterBlur = await page.evaluate(point => {
    window.dispatchEvent(new Event('blur'));
    document.querySelector('#game-canvas canvas')!.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, clientX: point.x, clientY: point.y, buttons: 0,
    }));
    return {
      tile: window.__BATTLECITY__!.getEditorTiles()[8 * 26 + 14],
      saved: localStorage.getItem('battlecity.web.v1'),
      writes: Reflect.get(window, '__editorWrites'),
    };
  }, second);
  expect(afterBlur).toEqual({ tile: 0, saved, writes: 1 });
  await page.mouse.up();
  await page.mouse.click(second.x, second.y);
  await expect.poll(() => page.evaluate(() => window.__BATTLECITY__!.getEditorTiles()[8 * 26 + 14])).toBe(2);
  expect(await page.evaluate(() => Reflect.get(window, '__editorWrites'))).toBe(2);
  const beforeRightClick = await page.evaluate(() => localStorage.getItem('battlecity.web.v1'));
  await page.mouse.click(third.x, third.y, { button: 'right' });
  expect(await page.evaluate(() => window.__BATTLECITY__!.getEditorTiles()[8 * 26 + 18])).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('battlecity.web.v1'))).toBe(beforeRightClick);
  expect(await page.evaluate(() => Reflect.get(window, '__editorWrites'))).toBe(2);
});

test('native touch can drag paint, cancel, and start another stroke', async ({ page, context, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || !isMobile, 'Uses Chromium CDP native touch events on a phone viewport.');
  await ready(page);
  await page.getByRole('button', { name: /地图编辑/ }).click();
  await page.getByRole('button', { name: '绘制水面' }).click();
  const first = await canvasPoint(page, 6, 8);
  const second = await canvasPoint(page, 8, 8);
  const third = await canvasPoint(page, 14, 8);
  const fourth = await canvasPoint(page, 16, 8);
  const session = await context.newCDPSession(page);
  const tile = (x: number) => page.evaluate(x => window.__BATTLECITY__!.getEditorTiles()[8 * 26 + x], x);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, ...first }] });
    await expect.poll(() => tile(6)).toBe(3);
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, ...second }] });
    await expect.poll(() => tile(8)).toBe(3);
    await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await page.evaluate(point => {
      document.querySelector('#game-canvas canvas')!.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, clientX: point.x, clientY: point.y, buttons: 0,
      }));
    }, third);
    expect(await tile(14)).toBe(0);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 2, ...third }] });
    await expect.poll(() => tile(14)).toBe(3);
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 2, ...fourth }] });
    await expect.poll(() => tile(16)).toBe(3);
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await session.detach();
  }
});
