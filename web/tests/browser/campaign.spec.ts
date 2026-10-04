import { expect, test } from '@playwright/test';
import { getLevel } from '../../src/data/levels';
import { begin, ready, snapshot } from './helpers';

async function clearStage(page: Parameters<typeof snapshot>[0]): Promise<void> {
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    const state = api.state()!;
    api.debug({ spawned: 20, killed: 20, bullets: [], tanks: state.tanks.filter(tank => tank.team === 'player') });
    api.step(200);
  });
  await page.getByRole('button', { name: /进入下一关/ }).click();
}

test('the second cycle returns to stage 1 with player progress intact', async ({ page }) => {
  await ready(page);
  await begin(page, 'single', 70);
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    const state = api.state()!;
    Object.assign(state.players[0], { score: 23400, lives: 1, stars: 3 });
    api.debug({ players: state.players });
  });
  await clearStage(page);
  const state = (await snapshot(page))!;
  expect(state.stage).toBe(1);
  expect(state.enemyQueue).toEqual(getLevel(1).enemies);
  expect(state.players[0]).toMatchObject({ score: 23400, lives: 1, stars: 3 });
});

test('Construction replaces the selected starting stage then resumes the original campaign', async ({ page }) => {
  await ready(page);
  await page.getByLabel('选择关卡').selectOption('3');
  const draft = await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    api.openEditor();
    api.setEditorTile(270, 2);
    return api.getEditorTiles();
  });
  await page.getByRole('button', { name: /单人试玩/ }).click();
  let state = (await snapshot(page))!;
  expect(state.stage).toBe(3);
  expect(state.tiles).toEqual(draft);
  expect(state.enemyQueue).toEqual(getLevel(3).enemies);
  await page.evaluate(() => window.__BATTLECITY__!.step(250));
  await clearStage(page);
  state = (await snapshot(page))!;
  expect(state.stage).toBe(4);
  // Player spawning clears only the reserved starting space.
  const original = getLevel(4).tiles;
  for (let y = 24; y < 26; y++) for (let x = 8; x < 10; x++) original[y * 26 + x] = 0;
  expect(state.tiles).toEqual(original);
  expect(await page.evaluate(() => window.__BATTLECITY__!.getEditorTiles())).toEqual(draft);
  await page.locator('#pause').click();
  await page.getByRole('button', { name: '返回编辑' }).click();
  expect(await page.evaluate(() => window.__BATTLECITY__!.getEditorTiles())).toEqual(draft);
});

test('retrying a custom cooperative stage preserves the mode and draft', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Cooperative acceptance is desktop only.');
  await ready(page);
  const draft = await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    api.openEditor();
    api.setEditorTile(270, 2);
    api.playEditor('coop');
    api.step(250);
    api.debug({ baseAlive: false });
    api.step(200);
    return api.getEditorTiles();
  });
  await page.getByRole('button', { name: /查看结果/ }).click();
  await page.getByRole('button', { name: /重试这一关/ }).click();
  const state = (await snapshot(page))!;
  expect(state.mode).toBe('coop');
  expect(state.tiles).toEqual(draft);
  expect(state.baseAlive).toBe(true);
});
