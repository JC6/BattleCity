import { expect, test } from '@playwright/test';
import { begin, ready, snapshot } from './helpers';

async function inputField(page: Parameters<typeof snapshot>[0], mode: 'single' | 'coop' = 'single'): Promise<void> {
  await begin(page, mode);
  // Input acceptance needs room for a shot to remain observable, rather
  // than starting beside the fortress where a correct shot vanishes quickly.
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    const players = api.state()!.tanks.filter(tank => tank.team === 'player');
    Object.assign(players[0], { x: 32, y: 64, direction: 'right', spawnTicks: 0 });
    if (players[1]) Object.assign(players[1], { x: 160, y: 112, direction: 'up', spawnTicks: 0 });
    api.debug({ tanks: players, tiles: Array(676).fill(0), brickMasks: Array(676).fill(0), spawned: 20, bullets: [] });
  });
}

test('keyboard supports moving and firing together', async ({ page }) => {
  await ready(page);
  await inputField(page);
  const before = (await snapshot(page))!;
  const x = before.tanks.find(tank => tank.playerIndex === 0)!.x;
  await page.keyboard.down('d');
  await page.keyboard.down('j');
  await expect.poll(async () => (await snapshot(page))!.tanks.find(tank => tank.playerIndex === 0)!.x).toBeGreaterThan(x);
  await expect.poll(async () => (await snapshot(page))!.bullets.filter(bullet => bullet.team === 'player').length).toBeGreaterThan(0);
  await page.keyboard.up('j');
  await page.keyboard.up('d');
});

for (const key of ['Enter', 'Space']) {
  test(`paused buttons resume with native ${key} without rearming held input`, async ({ page, isMobile }) => {
    await ready(page);
    await inputField(page, key === 'Enter' && !isMobile ? 'coop' : 'single');
    const before = (await snapshot(page))!;
    const initialX = before.tanks.find(tank => tank.playerIndex === 0)!.x;
    await page.keyboard.down('d');
    await expect.poll(async () => (await snapshot(page))!.tanks.find(tank => tank.playerIndex === 0)!.x).toBeGreaterThan(initialX);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: '战斗暂停' })).toBeVisible();
    await page.getByRole('button', { name: /继续战斗/ }).focus();
    await page.keyboard.down(key);
    if (key === 'Space') {
      // A native button activates Space on release; repetition while paused stays native.
      await page.keyboard.down(key);
      await page.keyboard.up(key);
    }
    await expect(page.getByRole('heading', { name: '战斗暂停' })).toBeHidden();
    const resumed = (await snapshot(page))!;
    const resumedX = resumed.tanks.find(tank => tank.playerIndex === 0)!.x;
    await page.keyboard.down('d'); // Native repeat of the key that was held before pausing.
    if (key === 'Enter') await page.keyboard.down(key);
    await page.waitForTimeout(150);
    const after = (await snapshot(page))!;
    expect(after.phase).toBe('playing');
    expect(after.tanks.find(tank => tank.playerIndex === 0)!.x).toBe(resumedX);
    expect(after.bullets.filter(bullet => bullet.team === 'player')).toHaveLength(0);
    await page.keyboard.up('d');
    if (key === 'Enter') await page.keyboard.up(key);
    await page.keyboard.press('j');
    await expect.poll(async () => (await snapshot(page))!.bullets.filter(bullet => bullet.team === 'player').length).toBeGreaterThan(0);
  });
}

test('Escape resumes while game input is inactive and repeated Escape does not toggle twice', async ({ page }) => {
  await ready(page);
  await inputField(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: '战斗暂停' })).toBeVisible();
  await page.keyboard.down('Escape');
  await expect(page.getByRole('heading', { name: '战斗暂停' })).toBeHidden();
  await page.keyboard.down('Escape');
  await page.waitForTimeout(100);
  expect((await snapshot(page))!.phase).toBe('playing');
  await page.keyboard.up('Escape');
});

