import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page, TestInfo } from '@playwright/test';
import { BRICK_TILES, FOREST, ICE, PLAYER, STEEL, WATER, drawBitmap, type PixelSurface } from '../../src/game/pixel-assets';
import { inspectConstruction, protectedBattlefield } from '../browser/construction-fixture';
import { nativePixels, pixelsSHA256 } from '../browser/native-pixels';

const pollControl = vi.hoisted(() => ({ expire: false, lateRead: undefined as Promise<unknown> | undefined }));

vi.mock('../browser/native-pixels', async importOriginal => {
  const original = await importOriginal<typeof import('../browser/native-pixels')>();
  return { ...original, nativePixels: vi.fn() };
});
vi.mock('@playwright/test', async () => {
  const { expect } = await import('vitest');
  return { expect: Object.assign((value: unknown, message?: string) => expect(value, message), {
    poll: (read: () => Promise<unknown>, options: { timeout: number; message?: string }) => ({
      async toBe(expected: unknown) {
        expect(options.timeout).toBe(20000);
        // Supply controlled rendered frames without spending a real twenty seconds
        // on each intentionally stalled observation.
        for (let attempt = 0; attempt < 20; attempt++) {
          const reading = read();
          if (pollControl.expire) {
            pollControl.expire = false; pollControl.lateRead = reading;
            throw new Error(options.message ?? 'Construction observation expired');
          }
          if (await reading === expected) return;
        }
        throw new Error(options.message ?? 'Construction observation did not advance');
      },
    }),
  }) };
});

interface Cursor { column: number; row: number }
const origin = { column: 0, row: 0 }, start = { column: 0, row: 5 }, end = { column: 12, row: 5 };

/** Render terrain and the actual opaque cursor over an independent native surface. */
function picture(cursor: Cursor | null, code = 13, wallColumns = 0, waterPhase = 0): Buffer {
  const rgba = Buffer.alloc(256 * 240 * 4);
  for (let offset = 3; offset < rgba.length; offset += 4) rgba[offset] = 255;
  let color = 0;
  const surface: PixelSurface = {
    fillStyle(value: number) { color = value; return this; },
    fillRect(x: number, y: number, width: number, height: number) {
      for (let py = y; py < y + height; py++) for (let px = x; px < x + width; px++) {
        const offset = (py * 256 + px) * 4;
        rgba[offset] = color >>> 16; rgba[offset + 1] = color >>> 8 & 255; rgba[offset + 2] = color & 255;
      }
      return this;
    },
  };
  const steel = (column: number, row: number) => {
    for (const [dx, dy] of [[0, 0], [8, 0], [0, 8], [8, 8]]) {
      drawBitmap(surface, STEEL, 16 + column * 16 + dx, 16 + row * 16 + dy,
        { L: 0xadadad, D: 0x666666, W: 0xfcfcfc });
    }
  };
  for (let column = 0; column < wallColumns; column++) steel(column, 5);
  if (cursor) {
    const x = 16 + cursor.column * 16, y = 16 + cursor.row * 16;
    if (code === 9) steel(cursor.column, cursor.row);
    else if (code === 0) {
      for (const dy of [0, 8]) drawBitmap(surface, BRICK_TILES[15], x + 8, y + dy,
        { M: 0xadadad, D: 0x801000, B: 0xa05000 });
    } else if (code !== 13) {
      const [bitmap, colors] = code === 10 ? [WATER[waterPhase], { B: 0x4854ff, W: 0xa5dfb6 }]
        : code === 11 ? [FOREST, { D: 0x004e0f, L: 0x8ac900 }] : [ICE, { G: 0xb3b3b3, W: 0xf3f2f3 }];
      for (const [dx, dy] of [[0, 0], [8, 0], [0, 8], [8, 8]]) {
        drawBitmap(surface, bitmap, x + dx, y + dy, colors);
      }
    }
    drawBitmap(surface, PLAYER, x, y, { Y: 0xf8b800, D: 0x687000 });
  }
  return rgba;
}

beforeEach(() => { vi.mocked(nativePixels).mockReset(); pollControl.expire = false; pollControl.lateRead = undefined; });

