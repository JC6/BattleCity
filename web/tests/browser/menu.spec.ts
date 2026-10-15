import { expect, test } from '@playwright/test';
import { presentation, readyWithClock, select, snapshot, waitForPlaying } from './helpers';

test('Select cycles all three menu modes and movement keys leave selection alone', async ({ page }) => {
  await readyWithClock(page);
  for (const key of ['ArrowUp', 'ArrowDown', 'w', 's', 'ShiftLeft']) {
    await page.keyboard.down(key);
    try {
      await page.clock.runFor(34);
      expect(await presentation(page)).toMatchObject({ kind: 'menu', selection: 0 });
    } finally {
      await page.keyboard.up(key);
    }
    await page.clock.runFor(34);
  }
  for (const selection of [1, 2, 0]) {
    await select(page);
    expect(await presentation(page)).toMatchObject({ kind: 'menu', selection });
  }
});

test('Start opens stage selection, A and B change stage, Start begins the chosen mode', async ({ page }) => {
  await readyWithClock(page);
  await select(page);
  await page.keyboard.press('Enter');
  expect(await presentation(page)).toMatchObject({ kind: 'stage-select', stage: 1, mode: 'coop' });
  expect(await snapshot(page)).toBeNull();
  await page.keyboard.press('j');
  await page.clock.runFor(34);
  await expect.poll(() => presentation(page), { intervals: [16, 16, 16] }).toMatchObject({ kind: 'stage-select', stage: 2 });
  await page.keyboard.press('j');
  await page.clock.runFor(34);
  await expect.poll(() => presentation(page), { intervals: [16, 16, 16] }).toMatchObject({ kind: 'stage-select', stage: 3 });
  await page.keyboard.press('k');
  await page.clock.runFor(34);
  await expect.poll(() => presentation(page), { intervals: [16, 16, 16] }).toMatchObject({ kind: 'stage-select', stage: 2 });
  await page.keyboard.press('Enter');
  expect(await snapshot(page)).toMatchObject({ stage: 2, mode: 'coop', phase: 'intro' });
  await waitForPlaying(page);
});

test('held Start and Select do not repeat across presentation screens', async ({ page }) => {
  await readyWithClock(page);
  await page.keyboard.down('ShiftRight');
  await page.keyboard.down('ShiftRight');
  expect(await presentation(page)).toMatchObject({ kind: 'menu', selection: 1 });
  await page.keyboard.up('ShiftRight');
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter');
  await page.clock.runFor(100);
  expect(await presentation(page)).toMatchObject({ kind: 'stage-select' });
  expect(await snapshot(page)).toBeNull();
  await page.keyboard.up('Enter');
  await page.keyboard.press('Enter');
  expect(await snapshot(page)).toMatchObject({ phase: 'intro' });
});

test('Construction opens with Select twice and Start returns to the menu', async ({ page }) => {
  await readyWithClock(page);
  await select(page, 2);
  await page.keyboard.press('Enter');
  expect(await presentation(page)).toMatchObject({ kind: 'editor' });
  await page.keyboard.press('Enter');
  expect(await presentation(page)).toMatchObject({ kind: 'menu' });
  expect(await snapshot(page)).toBeNull();
});

test('the application exposes one canvas without auxiliary controls', async ({ page }) => {
  await readyWithClock(page);
  await expect(page.locator('#game-canvas canvas')).toHaveCount(1);
  await expect(page.locator('button, select, input, #touch-controls, #settings, #fullscreen')).toHaveCount(0);
});
