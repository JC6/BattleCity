import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { expect, type Page } from '@playwright/test';

/** Clip a fully visible canvas without element screenshot's RAF stability wait. */
export async function canvasScreenshot(page: Page): Promise<Buffer> {
  const canvas = page.locator('#game-canvas canvas');
  const box = await canvas.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      scrollX: window.scrollX, scrollY: window.scrollY,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
  });
  if (Object.values(box).every(Number.isFinite) && box.width > 0 && box.height > 0 &&
      box.viewportWidth > 0 && box.viewportHeight > 0 && box.scrollX === 0 && box.scrollY === 0 &&
      box.x >= 0 && box.y >= 0 && box.x + box.width <= box.viewportWidth && box.y + box.height <= box.viewportHeight) {
    // Match Playwright's enclosingIntRect epsilon and retain CSS pixels at DPR 2.
    const x = Math.floor(box.x + 1e-3), y = Math.floor(box.y + 1e-3);
    const right = Math.ceil(box.x + box.width - 1e-3), bottom = Math.ceil(box.y + box.height - 1e-3);
    if (right > x && bottom > y && right <= box.viewportWidth && bottom <= box.viewportHeight) {
      return page.screenshot({ clip: { x, y, width: right - x, height: bottom - y }, scale: 'css' });
    }
  }
  return canvas.screenshot({ scale: 'css' });
}

/** Decode the compositor screenshot without reading a discarded WebGL buffer. */
export async function nativePixels(page: Page, checkIntegerBlocks = false): Promise<Buffer> {
  const png = await canvasScreenshot(page);
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let width = 0, height = 0, channels = 0;
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset), kind = png.toString('ascii', offset + 4, offset + 8);
    const bytes = png.subarray(offset + 8, offset + 8 + size);
    if (kind === 'IHDR') {
      width = bytes.readUInt32BE(0); height = bytes.readUInt32BE(4);
      expect(bytes[8]).toBe(8); expect(bytes[12]).toBe(0);
      expect([2, 6]).toContain(bytes[9]); channels = bytes[9] === 6 ? 4 : 3;
    } else if (kind === 'IDAT') chunks.push(bytes);
    offset += size + 12;
  }
  const scale = width / 256;
  expect(Number.isInteger(scale) && scale >= 1 && height === 240 * scale).toBe(true);
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels;
  const decoded = Buffer.alloc(stride * height);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const input = y * (stride + 1) + 1, row = y * stride;
    const filter = raw[input - 1];
    if (filter > 4) throw new Error(`Unsupported PNG row filter ${filter}`);
    switch (filter) {
      case 0:
        raw.copy(decoded, row, input, input + stride);
        break;
      case 1:
        for (let x = 0; x < stride; x++) {
          const index = row + x, left = x >= channels ? decoded[index - channels] : 0;
          decoded[index] = (raw[input + x] + left) & 255;
        }
        break;
      case 2:
        for (let x = 0; x < stride; x++) {
          const above = y ? decoded[row + x - stride] : 0;
          decoded[row + x] = (raw[input + x] + above) & 255;
        }
        break;
      case 3:
        for (let x = 0; x < stride; x++) {
          const index = row + x, left = x >= channels ? decoded[index - channels] : 0;
          const above = y ? decoded[index - stride] : 0;
          decoded[index] = (raw[input + x] + Math.floor((left + above) / 2)) & 255;
        }
        break;
      case 4:
        for (let x = 0; x < stride; x++) {
          const index = row + x, left = x >= channels ? decoded[index - channels] : 0;
          const above = y ? decoded[index - stride] : 0, corner = y && x >= channels ? decoded[index - stride - channels] : 0;
          decoded[index] = (raw[input + x] + paeth(left, above, corner)) & 255;
        }
        break;
      // The original predictor is undefined for a missing filter byte and
      // its bitwise result is zero; the allocated row already contains zeros.
    }
  }
  const result = Buffer.alloc(256 * 240 * 4);
  let mixedBlocks = 0;
  for (let y = 0; y < 240; y++) for (let x = 0; x < 256; x++) {
    const source = (y * scale * width + x * scale) * channels, target = (y * 256 + x) * 4;
    result[target] = decoded[source]; result[target + 1] = decoded[source + 1]; result[target + 2] = decoded[source + 2];
    result[target + 3] = channels === 4 ? decoded[source + 3] : 255;
    if (checkIntegerBlocks) for (let py = 0; py < scale; py++) for (let px = 0; px < scale; px++) {
      const offset = ((y * scale + py) * width + x * scale + px) * channels;
      if (decoded[offset] !== decoded[source] || decoded[offset + 1] !== decoded[source + 1] ||
          decoded[offset + 2] !== decoded[source + 2] || channels === 4 && decoded[offset + 3] !== decoded[source + 3]) mixedBlocks++;
    }
  }
  if (checkIntegerBlocks) expect(mixedBlocks, 'Every native pixel must occupy one uniform integer block').toBe(0);
  return result;
}
export const pixelsSHA256 = (rgba: Buffer): string => createHash('sha256').update(rgba).digest('hex');
