import { describe, expect, it } from 'vitest';
import { ApuDriver } from '../../src/platform/apu-driver';
import { AUDIO_TRACKS, AUDIO_SCENE_TICKS, CUE } from '../../src/platform/audio-cues';

// Literal goldens independently decoded in Python from the annotated reference
// bank's raw hex bytes, not from audio-cues.ts or ApuDriver. FNV-1a hashes the
// ordered [frameLo, frameHi, channel, register, value] bus writes including mute.
// The last frame is the first mute after stop; loops are observed through 601.
const GOLDENS: Record<number, readonly [number, number, number]> = {
  0x00: [38, 0xfe31ef97, 7], 0x01: [266, 0xa7584a61, 29], 0x02: [266, 0x177b62f2, 23],
  0x03: [266, 0x7fb55ad4, 23], 0x04: [62, 0x8ace04f9, 8], 0x05: [56, 0x953cc9ed, 9],
  0x06: [41, 0x439d4b19, 13], 0x07: [28, 0x18727407, 13], 0x09: [34, 0xdff1e288, 8],
  0x0a: [16, 0x27d4b5ab, 3], 0x0b: [29, 0x05939130, 9], 0x0c: [5, 0x968a6389, 3],
  0x0d: [6, 0xc7e6a66e, 2], 0x0e: [7, 0x4780c09c, 3], 0x0f: [17, 0xf1039286, 1],
  0x10: [6, 0xb63f3896, 4], 0x11: [601, 0xd2e2b30d, 300], 0x12: [601, 0xcb845e83, 151],
  0x13: [3, 0xd22faf1e, 1], 0x14: [3, 0x524d25c8, 1], 0x15: [462, 0x90a77e4a, 66],
  0x16: [462, 0x3092d864, 81], 0x17: [382, 0x96191d15, 18], 0x18: [110, 0xb511b610, 10],
  0x19: [110, 0xb013c3cf, 10], 0x1a: [110, 0xf859eccd, 10], 0x1b: [30, 0x5d54047d, 7],
};

describe('reference APU bytecode driver', () => {
  it.each(Object.entries(GOLDENS))('matches the independent complete bus trace of slot %s', (key, [frames, hash, notes]) => {
    let frame = 0, checksum = 2166136261, writes = 0;
    const driver = new ApuDriver((channel, register, value) => {
      for (const byte of [frame & 255, frame >> 8, channel, register, value]) checksum = Math.imul(checksum ^ byte, 16777619) >>> 0;
      if (register === 3) writes++;
    });
    const id = Number(key); driver.trigger(id);
    for (frame = 1; frame <= frames; frame++) driver.tick();
    expect(checksum).toBe(hash); expect(writes).toBe(notes);
    expect(driver.active(id)).toBe(id === CUE.playerEngine || id === CUE.enemyEngine);
  });
  it('contains exactly 27 valid tracks and excludes the unused reference slot', () => {
    expect(AUDIO_TRACKS.filter(Boolean)).toHaveLength(27); expect(AUDIO_TRACKS[8]).toBeNull();
  });
  it('delays first register writes by one frame and decodes all three intro voices together', () => {
    let frame = 0; const writes: number[][] = [];
    const driver = new ApuDriver((channel, register, value) => { if (register === 2) writes.push([frame, channel, value]); });
    for (const id of [1, 2, 3]) driver.trigger(id);
    frame++; driver.tick(); expect(writes).toEqual([]);
    frame++; driver.tick(); expect(writes).toEqual([[2, 0, 213], [2, 2, 171], [2, 1, 59]]);
    for (; frame < AUDIO_SCENE_TICKS.intro; frame++) driver.tick();
    expect([1, 2, 3].some(id => driver.active(id))).toBe(false);
  });
  it('reserves a channel for its higher-priority track between notes, without resetting lower-slot timing', () => {
    const writes: number[][] = []; let frame = 0;
    const driver = new ApuDriver((channel, register, value) => { if (channel === 1 && register === 2) writes.push([frame, value]); });
    driver.trigger(CUE.enemyEngine);
    for (frame = 1; frame <= 4; frame++) driver.tick();
    driver.trigger(CUE.pickup);
    for (; frame <= 10; frame++) driver.tick();
    expect(writes.filter(([at]) => at >= 6)).toEqual([[6, 29], [9, 213]]);
    expect(driver.active(CUE.enemyEngine)).toBe(true);
  });
  it('checks only pause slot while paused and leaves ordinary music counters intact', () => {
    const normal: number[][] = [], paused: number[][] = [];
    const driver = new ApuDriver((c, r, v) => normal.push([c, r, v]));
    const reference = new ApuDriver((c, r, v) => paused.push([c, r, v]));
    driver.trigger(1); reference.trigger(1); driver.tick(); reference.tick(); driver.tick(); reference.tick();
    for (let i = 0; i < 100; i++) driver.tick(true);
    normal.length = 0; paused.length = 0;
    for (let i = 0; i < 30; i++) { driver.tick(); reference.tick(); }
    expect(normal).toEqual(paused);
  });
});
