import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from '@playwright/test';
import { createContext, runInContext } from 'node:vm';
import { attachPcmFailure, beginPcmCapture, installPcmProbe, pcmShotWindow } from '../browser/audio-probe';
import { observePcmShotFailure, pcmResponseObservation, pcmShotWindowFeatures, pcmWindowFeatures, restorePcmSnapshot, snapshotPcmWindow, type AudioCapture, type PcmPacket } from '../browser/pcm-window';
import { ApuDriver } from '../../src/platform/apu-driver';
import { ApuSynth } from '../../src/platform/apu-synth';

vi.mock('node:timers', () => ({
  setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback, delay),
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(timer),
}));

afterEach(() => { vi.useRealTimers(); });

function pageInRealm(realm: ReturnType<typeof createContext>): Page {
  const evaluate = (expression: (...args: never[]) => unknown, argument?: unknown) =>
    runInContext(`(${expression.toString()})(${JSON.stringify(argument) ?? 'undefined'})`, realm);
  return {
    addInitScript: vi.fn(async (source: string) => { runInContext(source, realm); }),
    evaluate: vi.fn(async (expression, argument) => evaluate(expression, argument)),
    waitForFunction: vi.fn(async (expression, argument) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        await Promise.resolve();
        const value = evaluate(expression, argument);
        if (value) return { jsonValue: async () => value, dispose: vi.fn() };
      }
      throw new Error('Fixture predicate never became ready');
    }),
  } as unknown as Page;
}

