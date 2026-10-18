import { createHash } from 'node:crypto';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { nativePixels } from './native-pixels';

interface Cursor { column: number; row: number }
type Signature = [number, number, number, number];
export interface ConstructionInspection {
  cursor: Cursor | null;
  cursorCandidates: (Cursor & { yellow: number; olive: number })[];
  signature: Signature | null;
  steelRows: number[];
  rows: { row: number; colors: number[]; counts: Record<string, number>; steel: boolean }[];
}
const steelPalette = [0x666666, 0xadadad, 0xfcfcfc];
const signatures = {
  0: [0x000000, 0xa05000, 0x000000, 0xadadad],
  13: [0, 0, 0, 0],
  12: [0xb3b3b3, 0xb3b3b3, 0xb3b3b3, 0xb3b3b3],
  11: [0x004e0f, 0x004e0f, 0x8ac900, 0x8ac900],
  10: [0x4854ff, 0x4854ff, 0x4854ff, 0x4854ff],
  9: [0xadadad, 0xadadad, 0x666666, 0x666666],
} as const;

/** One native screenshot supplies cursor, uncovered block pixels and the strict wall check. */
export function inspectConstruction(rgba: Uint8Array): ConstructionInspection {
  if (rgba.length !== 256 * 240 * 4) throw new Error('Construction inspection requires native 256×240 RGBA');
  const pixel = (x: number, y: number) => {
    const offset = (y * 256 + x) * 4;
    return (rgba[offset] << 16) | (rgba[offset + 1] << 8) | rgba[offset + 2];
  };
  const cursorCandidates: ConstructionInspection['cursorCandidates'] = [];
  for (let row = 0; row < 13; row++) for (let column = 0; column < 13; column++) {
    let yellow = 0, olive = 0;
    for (let y = 16 + row * 16; y < 32 + row * 16; y++) for (let x = 16 + column * 16; x < 32 + column * 16; x++) {
      const color = pixel(x, y);
      yellow += Number(color === 0xf8b800); olive += Number(color === 0x687000);
    }
    if (yellow >= 40 && olive >= 15) cursorCandidates.push({ column, row, yellow, olive });
  }
  const cursor = cursorCandidates.length === 1
    ? { column: cursorCandidates[0].column, row: cursorCandidates[0].row } : null;
  let signature: Signature | null = null;
  if (cursor) {
    const x = 16 + cursor.column * 16, y = 16 + cursor.row * 16;
    // The fixed upward editor cursor leaves its first and last rows transparent.
    signature = [pixel(x + 1, y), pixel(x + 9, y), pixel(x + 1, y + 15), pixel(x + 9, y + 15)];
  }
  const rows: ConstructionInspection['rows'] = [];
  for (let row = 1; row <= 5; row++) {
    const counts: Record<string, number> = {};
    for (let y = 16 + row * 16; y < 32 + row * 16; y++) for (let x = 16; x < 224; x++) {
      const color = pixel(x, y).toString(16).padStart(6, '0');
      counts[color] = (counts[color] ?? 0) + 1;
    }
    const colors = Object.keys(counts).map(color => Number.parseInt(color, 16)).sort((a, b) => a - b);
    const steel = colors.length === steelPalette.length && colors.every((color, index) => color === steelPalette[index]);
    rows.push({ row, colors, counts, steel });
  }
  return { cursor, cursorCandidates, signature, steelRows: rows.filter(row => row.steel).map(row => row.row), rows };
}

