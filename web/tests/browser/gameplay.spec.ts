import { expect, test } from '@playwright/test';
import { advanceToNextStage, begin, clearStage, completeLoss, presentation, readyWithClock, snapshot, startWithKeyboard } from './helpers';

test.setTimeout(60000);

test('stage 35 advances automatically to the next cycle with player progression', async ({ page }) => {
  await readyWithClock(page);
  await begin(page, 'single', 35);
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    const players = api.state()!.players;
    Object.assign(players[0], { score: 12300, stars: 2, lives: 1, nextExtraLife: Infinity });
    api.debug({ players });
  });
  await clearStage(page);
  await advanceToNextStage(page, 36);
  const state = (await snapshot(page))!;
  expect(state.players[0]).toMatchObject({ score: 12300, stars: 2, lives: 1, nextExtraLife: Infinity });
  expect(state.enemyQueue).toHaveLength(20);
  expect(state.enemyQueue.filter(kind => kind === 'power')).toHaveLength(4);
});

test('base destruction completes its presentations and a new run starts fresh', async ({ page }) => {
  await readyWithClock(page);
  await begin(page, 'single', 5);
  await completeLoss(page);
  expect(await snapshot(page)).toBeNull();
  await startWithKeyboard(page);
  expect(await snapshot(page)).toMatchObject({ stage: 1, phase: 'playing', baseAlive: true, killed: 0 });
});

test('an eliminated cooperative player remains eliminated across stages', async ({ page }) => {
  await readyWithClock(page);
  await begin(page, 'coop');
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    const state = api.state()!;
    Object.assign(state.players[1], { lives: 0, eliminated: true, respawnTicks: 0 });
    api.debug({ players: state.players, spawned: 20, killed: 20,
      tanks: state.tanks.filter(tank => tank.team === 'player' && tank.playerIndex === 0), bullets: [] });
    api.step(200);
  });
  expect(await presentation(page)).toMatchObject({ kind: 'score' });
  await advanceToNextStage(page, 2);
  const state = (await snapshot(page))!;
  expect(state.players[1].eliminated).toBe(true);
  expect(state.tanks.some(tank => tank.playerIndex === 1)).toBe(false);
});
