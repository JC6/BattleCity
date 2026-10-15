import { describe, expect, it, vi } from 'vitest';
import { Tile } from '../../src/core/types';
import { TICK_MS } from '../../src/core/constants';
import { directionalBitmap, PALETTE } from '../../src/game/pixel-assets';
import { SCORE_TIMING, scoreCompletionMs } from '../../src/game/score-timeline';
import golden from './fixtures/native-golden.json';
import { crop, hashPixels, PixelCanvas, renderer, withPixelDocument } from './native-renderer';
import { emptyWorld, entityWorld, renderFixtures } from './render-fixtures';
import { CanvasPixels, ImagePixels, NativeTexture } from '../../src/game/textures';

vi.mock('phaser', () => ({ default: { Scene: class {}, CANVAS: 1 } }));

describe('native texture presentation', () => {
  it('creates software page contexts before registration and preserves them across scene cleanup and recreation', () => {
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
    const { scene, textures, events } = renderer();
    const pageKeys = ['arena-page', 'arena-hiscore-0', 'arena-hiscore-1', 'arena-hiscore-2', 'arena-hiscore-3'];
    const previousPages = pageKeys.map(key => textures.get(key)!);
    for (const page of previousPages) {
      expect([page.canvas.width, page.canvas.height]).toEqual([256, 240]);
      expect(page.context.getContextAttributes().willReadFrequently).toBe(true);
    }
    for (const key of ['arena-atlas', 'arena-map-0', 'arena-map-1', 'arena-forest', 'arena-hud']) {
      expect(textures.get(key)!.context.getContextAttributes().willReadFrequently).toBe(false);
    }
    events.emit('shutdown'); expect(textures.size).toBe(0);
    scene.create(); expect(textures.size).toBe(10);
    pageKeys.forEach((key, index) => {
      const page = textures.get(key)!;
      expect(page.canvas === previousPages[index].canvas).toBe(false);
      expect(page.context.getContextAttributes().willReadFrequently).toBe(true);
    });
    events.emit('destroy'); expect(textures.size).toBe(0);
    expect(Object.getOwnPropertyDescriptor(globalThis, 'document')).toEqual(documentDescriptor);
  });
  it('rejects duplicate page keys, missing contexts and failed registration without retaining another texture', () => {
    const { scene, textures } = renderer(), originalPage = textures.get('arena-page');
    expect(() => NativeTexture.createPage(scene, 'arena-page', 256, 240)).toThrow('Duplicate native texture: arena-page');
    expect(textures.get('arena-page')).toBe(originalPage);
    const context = vi.spyOn(PixelCanvas.prototype, 'getContext').mockReturnValueOnce(null);
    try {
      withPixelDocument(() => expect(() => NativeTexture.createPage(scene, 'no-context', 256, 240))
        .toThrow('Native page context unavailable: no-context'));
    } finally { context.mockRestore(); }
    const registration = vi.spyOn(scene.textures, 'addCanvas').mockReturnValueOnce(null);
    try {
      withPixelDocument(() => expect(() => NativeTexture.createPage(scene, 'no-registration', 256, 240))
        .toThrow('Duplicate native texture: no-registration'));
    } finally { registration.mockRestore(); }
    expect(textures.size).toBe(10);
    expect(textures.has('no-context')).toBe(false); expect(textures.has('no-registration')).toBe(false);
  });
  for (const operation of ['fillRect', 'clearRect'] as const) {
    it.each([
      ['fully left', -3, 0, 1, 1],
      ['fully right', 4, 0, 1, 1],
      ['fully above', 0, -2, 1, 1],
      ['fully below', 0, 3, 1, 1],
      ['zero width left of the canvas', -1, 0, 0, 1],
      ['zero height', 0, 0, 1, 0],
    ] as const)(`${operation} preserves every pixel for an empty rectangle: %s`, (_label, x, y, width, height) => {
      const canvas = new PixelCanvas(4, 3);
      // Nonzero clear targets expose accidental erasure; fill targets start transparent.
      const expected = operation === 'clearRect' ? new Uint8ClampedArray([
        17, 34, 51, 255, 17, 34, 51, 255, 17, 34, 51, 255, 17, 34, 51, 255,
        17, 34, 51, 255, 17, 34, 51, 255, 17, 34, 51, 255, 17, 34, 51, 255,
        17, 34, 51, 255, 17, 34, 51, 255, 17, 34, 51, 255, 17, 34, 51, 255,
      ]) : new Uint8ClampedArray(48);
      canvas.data.set(expected);
      canvas.context.fillStyle = '#aabbcc';
      canvas.context[operation](x, y, width, height);
      expect(canvas.data).toEqual(expected);
    });
  }
  it('keeps clipped opaque page pixels and clears prior pixels when repainting the reused image', () => {
    const { scene, textures } = renderer();
    const page = new NativeTexture(scene, 'page-boundary', 4, 3), texture = textures.get('page-boundary')!;
    const control = new PixelCanvas(4, 3), canvasPixels = new CanvasPixels(control.context as unknown as CanvasRenderingContext2D);
    canvasPixels.fillStyle(0xaa1122).fillRect(-1, 0, 3, 2);
    canvasPixels.fillStyle(0x3344dd).fillRect(3, 1, 3, 3);
    canvasPixels.fillStyle(0x44bb33).fillRect(1, 2, 0, 1);
    canvasPixels.fillRect(-8, 0, 2, 2); canvasPixels.fillRect(0, 8, 2, 2); canvasPixels.fillRect(0, 0, 1, 0);
    texture.context.translate(100, 100); texture.context.globalAlpha = 0;
    page.paint(g => {
      g.fillStyle(0xaa1122); g.fillRect(-1, 0, 3, 2);
      g.fillStyle(0x3344dd); g.fillRect(3, 1, 3, 3);
      g.fillStyle(0x44bb33); g.fillRect(1, 2, 0, 1);
      g.fillRect(-8, 0, 2, 2); g.fillRect(0, 8, 2, 2); g.fillRect(0, 0, 1, 0);
    });
    const rgba = (colors: (number | null)[]) => Uint8ClampedArray.from(colors.flatMap(color => color === null
      ? [0, 0, 0, 0] : [color >>> 16, color >>> 8 & 255, color & 255, 255]));
    const expected = rgba([
      0xaa1122, 0xaa1122, null, null,
      0xaa1122, 0xaa1122, null, 0x3344dd,
      null, null, null, 0x3344dd,
    ]);
    expect(control.data).toEqual(expected); expect(texture.canvas.data).toEqual(expected);
    page.paint(g => { g.fillStyle(0x44bb33); g.fillRect(2, 0, 1, 1); });
    expect(texture.canvas.data).toEqual(rgba([null, null, 0x44bb33, null, null, null, null, null, null, null, null, null]));
    expect(texture.context.calls.createImageData).toBe(1);
  });
  it.each([0, 4, 1])('keeps clipped RGBA writes inside an image view at byte offset %i', offset => {
    const backing = new Uint8ClampedArray(offset + 48 + 4); backing.fill(0xa5);
    const data = new Uint8ClampedArray(backing.buffer, offset, 48); data.fill(0);
    const pixels = new ImagePixels({ width: 4, height: 3, data } as ImageData);
    pixels.place(1, 1, 2, 2);
    pixels.fillRect(0, 1, 1, 1); // Default opaque black; single-pixel write.
    pixels.fillStyle(0x123456).fillRect(-1, -1, 4, 2); // Clipped wide row.
    pixels.fillStyle(0x80ff01).fillRect(1, 1, 4, 4); // Clipped bottom-right pixel.
    pixels.fillRect(0, 0, 0, 2); pixels.fillRect(0, 0, 2, 0);
    pixels.fillRect(-5, 0, 1, 2); pixels.fillRect(5, 0, 1, 2);
    pixels.fillRect(0, -5, 2, 1); pixels.fillRect(0, 5, 2, 1);
    expect(() => pixels.place(3, 1, 2, 2)).toThrow('inside the texture');
    expect(() => pixels.fillRect(0, 0, -1, 1)).toThrow('nonnegative sizes');
    expect(() => pixels.fillStyle(0x1000000)).toThrow('opaque RGB color');
    expect(() => pixels.fillStyle(0x010203, 0)).toThrow('opaque RGB color');
    pixels.fillRect(1, 1, 1, 1); // Rejected styles must preserve the current color.
    // Literal RGBA expectation, independent of word packing and host byte order.
    expect(data).toEqual(new Uint8ClampedArray([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 18, 52, 86, 255, 18, 52, 86, 255, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 255, 128, 255, 1, 255, 0, 0, 0, 0,
    ]));
    expect([...backing.subarray(0, offset)]).toEqual(Array(offset).fill(0xa5));
    expect([...backing.subarray(offset + 48)]).toEqual([0xa5, 0xa5, 0xa5, 0xa5]);
  });
  it('preserves asymmetric bitmap rotations on the native grid', () => {
    const bitmap = ['12', '34', '56'];
    expect(directionalBitmap(bitmap, 'up')).toEqual(bitmap);
    expect(directionalBitmap(bitmap, 'right')).toEqual(['531', '642']);
    expect(directionalBitmap(bitmap, 'down')).toEqual(['65', '43', '21']);
    expect(directionalBitmap(bitmap, 'left')).toEqual(['246', '135']);
  });
  it('matches independent pre-texture whole-frame baselines including intro covers, PTS rows and layer overlap', () => {
    const { scene, frame } = renderer();
    for (const fixture of renderFixtures()) {
      scene.state = scene.hudState = null; scene.draft = null; scene.resetAnimation();
      fixture.apply(scene); scene.update(0, 0);
      expect(hashPixels(frame().data), fixture.name).toBe(golden.scenes[fixture.name as keyof typeof golden.scenes]);
    }
  });
  it.each(['single', 'coop'] as const)('places all %s menu fields at their source boundaries, including scores over one million', mode => {
    const { scene, frame } = renderer();
    for (const [name, expected] of Object.entries(golden.menuHeaders)) {
      if (!name.startsWith(mode)) continue;
      scene.presentation = { kind: 'menu', selection: 0, highScore: expected.highScore, playerScores: [...expected.playerScores] };
      scene.update(0, 0);
      // The frozen header includes complete labels, fields and both eight-pixel
      // gaps. Expected strings and coordinates were assembled without ArenaScene.
      expect(hashPixels(crop(frame(), 16, 24, 216, 8).data), name).toBe(expected.sha256);
      expect(scene.presentation.playerScores).toEqual(expected.playerScores);
      expect(scene.presentation.highScore).toBe(expected.highScore);
    }
  });
  it('refreshes the menu only for changed visible pixels and preserves I/HI when player two changes', () => {
    const { scene, textures, frame } = renderer();
    scene.presentation = { kind: 'menu', selection: 0, highScore: 20000, playerScores: [0, 0] };
    scene.update(0, 0);
    const page = textures.get('arena-page')!, original = frame();
    const first = page.refreshes;
    scene.presentation.highScore += 1_000_000;
    scene.presentation.playerScores = [1_000_000, 1_000_000]; scene.update(0, 0);
    expect(page.refreshes).toBe(first); expect(hashPixels(frame().data)).toBe(hashPixels(original.data));
    scene.presentation.playerScores[1] += 200; scene.update(0, 0);
    const changed = frame();
    expect(page.refreshes).toBe(first + 1);
    expect(hashPixels(crop(changed, 16, 24, 144, 8).data)).toBe(hashPixels(crop(original, 16, 24, 144, 8).data));
    expect(hashPixels(crop(changed, 184, 24, 48, 8).data)).not.toBe(hashPixels(crop(original, 184, 24, 48, 8).data));
    scene.presentation.selection = 1; scene.update(0, 0);
    expect(page.refreshes).toBe(first + 2);
    expect(hashPixels(crop(frame(), 16, 24, 216, 8).data)).toBe(hashPixels(crop(changed, 16, 24, 216, 8).data));
    scene.presentation.playerScores = [1_000_000]; scene.update(0, 0);
    expect(page.refreshes).toBe(first + 3);
    const hidden = crop(frame(), 168, 24, 64, 8).data;
    expect([...hidden].every((value, index) => value === (index % 4 === 3 ? 255 : 0))).toBe(true);
  });
  it('cycles all four original HISCORE palettes without uploading a texture each tick', () => {
    const { scene, textures, frame } = renderer();
    for (let tick = 0; tick < 12; tick++) {
      scene.presentation = { kind: 'hiscore', highScore: 206300, tick }; scene.update(0, 0);
      expect(hashPixels(frame().data), `tick ${tick}`).toBe(golden.hiscore[tick % 4]);
    }
    expect(textures.size).toBe(10);
    for (let phase = 0; phase < 4; phase++) expect(textures.get(`arena-hiscore-${phase}`)!.refreshes).toBe(1);
    scene.presentation = { kind: 'hiscore', highScore: 206400, tick: 0 }; scene.update(0, 0);
    for (let phase = 0; phase < 4; phase++) expect(textures.get(`arena-hiscore-${phase}`)!.refreshes).toBe(2);
  });
  it('prepares one hidden HISCORE palette per cached GAME OVER frame and uploads none on its first visible frame', () => {
    const { scene, textures, frame } = renderer();
    scene.state = emptyWorld(); scene.state.players[0].score = 206300;
    const presentation = { kind: 'gameover' as const, highScore: 20000 }; scene.presentation = presentation;
    const calls = vi.fn(); scene.onFrame = calls;
    const uploads = () => [0, 1, 2, 3].map(phase => textures.get(`arena-hiscore-${phase}`)!.refreshes);
    scene.update(0, 16);
    expect(uploads()).toEqual([0, 0, 0, 0]);
    expect(textures.get('arena-page')!.refreshes).toBe(1);
    for (let phase = 0; phase < 4; phase++) {
      const before = uploads().reduce((sum, count) => sum + count, 0); scene.update(phase + 1, 16);
      expect(uploads().reduce((sum, count) => sum + count, 0) - before).toBe(1);
      expect(hashPixels(frame().data)).toBe(golden.scenes.gameover);
      expect(scene.presentation).toBe(presentation); expect(presentation.highScore).toBe(20000);
    }
    expect(calls).toHaveBeenCalledTimes(5); expect(uploads()).toEqual([1, 1, 1, 1]);
    for (let tick = 0; tick < 4; tick++) {
      scene.presentation = { kind: 'hiscore', highScore: 206300, tick }; scene.update(tick, 16);
      expect(uploads()).toEqual([1, 1, 1, 1]); expect(hashPixels(frame().data)).toBe(golden.hiscore[tick]);
    }
    expect(textures.get('arena-page')!.refreshes).toBe(1);
  });
  it('prepares HISCORE only after a player strictly beats the known previous record, including player two', () => {
    const { scene, textures } = renderer(); scene.state = emptyWorld('coop');
    scene.state.players[0].score = 10000; scene.state.players[1].score = 20000;
    scene.presentation = { kind: 'gameover', highScore: 20000 };
    for (let index = 0; index < 6; index++) scene.update(index, 16);
    for (let phase = 0; phase < 4; phase++) expect(textures.get(`arena-hiscore-${phase}`)!.refreshes).toBe(0);
    scene.state.players[1].score = 206300;
    scene.presentation = { kind: 'gameover' };
    for (let index = 0; index < 4; index++) scene.update(index, 16);
    for (let phase = 0; phase < 4; phase++) expect(textures.get(`arena-hiscore-${phase}`)!.refreshes).toBe(0);
    scene.presentation = { kind: 'gameover', highScore: 20000 };
    for (let index = 0; index < 4; index++) scene.update(index, 16);
    for (let phase = 0; phase < 4; phase++) expect(textures.get(`arena-hiscore-${phase}`)!.refreshes).toBe(1);
  });
  it('finishes partial HISCORE preparation for the visible score and discards preparation on scene recreation', () => {
    const { scene, textures, frame, events } = renderer(); scene.state = emptyWorld(); scene.state.players[0].score = 206400;
    scene.presentation = { kind: 'gameover', highScore: 20000 }; scene.update(0, 16); scene.update(1, 16);
    expect([0, 1, 2, 3].map(phase => textures.get(`arena-hiscore-${phase}`)!.refreshes)).toEqual([1, 0, 0, 0]);
    scene.presentation = { kind: 'hiscore', highScore: 206300, tick: 0 }; scene.update(2, 16);
    expect([0, 1, 2, 3].map(phase => textures.get(`arena-hiscore-${phase}`)!.refreshes)).toEqual([2, 1, 1, 1]);
    expect(hashPixels(frame().data)).toBe(golden.hiscore[0]);
    events.emit('shutdown'); expect(textures.size).toBe(0); scene.create();
    scene.presentation = { kind: 'gameover', highScore: 20000 }; scene.update(3, 16);
    expect([0, 1, 2, 3].map(phase => textures.get(`arena-hiscore-${phase}`)!.refreshes)).toEqual([0, 0, 0, 0]);
    scene.state.players[0].score = 206300;
    for (let index = 0; index < 4; index++) scene.update(index + 4, 16);
    scene.presentation = { kind: 'hiscore', highScore: 206300, tick: 3 }; scene.update(8, 16);
    expect([0, 1, 2, 3].map(phase => textures.get(`arena-hiscore-${phase}`)!.refreshes)).toEqual([1, 1, 1, 1]);
    expect(hashPixels(frame().data)).toBe(golden.hiscore[3]); expect(textures.size).toBe(10);
  });
  it('uploads static pages only when visible menu, tally or TOTAL pixels change', () => {
    const { scene, textures } = renderer();
    scene.update(0, 0); for (let index = 0; index < 10; index++) scene.update(index, 16);
    const page = textures.get('arena-page')!; expect(page.refreshes).toBe(1);
    const state = emptyWorld(); state.players[0].kills = [2, 0, 0, 0];
    scene.presentation = { kind: 'score', state, highScore: 20000, elapsedMs: 0 }; scene.update(0, 0);
    const first = page.refreshes;
    scene.presentation.elapsedMs = SCORE_TIMING.leadMs - 1; scene.update(0, 0); expect(page.refreshes).toBe(first);
    scene.presentation.elapsedMs++; scene.update(0, 0); expect(page.refreshes).toBe(first + 1);
    scene.presentation.elapsedMs += SCORE_TIMING.countMs - 1; scene.update(0, 0); expect(page.refreshes).toBe(first + 1);
    scene.presentation.elapsedMs++; scene.update(0, 0); expect(page.refreshes).toBe(first + 2);
    const totalAt = scoreCompletionMs(state) - 135 * TICK_MS;
    scene.presentation.elapsedMs = totalAt - 1; scene.update(0, 0); const before = page.refreshes;
    scene.presentation.elapsedMs++; scene.update(0, 0); expect(page.refreshes).toBe(before + 1);
    for (let index = 0; index < 5; index++) { scene.presentation.elapsedMs++; scene.update(0, 0); }
    expect(page.refreshes).toBe(before + 1);
  });
  it('patches damaged brick and removed forest while two water phases reuse their unchanged maps', () => {
    const { scene, textures, frame } = renderer();
    const world = emptyWorld(); scene.state = world; scene.presentation = { kind: 'game' };
    scene.state.tiles[0] = Tile.Water; scene.state.tiles[1] = Tile.Brick; scene.state.brickMasks[1] = 15;
    scene.state.tiles[2] = Tile.Forest; scene.update(0, 0);
    const a = hashPixels(crop(frame(), 16, 16, 8, 8).data);
    world.tick = 16; scene.update(0, 0); const b = hashPixels(crop(frame(), 16, 16, 8, 8).data);
    world.tick = 32; scene.update(0, 0); expect(hashPixels(crop(frame(), 16, 16, 8, 8).data)).toBe(a); expect(b).not.toBe(a);
    expect(textures.get('arena-map-0')!.refreshes).toBe(1); expect(textures.get('arena-map-1')!.refreshes).toBe(1);
    scene.state.brickMasks[1] = 2; scene.state.tiles[2] = Tile.Empty; scene.update(0, 0);
    expect(textures.get('arena-map-0')!.refreshes).toBe(2); expect(textures.get('arena-map-1')!.refreshes).toBe(2);
    expect(textures.get('arena-forest')!.refreshes).toBe(2);
    const brick = crop(frame(), 24, 16, 4, 4); const cleared = crop(frame(), 32, 16, 8, 8);
    expect([...brick.data].filter((_, index) => index % 4 !== 3).every(value => value === 0)).toBe(true);
    expect([...cleared.data].filter((_, index) => index % 4 !== 3).every(value => value === 0)).toBe(true);
  });
  it('continues simulation during an opaque paused intro without painting its hidden world', () => {
    const { scene, textures, frame } = renderer(); let calls = 0; scene.onFrame = () => { calls++; };
    scene.state = entityWorld(); scene.presentation = { kind: 'intro', stage: 21, elapsedMs: 0, paused: true };
    for (let index = 0; index < 10; index++) scene.update(index, 16);
    expect(calls).toBe(10); expect(textures.get('arena-map-0')!.refreshes).toBe(0); expect(textures.get('arena-hud')!.refreshes).toBe(0);
    expect(hashPixels(frame().data)).toBe(golden.scenes['intro-0-true']);
    scene.state.tiles[0] = Tile.Water; scene.presentation.elapsedMs = 1500; scene.update(0, 0);
    expect(textures.get('arena-map-0')!.refreshes).toBe(1); expect(textures.get('arena-map-1')!.refreshes).toBe(1);
    expect(textures.get('arena-hud')!.refreshes).toBe(1);
  });
  it('keeps the cached HUD tied to the authoritative final result while its world continues', () => {
    const { scene, textures } = renderer(); const world = entityWorld(); scene.state = world; scene.hudState = structuredClone(world);
    scene.presentation = { kind: 'game' }; scene.update(0, 0);
    const hud = textures.get('arena-hud')!; const initial = hashPixels(hud.canvas.data);
    world.spawned++; world.players[0].lives--; world.stage++; scene.update(0, 0);
    expect(hud.refreshes).toBe(1); expect(hashPixels(hud.canvas.data)).toBe(initial);
    scene.hudState = null; scene.update(0, 0); expect(hud.refreshes).toBe(2); expect(hashPixels(hud.canvas.data)).not.toBe(initial);
  });
  it('shows overwritten Construction terrain instead of the base when the draft hides its eagle', () => {
    const { scene, frame } = renderer(); const draft = emptyWorld().tiles; scene.draft = draft;
    for (const index of [636, 637, 662, 663]) draft[index] = Tile.Water;
    scene.presentation = { kind: 'editor', baseVisible: false }; scene.update(0, 0);
    const colors = new Set<number>(); const pixels = crop(frame(), 112, 208, 16, 16).data;
    for (let index = 0; index < pixels.length; index += 4) colors.add(pixels[index] << 16 | pixels[index + 1] << 8 | pixels[index + 2]);
    expect(colors).toEqual(new Set([0x4854ff, 0xa5dfb6]));
    scene.presentation.baseVisible = true; scene.update(0, 0);
    expect(hashPixels(crop(frame(), 112, 208, 16, 16).data)).not.toBe(hashPixels(pixels));
  });
  it('reuses entity slots across cumulative ids and hides unused actors on world and page transitions', () => {
    const { scene, images, frame } = renderer(); scene.state = entityWorld(); scene.presentation = { kind: 'game' }; scene.update(0, 0);
    const count = images.length;
    for (let index = 0; index < 50; index++) {
      scene.state.tanks.forEach(tank => { tank.id += 100; tank.x++; }); scene.update(0, 0);
    }
    expect(images.length).toBe(count);
    const poolFrames = [/^(player:|enemy:|spawn:|shield$)/, /^(bullet:|impact:)/, /^explosion:/, /^glyph:/];
    const actors = images.filter(image => image.visible && poolFrames.some(pattern => pattern.test(image.frame.name)));
    for (const pattern of poolFrames) expect(actors.some(image => pattern.test(image.frame.name))).toBe(true);
    const restore = () => {
      const state = entityWorld();
      scene.state = state; scene.hudState = null; scene.draft = null; scene.presentation = { kind: 'game' };
      scene.update(0, 0);
      expect(actors.every(image => image.visible)).toBe(true); expect(images.length).toBe(count);
      return state;
    };
    // Start each transition with all four pools populated; an opaque page must
    // hide the actors themselves, even when its pixels would cover them.
    for (const fixture of renderFixtures().filter(value => ['menu-0', 'stage-35', 'score-coop-6000', 'gameover'].includes(value.name))) {
      restore(); fixture.apply(scene); scene.update(0, 0);
      expect(actors.every(image => !image.visible), fixture.name).toBe(true);
    }
    restore(); scene.presentation = { kind: 'hiscore', highScore: 206300, tick: 0 }; scene.update(0, 0);
    expect(actors.every(image => !image.visible)).toBe(true);
    for (const paused of [false, true]) {
      restore(); scene.presentation = { kind: 'intro', stage: 21, elapsedMs: 999, paused }; scene.update(0, 0);
      expect(actors.every(image => !image.visible)).toBe(true);
      scene.presentation.elapsedMs = 1000; scene.update(0, 0);
      expect(actors.every(image => image.visible)).toBe(true); expect(images.length).toBe(count);
    }
    restore(); scene.draft = scene.state!.tiles; scene.state = null; scene.presentation = { kind: 'editor', cursor: { x: 4, y: 12 } };
    scene.update(0, 0);
    expect(actors.every(image => !image.visible)).toBe(true);
    expect(images.some(image => image.visible && image.depth === 600)).toBe(true);
    const state = restore();
    state.tanks = []; state.bullets = []; state.effects = []; state.powerUp = null; scene.update(0, 0);
    expect(actors.every(image => !image.visible)).toBe(true);
    expect(images.filter(image => image.visible && image.depth >= 20 && image.depth < 400)).toHaveLength(0);
    scene.presentation = { kind: 'menu', selection: 0, highScore: 20000, playerScores: [0] }; scene.update(0, 0);
    expect(images.filter(image => image.visible)).toHaveLength(1); expect(hashPixels(frame().data)).toBe(golden.scenes['menu-0']);
  });
  it('releases all owned textures and images on shutdown and recreates a bounded fresh scene', () => {
    const { scene, textures, images, events } = renderer(); scene.state = entityWorld(); scene.presentation = { kind: 'game' }; scene.update(0, 0);
    const oldImages = [...images]; expect(textures.size).toBe(10);
    events.emit('shutdown'); expect(textures.size).toBe(0); expect(oldImages.every(image => image.destroyed)).toBe(true);
    events.emit('destroy'); expect(textures.size).toBe(0);
    let calls = 0; scene.onFrame = () => { calls++; }; scene.update(0, 16); expect(calls).toBe(1);
    scene.create(); scene.update(0, 0); expect(textures.size).toBe(10);
    expect(images.filter(image => !image.destroyed)).toHaveLength(oldImages.length); events.emit('destroy'); expect(textures.size).toBe(0);
  });
  it('keeps image origins and positions integral and disables only Canvas half-pixel expansion', () => {
    const canvas = renderer(true), webgl = renderer(); expect(canvas.camera.roundPixels).toBe(false); expect(webgl.camera.roundPixels).toBe(true);
    canvas.scene.state = entityWorld(); canvas.scene.presentation = { kind: 'game' }; canvas.scene.update(0, 0);
    for (const image of canvas.images) {
      expect([image.originX, image.originY]).toEqual([0, 0]); expect(Number.isInteger(image.x)).toBe(true); expect(Number.isInteger(image.y)).toBe(true);
    }
    expect(PALETTE.black).toBe(0);
  });
});
