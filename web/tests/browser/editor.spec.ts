import { expect, test, type Page } from '@playwright/test';
import { openWithKeyboard, presentation, ready, readyWithClock, snapshot, startWithKeyboard } from './helpers';

async function editor(page: Page) {
  return page.evaluate(() => window.__BATTLECITY__!.editor());
}

async function block(page: Page, x: number, y: number) {
  return page.evaluate(({ x, y }) => {
    const tiles = window.__BATTLECITY__!.getEditorTiles();
    return [0, 1, 26, 27].map(offset => tiles[y * 2 * 26 + x * 2 + offset]);
  }, { x, y });
}

async function openTimedEditor(page: Page): Promise<void> {
  await readyWithClock(page);
  await openWithKeyboard(page);
  await page.clock.runFor(34);
}

async function moveInside(page: Page): Promise<void> {
  for (let index = 0; index < 4; index++) await move(page, 'd');
  for (let index = 0; index < 4; index++) await move(page, 's');
}

async function move(page: Page, key: 'd' | 's'): Promise<void> {
  const cursor = (await editor(page)).cursor;
  const target = { x: cursor.x + Number(key === 'd'), y: cursor.y + Number(key === 's') };
  await page.keyboard.down(key);
  try {
    // Two animation frames consume the held direction before its twenty-tick
    // repeat. Time remains paused while observing and releasing the real key.
    await page.clock.runFor(34);
    expect((await editor(page)).cursor).toEqual(target);
  } finally {
    await page.keyboard.up(key);
  }
  // Let the editor observe a neutral direction before the next press.
  await page.clock.runFor(34);
}

test('Construction cursor uses WASD, A/B cycle blocks and Start completes editing', async ({ page }) => {
  test.setTimeout(60000);
  await openTimedEditor(page);
  const initial = await editor(page);
  await moveInside(page);
  expect((await editor(page)).cursor).toEqual({ x: initial.cursor.x + 4, y: initial.cursor.y + 4 });
  await page.keyboard.press('j');
  await page.clock.runFor(34);
  expect((await editor(page)).selectedCode).toBe(initial.selectedCode);
  await page.keyboard.press('j');
  await page.clock.runFor(34);
  expect((await editor(page)).selectedCode).toBe(initial.selectedCode + 1);
  await page.keyboard.press('k');
  await page.clock.runFor(34);
  expect((await editor(page)).selectedCode).toBe(initial.selectedCode);
  await page.keyboard.press('Enter');
  await startWithKeyboard(page);
  expect(await snapshot(page)).toMatchObject({ stage: 1, mode: 'single' });
});

test('holding a block action paints while moving and releasing it stops painting', async ({ page }) => {
  test.setTimeout(60000);
  await openTimedEditor(page);
  await moveInside(page);
  const first = (await editor(page)).cursor;
  const selected = (await editor(page)).selectedCode;
  await page.keyboard.press('j');
  await page.clock.runFor(34);
  await page.keyboard.down('j');
  try {
    await page.clock.runFor(34);
    expect((await editor(page)).selectedCode).toBe(selected + 1);
    const painted = await block(page, first.x, first.y);
    await page.keyboard.down('d');
    try {
      await page.clock.runFor(500);
    } finally {
      await page.keyboard.up('d');
    }
    await page.clock.runFor(34);
    const held = (await editor(page)).cursor;
    expect(held.y).toBe(first.y);
    expect(held.x - first.x).toBeGreaterThan(1);
    for (let x = first.x + 1; x <= held.x; x++) {
      expect(await block(page, x, held.y)).toEqual(painted);
    }
    const beforeUnpainted = await block(page, held.x + 1, held.y);
    expect(beforeUnpainted).not.toEqual(painted);
    await page.keyboard.up('j');
    await move(page, 'd');
    expect(await block(page, held.x + 1, held.y)).toEqual(beforeUnpainted);
  } finally {
    await page.keyboard.up('j');
  }
});

test('Construction blur releases its held block action', async ({ page }) => {
  test.setTimeout(60000);
  await openTimedEditor(page);
  await moveInside(page);
  const cursor = (await editor(page)).cursor;
  const untouched = await block(page, cursor.x + 1, cursor.y);
  const selected = (await editor(page)).selectedCode;
  await page.keyboard.press('j');
  await page.clock.runFor(34);
  await page.keyboard.down('j');
  try {
    await page.clock.runFor(34);
    expect((await editor(page)).selectedCode).toBe(selected + 1);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.keyboard.down('d');
    await page.clock.runFor(300);
    expect((await editor(page)).cursor).toEqual(cursor);
    await page.keyboard.up('d');
    await page.keyboard.press('Enter');
    expect(await presentation(page)).toMatchObject({ kind: 'editor' });
    await move(page, 'd');
    expect(await block(page, cursor.x + 1, cursor.y)).toEqual(untouched);
  } finally {
    await page.keyboard.up('d');
    await page.keyboard.up('j');
  }
});

test('playing a constructed map copies the draft rather than mutating it', async ({ page }) => {
  await ready(page);
  const draft = await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    api.openEditor();
    api.setEditorTile(270, 1);
    api.setEditorTile(271, 1);
    api.playEditor('single');
    return api.getEditorTiles();
  });
  expect((await snapshot(page))!.tiles).toEqual(draft);
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    const tiles = api.state()!.tiles;
    tiles[270] = 0;
    api.debug({ tiles });
    api.openEditor();
  });
  expect(await page.evaluate(() => window.__BATTLECITY__!.getEditorTiles())).toEqual(draft);
});

test('editor can paint base and birth blocks; playing restores only the occupied cells', async ({ page }) => {
  await ready(page);
  const values = await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    api.openEditor();
    const cells = [0, 12, 24, 24 * 26 + 8, 24 * 26 + 12, 24 * 26 + 16];
    cells.forEach(index => api.setEditorTile(index, 2));
    const draft = api.getEditorTiles();
    api.playEditor('single');
    const played = api.state()!.tiles;
    return { edited: cells.map(index => draft[index]), played: cells.map(index => played[index]), retained: api.getEditorTiles() };
  });
  expect(values.edited).toEqual([2, 2, 2, 2, 2, 2]);
  expect(values.played).toEqual([2, 2, 2, 0, 0, 2]);
  expect(values.retained[0]).toBe(2);
});

test('refresh discards the constructed map', async ({ page }) => {
  await ready(page);
  const original = await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    api.openEditor();
    const original = api.getEditorTiles();
    api.setEditorTile(270, original[270] === 2 ? 4 : 2);
    return original;
  });
  expect(await page.evaluate(() => window.__BATTLECITY__!.getEditorTiles())).not.toEqual(original);
  await page.reload();
  await page.waitForFunction(() => !!window.__BATTLECITY__);
  await page.evaluate(() => window.__BATTLECITY__!.openEditor());
  expect(await page.evaluate(() => window.__BATTLECITY__!.getEditorTiles())).toEqual(original);
});
