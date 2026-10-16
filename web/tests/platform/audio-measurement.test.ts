import { describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { createContext, runInContext } from 'node:vm';
import { pcmAssert, pcmFeatures, pcmMeasurement, type PcmMeasurementFailure } from '../browser/audio-probe';
import { pcmWindowFeatures, restorePcmSnapshot, snapshotPcmWindow, type AudioCapture } from '../browser/pcm-window';

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
