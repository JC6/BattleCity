import { createHash } from 'node:crypto';
import { ArenaScene } from '../../src/game/arena';

/** Test-only native RGBA surface, independent of bitmap recipes and atlas layout. */
export class PixelCanvas {
  data: Uint8ClampedArray;
  pixels: Uint32Array;
  readonly context: PixelContext;
  private attributes?: CanvasRenderingContext2DSettings;
  constructor(public width: number, public height: number) {
    this.data = new Uint8ClampedArray(width * height * 4);
    this.pixels = new Uint32Array(this.data.buffer); this.context = new PixelContext(this);
  }
  getContext(kind: string, attributes: CanvasRenderingContext2DSettings = {}): PixelContext | null {
    if (kind !== '2d') return null;
    if (!this.attributes) {
      this.attributes = { alpha: true, willReadFrequently: false, ...attributes };
      this.data = new Uint8ClampedArray(this.width * this.height * 4); this.pixels = new Uint32Array(this.data.buffer);
    }
    return this.context;
  }
  getContextAttributes(): CanvasRenderingContext2DSettings { return { ...this.attributes }; }
}
/** Scope the canvas DOM substitute to real scene/factory construction, including recreation. */
export function withPixelDocument<T>(create: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement(kind: string) { if (kind !== 'canvas') throw new Error(`Unexpected test element: ${kind}`); return new PixelCanvas(0, 0); },
  } });
  try { return create(); }
  finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor);
    else Reflect.deleteProperty(globalThis, 'document');
  }
}
class PixelContext {
  fillStyle = '#000000'; globalAlpha = 1; imageSmoothingEnabled = false;
  readonly calls = { fillRect: 0, createImageData: 0, putImageData: 0 };
  private x = 0; private y = 0;
  private stack: { x: number; y: number; fillStyle: string; alpha: number }[] = [];
  constructor(readonly canvas: PixelCanvas) {}
  getContextAttributes(): CanvasRenderingContext2DSettings { return this.canvas.getContextAttributes(); }
  setTransform(_a: number, _b: number, _c: number, _d: number, x: number, y: number): void { this.x = x; this.y = y; }
  translate(x: number, y: number): void { this.x += x; this.y += y; }
  save(): void { this.stack.push({ x: this.x, y: this.y, fillStyle: this.fillStyle, alpha: this.globalAlpha }); }
  restore(): void { const value = this.stack.pop()!; this.x = value.x; this.y = value.y; this.fillStyle = value.fillStyle; this.globalAlpha = value.alpha; }
  fillRect(x: number, y: number, width: number, height: number): void {
    this.calls.fillRect++;
    const color = Number.parseInt(this.fillStyle.slice(1), 16);
    this.rect(x, y, width, height, [color >> 16, color >> 8 & 255, color & 255, Math.round(this.globalAlpha * 255)]);
  }
  clearRect(x: number, y: number, width: number, height: number): void { this.rect(x, y, width, height, [0, 0, 0, 0]); }
  createImageData(width: number, height: number): ImageData {
    this.calls.createImageData++;
    return { width, height, colorSpace: 'srgb', data: new Uint8ClampedArray(width * height * 4) };
  }
  putImageData(image: ImageData, dx: number, dy: number): void {
    this.calls.putImageData++;
    const left = Math.max(0, -dx), right = Math.min(image.width, this.canvas.width - dx);
    if (left >= right) return;
    for (let row = Math.max(0, -dy); row < Math.min(image.height, this.canvas.height - dy); row++) {
      this.canvas.data.set(image.data.subarray((row * image.width + left) * 4, (row * image.width + right) * 4),
        ((row + dy) * this.canvas.width + dx + left) * 4);
    }
  }
  private rect(x: number, y: number, width: number, height: number, rgba: number[]): void {
    const left = Math.max(0, Math.round(x + this.x)), top = Math.max(0, Math.round(y + this.y));
    const right = Math.min(this.canvas.width, Math.round(x + this.x + width));
    const bottom = Math.min(this.canvas.height, Math.round(y + this.y + height));
    if (left >= right || top >= bottom) return;
    const color = new Uint32Array(new Uint8ClampedArray(rgba).buffer)[0];
    for (let py = top; py < bottom; py++) this.canvas.pixels.fill(color, py * this.canvas.width + left, py * this.canvas.width + right);
  }
  drawImage(source: PixelCanvas, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void {
    const left = Math.round(dx + this.x), top = Math.round(dy + this.y);
    for (let y = Math.max(0, top); y < Math.min(this.canvas.height, top + dh); y++) {
      for (let x = Math.max(0, left); x < Math.min(this.canvas.width, left + dw); x++) {
        const sourceX = sx + Math.floor((x - left) * sw / dw), sourceY = sy + Math.floor((y - top) * sh / dh);
        const offset = (sourceY * source.width + sourceX) * 4;
        const alpha = source.data[offset + 3]; if (!alpha) continue;
        const target = (y * this.canvas.width + x) * 4;
        if (alpha === 255) this.canvas.pixels[target / 4] = source.pixels[offset / 4];
        else {
          const a = alpha / 255, previous = this.canvas.data[target + 3] / 255, finalAlpha = a + previous * (1 - a);
          for (let channel = 0; channel < 3; channel++) this.canvas.data[target + channel] =
            (source.data[offset + channel] * a + this.canvas.data[target + channel] * previous * (1 - a)) / finalAlpha;
          this.canvas.data[target + 3] = finalAlpha * 255;
        }
      }
    }
  }
}
export interface Frame { name: string; x: number; y: number; width: number; height: number }
class TestTexture {
  readonly canvas: PixelCanvas; readonly context: PixelContext;
  readonly frames = new Map<string, Frame>(); refreshes = 0; filter = -1;
  constructor(readonly key: string, readonly width: number, readonly height: number, source?: PixelCanvas) {
    this.canvas = source ?? new PixelCanvas(width, height);
    // Pixel-art CanvasPool gets the first context before CanvasTexture requests true.
    if (!source) this.canvas.getContext('2d', { willReadFrequently: false });
    this.context = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.frames.set('__BASE', { name: '__BASE', x: 0, y: 0, width, height });
  }
  setFilter(value: number): this { this.filter = value; return this; }
  refresh(): this { this.refreshes++; return this; }
  add(name: string, _source: number, x: number, y: number, width: number, height: number): void {
    this.frames.set(name, { name, x, y, width, height });
  }
}
export class TestImage {
  x = 0; y = 0; depth = 0; visible = true; scaleX = 1; scaleY = 1; destroyed = false;
  originX = 0.5; originY = 0.5; texture!: TestTexture; frame!: Frame;
  constructor(private textures: Map<string, TestTexture>, key: string, frame?: string) { this.setTexture(key, frame); }
  setTexture(key: string, frame = '__BASE'): this {
    this.texture = this.textures.get(key)!; this.frame = this.texture.frames.get(frame)!;
    if (!this.frame) throw new Error(`Unknown mock frame ${key}:${frame}`); return this;
  }
  setPosition(x: number, y: number): this { this.x = x; this.y = y; return this; }
  setVisible(value: boolean): this { this.visible = value; return this; }
  setOrigin(value: number): this { this.originX = this.originY = value; return this; }
  setDepth(value: number): this { this.depth = value; return this; }
  setDisplaySize(width: number, height: number): this { this.scaleX = width / this.frame.width; this.scaleY = height / this.frame.height; return this; }
  destroy(): void { this.destroyed = true; this.visible = false; }
}
export function hashPixels(bytes: Uint8ClampedArray): string { return createHash('sha256').update(bytes).digest('hex'); }
export function crop(canvas: PixelCanvas, x: number, y: number, width: number, height: number): PixelCanvas {
  const target = new PixelCanvas(width, height); target.context.drawImage(canvas, x, y, width, height, 0, 0, width, height); return target;
}
export function renderer(canvas = false) {
  const scene = new ArenaScene();
  const textures = new Map<string, TestTexture>(), images: TestImage[] = [];
  const callbacks = new Map<string, { fn: () => void; context: unknown }[]>();
  const events = {
    once(name: string, fn: () => void, context: unknown) { callbacks.set(name, [...(callbacks.get(name) ?? []), { fn, context }]); },
    off(name: string, fn: () => void, context: unknown) { callbacks.set(name, (callbacks.get(name) ?? []).filter(item => item.fn !== fn || item.context !== context)); },
    emit(name: string) { const list = callbacks.get(name) ?? []; callbacks.delete(name); list.forEach(item => item.fn.call(item.context)); },
  };
  const camera = { roundPixels: true };
  Object.assign(scene, {
    game: { renderer: { type: canvas ? 1 : 2 } }, cameras: { main: camera }, events,
    textures: { createCanvas(key: string, width: number, height: number) {
      if (textures.has(key)) return null; const texture = new TestTexture(key, width, height); textures.set(key, texture); return texture;
    }, exists(key: string) { return textures.has(key); }, addCanvas(key: string, source: PixelCanvas) {
      if (textures.has(key)) return null; const texture = new TestTexture(key, source.width, source.height, source); textures.set(key, texture); return texture;
    }, remove(key: string) { textures.delete(key); } },
    add: { image(_x: number, _y: number, key: string, frame?: string) { const image = new TestImage(textures, key, frame); images.push(image); return image; } },
  });
  const create = scene.create.bind(scene);
  scene.create = () => withPixelDocument(create);
  scene.create();
  const frame = () => {
    const target = new PixelCanvas(256, 240);
    images.filter(image => image.visible && !image.destroyed).sort((a, b) => a.depth - b.depth).forEach(image => {
      const f = image.frame;
      target.context.drawImage(image.texture.canvas, f.x, f.y, f.width, f.height,
        image.x - image.originX * f.width, image.y - image.originY * f.height, f.width * image.scaleX, f.height * image.scaleY);
    });
    return target;
  };
  return { scene, textures, images, events, camera, frame };
}
