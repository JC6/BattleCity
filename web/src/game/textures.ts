import type Phaser from 'phaser';
import type { PixelSurface } from './pixel-assets';

/** Shared integer-pixel recipes paint once into CanvasTextures, on either renderer. */
export class CanvasPixels implements PixelSurface {
  constructor(readonly context: CanvasRenderingContext2D) {}
  fillStyle(color: number, alpha = 1): this {
    this.context.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
    this.context.globalAlpha = alpha;
    return this;
  }
  fillRect(x: number, y: number, width: number, height: number): this {
    this.context.fillRect(x, y, width, height);
    return this;
  }
}

/** Opaque integer recipes share one software surface before a native upload. */
export class ImagePixels implements PixelSurface {
  private x = 0;
  private y = 0;
  private width = 0;
  private height = 0;
  private readonly colorBytes = new Uint8Array([0, 0, 0, 255]);
  private readonly colorPixel = new Uint32Array(this.colorBytes.buffer);
  private readonly pixels?: Uint32Array;
  constructor(private readonly image: ImageData) {
    const data = image.data;
    if (data.byteOffset % 4 === 0 && data.byteLength % 4 === 0) {
      this.pixels = new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4);
    }
  }
  place(x: number, y: number, width: number, height: number): void {
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(width) || !Number.isInteger(height) ||
        x < 0 || y < 0 || width < 0 || height < 0 || x + width > this.image.width || y + height > this.image.height) {
      throw new Error('Image frames must occupy integer rectangles inside the texture.');
    }
    this.x = x; this.y = y; this.width = width; this.height = height;
  }
  fillStyle(color: number, alpha = 1): this {
    if (!Number.isInteger(color) || color < 0 || color > 0xffffff || alpha !== 1) {
      throw new Error('Image pixels require an opaque RGB color.');
    }
    this.colorBytes[0] = color >>> 16; this.colorBytes[1] = color >>> 8 & 255; this.colorBytes[2] = color & 255;
    return this;
  }
  fillRect(x: number, y: number, width: number, height: number): this {
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(width) || !Number.isInteger(height) ||
        width < 0 || height < 0) {
      throw new Error('Image pixels require integer rectangles with nonnegative sizes.');
    }
    const left = Math.max(0, x), top = Math.max(0, y);
    const right = Math.min(this.width, x + width), bottom = Math.min(this.height, y + height);
    if (right <= left || bottom <= top) return this;
    if (this.pixels) {
      const color = this.colorPixel[0], count = right - left;
      for (let row = top; row < bottom; row++) {
        const offset = (this.y + row) * this.image.width + this.x + left;
        if (count === 1) this.pixels[offset] = color;
        else this.pixels.fill(color, offset, offset + count);
      }
      return this;
    }
    const data = this.image.data;
    for (let row = top; row < bottom; row++) {
      let offset = ((this.y + row) * this.image.width + this.x + left) * 4;
      const end = offset + (right - left) * 4;
      while (offset < end) {
        data[offset++] = this.colorBytes[0]; data[offset++] = this.colorBytes[1];
        data[offset++] = this.colorBytes[2]; data[offset++] = 255;
      }
    }
    return this;
  }
}

export class NativeTexture {
  readonly texture: Phaser.Textures.CanvasTexture;
  readonly pixels: CanvasPixels;
  private paintImage?: ImageData;
  private paintPixels?: ImagePixels;
  /** Establish page backing before Phaser can request its first context. */
  static createPage(scene: Phaser.Scene, key: string, width: number, height: number): NativeTexture {
    if (scene.textures.exists(key)) throw new Error(`Duplicate native texture: ${key}`);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    if (!canvas.getContext('2d', { willReadFrequently: true })) throw new Error(`Native page context unavailable: ${key}`);
    return new NativeTexture(scene, key, width, height, canvas);
  }
  constructor(scene: Phaser.Scene, readonly key: string, width: number, height: number, sourceCanvas?: HTMLCanvasElement) {
    const texture = sourceCanvas ? scene.textures.addCanvas(key, sourceCanvas) : scene.textures.createCanvas(key, width, height);
    if (!texture) throw new Error(`Duplicate native texture: ${key}`);
    this.texture = texture;
    texture.setFilter(1); // Phaser.Textures.FilterMode.NEAREST, shared by Canvas and WebGL.
    texture.context.imageSmoothingEnabled = false;
    this.pixels = new CanvasPixels(texture.context);
  }
  clear(color?: number): void {
    const context = this.texture.context;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.clearRect(0, 0, this.texture.width, this.texture.height);
    if (color !== undefined) this.pixels.fillStyle(color).fillRect(0, 0, this.texture.width, this.texture.height);
  }
  /** Dense pages keep their recipes and publish all pixels in one operation. */
  paint(recipe: (pixels: PixelSurface) => void): void {
    if (!this.paintImage) {
      this.paintImage = this.texture.context.createImageData(this.texture.width, this.texture.height);
      this.paintPixels = new ImagePixels(this.paintImage);
      this.paintPixels.place(0, 0, this.texture.width, this.texture.height);
    }
    this.paintImage.data.fill(0);
    recipe(this.paintPixels!);
    this.texture.context.putImageData(this.paintImage, 0, 0);
    this.refresh();
  }
  refresh(): void { this.texture.refresh(); }
}
