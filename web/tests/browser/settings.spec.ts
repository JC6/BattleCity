import { expect, test } from '@playwright/test';
import { begin, ready } from './helpers';

const KEY = 'battlecity.web.v1';

for (const exit of ['menu', 'pagehide'] as const) {
  test(`high scores survive ${exit} before the next HUD refresh`, async ({ page }) => {
    await ready(page);
    await begin(page);
    await page.evaluate(() => {
      const api = window.__BATTLECITY__!;
      const players = api.state()!.players;
      players[0].score = 34500;
      api.debug({ players });
    });
    await expect(page.locator('#high-score')).toHaveText('034500');
    // The score change, storage checks and exit share one task, so no HUD
    // refresh can save the record before the lifecycle path being tested.
    const saved = await page.evaluate(({ key, exit }) => {
      const api = window.__BATTLECITY__!;
      const players = api.state()!.players;
      players[0].score = 45600;
      api.debug({ players });
      const before = JSON.parse(localStorage.getItem(key)!).highScore;
      if (exit === 'menu') document.querySelector<HTMLAnchorElement>('.brand')!.click();
      else window.dispatchEvent(new Event('pagehide'));
      const after = JSON.parse(localStorage.getItem(key)!).highScore;
      return { before, after };
    }, { key: KEY, exit });
    expect(saved).toEqual({ before: 34500, after: 45600 });
    await page.reload();
    await expect(page.locator('#high-score')).toHaveText('045600');
    await expect(page.getByRole('button', { name: /单人出击/ })).toBeVisible();
  });
}

test('sound preference survives refresh', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: '关闭声音', exact: true }).click();
  await expect(page.getByRole('button', { name: '开启声音', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '开启声音', exact: true })).toBeVisible();
});

test('disabled browser storage does not prevent playing or editing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage unavailable'); } });
  });
  await ready(page);
  await page.getByRole('button', { name: /地图编辑/ }).click();
  await page.getByRole('button', { name: '绘制树林' }).click();
  const canvas = page.locator('#game-canvas canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + 76 / 256 * box.width, box.y + 84 / 240 * box.height);
  const painted = [216, 217, 242, 243];
  await expect.poll(() => page.evaluate(indices => {
    const draft = window.__BATTLECITY__!.getEditorTiles();
    return indices.map(index => draft[index]);
  }, painted)).toEqual([4, 4, 4, 4]);
  await page.getByRole('button', { name: /单人试玩/ }).click();
  await expect(page.locator('#machine-status')).toHaveText('CUSTOM BATTLE');
  expect(await page.evaluate(indices => {
    const tiles = window.__BATTLECITY__!.state()!.tiles;
    return indices.map(index => tiles[index]);
  }, painted)).toEqual([4, 4, 4, 4]);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '返回编辑', exact: true }).click();
  expect(await page.evaluate(indices => {
    const draft = window.__BATTLECITY__!.getEditorTiles();
    return indices.map(index => draft[index]);
  }, painted)).toEqual([4, 4, 4, 4]);
  expect(errors).toEqual([]);
});

test('malformed stored JSON can be repaired and survive a new page load', async ({ page }) => {
  await ready(page);
  await page.evaluate(key => localStorage.setItem(key, '{broken'), KEY);
  await page.reload();
  await page.waitForFunction(() => !!window.__BATTLECITY__);
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    api.openEditor();
    api.setEditorTile(270, 2);
    api.start('single', 1);
    const players = api.state()!.players;
    players[0].score = 34500;
    api.debug({ players });
  });
  await expect(page.locator('#high-score')).toHaveText('034500');
  await page.getByRole('button', { name: '关闭声音', exact: true }).click();
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), KEY);
  expect(saved).toMatchObject({ highScore: 34500, volume: 0 });
  expect(saved.map[270]).toBe(2);
  await page.reload();
  await expect(page.locator('#high-score')).toHaveText('034500');
  await expect(page.getByRole('button', { name: '开启声音', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__BATTLECITY__!.getEditorTiles()[270])).toBe(2);
});