describe('deferred native audio event observation', () => {
  async function eventFixture(currentTime: () => number, observeDelivery = false) {
    const listeners = new Map<string, ((event: { code?: string; repeat?: boolean }) => void)[]>();
    const browserWindow: { __AUDIO_PCM__?: AudioCapture; addEventListener: (kind: string,
      listener: (event: { code?: string; repeat?: boolean }) => void) => void } = {
      addEventListener(kind, listener) {
        listeners.set(kind, [...(listeners.get(kind) ?? []), listener]);
      },
    };
    class AudioNode { connect() { return this; } }
    class AudioDestinationNode extends AudioNode {}
    class GainNode extends AudioNode {}
    class AudioWorkletNode extends AudioNode {}
    class AudioContext {}
    const realm = createContext({ window: browserWindow, AudioNode, AudioDestinationNode, GainNode, AudioWorkletNode, AudioContext,
      Blob, URL: { createObjectURL: () => 'blob:pcm-fixture', revokeObjectURL() {} } });
    const page = pageInRealm(realm);
    await installPcmProbe(page, { deferRecording: true, observeDelivery });
    const capture = browserWindow.__AUDIO_PCM__!;
    capture.context = { state: 'running', get currentTime() { return currentTime(); } } as unknown as NonNullable<AudioCapture['context']>;
    capture.rate = 44100; capture.ready = true; capture.gameReady = true;
    const emit = (kind: string, event: { code?: string; repeat?: boolean } = {}) => {
      for (const listener of listeners.get(kind) ?? []) listener(event);
    };
    return { page, capture, emit, AudioNode, AudioDestinationNode, GainNode, AudioWorkletNode, AudioContext };
  }
  async function transportFixture(observeDelivery = false) {
    const clock = vi.fn((): number => { throw new Error('Transport must not read native audio time'); });
    const fixture = await eventFixture(clock, observeDelivery);
    const result = { delegated: true };
    const post = vi.fn(function (this: unknown, ..._args: unknown[]) { return result; });
    const port = {
      postMessage: post,
      addEventListener: vi.fn(),
      start: vi.fn(),
      onmessage: null as null | ((event: { data: unknown }) => void),
    };
    const worklet = new fixture.AudioWorkletNode();
    Object.defineProperty(worklet, 'port', { value: port });
    fixture.capture.gain = new fixture.GainNode() as unknown as GainNode;
    const connect = () => Reflect.apply(worklet.connect, worklet, [fixture.capture.gain]);
    const receive = (data: unknown) => {
      const event = { data };
      port.onmessage?.(event);
      return event;
    };
    return { ...fixture, clock, worklet, port, post, result, connect, receive };
  }
  it('delegates original messages, transfers and receiver without listening to replies', async () => {
    const { capture, worklet, port, post, result, connect, receive, clock } = await transportFixture();
    expect(connect()).toBe(worklet); expect(connect()).toBe(worklet);
    expect(port.addEventListener).not.toHaveBeenCalled(); expect(port.start).not.toHaveBeenCalled();
    const receiver = vi.fn(); port.onmessage = receiver;
    const transfers = [new ArrayBuffer(4)];
    const message = { type: 'commands', generation: 3, sequence: 7,
      commands: [{ id: 15, start: true }] };
    expect(Reflect.apply(port.postMessage, port, [message, transfers])).toBe(result);
    expect(post).toHaveBeenCalledExactlyOnceWith(message, transfers); expect(post.mock.contexts[0]).toBe(port);
    port.postMessage({ type: 'pause', generation: 3, sequence: 8, paused: false, reason: 'manual', commands: [], confirm: true });
    const event = receive({ type: 'control-applied', generation: 3, sequence: 8 });
    expect(port.onmessage).toBe(receiver); expect(receiver).toHaveBeenCalledExactlyOnceWith(event);
    expect(capture.firstReset).toBeUndefined();
    expect(clock).not.toHaveBeenCalled(); expect(capture.errors).toEqual([]);
  });
  it('retains only the first reset and snapshots independent music, events and marks', async () => {
    const { capture, port, connect, clock } = await transportFixture(); connect();
    const reset = { type: 'reset', generation: 4, offset: 12, music: [1, 2, 3], engine: null, paused: false, reason: 'manual' };
    port.postMessage(reset);
    expect(capture.firstReset).toEqual(reset); expect(capture.firstReset).not.toBe(reset);
    reset.music[0] = 99;
    port.postMessage({ ...reset, generation: 5, offset: 0 });
    expect(capture.firstReset).toMatchObject({ generation: 4, offset: 12, music: [1, 2, 3] });
    capture.events.push({ kind: 'keydown', code: 'KeyJ', at: 8.5 }); capture.marks.push({ kind: 'game', at: 1 });
    capture.rate = 1000; capture.packets = [packet([0])];
    const snapshot = snapshotPcmWindow({ start: 0, end: 0.128 }, capture);
    capture.events[0].at = 99; capture.marks[0].at = 99;
    Object.assign(capture.firstReset!.music, { 0: 99 });
    expect(snapshot.diagnostics).toEqual({
      events: [{ kind: 'keydown', code: 'KeyJ', at: 8.5 }], marks: [{ kind: 'game', at: 1 }],
      firstReset: { ...reset, music: [1, 2, 3] },
    });
    const direct = pcmWindowFeatures({ start: 0, end: 0.128, frequencies: [] }, capture);
    expect(pcmWindowFeatures({ start: 0, end: 0.128, frequencies: [] }, restorePcmSnapshot(snapshot))).toEqual(direct);
    expect(clock).not.toHaveBeenCalled(); expect(capture.errors).toEqual([]);
  });
  it('preserves native post errors and receiver delivery when optional observation fails', async () => {
    const { capture, port, post, connect, receive } = await transportFixture(); connect();
    const receiver = vi.fn(); port.onmessage = receiver;
    const malformed = { get type(): string { throw new Error('Broken diagnostic value'); } };
    expect(Reflect.apply(port.postMessage, port, [malformed])).toEqual({ delegated: true });
    receive(malformed); expect(receiver).toHaveBeenCalledOnce();
    expect(capture.errors).toEqual([]);
    const reset = { type: 'reset', generation: 4, offset: 12, music: [1, 2, 3], engine: null, paused: false, reason: 'manual' };
    const failure = new Error('Native post failed'); post.mockImplementationOnce(() => { throw failure; });
    expect(() => port.postMessage(reset)).toThrow(failure);
    expect(post).toHaveBeenCalledTimes(2); expect(capture.firstReset).toBeUndefined();
    port.postMessage(reset); expect(capture.firstReset).toEqual(reset);
  });
  it('records only shot and control sends after capture starts, with independent snapshot data', async () => {
    const { page, capture, port, connect, clock } = await transportFixture(true); connect();
    const shot = { type: 'commands', generation: 3, sequence: 1,
      commands: [{ id: 15, start: true }, { id: 18, start: true }] };
    port.postMessage(shot);
    expect(capture.delivery!.entries).toEqual([]); expect(clock).not.toHaveBeenCalled();
    clock.mockReturnValue(3); await beginPcmCapture(page);
    port.postMessage({ ...shot, commands: [{ id: 18, start: true }] });
    expect(clock).toHaveBeenCalledOnce();
    const reset = { type: 'reset', generation: 4, offset: 12, music: [1, 2, 3], engine: null, paused: false, reason: 'manual' };
    port.postMessage(reset); port.postMessage(shot);
    port.postMessage({ type: 'pause', generation: 4, sequence: 2, paused: true, reason: 'focus', commands: [] });
    reset.music[0] = 99; shot.commands[0].start = false;
    capture.rate = 1000; capture.packets = [packet([0])];
    const snapshot = snapshotPcmWindow({ start: 0, end: 0.128 }, capture);
    expect(snapshot.diagnostics!.delivery).toEqual({ overflow: false, entries: [
      { at: 3, message: { ...reset, music: [1, 2, 3] } },
      { at: 3, message: { ...shot, commands: [{ id: 15, start: true }] } },
      { at: 3, message: { type: 'pause', generation: 4, sequence: 2, paused: true, reason: 'focus', commands: [] } },
    ] });
    const recorded = capture.delivery!.entries[1].message;
    if (recorded.type === 'commands') recorded.commands[0].start = false;
    capture.delivery!.entries[0].at = 99;
    expect(snapshot.diagnostics!.delivery!.entries[0].at).toBe(3);
    expect(snapshot.diagnostics!.delivery!.entries[1].message).toMatchObject({ commands: [{ id: 15, start: true }] });
    expect(capture.errors).toEqual([]);
  });
  it('bounds delivery evidence at 64 entries and marks overflow without discarding native sends or PCM', async () => {
    const { page, capture, port, post, connect, clock } = await transportFixture(true); connect();
    clock.mockReturnValue(3); await beginPcmCapture(page);
    for (let sequence = 1; sequence <= 70; sequence++)
      port.postMessage({ type: 'commands', generation: 1, sequence, commands: [{ id: 15, start: true }] });
    expect(post).toHaveBeenCalledTimes(70); expect(capture.delivery!.entries).toHaveLength(64);
    expect(capture.delivery!.entries.at(-1)!.message).toMatchObject({ sequence: 64 });
    capture.rate = 1000; capture.packets = [packet([0])];
    const snapshot = snapshotPcmWindow({ start: 0, end: 0.128 }, capture);
    expect(snapshot.diagnostics!.delivery!.overflow).toBe(true);
    expect(pcmWindowFeatures({ start: 0, end: 0.128, frequencies: [] }, restorePcmSnapshot(snapshot)).rms).toBeGreaterThan(0);
    expect(capture.errors).toEqual([]);
  });
  it('marks unavailable delivery evidence while preserving native results and exceptions', async () => {
    const { page, capture, port, post, result, connect, clock } = await transportFixture(true); connect();
    clock.mockReturnValue(3); await beginPcmCapture(page);
    clock.mockImplementation(() => { throw new Error('Optional clock unavailable'); });
    const shot = { type: 'commands', generation: 1, sequence: 1, commands: [{ id: 15, start: true }] };
    expect(port.postMessage(shot)).toBe(result);
    expect(capture.delivery).toEqual({ entries: [], overflow: false, unavailable: true });
    const failure = new Error('Native post failed'); post.mockImplementationOnce(() => { throw failure; });
    expect(() => port.postMessage(shot)).toThrow(failure);
    expect(capture.errors).toEqual([]);
  });
  it('keeps a failing optional diagnostic snapshot separate from validated raw PCM', async () => {
    const { capture } = await transportFixture(); capture.rate = 1000; capture.packets = [packet([0])];
    Object.defineProperty(capture, 'firstReset', { get() { throw new Error('Broken optional reset'); } });
    const snapshot = snapshotPcmWindow({ start: 0, end: 0.128 }, capture);
    expect(snapshot.diagnostics).toEqual({ unavailable: true });
    expect(pcmWindowFeatures({ start: 0, end: 0.128, frequencies: [] }, restorePcmSnapshot(snapshot)).rms).toBeGreaterThan(0);
    expect(capture.errors).toEqual([]);
  });
  it('does not read native event time for preparation keydown or blur while recording is deferred', async () => {
    const clock = vi.fn((): number => { throw new Error('Preparation must not read the native clock'); });
    const { capture, emit } = await eventFixture(clock);
    emit('keydown', { code: 'KeyS', repeat: false });
    emit('keydown', { code: 'KeyS', repeat: true });
    emit('blur');
    expect(clock).not.toHaveBeenCalled();
    expect(capture.recording).toBe(false); expect(capture.events).toEqual([]);
    expect(capture.errors).toEqual([]);
  });
  it('keeps original event times, order, repeat filtering and capacity after actual recording begins', async () => {
    let at = 3;
    const clock = vi.fn(() => at);
    const { page, capture, emit } = await eventFixture(clock);
    await beginPcmCapture(page);
    expect(capture.recording).toBe(true); expect(capture.recordFromFrame).toBe(3 * 44100);
    expect(clock).toHaveBeenCalledOnce();
    at = 3.25; emit('keydown', { code: 'Enter', repeat: false });
    emit('keydown', { code: 'Enter', repeat: true });
    at = 3.5; emit('blur');
    expect(capture.events).toEqual([
      { kind: 'keydown', code: 'Enter', at: 3.25 }, { kind: 'blur', code: '', at: 3.5 },
    ]);
    expect(clock).toHaveBeenCalledTimes(3);
    for (let index = 0; index < 126; index++) {
      at = 4 + index / 1000;
      emit('keydown', { code: 'KeyJ', repeat: false });
    }
    expect(capture.events).toHaveLength(128); expect(clock).toHaveBeenCalledTimes(129);
    expect(capture.events[127]).toEqual({ kind: 'keydown', code: 'KeyJ', at: 4.125 });
    emit('keydown', { code: 'KeyJ', repeat: false });
    expect(capture.events).toHaveLength(128); expect(clock).toHaveBeenCalledTimes(129);
    expect(capture.errors).toEqual(['Audio event observation exceeded its bounded capacity']);
  });
  it('delegates later and non-gain connections without reading their native context', async () => {
    const { capture, AudioNode, GainNode, AudioWorkletNode } = await eventFixture(() => 1);
    const context = vi.fn(() => { throw new Error('Connection observation must not read this native context'); });
    const node = new AudioNode(), gain = new GainNode(), worklet = new AudioWorkletNode();
    for (const candidate of [node, gain, worklet]) Object.defineProperty(candidate, 'context', { get: context });
    const capturedContext = capture.context;
    capture.context = undefined;
    expect(node.connect()).toBe(node);
    capture.context = capturedContext;
    expect(gain.connect()).toBe(gain);
    capture.gain = gain as unknown as GainNode;
    capture.gameReady = false;
    expect(Reflect.apply(worklet.connect, worklet, [gain])).toBe(worklet);
    expect(capture.gameReady).toBe(true);
    expect(context).not.toHaveBeenCalled();
  });
  it('archives a replaced graph and observes its new clock without clearing previous errors', async () => {
    const { page, capture, port, connect, clock, AudioContext, AudioDestinationNode, GainNode, AudioWorkletNode } = await transportFixture(true);
    connect(); clock.mockReturnValue(5); await beginPcmCapture(page);
    const reset = { type: 'reset', generation: 4, offset: 12, music: [1, 2, 3], engine: null, paused: false, reason: 'manual' };
    port.postMessage(reset);
    const old = capture.context!, packets = capture.packets, events = capture.events, delivery = capture.delivery!;
    events.push({ kind: 'keydown', code: 'Enter', at: 5 });
    capture.errors.push('retained diagnostic');
    const replacement = Object.assign(new AudioContext(), { destination: new AudioDestinationNode(), sampleRate: 48000, currentTime: 0,
      audioWorklet: { addModule: () => new Promise<void>(() => {}) } });
    const gain = new GainNode(); Object.defineProperty(gain, 'context', { value: replacement });
    expect(Reflect.apply(gain.connect, gain, [replacement.destination])).toBe(gain);
    expect(capture.retiredGraphs).toHaveLength(1);
    expect(capture.retiredGraphs![0].context).toBe(old);
    expect(capture.retiredGraphs![0]).toMatchObject({ packets, events, firstReset: reset });
    expect(capture.retiredGraphs![0].delivery).toBe(delivery);
    expect(delivery.entries).toEqual([{ at: 5, message: reset }]);
    expect(capture.delivery).toEqual({ entries: [], overflow: false });
    expect(capture.context).toBe(replacement); expect(capture.rate).toBe(48000);
    expect(capture.ready).toBe(false); expect(capture.gameReady).toBe(false);
    expect(capture.packets).toEqual([]); expect(capture.events).toEqual([]);
    expect(capture.errors).toEqual(['retained diagnostic']);
    Reflect.apply(gain.connect, gain, [replacement.destination]);
    expect(capture.retiredGraphs).toHaveLength(1);
    port.postMessage({ ...reset, generation: 5 });
    expect(capture.firstReset).toBeUndefined();
    const worklet = new AudioWorkletNode(), newPort = { postMessage: vi.fn() };
    Object.defineProperty(worklet, 'port', { value: newPort });
    Reflect.apply(worklet.connect, worklet, [gain]);
    const newReset = { ...reset, generation: 6, offset: 30 };
    newPort.postMessage(newReset);
    port.postMessage({ ...reset, generation: 7 });
    expect(capture.firstReset).toEqual(newReset);
    expect(capture.retiredGraphs![0].firstReset).toEqual(reset);
    expect(capture.delivery!.entries).toEqual([{ at: 0, message: newReset }]);
    expect(delivery.entries).toHaveLength(1);
  });
});

