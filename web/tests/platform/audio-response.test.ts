import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { pcmPauseWindow } from '../browser/audio-probe';
import { pcmPauseWindowFeatures, pcmResponseObservation, snapshotPcmWindow, type AudioCapture } from '../browser/pcm-window';
import { processorFixture } from './audio-processor-fixture';

afterEach(() => vi.unstubAllGlobals());

function captureSamples(samples: Float32Array, rate: number, start = 1): AudioCapture {
  return { ready: true, gameReady: true, errors: [], rate, events: [], marks: [],
    packets: Array.from({ length: Math.ceil(samples.length / 128) }, (_, block) => {
      const offset = block * 128, frame = Math.round(start * rate) + offset;
      const chunk = samples.slice(offset, offset + 128);
      return { frame, frames: [frame], times: [frame / rate], lengths: [chunk.length], samples: chunk };
    }) };
}

function pauseFixture(rate = 44100, delay = 0.0876, mutation = ''): AudioCapture {
  // Independent EE2C pitches and timing, with an audible engine before pause.
  // No production cue, driver, synthesizer or analyzer constants generate this oracle.
  const pitches = [522.714077, 585.658704, 658.004779, 1045.428154, 1165.216797, 1316.009559, 782.243444];
  const first = Math.round(delay * rate), mute = first - Math.round(0.021 * rate);
  return captureSamples(Float32Array.from({ length: rate }, (_, index) => {
    const time = index / rate;
    if (index < mute || mutation === 'engine only') return 0.006 * Math.sin(2 * Math.PI * 61.7 * time);
    if (index < first) return 0;
    const elapsed = (index - first) / rate, ticks = elapsed * 60.0988;
    if (ticks >= 36) return mutation === 'residual sound' ? 0.01 : 0;
    const note = Math.min(6, Math.floor(ticks / 4));
    if (mutation === 'missing note' && note === 3) return 0;
    if (mutation === 'short last note' && ticks >= 30) return 0;
    if (mutation === 'blips' && ticks % 4 > 0.6) return 0;
    const frequency = pitches[note] * (mutation === 'wrong pitch' && note === 2 ? 1.2 : 1);
    return 0.02 * Math.cos(2 * Math.PI * frequency * elapsed);
  }), rate);
}

describe('hot audio response policy', () => {
  it.each([44100, 48000].flatMap(rate => (['shot', 'pause'] as const).map(kind => [rate, kind] as const)))
    ('compares sample-accurate 50ms/150ms boundaries at %i Hz for %s', (rate, kind) => {
      expect(pcmResponseObservation(kind, 1, 1.05, rate)).toMatchObject({ targetExceeded: false, limitExceeded: false });
      expect(pcmResponseObservation(kind, 1, 1.05 + 1 / rate, rate)).toMatchObject({ targetExceeded: true, limitExceeded: false });
      expect(pcmResponseObservation(kind, 1, 1.15, rate)).toMatchObject({ latencyMs: 150, limitExceeded: false });
      expect(pcmResponseObservation(kind, 1, 1.15 + 1 / rate, rate).limitExceeded).toBe(true);
      expect(pcmResponseObservation(kind, 1, null, rate)).toMatchObject({ latencyMs: null, targetExceeded: null, limitExceeded: true });
    });
});

describe('complete pause PCM measurement', () => {
  it.each([44100, 48000].flatMap(rate => [0.03, 0.0876, 0.15, 0.16].map(delay => [rate, delay] as const)))
    ('identifies the independent %i Hz phrase starting after %s seconds', (rate, delay) => {
      const match = pcmPauseWindowFeatures(1, pauseFixture(rate, delay));
      expect(match.onset).toBe(1 + Math.round(delay * rate) / rate);
      expect(match.notes).toHaveLength(7);
      expect(match.notes.at(-1)!.end - match.onset).toBeCloseTo(36 / 60.0988, 9);
      expect(match.phrase.rms).toBeGreaterThan(0.003);
      expect(match.silence.peak).toBe(0);
      expect(pcmResponseObservation('pause', 1, match.onset, rate).limitExceeded).toBe(delay > 0.15);
    });
  it.each(['engine only', 'wrong pitch', 'missing note', 'short last note', 'blips'])
    ('rejects %s instead of treating any audible PCM as pause', mutation => {
      expect(() => pcmPauseWindowFeatures(1, pauseFixture(44100, 0.0876, mutation))).toThrow(/Complete pause PCM signature was absent/);
    });
  it.each(['gap before onset', 'gap after phrase', 'non-finite tail'])('rejects %s across the entire capture', mutation => {
    const capture = pauseFixture();
    if (mutation === 'gap before onset') capture.packets.splice(1, 1);
    else if (mutation === 'gap after phrase') capture.packets.splice(320, 1);
    else capture.packets.at(-1)!.samples[0] = NaN;
    expect(() => pcmPauseWindowFeatures(1, capture)).toThrow(/Discontinuous PCM|Non-finite PCM/);
  });
  it.each([44100, 48000].flatMap(rate => [64, 128, 256].map(quantum => [rate, quantum] as const)))
    ('also matches native %i Hz PCM after the observed 66.8ms pause delivery with %i-sample blocks', async (rate, quantum) => {
      const { send, render } = await processorFixture(rate);
      send({ type: 'reset', generation: 2, music: [], offset: 0, engine: 18, paused: false, reason: 'manual' });
      const first = Math.round(rate * 0.0668), samples = new Float32Array(rate);
      samples.set(render(first, quantum));
      send({ type: 'pause', generation: 2, sequence: 1, paused: true, reason: 'manual', commands: [] });
      samples.set(render(rate - first, quantum), first);
      const match = pcmPauseWindowFeatures(0, captureSamples(samples.map(value => value * 0.3), rate, 0));
      expect(match.onset).toBeGreaterThan(0.08); expect(match.onset).toBeLessThan(0.09);
      expect(match.silence.peak).toBe(0);
    });
  it('retains the original snapshot and matched phrase when the silence assertion fails', async () => {
    const snapshot = snapshotPcmWindow({ start: 1, end: 2 }, pauseFixture(44100, 0.0876, 'residual sound'));
    const evaluate = vi.fn(async () => JSON.stringify(snapshot)), onFailure = vi.fn();
    const page = { evaluate, waitForFunction: vi.fn(async () => ({ dispose: vi.fn() })) } as unknown as Page;
    await expect(pcmPauseWindow(page, 1, onFailure, match => expect(match.silence.peak).toBe(0))).rejects.toThrow();
    expect(evaluate).toHaveBeenCalledOnce(); expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0][0]).toMatchObject({ snapshot, stage: 'assertion', match: { notes: expect.any(Array) } });
  });
});
