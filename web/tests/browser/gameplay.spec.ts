import { expect, test } from '@playwright/test';
import { begin, ready, snapshot } from './helpers';

test('stage 35 advances to the next cycle and carries player progression', async ({ page }) => {
  await ready(page);
  await begin(page, 'single', 35);
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    const state = api.state()!;
    state.players[0].score = 12300;
    state.players[0].stars = 2;
    state.players[0].lives = 1;
    state.players[0].nextExtraLife = Infinity;
    api.debug({ players: state.players, spawned: 20, killed: 20, tanks: state.tanks.filter(tank => tank.team === 'player'), bullets: [] });
    api.step(200);
  });
  await expect(page.getByRole('heading', { name: '基地守住了！' })).toBeVisible();
  await page.getByRole('button', { name: /进入下一关/ }).click();
  const state = (await snapshot(page))!;
  expect(state.stage).toBe(36);
  expect(state.players[0]).toMatchObject({ score: 12300, stars: 2, lives: 1 });
  expect(state.players[0].nextExtraLife).toBe(Infinity);
  expect(state.enemyQueue).toHaveLength(20);
  expect(state.enemyQueue.filter(kind => kind === 'power')).toHaveLength(4);
});

test('base destruction reaches game over and retry creates a fresh battlefield', async ({ page }) => {
  await ready(page);
  await begin(page, 'single', 5);
  await page.evaluate(() => {
    window.__BATTLECITY__!.debug({ baseAlive: false });
    window.__BATTLECITY__!.step(200);
  });
  await expect(page.getByRole('heading', { name: '战斗结束' })).toBeVisible();
  await page.getByRole('button', { name: /查看结果/ }).click();
  await expect(page.getByRole('heading', { name: /GAME.*OVER/ })).toBeVisible();
  await page.getByRole('button', { name: /重试这一关/ }).click();
  expect((await snapshot(page))!).toMatchObject({ stage: 5, phase: 'intro', baseAlive: true, killed: 0 });
});

test('an eliminated cooperative player remains eliminated across stages', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Cooperative acceptance is desktop only.');
  await ready(page);
  await begin(page, 'coop');
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    const state = api.state()!;
    Object.assign(state.players[1], { lives: 0, eliminated: true, respawnTicks: 0 });
    api.debug({ players: state.players, spawned: 20, killed: 20, tanks: state.tanks.filter(tank => tank.team === 'player' && tank.playerIndex === 0), bullets: [] });
    api.step(200);
  });
  await page.getByRole('button', { name: /进入下一关/ }).click();
  const state = (await snapshot(page))!;
  expect(state.stage).toBe(2);
  expect(state.players[1].eliminated).toBe(true);
  expect(state.tanks.some(tank => tank.playerIndex === 1)).toBe(false);
});
