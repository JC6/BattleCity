import { expect, test } from '@playwright/test';

test('production entry, base path, single player and refresh work without errors', async ({ page, isMobile }) => {
  const errors: string[] = [];
  const failedAssets: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (new URL(response.url()).pathname.startsWith('/assets/') && response.status() >= 400) failedAssets.push(response.url());
  });
  await page.goto('./');
  expect(new URL(page.url()).pathname).toBe('/');
  const assetUrls = await page.locator('script[src], link[rel="stylesheet"][href], link[rel="modulepreload"][href]')
    .evaluateAll(elements => elements.map(element =>
      new URL(element.getAttribute('src') ?? element.getAttribute('href')!, document.baseURI).href));
  expect(assetUrls.length).toBeGreaterThan(0);
  expect(assetUrls.every(url => new URL(url).pathname.startsWith('/assets/'))).toBe(true);
  await expect(page).toHaveTitle('BattleCity · 坦克大战');
  await expect(page.locator('#game-canvas canvas')).toBeVisible();
  await expect(page.locator('#stage-select option')).toHaveCount(35);
  await page.getByRole('button', { name: /单人出击/ }).click();
  await expect(page.locator('.stage-intro')).toBeHidden({ timeout: 8000 });
  await expect(page.locator('#stage-label')).toHaveText('01');
  await page.locator('#pause').click();
  await expect(page.getByRole('heading', { name: '战斗暂停' })).toBeVisible();
  await page.getByRole('button', { name: /继续战斗/ }).click();
  await expect(page.getByRole('heading', { name: '战斗暂停' })).toBeHidden();
  if (isMobile) {
    await expect(page.getByRole('button', { name: '射击', exact: true })).toBeVisible();
    const sizes = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    expect(sizes.scroll).toBeLessThanOrEqual(sizes.width + 1);
  }
  if (process.env.BATTLECITY_PRODUCTION === '1') {
    expect(await page.evaluate(() => typeof window.__BATTLECITY__)).toBe('undefined');
    const scripts = await page.locator('script[src]').evaluateAll(elements => elements.map(element => (element as HTMLScriptElement).src));
    for (const script of scripts) {
      const javascript = await (await page.request.get(script)).text();
      expect(javascript).not.toMatch(/__BATTLECITY__|setEditorTile|getEditorTiles/);
    }
    const license = await page.request.get('LICENSE.txt');
    expect(license.ok()).toBe(true);
    expect(await license.text()).toContain('GNU GENERAL PUBLIC LICENSE');
    const notices = await page.request.get('THIRD_PARTY_NOTICES.md');
    expect(notices.ok()).toBe(true);
    expect(await notices.text()).toContain('Arnout Kazemier');
  }
  await page.reload();
  await expect(page.getByRole('button', { name: /单人出击/ })).toBeVisible();
  expect(errors).toEqual([]);
  expect(failedAssets).toEqual([]);
});

test('Construction opens and can start a custom battlefield', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: /地图编辑/ }).click();
  await expect(page.getByRole('button', { name: '绘制砖墙' })).toBeVisible();
  await page.getByRole('button', { name: /单人试玩/ }).click();
  await expect(page.locator('#machine-status')).toHaveText('CUSTOM BATTLE');
  await page.locator('#pause').click();
  await page.getByRole('button', { name: '返回编辑' }).click();
  await expect(page.getByRole('button', { name: '绘制钢墙' })).toBeVisible();
});

test('desktop cooperative play starts with two players', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Same-machine cooperative mode is a desktop acceptance target.');
  await page.goto('./');
  await page.getByRole('button', { name: /双人合作/ }).click();
  await expect(page.locator('#machine-status')).toHaveText('CO-OP MISSION');
  await expect(page.locator('#p2-score')).toHaveText('000000');
});

