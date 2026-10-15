import { describe, expect, it, vi } from 'vitest';
import { ATLAS_SIZE } from '../../src/game/atlas';
import golden from './fixtures/native-golden.json';
import { crop, hashPixels, PixelCanvas, renderer } from './native-renderer';

vi.mock('phaser', () => ({ default: { Scene: class {}, CANVAS: 1 } }));

describe('native texture atlas', () => {
  it('preserves every bitmap, direction, tread, armor palette and damaged brick against the frozen native pixels', () => {
    const { textures } = renderer();
    const atlas = textures.get('arena-atlas')!;
    expect([...atlas.frames.keys()].filter(name => name !== '__BASE').sort()).toEqual(Object.keys(golden.frames).sort());
    for (const [name, expected] of Object.entries(golden.frames)) {
      const frame = atlas.frames.get(name)!;
      expect({ width: frame.width, height: frame.height }, name).toEqual({ width: expected.width, height: expected.height });
      expect(hashPixels(crop(atlas.canvas, frame.x, frame.y, frame.width, frame.height).data), name).toBe(expected.sha256);
    }
  });
  it('packs separate padded frames into one nearest-filtered 512-pixel texture uploaded once', () => {
    const { textures } = renderer();
    const atlas = textures.get('arena-atlas')!;
    expect([atlas.width, atlas.height, atlas.filter, atlas.refreshes]).toEqual([ATLAS_SIZE, ATLAS_SIZE, 1, 1]);
    const frames = [...atlas.frames.values()].filter(frame => frame.name !== '__BASE');
    const overlaps: string[] = [];
    for (const [index, frame] of frames.entries()) {
      expect(frame.x).toBeGreaterThanOrEqual(1); expect(frame.y).toBeGreaterThanOrEqual(1);
      expect(frame.x + frame.width).toBeLessThan(ATLAS_SIZE); expect(frame.y + frame.height).toBeLessThan(ATLAS_SIZE);
      for (const other of frames.slice(index + 1)) if (!(frame.x + frame.width < other.x || other.x + other.width < frame.x ||
        frame.y + frame.height < other.y || other.y + other.height < frame.y)) overlaps.push(`${frame.name}/${other.name}`);
    }
    expect(overlaps).toEqual([]);
  });
  it('writes all atlas pixels in one bulk operation without individual native rectangles', () => {
    const { textures } = renderer();
    const atlas = textures.get('arena-atlas')!;
    expect(atlas.context.calls).toEqual({ fillRect: 0, createImageData: 1, putImageData: 1 });
    expect(atlas.refreshes).toBe(1);
  });
  it('copies raw ImageData including transparent pixels independently of canvas transforms and alpha', () => {
    const canvas = new PixelCanvas(3, 2), context = canvas.context;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, 3, 2);
    const image = context.createImageData(2, 1);
    image.data.set([12, 34, 56, 255, 0, 0, 0, 0]);
    context.translate(100, 100); context.globalAlpha = 0;
    context.putImageData(image, 1, 1);
    expect([...canvas.data.slice(16, 24)]).toEqual([12, 34, 56, 255, 0, 0, 0, 0]);
    image.data.fill(99);
    expect([...canvas.data.slice(16, 24)]).toEqual([12, 34, 56, 255, 0, 0, 0, 0]);
  });
});
