import { describe, expect, it } from 'vitest';
import { ApuSynth } from '../../src/platform/apu-synth';
import { ApuDriver } from '../../src/platform/apu-driver';
import { AUDIO_CPU_HZ, AUDIO_TICK_HZ, CUE } from '../../src/platform/audio-cues';

interface SynthState {
  channels: { registers: Uint8Array; timer: number; clock: number; phase: number; length: number;
    envelope: number; divider: number; envelopeStart: boolean; sweepDivider: number; sweepReload: boolean }[];
  sequencer: number; sequencerStep: number; linear: number; linearReload: boolean; noise: number;
}

function tone(rate: number, triangle = false): Float32Array {
  const synth = new ApuSynth(rate), channel = triangle ? 2 : 0;
  // Independent register fixture: timer213 pulse=522.714 Hz, timer427 triangle=130.678 Hz.
  for (const [register, value] of [triangle ? [0, 0xff] : [0, 0xbf], [1, 0x7f], [2, triangle ? 171 : 213], [3, triangle ? 0x41 : 0x40]]) synth.write(channel, register, value);
  return Float32Array.from({ length: rate / 4 }, () => synth.sample());
}
function amplitude(samples: Float32Array, rate: number, frequency: number): number {
  let real = 0, imaginary = 0;
  for (let index = 0; index < samples.length; index++) {
    const phase = 2 * Math.PI * frequency * index / rate;
    real += samples[index] * Math.cos(phase); imaginary += samples[index] * Math.sin(phase);
  }
  return 2 * Math.hypot(real, imaginary) / samples.length;
}
describe('sample-rate-independent four-channel PCM', () => {
  it.each([44100, 48000])('preserves timer pitch and square duty harmonics at %s Hz', rate => {
    const samples = tone(rate);
    const fundamental = amplitude(samples, rate, 522.714);
    expect(fundamental).toBeGreaterThan(0.06);
    expect(amplitude(samples, rate, 1045.428)).toBeLessThan(fundamental * 0.08);
    expect(amplitude(samples, rate, 1568.142)).toBeGreaterThan(fundamental * 0.2);
    expect(amplitude(samples, rate, 500)).toBeLessThan(fundamental * 0.1);
  });
  it.each([44100, 48000])('preserves the triangle clock and attenuates its third harmonic at %s Hz', rate => {
    const samples = tone(rate, true), fundamental = amplitude(samples, rate, 130.678);
    expect(fundamental).toBeGreaterThan(0.01);
    // The two high-pass stages attenuate 130 Hz more than its third harmonic.
    expect(amplitude(samples, rate, 392.034)).toBeLessThan(fundamental * 0.35);
  });
  it('starts silent, resets every channel/filter/LFSR, and produces deterministic noise', () => {
    const synth = new ApuSynth(44100);
    expect(Array.from({ length: 2000 }, () => synth.sample()).every(value => value === 0)).toBe(true);
    const writeNoise = () => { synth.write(3, 0, 0x3f); synth.write(3, 2, 10); synth.write(3, 3, 0x40); };
    synth.reset(); writeNoise(); const first = Float32Array.from({ length: 1000 }, () => synth.sample());
    synth.reset(); writeNoise(); const second = Float32Array.from({ length: 1000 }, () => synth.sample());
    expect(second).toEqual(first); expect(first.some(value => Math.abs(value) > 0.02)).toBe(true);
    synth.reset(); expect(synth.sample()).toBe(0);
  });
  it.each([44100, 48000])('renders all simultaneous reference voices without NaN or clipping at %s Hz', rate => {
    const synth = new ApuSynth(rate), driver = new ApuDriver((c, r, v) => synth.write(c, r, v));
    for (const id of [1, 2, 3, 7]) driver.trigger(id);
    let nextTick = 0, energy = 0, peak = 0, finite = true;
    for (let sample = 0; sample < rate; sample++) {
      if (sample >= nextTick) { driver.tick(); nextTick += rate / AUDIO_TICK_HZ; }
      const value = synth.sample(); finite &&= Number.isFinite(value);
      energy += value * value; peak = Math.max(peak, Math.abs(value));
    }
    expect(finite).toBe(true); expect(energy / rate).toBeGreaterThan(0.001); expect(peak).toBeLessThan(1);
  });
  it.each([[44100, 0], [44100, 0x80], [48000, 0], [48000, 0x80]])('retains hardware state and later cue PCM after silent jumps at %s Hz, noise mode %s', (rate, mode) => {
    const reference = new ApuSynth(rate), jumped = new ApuSynth(rate), synths = [reference, jumped];
    // Literal register fixtures exercise sweep, envelopes, the linear counter
    // and both LFSR modes. The oracle calls the existing audible sample path;
    // it does not reimplement the jump algorithm or derive expected transitions.
    const registers = [[0xbf, 0x9a, 213, 0x40], [0x7f, 0xac, 0x3b, 0x42],
      [0xff, 0, 0xab, 0x41], [0x3f, 0, mode, 0x40]];
    for (const synth of synths) for (let channel = 0; channel < 4; channel++) {
      for (let register = 0; register < 4; register++) synth.write(channel, register, registers[channel][register]);
    }
    for (let sample = 0; sample < Math.round(rate * 0.023); sample++) for (const synth of synths) synth.sample();
    for (const synth of synths) for (let channel = 0; channel < 4; channel++) synth.write(channel, 0, channel === 2 ? 0 : 0x10);
    for (let sample = 0; sample < Math.ceil(rate * 0.08); sample++) for (const synth of synths) synth.sample();
    for (const synth of synths) synth.clearFilters();
    const silence = Math.round(rate * 1.125);
    for (let sample = 0; sample < silence; sample++) reference.sample();
    const quanta = [64, 257, 11, 128];
    for (let advanced = 0, quantum = 0; advanced < silence; quantum++) {
      const length = Math.min(silence - advanced, quanta[quantum % quanta.length]);
      jumped.advanceSilence(length); advanced += length;
    }
    // Compare effective hardware phases after materializing muted LFSR work.
    for (const synth of synths) synth.advanceSilence(0);
    // Inspect the ordinary instance only in the test, without a public hook.
    const expected = reference as unknown as SynthState, actual = jumped as unknown as SynthState;
    expect(actual.channels.map(channel => ({ ...channel, clock: 0 }))).toEqual(expected.channels.map(channel => ({ ...channel, clock: 0 })));
    for (let channel = 0; channel < 4; channel++) expect(Math.abs(actual.channels[channel].clock - expected.channels[channel].clock)).toBeLessThan(0.00001);
    expect(Math.abs(actual.sequencer - expected.sequencer)).toBeLessThan(0.00001);
    expect([actual.sequencerStep, actual.linear, actual.linearReload, actual.noise]).toEqual([expected.sequencerStep, expected.linear, expected.linearReload, expected.noise]);
    const drivers = synths.map(synth => new ApuDriver((channel, register, value) => synth.write(channel, register, value)));
    for (const driver of drivers) for (const id of [CUE.stagePulse1, CUE.stageTriangle, CUE.stagePulse2, CUE.playerExplosion]) driver.trigger(id);
    let nextTick = 0, error = 0, peak = 0;
    for (let sample = 0; sample < Math.round(rate * 0.2); sample++) {
      if (sample >= nextTick) { for (const driver of drivers) driver.tick(); nextTick += rate / AUDIO_TICK_HZ; }
      const expectedPcm = reference.sample(), actualPcm = jumped.sample();
      error = Math.max(error, Math.abs(actualPcm - expectedPcm)); peak = Math.max(peak, Math.abs(expectedPcm));
    }
    expect(peak).toBeGreaterThan(0.01); expect(error).toBeLessThan(0.000001);
  });
  it.each([0, 0x80])('retains future noise PCM across muted timer and tap switches from mode %s', mode => {
    const reference = new ApuSynth(44100), muted = new ApuSynth(44100);
    const expected = reference as unknown as SynthState, actual = muted as unknown as SynthState;
    // A zero-volume, length-held reference uses the unchanged audible LFSR
    // path; the other instance has no active noise voice while clocks advance.
    for (const synth of [reference, muted]) synth.write(3, 0, 0x30);
    reference.write(3, 3, 0x40);
    for (const setting of [mode, mode | 2, (mode ^ 0x80) | 15]) {
      for (const synth of [reference, muted]) synth.write(3, 2, setting);
      expect(actual.noise).toBe(expected.noise);
      for (let sample = 0; sample < 512; sample++) expect(muted.sample()).toBe(reference.sample());
      expect(actual.channels[3].clock).toBe(expected.channels[3].clock);
    }
    const before = [actual.sequencer, actual.channels[3].clock];
    muted.advanceSilence(0);
    expect([actual.sequencer, actual.channels[3].clock]).toEqual(before);
    expect(actual.noise).toBe(expected.noise);
    for (let sample = 0; sample < 512; sample++) expect(muted.sample()).toBe(reference.sample());
    for (let sample = 0; sample < 257; sample++) reference.sample();
    muted.advanceSilence(257);
    expect(actual.noise).toBe(expected.noise);
    expect(Math.abs(actual.channels[3].clock - expected.channels[3].clock)).toBeLessThan(0.00001);
    for (let sample = 0; sample < 512; sample++) expect(muted.sample()).toBe(reference.sample());
    for (const synth of [reference, muted]) { synth.write(3, 0, 0x3f); synth.write(3, 3, 0x40); }
    const expectedPcm = Float64Array.from({ length: 1024 }, () => reference.sample());
    expect(Float64Array.from({ length: 1024 }, () => muted.sample())).toEqual(expectedPcm);
    expect(expectedPcm.some(value => Math.abs(value) > 0.02)).toBe(true);
  });
  it.each([44100, 48000])('bounds deferred noise steps and preserves later PCM and reset at %s Hz', rate => {
    const synth = new ApuSynth(rate), reference = new ApuSynth(rate);
    const actual = synth as unknown as SynthState & { deferredNoiseSteps: number };
    const expected = reference as unknown as SynthState;
    // Find the long-mode cycle with the literal one-step recurrence, independent
    // of the production matrix powers, instead of advancing a billion samples.
    const step = (state: number) => (state >> 1) | (((state ^ (state >> 1)) & 1) << 14);
    let cycle = 0, noise = 1;
    do { noise = step(noise); cycle++; } while (noise !== 1);
    const priorSteps = 0x40000000 - 8, steps = Math.floor(AUDIO_CPU_HZ / rate / 4);
    for (let count = 0; count < (priorSteps + steps) % cycle; count++) noise = step(noise);
    actual.deferredNoiseSteps = priorSteps;
    expect(synth.sample()).toBe(0);
    expect(actual.deferredNoiseSteps).toBe(0);
    expect(actual.noise).toBe(noise);
    reference.write(3, 0, 0x30); reference.write(3, 3, 0x40); reference.sample();
    expected.noise = noise;
    for (const instance of [synth, reference]) { instance.write(3, 0, 0x3f); instance.write(3, 3, 0x40); }
    const expectedPcm = Float64Array.from({ length: 512 }, () => reference.sample());
    expect(Float64Array.from({ length: 512 }, () => synth.sample())).toEqual(expectedPcm);
    expect(expectedPcm.some(value => Math.abs(value) > 0.02)).toBe(true);
    actual.deferredNoiseSteps = 0x40000000 - 1;
    synth.reset(); reference.reset();
    expect([actual.noise, actual.deferredNoiseSteps, actual.channels[3].clock]).toEqual([1, 0, 0]);
    for (const instance of [synth, reference]) {
      instance.write(3, 0, 0x3f); instance.write(3, 2, 0x8a); instance.write(3, 3, 0x40);
    }
    expect(Float64Array.from({ length: 512 }, () => synth.sample()))
      .toEqual(Float64Array.from({ length: 512 }, () => reference.sample()));
  });
});