describe('native PCM tap activation', () => {
  async function fixture(deferRecording = true) {
    const worklets: AudioWorkletNode[] = [];
    const edges: unknown[][] = [];
    class AudioNode {
      connect(destination: unknown) { edges.push([this, destination]); return destination; }
      disconnect = vi.fn();
    }
    class AudioDestinationNode extends AudioNode {}
    class GainNode extends AudioNode {
      gain = { value: 1 };
      constructor(readonly context: AudioContext) { super(); }
    }
    class AudioContext {
      state = 'running'; sampleRate = 44100; currentTime = 3;
      destination = new AudioDestinationNode();
      audioWorklet = { addModule: vi.fn((_url: string): Promise<void> => Promise.resolve()) };
      createGain() { return new GainNode(this); }
    }
    class AudioWorkletNode extends AudioNode {
      port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null as null | ((event: { data: PcmPacket }) => void) };
      constructor(readonly context: AudioContext, readonly name: string) {
        super(); worklets.push(this);
        if (name === 'battlecity-test-pcm') queueMicrotask(() => this.port.onmessage?.({ data: packet([0]) }));
      }
    }
    const browserWindow = { addEventListener() {}, __AUDIO_PCM__: undefined as AudioCapture | undefined };
    const revoke = vi.fn();
    const realm = createContext({ window: browserWindow, AudioNode, AudioDestinationNode, GainNode, AudioWorkletNode,
      AudioContext, Blob, URL: { createObjectURL: () => 'blob:tap-test', revokeObjectURL: revoke } });
    const page = pageInRealm(realm);
    await installPcmProbe(page, { deferRecording });
    const capture = browserWindow.__AUDIO_PCM__!;
    const connectGame = (context = new AudioContext()) => {
      const gain = context.createGain(); gain.connect(context.destination);
      const game = new AudioWorkletNode(context, 'game');
      expect(game.connect(gain)).toBe(gain);
      return { context, game, gain };
    };
    return { page, capture, connectGame, worklets, edges, revoke, AudioContext };
  }
  it('starts no tap during preparation, then records real packet delivery once activation is requested', async () => {
    const { page, capture, connectGame, worklets, edges } = await fixture();
    const { context, game, gain } = connectGame();
    expect(context.audioWorklet.addModule).not.toHaveBeenCalled();
    expect(worklets).toEqual([game]); expect(capture.ready).toBe(false);
    expect(edges).toEqual([[gain, context.destination], [game, gain]]);
    await beginPcmCapture(page);
    expect(context.audioWorklet.addModule).toHaveBeenCalledOnce();
    expect(capture.ready).toBe(true); expect(capture.recording).toBe(true);
    expect(capture.packets).toEqual([]); // The readiness packet precedes the capture boundary.
    const data = packet([Math.ceil(context.currentTime * context.sampleRate)]);
    worklets[1].port.onmessage!({ data });
    expect(capture.packets).toEqual([data]);
    capture.activateTap!(); capture.activateTap!();
    await expect(beginPcmCapture(page)).rejects.toThrow('already started');
    expect(worklets).toHaveLength(2); expect(context.audioWorklet.addModule).toHaveBeenCalledOnce();
  });
  it('keeps immediate capture for opening and recovery observations', async () => {
    const { page, capture, connectGame } = await fixture(false);
    const { context } = connectGame();
    expect(context.audioWorklet.addModule).toHaveBeenCalledOnce();
    await page.waitForFunction(() => window.__AUDIO_PCM__!.ready);
    expect(capture.packets).toHaveLength(1); expect(capture.recording).toBe(true);
  });
  it.each(['sync', 'async'] as const)('retains a %s tap load failure without changing the game connection', async mode => {
    const { page, capture, connectGame, AudioContext } = await fixture();
    const context = new AudioContext(), failure = new Error('tap module unavailable');
    context.audioWorklet.addModule.mockImplementation(() => {
      if (mode === 'sync') throw failure;
      return Promise.reject(failure);
    });
    connectGame(context);
    await expect(beginPcmCapture(page)).rejects.toThrow('tap module unavailable');
    expect(capture.errors).toEqual(['Error: tap module unavailable']);
    expect(capture.recording).toBe(false); expect(capture.packets).toEqual([]);
  });
  it('ignores a late old-graph module and activates only the replacement tap', async () => {
    const { page, capture, connectGame, worklets, AudioContext, revoke } = await fixture();
    const old = new AudioContext();
    let finish!: () => void;
    old.audioWorklet.addModule.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    capture.activateTap!(); // An early request waits for the actual game connection.
    expect(old.audioWorklet.addModule).not.toHaveBeenCalled();
    connectGame(old);
    const { context: replacement } = connectGame();
    finish();
    await beginPcmCapture(page);
    expect(capture.retiredGraphs).toHaveLength(1);
    expect(capture.retiredGraphs![0].context).toBe(old);
    const taps = worklets.filter(node => node.name === 'battlecity-test-pcm');
    expect(taps).toHaveLength(1); expect(taps[0].context).toBe(replacement);
    expect(revoke).toHaveBeenCalledTimes(2); expect(capture.errors).toEqual([]);
  });
});

const shotParameters = { start: 0, end: 0.5, frequencies: Array.from({ length: 27 }, (_, index) => 600 + 25 * index), minimumAmplitude: 0.002 };

describe('failed player-shot diagnostic observation', () => {
  it('does not evaluate failure details or call the observer after a successful measurement', async () => {
    const result = { measured: true }, details = vi.fn(), observer = vi.fn();
    await expect(observePcmShotFailure(async () => result, details, observer)).resolves.toBe(result);
    expect(details).not.toHaveBeenCalled(); expect(observer).not.toHaveBeenCalled();
  });
  it('passes the unchanged snapshot, parameters, stage and original error to the observer', async () => {
    const capture: AudioCapture = { ready: true, gameReady: true, errors: [], rate: 1000, events: [], marks: [],
      packets: [{ frame: 0, frames: [0], times: [0], lengths: [128], samples: new Float32Array(128).fill(0.01) }] };
    const snapshot = snapshotPcmWindow({ start: 0, end: 0.128 }, capture);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const original = new Error('Player-shot PCM signature was absent in the captured interval');
    const details = { parameters: shotParameters, snapshot, stage: 'measurement' as const };
    const observer = vi.fn();
    await expect(observePcmShotFailure(async () => { throw original; }, () => details, observer)).rejects.toBe(original);
    expect(observer).toHaveBeenCalledOnce();
    const observed = observer.mock.calls[0][0];
    expect(observed.error).toBe(original); expect(observed.parameters).toBe(shotParameters);
    expect(observed.snapshot).toBe(snapshot); expect(observed.stage).toBe('measurement');
    expect(snapshotPcmWindow({ start: 0, end: 0.128 }, capture)).toEqual(snapshot);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps the original failure when attaching evidence or obtaining its details fails', async () => {
    const original = new Error('Discontinuous PCM in the original measurement');
    const details = { parameters: shotParameters, stage: 'sampling' as const };
    await expect(observePcmShotFailure(async () => { throw original; }, () => details, async () => {
      throw new Error('artifact write failed');
    })).rejects.toBe(original);
    const observer = vi.fn();
    await expect(observePcmShotFailure(async () => { throw original; }, () => {
      throw new Error('snapshot details failed');
    }, observer)).rejects.toBe(original);
    expect(observer).not.toHaveBeenCalled();
    const absentDetails = vi.fn();
    await expect(observePcmShotFailure(async () => { throw original; }, absentDetails)).rejects.toBe(original);
    expect(absentDetails).not.toHaveBeenCalled();
  });
  it('bounds an observer that never settles and still rejects with the original failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const original = new Error('Player-shot PCM signature was absent in the captured interval');
    const observer = vi.fn(() => new Promise<void>(() => {}));
    let settled = false;
    const result = observePcmShotFailure(async () => { throw original; }, () => ({ parameters: shotParameters,
      stage: 'measurement' }), observer).catch(error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(2999);
    expect(observer).toHaveBeenCalledOnce(); expect(settled).toBe(false); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(original); expect(vi.getTimerCount()).toBe(0);
  });
});

