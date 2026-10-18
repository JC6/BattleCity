import { describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { createContext, runInContext } from 'node:vm';
import { expectOpeningPcm, pcmAssert, pcmFeatures, pcmMeasurement, type PcmMeasurementFailure, type PcmOpeningObservation } from '../browser/audio-probe';
import { pcmWindowFeatures, restorePcmSnapshot, snapshotPcmWindow, type AudioCapture } from '../browser/pcm-window';

vi.mock('node:timers', () => ({
  setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
}));

function fixture() {
  const capture: AudioCapture = { ready: true, gameReady: true, errors: [], rate: 1000, events: [], marks: [],
    packets: [{ frame: 0, frames: [0, 128], times: [0, 0.128], lengths: [128, 128], samples: new Float32Array(256).fill(0.01) }] };
  const parameters = { start: 0.032, end: 0.2, frequencies: [100] };
  const snapshot = snapshotPcmWindow(parameters, capture);
  const dispose = vi.fn(), evaluate = vi.fn(async (_expression: unknown, _parameters: unknown) => JSON.stringify(snapshot));
  const waitForFunction = vi.fn(async (_expression: unknown, _parameters: unknown, _options: unknown) => ({ dispose }));
  const page = { evaluate, waitForFunction } as unknown as Page;
  return { page, capture, parameters, snapshot, dispose, evaluate, waitForFunction };
}

function browserSerializationFixture() {
  const value = fixture();
  const realm = createContext({ window: { __AUDIO_PCM__: value.capture }, Float32Array, Uint8Array, btoa, performance });
  value.evaluate.mockImplementation(async (expression, parameters) => {
    realm.request = parameters;
    const wire = runInContext(typeof expression === 'function' ? `(${expression.toString()})(request)` : String(expression), realm);
    expect(typeof wire).toBe('string');
    return wire;
  });
  return value;
}

function openingFixture(delayMs: number | null, voices = [0.020, 0.012, 0.006]) {
  const value = fixture(), keyAt = 1, rate = 48000;
  const firstTone = delayMs === null ? Infinity : Math.round(delayMs * rate / 1000);
  value.capture.rate = rate;
  value.capture.packets = Array.from({ length: rate / 128 }, (_, block) => {
    const offset = block * 128, frame = keyAt * rate + offset;
    const samples = Float32Array.from({ length: 128 }, (_, index) => {
      const relative = offset + index - firstTone;
      if (relative < 0) return 0;
      return [522.714, 195.57, 130.678].reduce((sum, frequency, voice) =>
        sum + voices[voice] * Math.cos(2 * Math.PI * frequency * relative / rate), 0);
    });
    return { frame, frames: [frame], times: [frame / rate], lengths: [128], samples };
  });
  value.evaluate.mockImplementation(async (_expression, parameters) =>
    JSON.stringify(snapshotPcmWindow(parameters as { start: number; end: number }, value.capture)));
  const sampleAt = (relativeSeconds: number, sample: number) => {
    const index = Math.round(relativeSeconds * rate);
    value.capture.packets[Math.floor(index / 128)].samples[index % 128] = sample;
  };
  return { ...value, keyAt, sampleAt };
}

describe('functional opening PCM policy', () => {
  it.each([30, 120, 490])('accepts a complete opening delayed by %i ms with unchanged voice quality', async delay => {
    const value = openingFixture(delay), onObservation = vi.fn(), onFailure = vi.fn();
    const onset = await expectOpeningPcm(value.page, value.keyAt, { checkVoices: true, onObservation, onFailure });
    expect(onset).toBeCloseTo(value.keyAt + delay / 1000, 10);
    expect(onFailure).not.toHaveBeenCalled(); expect(onObservation).toHaveBeenCalledOnce();
    const observation: PcmOpeningObservation = onObservation.mock.calls[0][0];
    expect(observation).toEqual({ clock: 'AudioContext', keyAt: value.keyAt, onset,
      latencyMs: expect.any(Number), targetMs: 90, targetExceeded: delay > 90, functionalLimitMs: 500, rate: 48000 });
    expect(observation.latencyMs).toBeCloseTo(delay, 8);
    expect(value.evaluate).toHaveBeenCalledTimes(2);
  });

  it.each([500, 510, null])('rejects an absent opening before the deadline (delay %s), recording a null observation first', async delay => {
    const value = openingFixture(delay), onObservation = vi.fn(), onFailure = vi.fn();
    await expect(expectOpeningPcm(value.page, value.keyAt, { onObservation, onFailure })).rejects.toThrow();
    expect(onObservation).toHaveBeenCalledOnce(); expect(onFailure).toHaveBeenCalledOnce();
    expect(onObservation.mock.calls[0][0]).toMatchObject({ onset: null, latencyMs: null,
      targetExceeded: null, functionalLimitMs: 500 });
    expect(onObservation.mock.invocationCallOrder[0]).toBeLessThan(onFailure.mock.invocationCallOrder[0]);
    expect(onFailure.mock.calls[0][0]).toMatchObject({ stage: 'assertion', features: { onset: null } });
    expect(value.evaluate).toHaveBeenCalledOnce();
  });

  it.each(['gap before onset', 'missing tail', 'non-finite sample'] as const)('rejects %s even when later PCM contains the complete correct tune', async corruption => {
    const value = openingFixture(120), onObservation = vi.fn(), onFailure = vi.fn();
    if (corruption === 'gap before onset') value.capture.packets.splice(1, 1);
    else if (corruption === 'missing tail') value.capture.packets.splice(100, value.capture.packets.length - 101);
    else value.sampleAt(0.01, Number.NaN);
    await expect(expectOpeningPcm(value.page, value.keyAt, { checkVoices: true, onObservation, onFailure }))
      .rejects.toThrow(corruption === 'gap before onset' ? /Discontinuous PCM/ :
        corruption === 'missing tail' ? /Incomplete PCM interval/ : /Non-finite PCM sample/);
    expect(onObservation).not.toHaveBeenCalled(); expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0][0]).toMatchObject({ stage: 'measurement', snapshot: expect.any(Object) });
    expect(value.evaluate).toHaveBeenCalledOnce();
  });

  it('does not replace an early transient followed by silence with a later correct tune', async () => {
    const value = openingFixture(300), onObservation = vi.fn(), onFailure = vi.fn();
    value.sampleAt(0.03, 0.01);
    await expect(expectOpeningPcm(value.page, value.keyAt, { onObservation, onFailure })).rejects.toThrow();
    expect(onObservation.mock.calls[0][0].onset).toBeCloseTo(value.keyAt + 0.03, 10);
    expect(onFailure.mock.calls[0][0]).toMatchObject({ stage: 'assertion', features: { rms: 0 } });
    expect(value.evaluate).toHaveBeenCalledTimes(2);
  });

  it('rejects a detectable opening whose fixed audible window is too quiet', async () => {
    const value = openingFixture(120, [0.004, 0.0024, 0.0012]), onObservation = vi.fn(), onFailure = vi.fn();
    await expect(expectOpeningPcm(value.page, value.keyAt, { onObservation, onFailure })).rejects.toThrow();
    expect(onObservation.mock.calls[0][0].onset).not.toBeNull();
    expect(onFailure.mock.calls[0][0].stage).toBe('assertion');
    expect(onFailure.mock.calls[0][0].features.rms).toBeLessThan(0.008);
    expect(value.evaluate).toHaveBeenCalledTimes(2);
  });

  it.each(['before onset', 'after onset beyond the first window'] as const)('rejects an excessive peak %s', async where => {
    const value = openingFixture(490), onFailure = vi.fn();
    value.sampleAt(where === 'before onset' ? 0.01 : 0.54, 0.6);
    await expect(expectOpeningPcm(value.page, value.keyAt, { onFailure })).rejects.toThrow();
    expect(onFailure.mock.calls[0][0]).toMatchObject({ stage: 'assertion', features: { peak: expect.any(Number) } });
    expect(onFailure.mock.calls[0][0].features.peak).toBeGreaterThan(0.5);
  });

  it.each([0, 1, 2])('rejects missing voice %i when voice verification is requested', async missing => {
    const voices = [0.020, 0.012, 0.006]; voices[missing] = 0;
    const value = openingFixture(120, voices), onFailure = vi.fn();
    await expect(expectOpeningPcm(value.page, value.keyAt, { checkVoices: true, onFailure })).rejects.toThrow();
    expect(onFailure.mock.calls[0][0].features.rms).toBeGreaterThan(0.008);
    expect(onFailure.mock.calls[0][0].features.amplitudes[missing]).toBeLessThan([0.005, 0.003, 0.001][missing]);
  });

  it('allows the continuity setup to check audible PCM without repeating voice verification', async () => {
    const value = openingFixture(120, [0.020, 0, 0]);
    await expect(expectOpeningPcm(value.page, value.keyAt)).resolves.toBeCloseTo(value.keyAt + 0.12, 10);
  });

  it('rejects corrupted data in the relative quality window beyond the opening deadline', async () => {
    const value = openingFixture(490), onObservation = vi.fn(), onFailure = vi.fn();
    value.sampleAt(0.54, Number.NaN);
    await expect(expectOpeningPcm(value.page, value.keyAt, { onObservation, onFailure })).rejects.toThrow(/Non-finite PCM sample/);
    expect(onObservation).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0][0]).toMatchObject({ stage: 'measurement', snapshot: expect.any(Object) });
    expect(value.evaluate).toHaveBeenCalledTimes(2);
  });

  it('preserves a stopped audio clock coverage failure without inventing an observation or PCM', async () => {
    const value = openingFixture(30), original = new Error('Native audio coverage timed out'), onObservation = vi.fn(), onFailure = vi.fn();
    value.waitForFunction.mockRejectedValue(original);
    await expect(expectOpeningPcm(value.page, value.keyAt, { onObservation, onFailure })).rejects.toBe(original);
    expect(value.waitForFunction.mock.calls[0][2]).toMatchObject({ timeout: 15000 });
    expect(value.evaluate).not.toHaveBeenCalled(); expect(onObservation).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0][0]).toMatchObject({ stage: 'coverage', error: original, snapshot: undefined });
  });

  it.each([30, null])('ignores observation attachment failure without changing the PCM verdict (delay %s)', async delay => {
    const value = openingFixture(delay), onObservation = vi.fn(async () => { throw new Error('Observation attachment failed'); });
    const onFailure = vi.fn(), result = expectOpeningPcm(value.page, value.keyAt, { onObservation, onFailure });
    if (delay === null) {
      await expect(result).rejects.toThrow();
      expect(onFailure.mock.calls[0][0]).toMatchObject({ stage: 'assertion', features: { onset: null } });
      expect(String(onFailure.mock.calls[0][0].error)).not.toContain('Observation attachment failed');
    } else {
      await expect(result).resolves.toBeCloseTo(value.keyAt + delay / 1000, 10);
      expect(onFailure).not.toHaveBeenCalled();
    }
    expect(onObservation).toHaveBeenCalledOnce();
  });

  it.each([30, null])('bounds an observation that never settles without replacing the PCM verdict (delay %s)', async delay => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const value = openingFixture(delay), onObservation = vi.fn(() => new Promise<void>(() => {})), onFailure = vi.fn();
      let settled = false;
      const result = expectOpeningPcm(value.page, value.keyAt, { onObservation, onFailure }).then(
        onset => { settled = true; return { onset, error: undefined }; },
        error => { settled = true; return { onset: undefined, error }; });
      await vi.advanceTimersByTimeAsync(2999);
      expect(onObservation).toHaveBeenCalledOnce(); expect(settled).toBe(false); expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      const outcome = await result;
      if (delay === null) {
        expect(outcome.error).toBeInstanceOf(Error);
        expect(onFailure.mock.calls[0][0]).toMatchObject({ stage: 'assertion', features: { onset: null }, error: outcome.error });
      } else {
        expect(outcome.error).toBeUndefined(); expect(outcome.onset).toBeCloseTo(value.keyAt + delay / 1000, 10);
        expect(onFailure).not.toHaveBeenCalled();
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe('exact PCM measurement diagnostics', () => {
  it('exports a standalone browser snapshot as one string with unchanged PCM bytes, labels and observations', async () => {
    const value = browserSerializationFixture();
    value.capture.events.push({ kind: 'keydown', code: 'KeyJ', at: 0.03 });
    value.capture.transport = { next: 0, dropped: 3, observationErrors: 0,
      entries: Array.from({ length: 512 }, (_, sequence) => ({ direction: 'send', type: 'frames',
        generation: 2, wall: 1700000000000 + sequence, sequence, at: sequence / 60,
        frames: [{ tick: sequence, start: sequence === 511 ? [15] : [], stop: [] }] })) };
    const expected = snapshotPcmWindow(value.parameters, value.capture);
    const result = await pcmMeasurement(value.page, value.parameters.start, value.parameters.end, value.parameters.frequencies);
    expect(result.snapshot).toEqual({ ...expected, timing: expect.any(Object) });
    expect(result.features).toEqual(pcmWindowFeatures(value.parameters, value.capture));
    expect(value.evaluate).toHaveBeenCalledOnce();
  });
  it.each(['non-finite time', 'invalid length', 'non-finite sample'] as const)('still rejects %s after the actual string export', async corruption => {
    const value = browserSerializationFixture(), raw = value.capture.packets[0], observer = vi.fn();
    if (corruption === 'non-finite time') raw.times[1] = Number.NaN;
    else if (corruption === 'invalid length') raw.lengths[1] = Number.POSITIVE_INFINITY;
    else new Uint32Array(raw.samples.buffer)[150] = 0x7fc12345;
    await expect(pcmMeasurement(value.page, value.parameters.start, value.parameters.end, value.parameters.frequencies, observer))
      .rejects.toThrow(corruption === 'non-finite time' ? /frame\/time labels disagree/ :
        corruption === 'invalid length' ? /Invalid PCM quantum labels/ : /Non-finite PCM sample/);
    expect(observer).toHaveBeenCalledOnce(); expect(value.evaluate).toHaveBeenCalledOnce();
    const failure = observer.mock.calls[0][0];
    expect(failure.stage).toBe('measurement');
    expect(failure.snapshot.packets[0].samplesBase64).toBe(Buffer.from(raw.samples.buffer).toString('base64'));
  });
  it('checks a successful measurement once without observing failure or resampling', async () => {
    const value = fixture(), observer = vi.fn(), assertion = vi.fn();
    const result = await pcmAssert(value.page, value.parameters.start, value.parameters.end, value.parameters.frequencies, assertion, observer);
    expect(assertion).toHaveBeenCalledOnce(); expect(assertion).toHaveBeenCalledWith(result);
    expect(result).toEqual(pcmWindowFeatures(value.parameters, restorePcmSnapshot(value.snapshot)));
    expect(value.waitForFunction).toHaveBeenCalledOnce(); expect(value.evaluate).toHaveBeenCalledOnce();
    expect(observer).not.toHaveBeenCalled();
  });
  it.each(['coverage', 'sampling', 'measurement'] as const)('observes a %s failure once before assertions', async stage => {
    const value = fixture(), original = new Error(`${stage} failed`), observer = vi.fn(), assertion = vi.fn();
    if (stage === 'coverage') value.waitForFunction.mockRejectedValue(original);
    else if (stage === 'sampling') value.evaluate.mockRejectedValue(original);
    else value.snapshot.errors.push(original.message);
    let caught: unknown;
    try { await pcmAssert(value.page, value.parameters.start, value.parameters.end, value.parameters.frequencies, assertion, observer); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error); expect((caught as Error).message).toBe(original.message);
    if (stage !== 'measurement') expect(caught).toBe(original);
    expect(observer).toHaveBeenCalledOnce(); expect(assertion).not.toHaveBeenCalled();
    const observed = observer.mock.calls[0][0];
    expect(observed.error).toBe(caught); expect(observed.stage).toBe(stage);
    expect(observed.parameters).toEqual(value.parameters); expect(observed.features).toBeUndefined();
    expect(observed.snapshot).toEqual(stage === 'measurement' ? value.snapshot : undefined);
    expect(value.evaluate).toHaveBeenCalledTimes(stage === 'coverage' ? 0 : 1);
  });
  it('observes an assertion failure once with its original error and exact analyzed sample', async () => {
    const value = fixture(), original = new Error('PCM assertion failed'), observer = vi.fn();
    let analyzed: unknown;
    await expect(pcmAssert(value.page, value.parameters.start, value.parameters.end, value.parameters.frequencies, features => {
      analyzed = features; throw original;
    }, observer)).rejects.toBe(original);
    expect(observer).toHaveBeenCalledOnce();
    const observed = observer.mock.calls[0][0];
    expect(observed.error).toBe(original); expect(observed.stage).toBe('assertion');
    expect(observed.snapshot).toEqual(value.snapshot); expect(observed.parameters).toEqual(value.parameters);
    expect(observed.features).toBe(analyzed);
    expect(value.waitForFunction).toHaveBeenCalledOnce(); expect(value.evaluate).toHaveBeenCalledOnce();
  });
  it('preserves the assertion error when attaching its retained measurement fails', async () => {
    const value = fixture(), original = new Error('PCM assertion failed');
    const observer = vi.fn(async () => { throw new Error('attachment failed'); });
    await expect(pcmAssert(value.page, value.parameters.start, value.parameters.end, value.parameters.frequencies, () => {
      throw original;
    }, observer)).rejects.toBe(original);
    expect(observer).toHaveBeenCalledOnce(); expect(value.evaluate).toHaveBeenCalledOnce();
  });
  it('retains the analyzed raw snapshot, parameters and features without a second sample', async () => {
    const value = fixture(), observer = vi.fn();
    const result = await pcmMeasurement(value.page, value.parameters.start, value.parameters.end, value.parameters.frequencies, observer);
    expect(result.snapshot).toEqual(value.snapshot);
    expect(result.parameters).toEqual(value.parameters);
    expect(result.features).toEqual(pcmWindowFeatures(value.parameters, restorePcmSnapshot(value.snapshot)));
    expect(value.waitForFunction).toHaveBeenCalledOnce();
    expect(value.waitForFunction.mock.calls[0][1]).toBe(value.parameters.end);
    expect(value.evaluate).toHaveBeenCalledOnce();
    expect(value.evaluate.mock.calls[0][1]).toEqual({ start: value.parameters.start, end: value.parameters.end, measure: true });
    expect(value.dispose).toHaveBeenCalledOnce(); expect(observer).not.toHaveBeenCalled();
  });
  it('keeps the existing pcmFeatures result and its wait and sample behavior', async () => {
    const value = fixture();
    const result = await pcmFeatures(value.page, value.parameters.start, value.parameters.end, value.parameters.frequencies);
    expect(result).toEqual(pcmWindowFeatures(value.parameters, restorePcmSnapshot(value.snapshot)));
    expect(value.waitForFunction).toHaveBeenCalledOnce(); expect(value.evaluate).toHaveBeenCalledOnce();
  });
  it('preserves the coverage or sampling error with no nonexistent sample or measured features', async () => {
    for (const stage of ['coverage', 'sampling'] as const) {
      const value = fixture(), original = new Error(`${stage} RPC failed`), observer = vi.fn();
      if (stage === 'coverage') value.waitForFunction.mockRejectedValue(original);
      else value.evaluate.mockRejectedValue(original);
      await expect(pcmMeasurement(value.page, value.parameters.start, value.parameters.end, value.parameters.frequencies, observer)).rejects.toBe(original);
      expect(observer).toHaveBeenCalledOnce();
      const observed = observer.mock.calls[0][0];
      expect(observed).toMatchObject({ stage, parameters: value.parameters });
      expect(observed.error).toBe(original); expect(observed.snapshot).toBeUndefined(); expect(observed.features).toBeUndefined();
      expect(value.evaluate).toHaveBeenCalledTimes(stage === 'coverage' ? 0 : 1);
    }
  });
  it('retains the exact malformed snapshot and analysis failure even when its attachment fails', async () => {
    const value = fixture(), original = new Error('artifact write failed');
    value.snapshot.errors.push('Raw PCM capture failed');
    const observer = vi.fn(async (_failure: PcmMeasurementFailure) => { throw original; });
    let caught: unknown;
    try { await pcmMeasurement(value.page, value.parameters.start, value.parameters.end, value.parameters.frequencies, observer); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error); expect((caught as Error).message).toBe('Raw PCM capture failed');
    const observed = observer.mock.calls[0][0];
    expect(observed.error).toBe(caught); expect(observed.snapshot).toEqual(value.snapshot);
    expect(observed.stage).toBe('measurement'); expect(observed.features).toBeUndefined();
    expect(value.evaluate).toHaveBeenCalledOnce();
  });
});
