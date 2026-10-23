import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { createNativePixelReader, nativePixels } from '../browser/native-pixels';

vi.mock('@playwright/test', async () => ({ expect: (await import('vitest')).expect }));

// Encode independent PNG fixtures, including the checksum ignored by our decoder.
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});
function chunk(kind: string, data: Buffer): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length); result.write(kind, 4, 'ascii'); data.copy(result, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < result.length - 4; i++) crc = crcTable[(crc ^ result[i]) & 255] ^ (crc >>> 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

function png(width: number, height: number, channels: number, raw: Buffer,
  header: { depth?: number; colorType?: number; interlace?: number } = {}): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = header.depth ?? 8; ihdr[9] = header.colorType ?? (channels === 4 ? 6 : 2);
  ihdr[12] = header.interlace ?? 0;
  const compressed = deflateSync(raw), middle = Math.floor(compressed.length / 2);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', compressed.subarray(0, middle)), chunk('IDAT', compressed.subarray(middle)), chunk('IEND', Buffer.alloc(0))]);
}

function fixture(channels: 3 | 4, scale: number, filter: number, mixedAlpha = false): { png: Buffer; rgba: Buffer } {
  const width = 256 * scale, height = 240 * scale, stride = width * channels;
  const rgba = Buffer.alloc(256 * 240 * 4), pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < 240; y++) for (let x = 0; x < 256; x++) {
    const offset = (y * 256 + x) * 4;
    rgba[offset] = (x * 73 + y * 17) & 255; rgba[offset + 1] = (x * 31 - y * 19) & 255;
    rgba[offset + 2] = (x * 11 + y * 101) & 255; rgba[offset + 3] = channels === 3 ? 255 : (x * 29 + y * 37) & 255;
  }
  // Exercise Paeth's left/corner, above/corner and all-equal ties at scale 1.
  for (const [x, y, rgb] of [[0, 0, [1, 1, 7]], [1, 0, [3, 0, 7]], [0, 1, [0, 3, 7]], [1, 1, [201, 202, 7]]] as const)
    for (let channel = 0; channel < 3; channel++) rgba[(y * 256 + x) * 4 + channel] = rgb[channel];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = (Math.floor(y / scale) * 256 + Math.floor(x / scale)) * 4;
    for (let channel = 0; channel < channels; channel++) pixels[(y * width + x) * channels + channel] = rgba[source + channel];
  }
  if (mixedAlpha) pixels[(width + 1) * channels + 3] ^= 1;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowFilter = filter < 0 ? y % 5 : filter, output = y * (stride + 1);
    raw[output] = rowFilter;
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x, left = x >= channels ? pixels[index - channels] : 0;
      const above = y ? pixels[index - stride] : 0, corner = y && x >= channels ? pixels[index - stride - channels] : 0;
      let predictor = 0;
      if (rowFilter === 1) predictor = left;
      else if (rowFilter === 2) predictor = above;
      else if (rowFilter === 3) predictor = Math.floor((left + above) / 2);
      else if (rowFilter === 4) {
        const estimate = left + above - corner;
        const distance = Math.min(Math.abs(estimate - left), Math.abs(estimate - above), Math.abs(estimate - corner));
        predictor = distance === Math.abs(estimate - left) ? left : distance === Math.abs(estimate - above) ? above : corner;
      }
      raw[output + 1 + x] = (pixels[index] - predictor) & 255;
    }
  }
  return { png: png(width, height, channels, raw), rgba };
}

function screenshotPage(bytes: Buffer): Page {
  return {
    locator: () => ({
      evaluate: async () => ({ x: 0, y: 0, width: 256, height: 240,
        scrollX: 0, scrollY: 0, viewportWidth: 256, viewportHeight: 240 }),
      screenshot: async () => bytes,
    }),
    screenshot: async () => bytes,
  } as unknown as Page;
}