test('a direction finger becomes neutral at the center or outside and can slide back while firing', async ({ page, browserName, isMobile, context }) => {
  test.skip(browserName !== 'chromium' || !isMobile, 'Uses native Chromium touch points on a phone viewport.');
  await ready(page);
  await inputField(page);
  const initialX = (await snapshot(page))!.tanks.find(tank => tank.playerIndex === 0)!.x;
  const right = (await page.getByRole('button', { name: '向右', exact: true }).boundingBox())!;
  const fire = (await page.getByRole('button', { name: '射击', exact: true }).boundingBox())!;
  const center = (await page.locator('.pad-center').boundingBox())!;
  const outside = (await page.locator('.touch-caption').boundingBox())!;
  const point = (rect: typeof right) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  const session = await context.newCDPSession(page);
  const move = (rect: typeof right) => session.send('Input.dispatchTouchEvent', {
    type: 'touchMove', touchPoints: [{ id: 1, ...point(rect) }, { id: 2, ...point(fire) }],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ id: 1, ...point(right) }, { id: 2, ...point(fire) }],
  });
  await expect.poll(async () => (await snapshot(page))!.tanks.find(tank => tank.playerIndex === 0)!.x).toBeGreaterThan(initialX);
  await expect.poll(async () => (await snapshot(page))!.bullets.filter(bullet => bullet.team === 'player').length).toBeGreaterThan(0);
  for (const neutral of [center, outside]) {
    await move(neutral);
    await expect(page.getByRole('button', { name: '向右', exact: true })).not.toHaveClass(/held/);
    await expect(page.getByRole('button', { name: '射击', exact: true })).toHaveClass(/held/);
    const stoppedX = (await snapshot(page))!.tanks.find(tank => tank.playerIndex === 0)!.x;
    await page.waitForTimeout(120);
    expect((await snapshot(page))!.tanks.find(tank => tank.playerIndex === 0)!.x).toBe(stoppedX);
    await move(right);
    await expect(page.getByRole('button', { name: '向右', exact: true })).toHaveClass(/held/);
    await expect.poll(async () => (await snapshot(page))!.tanks.find(tank => tank.playerIndex === 0)!.x).toBeGreaterThan(stoppedX);
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.getByRole('button', { name: '射击', exact: true })).not.toHaveClass(/held/);
});

test('both cooperative players can move and fire on the same keyboard', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Cooperative acceptance is desktop only.');
  await ready(page);
  await inputField(page, 'coop');
  await page.keyboard.down('d');
  await page.keyboard.down('ArrowLeft');
  await page.keyboard.down('j');
  await page.keyboard.down('Enter');
  await expect.poll(async () => {
    const state = (await snapshot(page))!;
    return {
      p1: state.tanks.find(tank => tank.playerIndex === 0)!.x > 32,
      p2: state.tanks.find(tank => tank.playerIndex === 1)!.x < 160,
      shooters: new Set(state.bullets.filter(bullet => bullet.team === 'player').map(bullet => bullet.playerIndex)).size,
    };
  }).toEqual({ p1: true, p2: true, shooters: 2 });
  for (const key of ['d', 'ArrowLeft', 'j', 'Enter']) await page.keyboard.up(key);
});

test('loss of focus pauses and releases held input until explicit resume', async ({ page }) => {
  await ready(page);
  await inputField(page);
  await page.keyboard.down('d');
  const paused = await page.evaluate(() => {
    window.dispatchEvent(new Event('blur'));
    return window.__BATTLECITY__!.state()!;
  });
  expect(paused.phase).toBe('paused');
  await page.waitForTimeout(1000);
  expect((await snapshot(page))!.tick).toBe(paused.tick);
  const resumed = await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[data-action="resume"]')!.click();
    const state = window.__BATTLECITY__!.state()!;
    return { tick: state.tick, x: state.tanks.find(tank => tank.playerIndex === 0)!.x, time: performance.now() };
  });
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => {
    const state = window.__BATTLECITY__!.state()!;
    return { tick: state.tick, x: state.tanks.find(tank => tank.playerIndex === 0)!.x, time: performance.now() };
  });
  expect(after.x).toBe(resumed.x);
  expect(after.tick - resumed.tick).toBeGreaterThan(0);
  expect(after.tick - resumed.tick).toBeLessThanOrEqual(Math.ceil((after.time - resumed.time) * 60.0988 / 1000) + 6);
  await page.keyboard.up('d');
});
