import { expect, test } from '@playwright/test';
import { advancePresentation, begin, presentation, readyWithClock, snapshot } from './helpers';

// Wall time bounds browser RPC/painting costs. Scene progress has separate,
// bounded animation-time budgets and never retries a failed transition.
test.setTimeout(60000);

// Debug fixtures exercise browser integration; they are not original-game evidence.
test('loss locks the result while its battlefield animates and settles automatically', async ({ page }) => {
  await readyWithClock(page);
  await begin(page);
  const result = await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    const state = api.state()!;
    state.players[0].score = 12345;
    state.players[0].kills = [1, 2, 3, 4];
    api.debug({ phase: 'lost', pendingOutcome: 'lost', baseAlive: false, players: state.players });
    api.step(0);
    return api.state();
  });
  await page.clock.runFor(34);
  const banner = await presentation(page);
  expect(banner.kind).toBe('game');
  if (banner.kind !== 'game') throw new Error('Loss banner was not shown');
  expect(banner.lossBannerProgress).toBeGreaterThan(0);
  for (const key of ['w', 'j', 'Enter']) {
    try {
      await page.keyboard.down(key);
      await page.clock.runFor(34);
      expect(await snapshot(page)).toEqual(result);
    } finally {
      await page.keyboard.up(key);
    }
  }
  expect(await snapshot(page)).toEqual(result);
  const laterBanner = await presentation(page);
  expect(laterBanner.kind).toBe('game');
  if (laterBanner.kind !== 'game') throw new Error('Loss banner ended early');
  expect(laterBanner.lossBannerProgress).toBeGreaterThan(banner.lossBannerProgress!);
  const score = await advancePresentation(page, 'game', 'score', 2500);
  expect(score.kind).toBe('score');
  if (score.kind !== 'score') throw new Error('Score was not shown');
  expect(score.state).toEqual(result);
  expect(await snapshot(page)).toEqual(result);
  await advancePresentation(page, 'score', 'gameover', 8000);
  expect(await snapshot(page)).toEqual(result);
  await advancePresentation(page, 'gameover', 'menu', 2500);
  expect(await snapshot(page)).toBeNull();
});

test('a record run shows HISCORE after brick Game Over before returning to the menu', async ({ page }) => {
  await readyWithClock(page);
  await begin(page);
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    const players = api.state()!.players;
    players[0].score = 34500;
    api.debug({ players, baseAlive: false });
    api.step(200);
  });
  await advancePresentation(page, 'game', 'score', 2500);
  await advancePresentation(page, 'score', 'gameover', 8000);
  const record = await advancePresentation(page, 'gameover', 'hiscore', 2500);
  expect(record).toMatchObject({ kind: 'hiscore', highScore: 34500 });
  expect(await advancePresentation(page, 'hiscore', 'menu', 8000)).toMatchObject({ kind: 'menu', highScore: 34500 });
});