describe('Construction compositor observations', () => {
  it.each([
    [0, [0, 0xa05000, 0, 0xadadad]],
    [13, [0, 0, 0, 0]],
    [12, [0xb3b3b3, 0xb3b3b3, 0xb3b3b3, 0xb3b3b3]],
    [11, [0x004e0f, 0x004e0f, 0x8ac900, 0x8ac900]],
    [10, [0x4854ff, 0x4854ff, 0x4854ff, 0x4854ff]],
    [9, [0xadadad, 0xadadad, 0x666666, 0x666666]],
  ] as const)('reads code %i at the transparent cursor edges', (code, signature) => {
    const result = inspectConstruction(picture(start, code));
    expect(result.cursor).toEqual(start);
    expect(result.signature).toEqual(signature);
  });

  it('keeps both animated water frames distinct from steel', () => {
    expect(inspectConstruction(picture(end, 10, 0, 0)).signature)
      .toEqual(inspectConstruction(picture(end, 10, 0, 1)).signature);
    expect(inspectConstruction(picture(end, 10, 0, 1)).signature)
      .not.toEqual(inspectConstruction(picture(end, 9)).signature);
  });

  it('requires one cursor, rejecting a missing cursor and two plausible cursors', () => {
    expect(inspectConstruction(picture(null)).cursor).toBeNull();
    const rgba = picture(start), second = picture(end);
    for (let offset = 0; offset < rgba.length; offset += 4) {
      const color = (second[offset] << 16) | (second[offset + 1] << 8) | second[offset + 2];
      if (color === 0xf8b800 || color === 0x687000) second.copy(rgba, offset, offset, offset + 4);
    }
    const result = inspectConstruction(rgba);
    expect(result.cursor).toBeNull(); expect(result.signature).toBeNull();
    expect(result.cursorCandidates).toHaveLength(2);
  });

  it('retains the full row check instead of substituting cursor corner samples', () => {
    const partial = inspectConstruction(picture(end, 9, 11));
    expect(partial.cursor).toEqual(end); expect(partial.signature).toEqual([0xadadad, 0xadadad, 0x666666, 0x666666]);
    expect(partial.steelRows).toEqual([]);
    expect(inspectConstruction(picture(origin, 13, 13)).steelRows).toEqual([5]);
    expect(inspectConstruction(picture(end, 9, 13)).steelRows).toEqual([]);
    const gap = picture(origin, 13, 13);
    gap.fill(0, ((16 + 5 * 16 + 4) * 256 + 80) * 4, ((16 + 5 * 16 + 4) * 256 + 80) * 4 + 3);
    expect(inspectConstruction(gap).steelRows).toEqual([]);
  });
});