for (const size of [
  { name: 'short screen', width: 560, height: 320 },
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'phone portrait', width: 390, height: 844 },
]) {
  // Firefox fullscreen uses its real headless screen, configured before launch.
  const fullscreenTest = test.extend({
    launchOptions: {
      env: {
        ...process.env,
        MOZ_HEADLESS_WIDTH: String(size.width),
        MOZ_HEADLESS_HEIGHT: String(size.height),
      },
    },
  });
  fullscreenTest.describe(`native fullscreen on ${size.name}`, () => {
    const viewport = { width: size.width, height: size.height };
    fullscreenTest.use({ viewport, contextOptions: { screen: viewport } });

    fullscreenTest('keeps the canvas ratio, reaches controls and paints editor coordinates', async ({ page, isMobile, browserName }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      // Desktop Firefox's native window cannot be narrower than 500px.
      // Mobile-capable projects retain the 390px portrait viewport.
      const actualViewport = browserName === 'firefox' && size.name === 'phone portrait'
        ? { ...viewport, width: 500 } : viewport;
      if (actualViewport !== viewport) await page.setViewportSize(actualViewport);
      await page.goto('./');
      const supported = await page.evaluate(() => document.fullscreenEnabled &&
        typeof document.querySelector<HTMLElement>('.arcade')?.requestFullscreen === 'function');
      fullscreenTest.skip(!supported, 'Native Fullscreen API is unavailable or disabled in this browser context.');

      const canvas = page.locator('#game-canvas canvas');
      const fullscreen = page.locator('#fullscreen');
      const touch = isMobile && browserName === 'chromium';
      const expectRatio = async () => {
        await expect.poll(async () => {
          const box = await canvas.boundingBox();
          return box && box.height > 0 ? Math.abs(box.width / box.height - 256 / 240) : Infinity;
        }).toBeLessThan(0.01);
      };
      const paintImmediately = (action: 'editor' | 'edit-return' | null, tile: number, resizeDuringDrag = false, touch = false) =>
        page.evaluate(({ action, tile, resizeDuringDrag, touch }) => {
          // UI changes and input share one task, before Phaser's next bounds poll.
          if (action) document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.click();
          document.querySelector<HTMLButtonElement>(`[data-action="brush-${tile}"]`)!.click();
          const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas canvas')!;
          const wrap = document.querySelector<HTMLElement>('.screen-wrap')!;
          canvas.scrollIntoView({ block: 'center' });
          const originalWidth = wrap.style.width;
          const pointer = (type: 'down' | 'move' | 'up', logicalX: number) => {
            const box = canvas.getBoundingClientRect();
            const clientX = box.x + logicalX / 256 * box.width;
            const clientY = box.y + 88 / 240 * box.height;
            if (touch) {
              const point = new Touch({
                identifier: 1, target: canvas, clientX, clientY,
                pageX: clientX + scrollX, pageY: clientY + scrollY,
              });
              canvas.dispatchEvent(new TouchEvent(type === 'down' ? 'touchstart' : type === 'move' ? 'touchmove' : 'touchend', {
                bubbles: true, cancelable: true, changedTouches: [point],
                touches: type === 'up' ? [] : [point], targetTouches: type === 'up' ? [] : [point],
              }));
            } else {
              canvas.dispatchEvent(new MouseEvent(`mouse${type}`, {
                bubbles: true, cancelable: true, clientX, clientY, button: 0, buttons: type === 'up' ? 0 : 1,
              }));
            }
          };
          try {
            pointer('down', 80);
            if (resizeDuringDrag) {
              wrap.style.width = '50%';
              pointer('move', 112);
            }
            const map = JSON.parse(localStorage.getItem('battlecity.web.v1') ?? '{}').map;
            return (resizeDuringDrag ? [8, 12] : [8]).map(x =>
              [8 * 26 + x, 8 * 26 + x + 1, 9 * 26 + x, 9 * 26 + x + 1].map(index => map?.[index]));
          } finally {
            pointer('up', resizeDuringDrag ? 112 : 80);
            wrap.style.width = originalWidth;
          }
        }, { action, tile, resizeDuringDrag, touch });
      await expect(canvas).toBeVisible();
      await fullscreen.click();
      // Fullscreen and viewport resizing share the previous two 5s polling budgets.
      await expect.poll(() => page.evaluate(() => ({
        fullscreen: document.fullscreenElement === document.querySelector('.arcade'),
        width: innerWidth,
        height: innerHeight,
      })), { timeout: 10_000 }).toEqual({ fullscreen: true, ...actualViewport });
      await expectRatio();

      expect(await paintImmediately('editor', 2, false, touch)).toEqual([[2, 2, 2, 2]]);
      const water = page.getByRole('button', { name: '绘制水面' });
      await water.scrollIntoViewIfNeeded();
      await expect(water).toBeInViewport();
      await water.click();
      await canvas.scrollIntoViewIfNeeded();
      await expectRatio();
      const box = (await canvas.boundingBox())!;
      // Original canvas offset (8,16), then macro-block (4,4)'s center.
      await page.mouse.click(box.x + 80 / 256 * box.width, box.y + 88 / 240 * box.height);
      await expect.poll(() => page.evaluate(() => {
        const map = JSON.parse(localStorage.getItem('battlecity.web.v1') ?? '{}').map;
        return [8 * 26 + 8, 8 * 26 + 9, 9 * 26 + 8, 9 * 26 + 9].map(index => map?.[index]);
      })).toEqual([3, 3, 3, 3]);

      const play = page.getByRole('button', { name: /单人试玩/ });
      await play.scrollIntoViewIfNeeded();
      await expect(play).toBeInViewport();
      await play.click();
      await expect(page.locator('#machine-status')).toHaveText('CUSTOM BATTLE');
      await expectRatio();
      if (isMobile || size.width <= 780) {
        const fire = page.getByRole('button', { name: '射击', exact: true });
        await expect(fire).toBeVisible();
        await fire.scrollIntoViewIfNeeded();
        await expect(fire).toBeInViewport();
        if (isMobile) await fire.tap();
        else await fire.click();
      }
      const pause = page.locator('#pause');
      await pause.scrollIntoViewIfNeeded();
      await pause.click();
      await expect(page.getByRole('heading', { name: '战斗暂停' })).toBeVisible();

      expect(await paintImmediately('edit-return', 4, false, touch)).toEqual([[4, 4, 4, 4]]);
      if (size.name === 'desktop') {
        // Hold the pointer across another layout change to exercise move events.
        expect(await paintImmediately(null, 5, true, touch)).toEqual([[5, 5, 5, 5], [5, 5, 5, 5]]);
      }

      await fullscreen.scrollIntoViewIfNeeded();
      await fullscreen.click();
      await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
      await expectRatio();
      expect(errors).toEqual([]);
    });
  });
}