describe('native PNG decoding', () => {
  const combinations = ([3, 4] as const).flatMap(channels =>
    [1, 2].flatMap(scale => [0, 1, 2, 3, 4].map(filter => [channels, scale, filter] as const)));
  it.each(combinations)('decodes %i-channel PNG at scale %i with filter %i, split IDAT and uniform integer blocks', async (channels, scale, filter) => {
    const image = fixture(channels, scale, filter);
    expect((await nativePixels(screenshotPage(image.png), true)).equals(image.rgba)).toBe(true);
  });

  it('decodes mixed RGBA row filters at scale 3', async () => {
    const mixed = fixture(4, 3, -1);
    expect((await nativePixels(screenshotPage(mixed.png), true)).equals(mixed.rgba)).toBe(true);
  });

  it('rejects an alpha-only mixed block while keeping native sampling unchanged', async () => {
    const image = fixture(4, 2, 4, true);
    expect((await nativePixels(screenshotPage(image.png))).equals(image.rgba)).toBe(true);
    await expect(nativePixels(screenshotPage(image.png), true)).rejects.toThrow('Every native pixel must occupy one uniform integer block');
  });

  it('rejects invalid native shapes, unsupported PNG formats and unknown row filters', async () => {
    for (const [width, height] of [[255, 240], [256, 239], [512, 240]])
      await expect(nativePixels(screenshotPage(png(width, height, 4, Buffer.alloc(0))))).rejects.toThrow();
    for (const header of [{ depth: 16 }, { colorType: 3 }, { interlace: 1 }])
      await expect(nativePixels(screenshotPage(png(256, 240, 4, Buffer.alloc(0), header)))).rejects.toThrow();
    await expect(nativePixels(screenshotPage(png(256, 240, 4, Buffer.from([5]))))).rejects.toThrow('Unsupported PNG row filter 5');
    const badSignature = png(256, 240, 4, Buffer.alloc(0)); badSignature[0] = 0;
    await expect(nativePixels(screenshotPage(badSignature))).rejects.toThrow();
  });
});

describe('fixed Construction pixel reader', () => {
  function readerPage() {
    const image = fixture(4, 1, 4);
    const geometry = { x: 0, y: 0, width: 256, height: 240,
      viewportWidth: 256, viewportHeight: 240, scrollX: 0, scrollY: 0 };
    const evaluate = vi.fn(async () => geometry);
    const page = { locator: vi.fn(() => ({ evaluate })),
      viewportSize: vi.fn(() => ({ width: 256, height: 240 })), screenshot: vi.fn(async () => image.png) };
    return { page, evaluate, geometry, image, browser: page as unknown as Page };
  }
  it('confirms geometry once and decodes repeated compositor screenshots with the remaining budget', async () => {
    const { page, evaluate, image, browser } = readerPage();
    const read = await createNativePixelReader(browser), progress = vi.fn();
    const deadline = performance.now() + 10000;
    expect((await read(deadline, progress)).equals(image.rgba)).toBe(true);
    expect((await read(deadline)).equals(image.rgba)).toBe(true);
    expect(evaluate).toHaveBeenCalledOnce(); expect(page.locator).toHaveBeenCalledOnce();
    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), undefined, { timeout: 20000 });
    const options = vi.mocked(page.screenshot).mock.calls as unknown as [{ timeout: number; clip: object; scale: string }][];
    expect(options[0][0]).toMatchObject({ clip: { x: 0, y: 0, width: 256, height: 240 }, scale: 'css' });
    expect(options[0][0].timeout).toBeGreaterThan(0);
    expect(options[0][0].timeout).toBeLessThanOrEqual(10000);
    expect(options[1][0].timeout).toBeLessThanOrEqual(options[0][0].timeout);
    expect(progress.mock.calls).toEqual([['screenshot', false], ['screenshot', true], ['decode', false], ['decode', true]]);
  });
  it('rejects displaced geometry and a later viewport change before taking a screenshot', async () => {
    const { browser, page, geometry } = readerPage();
    geometry.x = 1;
    await expect(createNativePixelReader(browser)).rejects.toThrow(/fixed viewport/);
    geometry.x = 0;
    const read = await createNativePixelReader(browser);
    page.viewportSize.mockReturnValue({ width: 512, height: 480 });
    await expect(read(performance.now() + 10000)).rejects.toThrow(/viewport changed/);
    expect(page.screenshot).not.toHaveBeenCalled();
  });
  it('does not turn an exhausted budget into an unlimited screenshot timeout', async () => {
    const { browser, page } = readerPage(), read = await createNativePixelReader(browser);
    await expect(read(performance.now() - 1)).rejects.toThrow(/deadline exceeded/);
    expect(page.screenshot).not.toHaveBeenCalled();
  });
  it('preserves screenshot errors and distinguishes them from decoding failures', async () => {
    const { browser, page } = readerPage(), read = await createNativePixelReader(browser), progress = vi.fn();
    const failure = new Error('native screenshot timed out');
    page.screenshot.mockRejectedValueOnce(failure);
    await expect(read(performance.now() + 10000, progress)).rejects.toBe(failure);
    expect(progress.mock.calls).toEqual([['screenshot', false]]);
    progress.mockClear(); page.screenshot.mockResolvedValueOnce(Buffer.alloc(8));
    await expect(read(performance.now() + 10000, progress)).rejects.toThrow();
    expect(progress.mock.calls).toEqual([['screenshot', false], ['screenshot', true], ['decode', false]]);
  });
});
