import { expect, test, type Page } from '@playwright/test';
import { readyWithClock, snapshot, startWithKeyboard } from './helpers';

async function inputField(page: Page, mode: 'single' | 'coop' = 'single'): Promise<void> {
  // Follow the normal menu lifecycle before isolating the controller fixture.
  await startWithKeyboard(page, mode);
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    const players = api.state()!.tanks.filter(tank => tank.team === 'player');
    Object.assign(players[0], { x: 32, y: 64, direction: 'right', spawnTicks: 0 });
    if (players[1]) Object.assign(players[1], { x: 160, y: 112, direction: 'up', spawnTicks: 0 });
    api.debug({ tanks: players, tiles: Array(676).fill(0), brickMasks: Array(676).fill(0), spawned: 20, bullets: [] });
  });
}

for (const fire of ['j', 'k']) {
  test(`1P can move and fire with ${fire.toUpperCase()}`, async ({ page }) => {
    await readyWithClock(page);
    await inputField(page);
    try {
      await page.keyboard.down('d');
      await page.keyboard.down(fire);
      await page.clock.runFor(100);
      const state = (await snapshot(page))!;
      expect(state.tanks.find(tank => tank.playerIndex === 0)!.x).toBeGreaterThan(32);
      expect(state.bullets.some(bullet => bullet.playerIndex === 0)).toBe(true);
    } finally {
      await page.keyboard.up(fire);
      await page.keyboard.up('d');
    }
  });
}

for (const fire of ['n', 'm']) {
  test(`both players can move and fire together with 2P ${fire.toUpperCase()}`, async ({ page }) => {
    await readyWithClock(page);
    await inputField(page, 'coop');
    const keys = ['d', 'ArrowLeft', 'j', fire];
    try {
      for (const key of keys) await page.keyboard.down(key);
      await page.clock.runFor(100);
      const state = (await snapshot(page))!;
      expect(state.tanks.find(tank => tank.playerIndex === 0)!.x).toBeGreaterThan(32);
      expect(state.tanks.find(tank => tank.playerIndex === 1)!.x).toBeLessThan(160);
      expect(new Set(state.bullets.filter(bullet => bullet.team === 'player').map(bullet => bullet.playerIndex)))
        .toEqual(new Set([0, 1]));
    } finally {
      for (const key of keys) await page.keyboard.up(key);
    }
  });
}

test('Enter pauses and resumes once per press, keeping held movement and fire neutral', async ({ page }) => {
  await readyWithClock(page);
  await inputField(page);
  try {
    await page.keyboard.down('d');
    await page.clock.runFor(34);
    expect((await snapshot(page))!.tanks[0].x).toBeGreaterThan(32);
    await page.keyboard.press('Enter');
    const paused = (await snapshot(page))!;
    expect(paused.phase).toBe('paused');
    await page.clock.runFor(150);
    expect((await snapshot(page))!.tick).toBe(paused.tick);
    await page.keyboard.down('j');
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.clock.runFor(150);
    const resumed = (await snapshot(page))!;
    expect(resumed.phase).toBe('playing');
    expect(resumed.tick).toBeGreaterThan(paused.tick);
    expect(resumed.tanks[0].x).toBe(paused.tanks[0].x);
    expect(resumed.bullets.filter(bullet => bullet.team === 'player')).toHaveLength(0);
  } finally {
    for (const key of ['Enter', 'd', 'j']) await page.keyboard.up(key);
  }
  const resumedX = (await snapshot(page))!.tanks[0].x;
  try {
    await page.keyboard.down('d');
    await page.clock.runFor(34);
    expect((await snapshot(page))!.tanks[0].x).toBeGreaterThan(resumedX);
  } finally {
    await page.keyboard.up('d');
  }
});

test('single player arrows, Space and Escape do not act as controller aliases', async ({ page }) => {
  await readyWithClock(page);
  await inputField(page);
  for (const key of ['ArrowRight', 'Space', 'Escape']) {
    const before = (await snapshot(page))!;
    try {
      await page.keyboard.down(key);
      await page.clock.runFor(100);
      const after = (await snapshot(page))!;
      expect(after.phase).toBe('playing');
      expect(after.tanks.map(({ x, y }) => ({ x, y }))).toEqual(before.tanks.map(({ x, y }) => ({ x, y })));
      expect(after.bullets.filter(bullet => bullet.team === 'player')).toHaveLength(0);
      expect(after.tick).toBeGreaterThan(before.tick);
    } finally {
      await page.keyboard.up(key);
    }
    await page.clock.runFor(34);
  }
});

test('loss of focus pauses and releases held input until explicit Start', async ({ page }) => {
  await readyWithClock(page);
  await inputField(page);
  try {
    await page.keyboard.down('d');
    await page.clock.runFor(34);
    expect((await snapshot(page))!.tanks[0].x).toBeGreaterThan(32);
    const paused = await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      return window.__BATTLECITY__!.state()!;
    });
    expect(paused.phase).toBe('paused');
    await page.clock.runFor(300);
    expect((await snapshot(page))!.tick).toBe(paused.tick);
    await page.keyboard.press('Enter');
    const resumed = (await snapshot(page))!;
    await page.clock.runFor(150);
    const after = (await snapshot(page))!;
    expect(after.phase).toBe('playing');
    expect(after.tanks[0].x).toBe(resumed.tanks[0].x);
    expect(after.tick).toBeGreaterThan(resumed.tick);
    expect(after.bullets.filter(bullet => bullet.team === 'player')).toHaveLength(0);
  } finally {
    await page.keyboard.up('d');
  }
});