/** Prepare the real-keyboard audio fixture without advancing or replacing either native clock. */
export async function protectedBattlefield(page: Page, testInfo: TestInfo): Promise<void> {
  let lastRgba: Buffer | undefined, last: ConstructionInspection | undefined;
  let phase = 'enter Construction', expected: unknown, barrierRow: number | undefined;
  let failed = false, failure: unknown, cleanupError: unknown;
  const held = new Set<string>();
  const press = async (key: string, delay?: number) => {
    held.add(key); await page.keyboard.press(key, delay === undefined ? {} : { delay }); held.delete(key);
  };
  const release = async (key: string) => {
    if (!held.has(key)) return;
    try { await page.keyboard.up(key); held.delete(key); }
    catch (error) { cleanupError ??= error; }
  };
  const wait = async (message: string, predicate: (inspection: ConstructionInspection) => boolean) => {
    phase = message;
    let active = true;
    try {
      await expect.poll(async () => {
        const rgba = await nativePixels(page);
        // A deadline does not cancel a pending screenshot. A late result must
        // not replace the exact frame retained for failure attachments.
        if (!active) return false;
        lastRgba = rgba; last = undefined;
        last = inspectConstruction(rgba);
        return predicate(last);
      }, { timeout: 20000, message }).toBe(true);
    } finally { active = false; }
    return last!;
  };
  const matches = (inspection: ConstructionInspection, code: keyof typeof signatures) =>
    inspection.signature?.every((color, index) => color === signatures[code][index]) === true;
  try {
    await press('ShiftRight'); await press('ShiftRight'); await press('Enter');
    expected = { column: 0, row: 0 };
    await wait('Construction must render its initial cursor before moving down', value =>
      value.cursor?.column === 0 && value.cursor.row === 0);
    phase = 'move Construction cursor down';
    expected = { column: 0, row: '1..5' };
    for (let row = 0; row < 5; row++) {
      await press('s', 34);
      await page.evaluate(ms => new Promise<void>(resolve => setTimeout(resolve, ms)), 34);
    }
    for (const code of [0, 13, 12, 11, 10] as const) {
      expected = { column: 0, row: barrierRow ?? '1..5', code, signature: signatures[code] };
      held.add('k'); await page.keyboard.down('k');
      const inspection = await wait(`Construction block ${code} must be committed before the next B press`, value =>
        value.cursor?.column === 0 && value.cursor.row >= 1 && value.cursor.row <= 5 &&
        (barrierRow === undefined || value.cursor.row === barrierRow) && matches(value, code));
      barrierRow ??= inspection.cursor!.row;
      await page.keyboard.up('k'); held.delete('k');
    }
    held.add('k'); await page.keyboard.down('k');
    try {
      expected = { column: 0, row: barrierRow, code: 9, signature: signatures[9] };
      await wait('Construction must commit full steel before moving right', value =>
        value.cursor?.column === 0 && value.cursor.row === barrierRow && matches(value, 9));
      held.add('d'); await page.keyboard.down('d');
      expected = { column: 12, row: barrierRow, code: 9, signature: signatures[9] };
      await wait('Construction must paint full steel through its clamped right edge', value =>
        value.cursor?.column === 12 && value.cursor.row === barrierRow && matches(value, 9));
    } finally { await Promise.allSettled([release('d'), release('k')]); }
    if (cleanupError) throw cleanupError;
    await press('Enter');
    await press('ShiftRight'); await press('ShiftRight'); await press('Enter');
    expected = { column: 0, row: 0 };
    await wait('Construction must render its reset cursor before inspecting the wall', value =>
      value.cursor?.column === 0 && value.cursor.row === 0);
    phase = 'verify continuous full steel barrier';
    expected = { steelRows: 1, palette: steelPalette };
    expect(last!.steelRows, 'Construction must create one continuous full steel barrier in the upper battlefield').toHaveLength(1);
    await press('Enter');
  } catch (error) { failed = true; failure = error; }
  finally { await Promise.allSettled([...held].map(release)); }
  if (!failed && cleanupError) { failed = true; failure = cleanupError; }
  if (failed) {
    const error = failure instanceof Error
      ? { name: failure.name, message: failure.message, stack: failure.stack } : { name: 'Error', message: String(failure) };
    const pixelsSHA256 = lastRgba ? createHash('sha256').update(lastRgba).digest('hex') : null;
    try {
      if (lastRgba) await testInfo.attach('construction-fixture-rgba', {
        contentType: 'application/octet-stream', body: lastRgba,
      });
    } catch { /* Preserve the fixture failure if attaching its evidence fails. */ }
    try {
      await testInfo.attach('construction-fixture-failure', {
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify({ phase, expected, barrierRow, width: 256, height: 240, pixelsSHA256,
          observation: last ?? null, error }, null, 2)),
      });
    } catch { /* Preserve the fixture failure if attaching its evidence fails. */ }
    throw failure;
  }
}