function packet(frames: number[], lengths = frames.map(() => 128)): PcmPacket {
  const samples = new Float32Array(lengths.reduce((sum, length) => sum + length, 0));
  let offset = 0;
  for (let index = 0; index < lengths.length; index++) {
    samples.fill((index + 1) / 100, offset, offset + lengths[index]); offset += lengths[index];
  }
  return { frame: frames[0], frames, lengths, times: frames.map(frame => frame / 1000), samples };
}
function features(packets: PcmPacket[], start = 1.024, end = 1.28) {
  const capture: AudioCapture = { ready: true, gameReady: true, errors: [], rate: 1000, packets, events: [], marks: [] };
  return pcmWindowFeatures({ start, end, frequencies: [] }, restorePcmSnapshot(snapshotPcmWindow({ start, end }, capture)));
}
function nativeTones(segments: { engine: number; c6?: number; comparison?: [number, number] }[], rate = 8000): AudioCapture {
  const segmentLength = rate / 4, length = segments.length * segmentLength, samples = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    const segment = segments[Math.floor(index / segmentLength)], time = index / rate;
    samples[index] = segment.engine * Math.sin(2 * Math.PI * 60 * time) +
      (segment.c6 ?? 0) * Math.sin(2 * Math.PI * 1045.428154 * time) +
      (segment.comparison?.[0] ?? 0) * Math.sin(2 * Math.PI * 700 * time) +
      (segment.comparison?.[1] ?? 0) * Math.sin(2 * Math.PI * 850 * time);
  }
  const frames = Array.from({ length: Math.ceil(length / 128) }, (_, index) => index * 128);
  const raw = { frame: 0, frames, lengths: frames.map(frame => Math.min(128, length - frame)),
    times: frames.map(frame => frame / rate), samples };
  return { ready: true, gameReady: true, errors: [], rate, packets: [raw], events: [], marks: [] };
}
function nativeShot(capture = nativeTones([{ engine: 0.003 }, { engine: 0.003 }]), amplitude = 0.008,
  options: { onset?: number; phase?: number; frequencies?: number[]; duration?: number } = {}): AudioCapture {
  const raw = capture.packets[0];
  // Independently derived from shot $0F: timer95, positive shift2 sweep.
  // Keep the phase continuous across literal half-frame frequency segments;
  // no production driver, synth or sound table generates this fixture.
  const frequencies = options.frequencies ?? [1165.216797, 940.006828, 755.816301, 607.939198, 488.475164,
    391.121722, 313.335609, 250.808997, 200.827311, 160.719558, 128.723605, 103.002590, 82.432434];
  let phase = options.phase ?? 0;
  for (let index = 0; index < raw.samples.length; index++) {
    const elapsed = index / capture.rate - (options.onset ?? 0.04);
    if (elapsed < 0) continue;
    const frequency = frequencies[Math.floor(options.duration === undefined ? elapsed * 120 : elapsed / options.duration)];
    if (frequency === undefined) continue;
    phase += 2 * Math.PI * frequency / capture.rate;
    raw.samples[index] += amplitude * Math.sin(phase);
  }
  return capture;
}
function nativeEnemyPulse(): AudioCapture {
  const capture = nativeTones([{ engine: 0 }, { engine: 0 }]), raw = capture.packets[0];
  let phase = 0, previous = -1;
  // Literal enemy pulse timers1812/1710 alternate every four steady game ticks.
  // This independent harmonic stress fixture is not a full APU emulation.
  for (let index = 0; index < raw.samples.length; index++) {
    const note = Math.floor(index / capture.rate * 60.0988 / 4) % 2;
    if (note !== previous) { phase = 0; previous = note; }
    phase += 2 * Math.PI * (note === 0 ? 61.69929 : 65.37745) / capture.rate;
    raw.samples[index] = Math.sin(phase) >= 0 ? 0.006 : -0.006;
  }
  return capture;
}
function transmitted(capture: AudioCapture, start: number, end: number): AudioCapture {
  // Exercise the wire representation, rather than sharing packet objects with
  // the analyzer as an in-memory fixture could accidentally do.
  return restorePcmSnapshot(JSON.parse(JSON.stringify(snapshotPcmWindow({ start, end }, capture))));
}
function keepSamples(capture: AudioCapture, count: number): void {
  const raw = capture.packets[0], frames = raw.frames.filter(frame => frame < count);
  raw.frames = frames; raw.times = frames.map(frame => frame / capture.rate);
  raw.lengths = frames.map(frame => Math.min(128, count - frame)); raw.samples = raw.samples.slice(0, count);
}
function actualCue(cue: number, rate: number, warmup = 1): AudioCapture {
  // These are supplementary negative/cross-calibration fixtures. Independent
  // literal sweeps above remain the positive oracle, not the production driver.
  const synth = new ApuSynth(rate), driver = new ApuDriver((channel, register, value) => synth.write(channel, register, value));
  driver.trigger(0x12);
  const first = Math.round(warmup * rate), onset = first + Math.round(rate / 2), samples = new Float32Array(rate);
  let nextTick = 0, triggered = false;
  for (let sample = 0; sample < first + rate; sample++) {
    if (sample >= nextTick) {
      if (sample >= onset && !triggered) { driver.trigger(cue); triggered = true; }
      driver.tick(); nextTick += rate / 60.0988;
    }
    const value = synth.sample() * 0.3;
    if (sample >= first) samples[sample - first] = value;
  }
  const frames = Array.from({ length: Math.ceil(samples.length / 128) }, (_, index) => index * 128);
  return { ready: true, gameReady: true, errors: [], rate, events: [], marks: [],
    packets: [{ frame: 0, frames, lengths: frames.map(frame => Math.min(128, samples.length - frame)),
      times: frames.map(frame => frame / rate), samples }] };
}
describe('bounded browser-to-Node PCM snapshots', () => {
  it('keeps native and fallback byte encoding identical across chunk boundaries and buffer offsets', () => {
    const bits = new Uint32Array(32772);
    for (let index = 0; index < bits.length; index++) bits[index] = [0x3f800001, 0x80000000, 0x7fc12345, 0x00000001][index % 4];
    const samples = new Float32Array(bits.buffer, 4, bits.length - 2);
    const capture: AudioCapture = { ready: true, gameReady: true, errors: [], rate: 44100, events: [], marks: [],
      packets: [{ frame: 0, frames: [0], times: [0], lengths: [samples.length], samples }] };
    const native = vi.fn(function (this: Uint8Array) {
      return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString('base64');
    });
    const snapshots = [true, false].map(enabled => {
      class Bytes extends Uint8Array {}
      Object.defineProperty(Bytes.prototype, 'toBase64', { value: enabled ? native : undefined });
      const realm = createContext({ Uint8Array: Bytes, Float32Array, btoa, capture });
      return runInContext(`(${snapshotPcmWindow.toString()})({start:0,end:0.5},capture)`, realm);
    });
    expect(native).toHaveBeenCalledOnce(); expect(snapshots[0]).toEqual(snapshots[1]);
    for (const snapshot of snapshots) {
      const restored = restorePcmSnapshot(snapshot);
      expect(Array.from(new Uint32Array(restored.packets[0].samples.buffer))).toEqual(Array.from(bits.subarray(1, -1)));
    }
  });

  it('copies complete intersecting packets in order and retains the final native coverage packet', () => {
    const packets = [packet([0, 128]), packet([512, 640]), packet([1024, 1152]), packet([2048]), packet([4096])];
    const capture: AudioCapture = { ready: true, gameReady: true, errors: [], rate: 1000, packets, events: [], marks: [] };
    const restored = transmitted(capture, 1.034, 1.27);
    expect(restored.packets.map(raw => raw.frame)).toEqual([1024, 4096]);
    expect(restored.packets[0].frames).toEqual([1024, 1152]);
    expect(restored.packets[0].lengths).toEqual([128, 128]);
    expect(restored.packets[0].samples).toEqual(packets[2].samples);
    expect(pcmWindowFeatures({ start: 1.034, end: 1.27, frequencies: [17] }, restored))
      .toEqual(pcmWindowFeatures({ start: 1.034, end: 1.27, frequencies: [17] }, capture));
  });
  it('preserves every Float32 bit from a subarray, including signed zero and a noncanonical NaN', () => {
    const bits = new Uint32Array([0xdeadbeef, 0x3f800001, 0x80000000, 0x7fc12345, 0x00000001, 0xcafebabe]);
    const samples = new Float32Array(bits.buffer, 4, 4);
    const capture: AudioCapture = { ready: true, gameReady: true, errors: [], rate: 1000,
      packets: [{ frame: 0, frames: [0], times: [0], lengths: [4], samples }], events: [], marks: [] };
    const snapshot = snapshotPcmWindow({ start: 0, end: 0.004 }, capture);
    samples.fill(0); capture.packets[0].frames[0] = 32;
    const restored = restorePcmSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(Array.from(new Uint32Array(restored.packets[0].samples.buffer))).toEqual([0x3f800001, 0x80000000, 0x7fc12345, 0x00000001]);
    expect(restored.packets[0].frames).toEqual([0]);
    expect(() => pcmWindowFeatures({ start: 0, end: 0.004, frequencies: [] }, restored)).toThrow(/Non-finite PCM sample/);
  });
  it('serializes without referring to the Node decoder or spectrum implementation', () => {
    const capture = nativeShot();
    // Playwright sends this function's source to a different realm. It must not
    // require a closed-over Buffer, imported helper, or spectral calculation.
    const evaluate = new Function('request', 'capture', `return (${snapshotPcmWindow.toString()})(request, capture);`);
    const request = { start: 0.02, end: 0.18 };
    expect(evaluate(request, capture)).toEqual(snapshotPcmWindow(request, capture));
  });
  it.each(['ordinary', 'idle', 'band'] as const)('retains the direct %s analysis and its original thresholds', mode => {
    const capture = mode === 'band' ? nativeShot() : nativeEnemyPulse();
    const parameters: Parameters<typeof pcmWindowFeatures>[0] = { start: 0, end: 0.5,
      frequencies: Array.from({ length: 27 }, (_, index) => 600 + index * 25) };
    if (mode === 'idle') { parameters.idle = true; parameters.comparison = { duration: 0.025, step: 0.008 }; }
    if (mode === 'band') parameters.scan = { duration: 0.025, step: 0.008, minimumAmplitude: 0.002 };
    expect(pcmWindowFeatures(parameters, transmitted(capture, parameters.start, parameters.end)))
      .toEqual(pcmWindowFeatures(parameters, capture));
  });
  it('keeps early band success and a pending scan distinct from a captured absent band', () => {
    const capture = nativeShot(), raw = capture.packets[0];
    raw.frames = raw.frames.slice(0, 18); raw.times = raw.times.slice(0, 18); raw.lengths = raw.lengths.slice(0, 18);
    raw.samples = raw.samples.slice(0, 18 * 128);
    const parameters = { start: 0, end: 0.5, frequencies: Array.from({ length: 27 }, (_, index) => 600 + index * 25),
      scan: { duration: 0.025, step: 0.008, minimumAmplitude: 0.002 } };
    expect((raw.frames.at(-1)! + raw.lengths.at(-1)!) / capture.rate).toBeLessThan(parameters.end);
    expect(Math.max(...pcmWindowFeatures(parameters, transmitted(capture, 0, 0.5)).amplitudes)).toBeGreaterThan(0.002);
    parameters.scan.minimumAmplitude = 1;
    expect(pcmWindowFeatures(parameters, transmitted(capture, 0, 0.5))).toEqual(pcmWindowFeatures(parameters, capture));
    const complete = nativeShot();
    expect(() => pcmWindowFeatures(parameters, transmitted(complete, 0, 0.5))).toThrow(/band was absent/);
  });
  it('retains idle success before its deadline and pending idle without accepting a lone quiet window', () => {
    const capture = nativeTones([{ engine: 0.003, c6: 0.01 }, { engine: 0.003 }]);
    const parameters = { start: 0, end: 1.5, frequencies: [700], idle: true };
    expect(pcmWindowFeatures(parameters, transmitted(capture, 0, 1.5))).toMatchObject({ idleReady: false });
    const early = nativeTones([{ engine: 0.003 }, { engine: 0.003 }]);
    expect(pcmWindowFeatures(parameters, transmitted(early, 0, 1.5))).toEqual(pcmWindowFeatures(parameters, early));
    expect(pcmWindowFeatures(parameters, transmitted(early, 0, 1.5)).idleReady).toBe(true);
  });
  it('fails a missing tail immediately when a later real packet proves the deadline was captured', () => {
    const capture: AudioCapture = { ready: true, gameReady: true, errors: [], rate: 1000,
      packets: [packet([0, 128, 256]), packet([1024])], events: [], marks: [] };
    capture.packets.forEach(raw => raw.samples.fill(0));
    const parameters = { start: 0, end: 0.768, frequencies: [50],
      scan: { duration: 0.2, step: 0.05, minimumAmplitude: 0.005 } };
    expect(() => pcmWindowFeatures(parameters, capture)).toThrow(/Incomplete PCM interval/);
    const restored = transmitted(capture, 0, 0.768);
    expect(restored.packets.map(raw => raw.frame)).toEqual([0, 1024]);
    expect(() => pcmWindowFeatures(parameters, restored)).toThrow(/Incomplete PCM interval/);
  });
  it('does not hide capture errors or overflow when selecting a small valid window', () => {
    const capture = nativeShot(); capture.errors.push('PCM capture exceeded its bounded packet capacity');
    expect(() => snapshotPcmWindow({ start: 0.04, end: 0.065 }, capture)).toThrow(/bounded packet capacity/);
    capture.errors = ['native tap failed'];
    expect(() => snapshotPcmWindow({ start: 0.04, end: 0.065 }, capture)).toThrow(/native tap failed/);
    capture.errors = []; capture.packets = Array.from({ length: 769 }, () => capture.packets[0]);
    expect(() => snapshotPcmWindow({ start: 0.04, end: 0.065 }, capture)).toThrow(/bounded packet capacity/);
  });
});
describe('raw PCM measurement windows', () => {
  it('ignores gaps outside this window while measuring exactly its raw samples', () => {
    const result = features([packet([0, 128]), packet([1024, 1152]), packet([2048])], 1.034, 1.27);
    expect(result.samples).toBe(236); expect(result.rate).toBe(1000); expect(result.onset).toBe(1.034);
    expect(result.peak).toBeCloseTo(0.02, 7);
    expect(result.rms).toBeCloseTo(Math.sqrt((0.01 ** 2 + 0.02 ** 2) / 2), 7);
  });
  it('accepts an unrelated prefix gap within the same native packet', () => {
    const result = features([packet([0, 128, 1024, 1152])]);
    expect(result.samples).toBe(256); expect(result.peak).toBeCloseTo(0.04, 7);
  });
  it.each([
    ['missing quantum', [1024, 1280]],
    ['duplicated quantum', [1024, 1024, 1152]],
    ['reordered quantum', [1152, 1024]],
  ] as const)('rejects a %s inside the measurement', (_name, frames) => {
    expect(() => features([packet([...frames])], 1.024, 1.408)).toThrow(/Discontinuous PCM/);
  });
  it.each([[1, 1.28], [1.024, 1.3]])('rejects incomplete edge samples in %s–%s', (start, end) => {
    expect(() => features([packet([1024, 1152])], start, end)).toThrow(/Incomplete PCM interval/);
  });
  it('checks raw frame/time labels without repairing timestamps', () => {
    const raw = packet([1024, 1152]); raw.times[1] += 0.002;
    expect(() => features([raw])).toThrow(/frame\/time labels/);
  });
  it('checks packet sample counts against the actual quantum lengths', () => {
    const raw = packet([1024, 1152]); raw.samples = raw.samples.subarray(0, 255);
    expect(() => features([raw])).toThrow(/sample count/);
  });
  it('accepts actual variable quantum lengths without assuming 128 samples', () => {
    const result = features([packet([1024, 1088], [64, 256])], 1.024, 1.344);
    expect(result.samples).toBe(320); expect(result.peak).toBeCloseTo(0.02, 7);
  });
  it('rejects non-finite samples in the requested window', () => {
    const raw = packet([1024, 1152]); raw.samples[129] = Number.NaN;
    expect(() => features([raw])).toThrow(/Non-finite PCM sample/);
  });
  it('finds a complete later band window without filling the earlier silence', () => {
    const raw = packet([1024, 1152, 1280, 1408, 1536, 1664]);
    for (let index = 0; index < raw.samples.length; index++) {
      raw.samples[index] = index < 384 ? 0 : 0.02 * Math.sin(2 * Math.PI * 50 * index / 1000);
    }
    const capture: AudioCapture = { ready: true, gameReady: true, errors: [], rate: 1000, packets: [raw], events: [], marks: [] };
    const result = pcmWindowFeatures({ start: 1.024, end: 1.792, frequencies: [50],
      scan: { duration: 0.2, step: 0.05, minimumAmplitude: 0.005 } }, capture);
    expect(result.samples).toBe(200); expect(result.amplitudes[0]).toBeGreaterThan(0.005);
    expect(result.onset).toBeGreaterThanOrEqual(1.408);
  });
  it('fails a discontinuous candidate before a later audible band', () => {
    const raw = packet([1024, 1280, 1408, 1536, 1664]);
    raw.samples.fill(0.02);
    const capture: AudioCapture = { ready: true, gameReady: true, errors: [], rate: 1000, packets: [raw], events: [], marks: [] };
    expect(() => pcmWindowFeatures({ start: 1.024, end: 1.792, frequencies: [0],
      scan: { duration: 0.4, step: 0.05, minimumAmplitude: 0.005 } }, capture)).toThrow(/Discontinuous PCM/);
  });
  it('fails an entirely captured scan that never contains its required band', () => {
    const raw = packet([1024, 1152, 1280, 1408]); raw.samples.fill(0);
    const capture: AudioCapture = { ready: true, gameReady: true, errors: [], rate: 1000, packets: [raw], events: [], marks: [] };
    expect(() => pcmWindowFeatures({ start: 1.024, end: 1.536, frequencies: [50],
      scan: { duration: 0.2, step: 0.05, minimumAmplitude: 0.005 } }, capture)).toThrow(/band was absent/);
  });
  it('detects a brief independent shot sweep that a 105ms band window dilutes', () => {
    const capture = nativeShot(), frequencies = Array.from({ length: 27 }, (_, index) => 600 + index * 25);
    const short = pcmWindowFeatures({ start: 0, end: 0.5, frequencies,
      scan: { duration: 0.025, step: 0.008, minimumAmplitude: 0.002 } }, capture);
    expect(short.samples).toBe(200); expect(Math.max(...short.amplitudes)).toBeGreaterThan(0.002);
    expect(() => pcmWindowFeatures({ start: 0.025, end: 0.5, frequencies,
      scan: { duration: 0.105, step: 0.025, minimumAmplitude: 0.002 } }, capture)).toThrow(/band was absent/);
  });
  it('rejects a gap in the earliest short candidate before a later shot sweep', () => {
    const capture = nativeShot(), raw = capture.packets[0];
    raw.frames.splice(1, 1); raw.lengths.splice(1, 1); raw.times.splice(1, 1);
    const samples = new Float32Array(raw.samples.length - 128);
    samples.set(raw.samples.subarray(0, 128)); samples.set(raw.samples.subarray(256), 128); raw.samples = samples;
    expect(() => pcmWindowFeatures({ start: 0, end: 0.5,
      frequencies: Array.from({ length: 27 }, (_, index) => 600 + index * 25),
      scan: { duration: 0.025, step: 0.008, minimumAmplitude: 0.002 } }, capture)).toThrow(/Incomplete PCM interval/);
  });
  it('rejects engine-only harmonics with a conservative baseline at the same short-window resolution', () => {
    const capture = nativeEnemyPulse(), frequencies = Array.from({ length: 27 }, (_, index) => 600 + index * 25);
    const broad = pcmWindowFeatures({ start: 0, end: 0.5, frequencies, idle: true }, capture);
    const baseline = pcmWindowFeatures({ start: 0, end: 0.5, frequencies, idle: true,
      comparison: { duration: 0.025, step: 0.008 } }, capture);
    expect(baseline.idleReady).toBe(true);
    const baselinePeak = Math.max(...baseline.amplitudes);
    expect(baselinePeak).toBeGreaterThan(Math.max(...broad.amplitudes) * 2);
    expect(baselinePeak * 3).toBeGreaterThan(0.002);
    const threshold = Math.max(0.002, baselinePeak * 3);
    expect(() => pcmWindowFeatures({ start: 0, end: 0.5, frequencies,
      scan: { duration: 0.025, step: 0.008, minimumAmplitude: threshold } }, capture)).toThrow(/band was absent/);
    // A genuine independent sweep on this same pulse background must retain
    // enough attack amplitude to satisfy the unchanged three-times-idle gate.
    const shot = pcmWindowFeatures({ start: 0, end: 0.5, frequencies,
      scan: { duration: 0.025, step: 0.008, minimumAmplitude: threshold } }, nativeShot(nativeEnemyPulse(), 0.03));
    expect(Math.max(...shot.amplitudes)).toBeGreaterThan(threshold);
  });
  it('rejects C6-contaminated baseline windows before accepting two native idle windows', () => {
    const capture = nativeTones([
      { engine: 0.003, c6: 0.01, comparison: [0.008, 0.008] },
      { engine: 0.003, c6: 0.01, comparison: [0.008, 0.008] },
      { engine: 0.003, comparison: [0.0002, 0.0003] },
      { engine: 0.003, comparison: [0.0002, 0.0003] },
    ]);
    const idle = pcmWindowFeatures({ start: 0, end: 1, frequencies: [700, 850], idle: true }, capture);
    expect(idle.idleReady).toBe(true); expect(idle.samples).toBe(4000);
    expect(idle.amplitudes[0]).toBeCloseTo(0.0002, 6); expect(idle.amplitudes[1]).toBeCloseTo(0.0003, 6);
  });
  it('does not mistake a single quiet music-rest window for stable native idle', () => {
    const capture = nativeTones([
      { engine: 0.003 }, { engine: 0.003, c6: 0.01 },
      { engine: 0.003 }, { engine: 0.003, c6: 0.01 },
    ]);
    expect(() => pcmWindowFeatures({ start: 0, end: 1, frequencies: [700], idle: true }, capture)).toThrow(/Stable native PCM idle was absent/);
  });
  it('fails a native gap instead of scanning past it to an idle baseline', () => {
    const capture = nativeTones([{ engine: 0.003 }, { engine: 0.003 }, { engine: 0.003 }]);
    const raw = capture.packets[0]; raw.frames.splice(2, 1); raw.lengths.splice(2, 1); raw.times.splice(2, 1);
    const samples = new Float32Array(raw.samples.length - 128);
    samples.set(raw.samples.subarray(0, 256)); samples.set(raw.samples.subarray(384), 256); raw.samples = samples;
    expect(() => pcmWindowFeatures({ start: 0, end: 0.75, frequencies: [700], idle: true }, capture)).toThrow(/Discontinuous PCM/);
  });
  it('fails when the captured native deadline contains no stable audible engine', () => {
    const capture = nativeTones([{ engine: 0 }, { engine: 0 }, { engine: 0 }, { engine: 0 }]);
    expect(() => pcmWindowFeatures({ start: 0, end: 1, frequencies: [700], idle: true }, capture)).toThrow(/Stable native PCM idle was absent/);
  });
  it('uses the larger amplitude at each frequency across both adjacent baseline windows', () => {
    const capture = nativeTones([
      { engine: 0.003, comparison: [0.0002, 0.0004] }, { engine: 0.003, comparison: [0.0005, 0.0001] },
    ]);
    const idle = pcmWindowFeatures({ start: 0, end: 0.5, frequencies: [700, 850], idle: true }, capture);
    expect(idle.amplitudes[0]).toBeCloseTo(0.0005, 6); expect(idle.amplitudes[1]).toBeCloseTo(0.0004, 6);
  });
  it('matches an independent direct-trigonometry spectrum for actual Float32 samples', () => {
    const raw = packet([1024, 1152, 1280, 1408]); let random = 0x12345678;
    for (let index = 0; index < raw.samples.length; index++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      raw.samples[index] = (random / 0x100000000 - 0.5) / 4;
    }
    const frequencies = [17.123, 133.7, 271.19], start = 1.024, end = 1.536;
    const capture: AudioCapture = { ready: true, gameReady: true, errors: [], rate: 1000, packets: [raw], events: [], marks: [] };
    const actual = pcmWindowFeatures({ start, end, frequencies }, capture);
    const direct = frequencies.map(frequency => {
      let real = 0, imaginary = 0;
      for (let index = 0; index < raw.samples.length; index++) {
        const weighted = raw.samples[index] * (0.5 - 0.5 * Math.cos(2 * Math.PI * index / (raw.samples.length - 1)));
        const angle = 2 * Math.PI * frequency * index / capture.rate;
        real += weighted * Math.cos(angle); imaginary += weighted * Math.sin(angle);
      }
      return 4 * Math.hypot(real, imaginary) / raw.samples.length;
    });
    for (let index = 0; index < frequencies.length; index++) expect(Math.abs(actual.amplitudes[index] - direct[index])).toBeLessThan(1e-10);
  });
});