function keyboardFixture(options: { failPainting?: boolean; missingWall?: boolean; releaseError?: boolean;
  attachError?: boolean; unmovedCursor?: boolean; stalledSteel?: boolean; latePaintingRead?: boolean;
  stalledEntry?: boolean; failMovement?: boolean } = {}) {
  const events: string[] = [], held = new Set<string>();
  // Fixture buffers are immutable. Repeated stalled observations need only one
  // diagnostic scan here; protectedBattlefield still analyzes every real read.
  const inspections = new WeakMap<Buffer, ReturnType<typeof inspectConstruction>>();
  const inspectFixture = (rgba: Buffer) => {
    let value = inspections.get(rgba);
    if (!value) { value = inspectConstruction(rgba); inspections.set(rgba, value); }
    return value;
  };
  const initialPixels = picture(origin);
  let entered = 0, selected = 0, last = picture(null), pending: Buffer[] = [], pendingCode = false;
  let failurePixels: Buffer | undefined;
  const captureError = new Error('compositor read failed');
  const movementError = new Error('first direction dispatch failed');
  let finishLateRead: ((rgba: Buffer) => void) | undefined;
  const page = {
    keyboard: {
      press: vi.fn(async (key: string) => {
        events.push(`press:${key}`);
        if (key === 's' && options.failMovement) {
          held.add(key); throw movementError;
        }
        if (key === 'Enter') {
          entered++;
          if (entered === 1) pending = [last, options.stalledEntry ? picture(start) : initialPixels];
          if (entered === 3) pending = [last, picture(origin, 13, options.missingWall ? 12 : 13)];
        }
      }),
      down: vi.fn(async (key: string) => {
        held.add(key); events.push(`down:${key}`);
        if (key === 'k') {
          const code = [0, 13, 12, 11, 10, 9][selected];
          pending = [last, picture(options.unmovedCursor ? origin : start, code === 9 && options.stalledSteel ? 10 : code)];
          pendingCode = true;
        } else if (key === 'd') {
          expect(inspectFixture(last).signature).toEqual([0xadadad, 0xadadad, 0x666666, 0x666666]);
          pending = [picture({ column: 11, row: 5 }, 9, 12), picture(end, 9, 13)];
        }
      }),
      up: vi.fn(async (key: string) => {
        held.delete(key); events.push(`up:${key}`);
        if ((key === 'd' || key === 's') && options.releaseError) throw new Error('keyboard release failed');
      }),
    },
    evaluate: vi.fn(async () => {}),
  };
  vi.mocked(nativePixels).mockImplementation(async () => {
    if (held.has('d') && options.latePaintingRead && pending.length === 1) {
      failurePixels = last; pollControl.expire = true;
      return new Promise<Buffer>(resolve => { finishLateRead = resolve; });
    }
    if (held.has('d') && options.failPainting && pending.length === 1) {
      failurePixels = last;
      throw captureError;
    }
    if (pendingCode && pending.length === 1) { selected++; pendingCode = false; }
    last = pending.shift() ?? last;
    const frame = inspectFixture(last);
    events.push(`frame:${frame.cursor?.column}:${frame.cursor?.row}:${frame.signature?.join(',')}`);
    return last;
  });
  const attach = vi.fn(async (_name: string, attachment: { body: Buffer; contentType: string }) => {
    if (options.attachError) throw new Error('artifact attachment failed');
    if (attachment.contentType === 'application/octet-stream' && finishLateRead) {
      finishLateRead(picture(origin, 13, 13));
      await pollControl.lateRead;
    }
  });
  return { page: page as unknown as Page, testInfo: { attach } as unknown as TestInfo,
    attach, held, events, captureError, movementError, initialPixels, failurePixels: () => failurePixels };
}

