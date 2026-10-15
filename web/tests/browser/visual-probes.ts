import { expect, type Page } from '@playwright/test';
import { nativePixels, pixelsSHA256 } from './native-pixels';

interface Bounds { x: number; y: number; width: number; height: number }
export interface CanvasProbe {
  menu: boolean;
  stageSelect: 1 | 2 | null;
  battleStage: 1 | 2 | null;
  player: Bounds | null;
  bullet: boolean;
  editorOrigin: boolean;
  editorPaintCursor: boolean;
  halfSteel: boolean;
  pixelsSHA256: string;
}

/** Read actual compositor pixels; a WebGL canvas need not retain its buffer. */
export async function probeCanvas(page: Page): Promise<CanvasProbe> {
  const rgba = await nativePixels(page);
  const pixel = (x: number, y: number) => {
    const offset = (y * 256 + x) * 4;
    return (rgba[offset] << 16) | (rgba[offset + 1] << 8) | rgba[offset + 2];
  };
  const black = 0x000000, gray = 0x666666, white = 0xfcfcfc;
  const light = 0xadadad, yellow = 0xf8b800, olive = 0x687000;
  // Independent, small visual contracts for the stage counter and menu.
  const digits = {
    1: ['00001100','00011100','00001100','00001100','00001100','00001100','00111111','00000000'],
    2: ['00111110','01100011','00000111','00011110','00111100','01110000','01111111','00000000'],
  };
  const glyph = (rows: readonly string[], x: number, y: number, foreground: number, background: number) =>
    rows.every((row, py) => [...row].every((value, px) => pixel(x + px, y + py) === (value === '1' ? foreground : background)));
  const digit = (x: number, y: number) => ([1, 2] as const).find(value => glyph(digits[value], x, y, black, gray)) ?? null;
  const count = (x: number, y: number, width: number, height: number, color: number) => {
    let found = 0;
    for (let py = y; py < y + height; py++) for (let px = x; px < x + width; px++) found += Number(pixel(px, py) === color);
    return found;
  };
  const tank = (x: number, y: number, width: number, height: number): Bounds | null => {
    // Spawn stars and shields contain no olive pixels. Terrain and enemy
    // activity cannot enter these small player/cursor regions in this recipe.
    if (count(x, y, width, height, yellow) < 40 || count(x, y, width, height, olive) < 15) return null;
    let left = 256, top = 240, right = -1, bottom = -1;
    for (let py = y; py < y + height; py++) for (let px = x; px < x + width; px++) {
      if (pixel(px, py) !== yellow) continue;
      left = Math.min(left, px); top = Math.min(top, py);
      right = Math.max(right, px); bottom = Math.max(bottom, py);
    }
    return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
  };
  const grayBackground = pixel(0, 0) === gray && pixel(255, 0) === gray;
  const base = pixel(112, 209) === gray && pixel(113, 209) === gray && pixel(116, 209) === black && pixel(126, 209) === gray;
  const player = tank(76, 176, 24, 48);
  const battleStage = grayBackground && pixel(16, 16) === black && base && player ? digit(240, 200) : null;
  const stageSelect = grayBackground && pixel(16, 16) === gray && pixel(128, 64) === gray ? digit(148, 120) : null;
  const menu = pixel(0, 0) === black && glyph(digits[1], 88, 136, white, black) &&
    count(24, 48, 192, 32, 0xbc3410) > 100 && count(88, 184, 72, 8, 0xbc3410) > 100;
  let halfSteel = true;
  for (let y = 48; y < 64; y++) for (let x = 48; x < 64; x++) {
    const color = pixel(x, y);
    if (x < 56 ? color !== black : ![white, light, gray].includes(color)) halfSteel = false;
  }
  halfSteel &&= [white, light, gray].every(color => count(56, 48, 8, 16, color) > 0);
  // The upward bullet lies above the moved tank's shield, below enemy
  // activity, and inside Stage 2's empty column-four corridor.
  const bulletRows = ['.W..', 'WWW.', '.W..', '.D..'];
  let bullet = false;
  for (let y = 164; y <= 188; y++) for (let x = 84; x <= 88; x++) {
    if (bulletRows.every((row, py) => [...row].every((value, px) =>
      pixel(x + px, y + py) === (value === 'W' ? white : value === 'D' ? light : black)))) bullet = true;
  }
  return {
    menu, stageSelect, battleStage, player, bullet, halfSteel,
    editorOrigin: grayBackground && base && !!tank(16, 16, 16, 16),
    editorPaintCursor: grayBackground && base && !!tank(64, 48, 16, 16),
    pixelsSHA256: pixelsSHA256(rgba),
  };
}

/** One screenshot and PNG decode can exceed 5 seconds on software WebKit. */
export async function waitForCanvasMenu(page: Page): Promise<void> {
  await expect.poll(async () => (await probeCanvas(page)).menu, {
    timeout: 20000,
    message: 'The canvas must render the menu',
  }).toBe(true);
}

/** Controlled animation time with real keyboard events, including production. */
export async function readyCanvasWithClock(page: Page): Promise<CanvasProbe> {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('./');
  await page.bringToFront();
  await expect(page.locator('#game-canvas canvas')).toBeVisible();
  await waitForCanvasMenu(page);
  await page.clock.pauseAt(new Date('2026-01-01T01:00:00Z'));
  await page.clock.runFor(34);
  const frame = await probeCanvas(page);
  expect(frame.menu, 'The rendered menu must be ready before controller input').toBe(true);
  return frame;
}

export async function controllerKey(page: Page, key: string, duration = 34): Promise<void> {
  await page.keyboard.down(key);
  try { await page.clock.runFor(duration); }
  finally { await page.keyboard.up(key); }
  // Let the editor observe release before a repeated directional press.
  await page.clock.runFor(34);
}

export async function renderedStageTwo(page: Page): Promise<CanvasProbe> {
  await page.clock.runFor(2800);
  let frame = await probeCanvas(page);
  for (let elapsed = 2800; !frame.player && elapsed < 3500;) {
    const step = Math.min(250, 3500 - elapsed);
    await page.clock.runFor(step); elapsed += step;
    frame = await probeCanvas(page);
  }
  expect(frame.battleStage, 'STAGE 2 must open its battlefield, base, HUD and real player within 3500 ms').toBe(2);
  expect(frame.player).not.toBeNull();
  return frame;
}
