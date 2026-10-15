import { expect, test } from '@playwright/test';
import { getLevel } from '../../src/data/levels';
import { advanceToNextStage, begin, clearStage, completeLoss, readyWithClock, snapshot } from './helpers';

test.setTimeout(60000);

test('the second cycle returns to stage 1 with player progress intact', async ({ page }) => {
  await readyWithClock(page);
  await begin(page, 'single', 70);
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    const players = api.state()!.players;
    Object.assign(players[0], { score: 23400, lives: 1, stars: 3 });
    api.debug({ players });
  });
  await clearStage(page);
  await advanceToNextStage(page, 1);
  const state = (await snapshot(page))!;
  expect(state.enemyQueue).toEqual(getLevel(1).enemies);
  expect(state.players[0]).toMatchObject({ score: 23400, lives: 1, stars: 3 });
});

test('Construction replaces the first map then resumes the original campaign', async ({ page }) => {
  await readyWithClock(page);
  const draft = await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    api.openEditor();
    api.setEditorTile(270, 2);
    api.playEditor('single');
    return api.getEditorTiles();
  });
  expect((await snapshot(page))!).toMatchObject({ stage: 1, tiles: draft });
  await page.evaluate(() => window.__BATTLECITY__!.step(250));
  await clearStage(page);
  await advanceToNextStage(page, 2);
  const original = getLevel(2).tiles;
  for (let y = 24; y < 26; y++) for (let x = 8; x < 10; x++) original[y * 26 + x] = 0;
  expect((await snapshot(page))!.tiles).toEqual(original);
  expect(await page.evaluate(() => window.__BATTLECITY__!.getEditorTiles())).toEqual(draft);
});

test('game over clears the runtime Construction map before the next visit', async ({ page }) => {
  await readyWithClock(page);
  const original = await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    api.openEditor();
    const original = api.getEditorTiles();
    api.setEditorTile(270, original[270] === 2 ? 4 : 2);
    api.playEditor('coop');
    api.step(250);
    return original;
  });
  await completeLoss(page);
  await page.evaluate(() => window.__BATTLECITY__!.openEditor());
  expect(await page.evaluate(() => window.__BATTLECITY__!.getEditorTiles())).toEqual(original);
});