describe('Construction keyboard preparation', { timeout: 15000 }, () => {
  it('awaits the initial cursor before moving, each actual block and the right edge, and the reset cursor after re-entry', async () => {
    const fixture = keyboardFixture();
    await protectedBattlefield(fixture.page, fixture.testInfo);
    const initial = fixture.events.indexOf('frame:0:0:0,0,0,0');
    expect(initial).toBeGreaterThan(fixture.events.indexOf('press:Enter'));
    expect(fixture.events.indexOf('press:s')).toBeGreaterThan(initial);
    expect(fixture.events.filter(event => event === 'press:s')).toHaveLength(5);
    expect(fixture.page.keyboard.press).toHaveBeenCalledWith('s', { delay: 34 });
    expect(fixture.page.evaluate).toHaveBeenCalledTimes(5);
    expect(fixture.page.keyboard.down).toHaveBeenCalledTimes(7);
    expect(fixture.events.filter(event => event === 'down:k')).toHaveLength(6);
    const steel = fixture.events.indexOf(`frame:0:5:${[0xadadad, 0xadadad, 0x666666, 0x666666].join(',')}`);
    expect(steel).toBeGreaterThan(0); expect(fixture.events.indexOf('down:d')).toBeGreaterThan(steel);
    expect(fixture.events.indexOf('up:d')).toBeGreaterThan(fixture.events.findIndex(event => event.startsWith('frame:12:5:')));
    expect(fixture.events.at(-1)).toBe('press:Enter');
    expect(fixture.held.size).toBe(0); expect(fixture.attach).not.toHaveBeenCalled();
  });

  it('does not move or paint when the initial origin cursor never renders', async () => {
    const fixture = keyboardFixture({ stalledEntry: true });
    await expect(protectedBattlefield(fixture.page, fixture.testInfo)).rejects.toThrow(/initial cursor before moving down/);
    expect(fixture.events).not.toContain('press:s');
    expect(fixture.page.keyboard.down).not.toHaveBeenCalled();
    expect(fixture.page.evaluate).not.toHaveBeenCalled();
    expect(fixture.held.size).toBe(0); expect(fixture.attach).toHaveBeenCalled();
  });

  it.each([false, true])('retains the confirmed initial frame and first movement error (cleanup failure: %s)', async releaseError => {
    const fixture = keyboardFixture({ failMovement: true, releaseError });
    await expect(protectedBattlefield(fixture.page, fixture.testInfo)).rejects.toBe(fixture.movementError);
    expect(fixture.events.filter(event => event === 'press:s')).toHaveLength(1);
    expect(fixture.page.keyboard.up).toHaveBeenCalledWith('s');
    expect(fixture.page.keyboard.down).not.toHaveBeenCalled();
    expect(fixture.page.evaluate).not.toHaveBeenCalled();
    expect(fixture.held.size).toBe(0);
    const attachments = fixture.attach.mock.calls.map(([, attachment]) => attachment);
    expect(attachments.find(value => value.contentType === 'application/octet-stream')?.body.equals(fixture.initialPixels)).toBe(true);
    const diagnostic = JSON.parse(attachments.find(value => value.contentType === 'application/json')!.body.toString());
    expect(diagnostic.phase).toBe('move Construction cursor down');
    expect(diagnostic.pixelsSHA256).toBe(pixelsSHA256(fixture.initialPixels));
    expect(diagnostic.observation.cursor).toEqual(origin);
    expect(diagnostic.error.message).toBe(fixture.movementError.message);
  });

  it.each([false, true])('retains the analyzed pixels and original error when held painting fails (cleanup failure: %s)', async releaseError => {
    const fixture = keyboardFixture({ failPainting: true, releaseError });
    await expect(protectedBattlefield(fixture.page, fixture.testInfo)).rejects.toBe(fixture.captureError);
    expect(fixture.held.size).toBe(0);
    const attachments = fixture.attach.mock.calls.map(([name, attachment]) => ({ name, ...attachment }));
    expect(attachments.find(value => value.contentType === 'application/octet-stream')?.body.equals(fixture.failurePixels()!)).toBe(true);
    const diagnostic = JSON.parse(attachments.find(value => value.contentType === 'application/json')!.body.toString());
    expect(diagnostic.pixelsSHA256).toBe(pixelsSHA256(fixture.failurePixels()!));
    expect(diagnostic.observation.cursor).toEqual({ column: 11, row: 5 });
    expect(diagnostic.observation.steelRows).toEqual([]);
  });

  it('does not replace the preparation failure if attaching evidence also fails', async () => {
    const fixture = keyboardFixture({ failPainting: true, attachError: true });
    await expect(protectedBattlefield(fixture.page, fixture.testInfo)).rejects.toBe(fixture.captureError);
    expect(fixture.held.size).toBe(0);
  });

  it('keeps RGBA, hash and inspection consistent when a timed-out screenshot returns during attachment', async () => {
    const fixture = keyboardFixture({ latePaintingRead: true });
    await expect(protectedBattlefield(fixture.page, fixture.testInfo)).rejects.toThrow(/clamped right edge/);
    const attachments = fixture.attach.mock.calls.map(([, attachment]) => attachment);
    expect(attachments.find(value => value.contentType === 'application/octet-stream')?.body.equals(fixture.failurePixels()!)).toBe(true);
    const diagnostic = JSON.parse(attachments.find(value => value.contentType === 'application/json')!.body.toString());
    expect(diagnostic.pixelsSHA256).toBe(pixelsSHA256(fixture.failurePixels()!));
    expect(diagnostic.observation.cursor).toEqual({ column: 11, row: 5 });
    expect(diagnostic.observation.steelRows).toEqual([]);
    expect(fixture.held.size).toBe(0);
  });

  it.each([
    ['an unsampled direction', { unmovedCursor: true }, 1],
    ['a final B press still showing water', { stalledSteel: true }, 6],
  ] as const)('stops on %s without issuing D or replaying any B press', async (_label, options, presses) => {
    const fixture = keyboardFixture(options);
    await expect(protectedBattlefield(fixture.page, fixture.testInfo)).rejects.toThrow(/Construction/);
    expect(fixture.events.filter(event => event === 'down:k')).toHaveLength(presses);
    expect(fixture.events).not.toContain('down:d');
    expect(fixture.held.size).toBe(0); expect(fixture.attach).toHaveBeenCalled();
  });

  it('rejects an incomplete wall after the origin cursor has actually rendered', async () => {
    const fixture = keyboardFixture({ missingWall: true });
    await expect(protectedBattlefield(fixture.page, fixture.testInfo)).rejects.toThrow(/continuous full steel barrier/);
    expect(fixture.held.size).toBe(0); expect(fixture.attach).toHaveBeenCalled();
  });
});