test('cross-tab sound updates immediately while the higher score and active editor draft stay separate', async ({ page, context }) => {
  await page.addInitScript(key => {
    const probe = { masterGain: null as GainNode | null, scheduledGain: null as number | null, resumes: 0, writes: 0 };
    const createGain = AudioContext.prototype.createGain;
    AudioContext.prototype.createGain = function () {
      const gain = createGain.call(this);
      if (!probe.masterGain) probe.masterGain = gain;
      return gain;
    };
    const schedule = AudioParam.prototype.setValueAtTime;
    AudioParam.prototype.setValueAtTime = function (value, time) {
      const result = schedule.call(this, value, time);
      if (this === probe.masterGain?.gain) probe.scheduledGain = value;
      return result;
    };
    const resume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function () {
      probe.resumes++;
      return resume.call(this);
    };
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (requested, value) {
      if (requested === key) probe.writes++;
      return setItem.call(this, requested, value);
    };
    Object.defineProperty(window, '__soundProbe', { value: () => {
      const gain = probe.masterGain?.gain.value ?? null;
      const audioState = probe.masterGain?.context.state ?? null;
      return {
        gain, audioState, scheduledGain: probe.scheduledGain,
        // Suspended contexts accept automation while their audio clock is stopped.
        checkedGain: audioState === 'suspended' ? probe.scheduledGain : gain,
        resumes: probe.resumes, writes: probe.writes,
        label: document.querySelector('#sound-toggle')?.getAttribute('aria-label'),
        pressed: document.querySelector('#sound-toggle')?.getAttribute('aria-pressed'),
        highScore: document.querySelector('#high-score')?.textContent,
        draft: window.__BATTLECITY__?.getEditorTiles()[270],
      };
    } });
  }, KEY);
  await ready(page);
  await page.getByRole('button', { name: /地图编辑/ }).click();
  await page.evaluate(() => window.__BATTLECITY__!.setEditorTile(270, 2));
  const baseline = await page.evaluate(() => Reflect.get(window, '__soundProbe')());
  expect(baseline.gain).toBeCloseTo(0.3 * 0.13, 6);
  const other = await context.newPage();
  await other.goto(page.url());
  for (const [highScore, volume] of [[50000, 0], [30000, 0.8], [30000, 0]]) {
    await other.evaluate(({ key, highScore, volume }) => {
      localStorage.setItem(key, JSON.stringify({ highScore, volume, map: Array(676).fill(4) }));
    }, { key: KEY, highScore, volume });
    await expect.poll(() => page.evaluate(() => Reflect.get(window, '__soundProbe')())).toMatchObject({
      label: volume ? '关闭声音' : '开启声音', pressed: String(!!volume),
      audioState: expect.stringMatching(/^(running|suspended)$/),
      scheduledGain: expect.closeTo(volume * 0.13, 6), checkedGain: expect.closeTo(volume * 0.13, 6),
      highScore: '050000', draft: 2,
      resumes: baseline.resumes, writes: baseline.writes,
    });
  }
  await page.locator('#sound-toggle').click();
  await expect.poll(() => page.evaluate(key => {
    const saved = JSON.parse(localStorage.getItem(key)!);
    return { ...Reflect.get(window, '__soundProbe')(), saved: {
      highScore: saved.highScore, volume: saved.volume, mapTile: saved.map[270],
    } };
  }, KEY)).toMatchObject({
    label: '关闭声音', pressed: 'true', audioState: expect.stringMatching(/^(running|suspended)$/),
    scheduledGain: expect.closeTo(0.8 * 0.13, 6), checkedGain: expect.closeTo(0.8 * 0.13, 6),
    highScore: '050000', draft: 2, saved: { highScore: 50000, volume: 0.8, mapTile: 4 },
  });
  await other.close();
});

test('normal HUD refreshes read cached scores while a new record still persists', async ({ page }) => {
  await ready(page);
  await begin(page);
  const initialTick = await page.evaluate(key => {
    const api = window.__BATTLECITY__!;
    const state = api.state()!;
    api.debug({ tanks: state.tanks.filter(tank => tank.team === 'player'), spawned: 20, bullets: [] });
    const reads = { count: 0 };
    Object.assign(window, { __preferenceReads: reads });
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function (requested: string): string | null {
      if (requested === key) reads.count++;
      return original.call(this, requested);
    };
    return state.tick;
  }, KEY);
  await page.waitForFunction(tick => window.__BATTLECITY__!.state()!.tick >= tick + 32, initialTick);
  expect(await page.evaluate(() => (window as typeof window & { __preferenceReads: { count: number } }).__preferenceReads.count)).toBe(0);
  await page.evaluate(() => {
    const api = window.__BATTLECITY__!;
    const players = api.state()!.players;
    players[0].score = 34500;
    api.debug({ players });
  });
  await expect(page.locator('#high-score')).toHaveText('034500');
  const result = await page.evaluate(key => ({
    reads: (window as typeof window & { __preferenceReads: { count: number } }).__preferenceReads.count,
    saved: JSON.parse(localStorage.getItem(key)!),
  }), KEY);
  expect(result.reads).toBe(1);
  expect(result.saved.highScore).toBe(34500);
});