describe('player-shot PCM signature', () => {
  const frequencies = Array.from({ length: 27 }, (_, index) => 600 + 25 * index);
  const parameters = { start: 0, end: 0.5, frequencies, minimumAmplitude: 0.002 };
  const independent = (rate = 44100, onset = 0.04, amplitude = 0.03, phase = 0) =>
    nativeShot(nativeTones([{ engine: 0.003 }, { engine: 0.003 }], rate), amplitude, { onset, phase });
  const measured = (capture: AudioCapture, options = parameters) => pcmShotWindowFeatures(options, transmitted(capture, options.start, options.end));
  const gateFor = (capture: AudioCapture) => Math.max(0.002, Math.max(...pcmWindowFeatures({
    start: 0, end: 0.5, frequencies, idle: true, comparison: { duration: 0.025, step: 0.008 },
  }, capture).amplitudes) * 3);

  it.each([44100, 48000])('rejects a complete but late %i Hz shot and retains its original matching PCM', async rate => {
    const snapshot = snapshotPcmWindow(parameters, independent(rate, 0.16)), onFailure = vi.fn();
    const evaluate = vi.fn(async () => JSON.stringify(snapshot));
    const page = { evaluate, waitForFunction: vi.fn(async () => ({ dispose: vi.fn() })) } as unknown as Page;
    await expect(pcmShotWindow(page, 0, 0.5, frequencies, 0.002, onFailure, (match, capturedRate) => {
      expect(pcmResponseObservation('shot', 0, match.phases[0].start + 0.008, capturedRate).limitExceeded).toBe(false);
    })).rejects.toThrow();
    expect(evaluate).toHaveBeenCalledOnce(); expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure.mock.calls[0][0]).toMatchObject({ snapshot, match: { phases: expect.any(Array) }, stage: 'assertion' });
  });

  it('waits for the original complete window before exporting once, with unchanged sweep analysis', async () => {
    const capture = independent();
    capture.delivery = { overflow: false, entries: [{ at: 0.02, message: {
      type: 'commands', generation: 1, sequence: 2, commands: [{ id: 0x0f, start: true }],
    } }] };
    const snapshot = snapshotPcmWindow(parameters, capture), assertion = vi.fn();
    let complete!: (handle: { dispose: () => void }) => void;
    const coverage = new Promise<{ dispose: () => void }>(resolve => { complete = resolve; });
    const dispose = vi.fn(), evaluate = vi.fn(async () => JSON.stringify(snapshot));
    const waitForFunction = vi.fn((_expression: unknown, _parameters: unknown, _options: unknown) => coverage);
    const page = { evaluate, waitForFunction } as unknown as Page;
    const result = pcmShotWindow(page, parameters.start, parameters.end, frequencies, parameters.minimumAmplitude, undefined, assertion);
    await Promise.resolve();
    expect(evaluate).not.toHaveBeenCalled();
    expect(waitForFunction.mock.calls[0]?.[1]).toBe(parameters.end);
    expect(waitForFunction.mock.calls[0]?.[2]).toEqual({ polling: 25, timeout: 15000 });
    complete({ dispose });
    expect(await result).toEqual(pcmShotWindowFeatures(parameters, capture));
    expect(assertion).toHaveBeenCalledExactlyOnceWith(pcmShotWindowFeatures(parameters, capture), capture.rate, snapshot.diagnostics);
    expect(evaluate).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
  });

  it('attaches a missing shot and its submitted command without losing the original failure', async () => {
    const capture = independent();
    capture.packets[0].samples.fill(0);
    capture.delivery = { overflow: false, entries: [{ at: 0.02, message: {
      type: 'commands', generation: 1, sequence: 2, commands: [{ id: 0x0f, start: true }],
    } }] };
    const snapshot = snapshotPcmWindow(parameters, capture), attach = vi.fn();
    const error = new Error('Player-shot PCM signature was absent');
    await attachPcmFailure({ attach } as unknown as Parameters<typeof attachPcmFailure>[0],
      { parameters, snapshot, stage: 'measurement', error }, 'player shot', { shotAt: 0 });
    expect(attach).toHaveBeenCalledOnce();
    expect(attach.mock.calls[0][0]).toBe('audio-measurement-failure');
    expect(JSON.parse(attach.mock.calls[0][1].body.toString())).toMatchObject({
      error: { message: error.message }, snapshot, response: {
        onset: null, latencyMs: null, limitExceeded: true,
        submission: { status: 'matched', keyToSubmitMs: 20, submitToOnsetMs: null },
      },
    });
  });

  it.each(['absent shot', 'invalid tail after a valid shot'] as const)('retains the complete failing window for %s without another export', async kind => {
    const capture = independent();
    if (kind === 'absent shot') capture.packets[0].samples.fill(0);
    else capture.packets[0].samples[Math.floor(capture.rate * 0.4)] = Number.NaN;
    const snapshot = snapshotPcmWindow(parameters, capture), observer = vi.fn();
    const evaluate = vi.fn(async () => JSON.stringify(snapshot)), dispose = vi.fn();
    const page = { evaluate, waitForFunction: vi.fn(async () => ({ dispose })) } as unknown as Page;
    await expect(pcmShotWindow(page, parameters.start, parameters.end, frequencies, parameters.minimumAmplitude, observer))
      .rejects.toThrow(kind === 'absent shot' ? /Player-shot PCM signature was absent/ : /Non-finite PCM sample/);
    expect(evaluate).toHaveBeenCalledOnce(); expect(observer).toHaveBeenCalledOnce();
    expect(observer.mock.calls[0][0].snapshot).toEqual(snapshot);
    expect(observer.mock.calls[0][0].parameters).toEqual(parameters);
    expect(observer.mock.calls[0][0].stage).toBe('measurement');
  });

  it.each([44100, 48000].flatMap(rate => [0.04, 0.041, 0.053, 0.137].map((onset, index) => [rate, onset, index * 0.7] as const)))
    ('matches an independent %sHz literal sweep starting at %ss with phase %s', (rate, onset, phase) => {
      const capture = independent(rate, onset, 0.008, phase), match = measured(capture)!;
      expect(match).not.toBeNull(); expect(match).toEqual(pcmShotWindowFeatures(parameters, capture));
      const targets = [940.006828, 755.816301, 607.939198];
      for (let index = 0; index < match.phases.length; index++) {
        expect(Math.abs(match.phases[index].frequency - targets[index])).toBeLessThanOrEqual(50);
        expect(match.phases[index].concentration).toBeGreaterThanOrEqual(0.8);
        expect(match.phases[index].amplitude).toBeGreaterThan(parameters.minimumAmplitude);
        if (index) {
          expect(match.phases[index].start - match.phases[index - 1].start).toBeGreaterThanOrEqual(0.004 - 1e-9);
          expect(match.phases[index].start - match.phases[index - 1].start).toBeLessThanOrEqual(0.018 + 1e-9);
        }
      }
      expect(match.bandStart).toBeLessThanOrEqual(match.phases[0].start + 0.004 + 1e-9);
      expect(match.bandStart + 0.025).toBeGreaterThanOrEqual(match.phases[1].start + 0.004 - 1e-9);
      expect(Math.max(...match.band.amplitudes)).toBeGreaterThan(parameters.minimumAmplitude);
      expect(match.band).toEqual(pcmWindowFeatures({ start: match.bandStart, end: match.bandStart + 0.025, frequencies }, capture));
    });
  it.each([44100, 48000])('retains actual %sHz shot attacks across native APU starting phases', rate => {
    for (const warmup of [1, 1.003, 1.011, 1.027]) {
      const capture = actualCue(0x0f, rate, warmup), minimumAmplitude = gateFor(capture);
      const match = measured(capture, { start: 0.5, end: 1, frequencies, minimumAmplitude })!;
      expect(match).not.toBeNull();
      expect(Math.max(...match.band.amplitudes)).toBeGreaterThan(minimumAmplitude);
      expect(match.phases.every(phase => phase.amplitude > minimumAmplitude)).toBe(true);
    }
  });
  it.each([44100, 48000].flatMap(rate => [0x07, 0x0a, 0x06, 0x09].flatMap(cue =>
    [1, 1.003, 1.011, 1.027].map(warmup => [rate, cue, warmup] as const))))
    ('rejects actual %sHz cue %s after %ss warmup without a player shot, even when its broad band passes', (rate, cue, warmup) => {
      const capture = actualCue(cue, rate, warmup), minimumAmplitude = gateFor(capture);
      const old = pcmWindowFeatures({ start: 0.5, end: 1, frequencies,
        scan: { duration: 0.025, step: 0.008, minimumAmplitude } }, capture);
      expect(Math.max(...old.amplitudes)).toBeGreaterThan(minimumAmplitude);
      expect(() => measured(capture, { start: 0.5, end: 1, frequencies, minimumAmplitude })).toThrow(/Player-shot PCM signature was absent/);
    });
  it.each([
    ['constant tone', [940.006828], 0.4],
    ['reversed tones', [607.939198, 755.816301, 940.006828], 1 / 120],
    ['missing third tone', [940.006828, 755.816301], 1 / 120],
    ['too-quick tones', [940.006828, 755.816301, 607.939198], 0.003],
    ['widely spaced tones', [940.006828, 755.816301, 607.939198], 0.04],
  ] as const)('rejects %s with an otherwise sufficient broad band', (_name, tones, duration) => {
    const capture = nativeShot(nativeTones([{ engine: 0.003 }, { engine: 0.003 }], 44100), 0.03,
      { frequencies: [...tones], duration });
    const old = pcmWindowFeatures({ start: 0, end: 0.5, frequencies,
      scan: { duration: 0.025, step: 0.008, minimumAmplitude: 0.002 } }, capture);
    expect(Math.max(...old.amplitudes)).toBeGreaterThan(0.002);
    expect(() => measured(capture)).toThrow(/Player-shot PCM signature was absent/);
  });
  it('does not combine a loud explosion with a sweep below the original idle margin', () => {
    const capture = actualCue(0x07, 44100), minimumAmplitude = gateFor(capture);
    nativeShot(capture, 0.003, { onset: 0.54 });
    const old = pcmWindowFeatures({ start: 0.5, end: 1, frequencies,
      scan: { duration: 0.025, step: 0.008, minimumAmplitude } }, capture);
    expect(Math.max(...old.amplitudes)).toBeGreaterThan(minimumAmplitude);
    expect(() => measured(capture, { start: 0.5, end: 1, frequencies, minimumAmplitude })).toThrow(/Player-shot PCM signature was absent/);
  });
  it('binds the original broad-band gate to the same attack rather than a later loud tone', () => {
    const capture = independent(44100, 0.04, 0.008), minimumAmplitude = 0.006;
    // The three short tones themselves are loud enough, but their 25ms attack
    // is too quiet for this gate. A separate late tone must not repair that.
    for (const [index, frequency] of [940.006828, 755.816301, 607.939198].entries()) {
      const start = 0.04 + (index + 1) / 120;
      expect(pcmWindowFeatures({ start, end: start + 0.008, frequencies: [frequency] }, capture).amplitudes[0]).toBeGreaterThan(minimumAmplitude);
    }
    expect(() => pcmWindowFeatures({ start: 0, end: 0.5, frequencies,
      scan: { duration: 0.025, step: 0.008, minimumAmplitude } }, capture)).toThrow(/band was absent/);
    const raw = capture.packets[0];
    for (let index = Math.ceil(0.3 * capture.rate); index < Math.floor(0.35 * capture.rate); index++) {
      raw.samples[index] += 0.03 * Math.sin(2 * Math.PI * 1000 * index / capture.rate);
    }
    expect(Math.max(...pcmWindowFeatures({ start: 0, end: 0.5, frequencies,
      scan: { duration: 0.025, step: 0.008, minimumAmplitude } }, capture).amplitudes)).toBeGreaterThan(minimumAmplitude);
    expect(() => measured(capture, { ...parameters, minimumAmplitude })).toThrow(/Player-shot PCM signature was absent/);
  });
  it('keeps incomplete evidence pending and accepts a valid attack before the native deadline', () => {
    const pending = independent(); keepSamples(pending, Math.floor(pending.rate * 0.025));
    expect(measured(pending)).toBeNull();
    const early = independent(); keepSamples(early, Math.floor(early.rate * 0.1));
    expect(early.packets[0].frames.at(-1)! + early.packets[0].lengths.at(-1)!).toBeLessThan(early.rate * 0.5);
    expect(measured(early)).not.toBeNull();
    const absent = nativeTones([{ engine: 0.003 }, { engine: 0.003 }], 44100);
    expect(() => measured(absent)).toThrow(/Player-shot PCM signature was absent/);
  });
  it.each((['missing', 'duplicated', 'reordered', 'NaN'] as const).flatMap(corruption =>
    [0.02, 0.2].map(at => [corruption, at] as const)))('does not conceal %s raw data at %ss before or after a valid attack', (corruption, at) => {
    const capture = independent(), raw = capture.packets[0], index = Math.floor(at * capture.rate / 128);
    if (corruption === 'NaN') raw.samples[index * 128] = Number.NaN;
    else if (corruption === 'missing') {
      const samples = new Float32Array(raw.samples.length - raw.lengths[index]);
      samples.set(raw.samples.subarray(0, index * 128)); samples.set(raw.samples.subarray((index + 1) * 128), index * 128);
      raw.frames.splice(index, 1); raw.times.splice(index, 1); raw.lengths.splice(index, 1); raw.samples = samples;
    } else {
      if (corruption === 'duplicated') raw.frames[index] = raw.frames[index - 1];
      else [raw.frames[index], raw.frames[index + 1]] = [raw.frames[index + 1], raw.frames[index]];
      raw.times = raw.frames.map(frame => frame / capture.rate);
    }
    expect(() => measured(capture)).toThrow(corruption === 'NaN' ? /Non-finite PCM sample/ : /Discontinuous PCM/);
  });
  it('fails a missing tail when a later genuine packet proves the deadline has arrived', () => {
    const capture = independent(); keepSamples(capture, Math.floor(capture.rate * 0.4));
    const frame = capture.rate;
    capture.packets.push({ frame, frames: [frame], times: [1], lengths: [128], samples: new Float32Array(128) });
    expect(() => measured(capture)).toThrow(/Incomplete PCM interval/);
  });
  it('uses actual variable quantum lengths without changing samples or their labels', () => {
    const capture = independent(), raw = capture.packets[0];
    raw.frames = []; raw.lengths = []; raw.times = [];
    for (let frame = 0, index = 0; frame < raw.samples.length; index++) {
      const length = Math.min([64, 256, 128][index % 3], raw.samples.length - frame);
      raw.frames.push(frame); raw.lengths.push(length); raw.times.push(frame / capture.rate); frame += length;
    }
    expect(measured(capture)).toEqual(pcmShotWindowFeatures(parameters, capture));
    expect(measured(capture)).not.toBeNull();
  });
  it('retains capture failures, capacity and the fixed bounded scan parameters', () => {
    const capture = independent(); capture.errors.push('native tap failed');
    expect(() => pcmShotWindowFeatures(parameters, capture)).toThrow(/native tap failed/);
    capture.errors = []; capture.packets = Array.from({ length: 769 }, () => capture.packets[0]);
    expect(() => pcmShotWindowFeatures(parameters, capture)).toThrow(/bounded packet capacity/);
    expect(() => measured(independent(), { ...parameters, end: 1 })).toThrow(/Invalid bounded PCM shot scan/);
    expect(() => measured(independent(), { ...parameters, minimumAmplitude: 0.001 })).toThrow(/Invalid bounded PCM shot scan/);
  });
});
