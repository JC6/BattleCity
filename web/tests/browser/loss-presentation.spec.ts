import { expect, test } from '@playwright/test';
import { advancePresentation, begin, presentation, readyWithClock, snapshot } from './helpers';

// Wall time bounds browser RPC/painting costs. Scene progress has separate,
// bounded animation-time budgets and never retries a failed transition.
test.setTimeout(60000);

// Debug fixtures exercise browser integration; they are not original-game evidence.
test('failure animates the authoritative battlefield, pauses explicitly, then enters score once', async ({ page }) => {
  await readyWithClock(page); await begin(page);
  const origin = await page.evaluate(() => {
    const api = window.__BATTLECITY__!, state = api.state()!;
    state.players[0].score = 12345; state.players[0].kills = [1, 2, 3, 4];
    state.tanks = state.tanks.filter(tank => tank.team === 'player');
    state.tanks.forEach(tank => { tank.spawnTicks = 0; tank.shieldTicks = 10000; });
    api.debug({ baseAlive: false, players: state.players, tanks: state.tanks, bullets: [], spawnTimer: 100000 });
    api.step(1); return api.state()!.tanks[0];
  });
  await page.clock.runFor(34);
  expect((await snapshot(page))!.lossBannerTicks).toBeLessThan(256);
  await page.keyboard.down('w'); await page.keyboard.down('j');
  await page.clock.runFor(100);
  const running = (await snapshot(page))!;
  expect(running.tanks[0]).toMatchObject({ x: origin.x, y: origin.y, moving: false });
  expect(running.bullets).toHaveLength(0);
  await page.keyboard.up('w'); await page.keyboard.up('j');
  await page.keyboard.press('Enter'); await page.clock.runFor(100);
  const paused = await snapshot(page); expect(paused!.phase).toBe('paused');
  await page.clock.runFor(500); expect(await snapshot(page)).toEqual(paused);
  await page.keyboard.press('Enter');
  await advancePresentation(page, 'game', 'score', 5000);
  const result = await snapshot(page);
  expect(result).toMatchObject({ phase: 'lost', lossBannerTicks: 0 });
  expect(result!.players[0]).toMatchObject({ score: 12345, kills: [1, 2, 3, 4] });
  await advancePresentation(page, 'score', 'gameover', 8000);
  expect(await snapshot(page)).toEqual(result);
  await page.keyboard.press('Enter'); await page.clock.runFor(34);
  expect(await presentation(page)).toMatchObject({ kind: 'menu' });
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
