import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioRuntime, type AudioRuntimeHooks } from '../../src/platform/audio-runtime';
import { AudioTransport } from '../../src/platform/audio-transport';
import { CUE } from '../../src/platform/audio-cues';
import type { AudioMessage } from '../../src/platform/audio-protocol';

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Gain {
  gain = { value: 0 }; connect = vi.fn(); disconnect = vi.fn();
}
class Context {
  static instances: Context[] = [];
  static load = () => Promise.resolve();
  static resume = () => Promise.resolve();
  static close = () => Promise.resolve();
  state = 'running'; currentTime = 1; destination = {}; gain = new Gain();
  audioWorklet = { addModule: vi.fn(() => Context.load()) };
  resume = vi.fn(() => Context.resume());
  close = vi.fn(() => { this.state = 'closed'; return Context.close(); });
  createGain() { return this.gain; }
  constructor() { Context.instances.push(this); }
}
class Node {
  static instances: Node[] = [];
  static connectionFailure = false;
  port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null as null | ((event: { data: unknown }) => void) };
  onprocessorerror: (() => void) | null = null;
  disconnect = vi.fn();
  connect = vi.fn(() => { if (Node.connectionFailure) throw new Error('connect failed'); });
  constructor() { Node.instances.push(this); }
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function fixture() {
  let now = 0;
  const hooks: AudioRuntimeHooks = { ready: vi.fn(), resumed: vi.fn(), blocked: vi.fn(), failed: vi.fn() };
  const runtime = new AudioRuntime(hooks, () => now);
  return { runtime, hooks, time: (value: number) => { now = value; } };
}
beforeEach(() => {
  Context.instances = []; Node.instances = []; Node.connectionFailure = false;
  Context.load = Context.resume = Context.close = () => Promise.resolve();
  vi.stubGlobal('AudioContext', Context); vi.stubGlobal('AudioWorkletNode', Node);
});
afterEach(() => vi.unstubAllGlobals());

describe('native audio graph lifecycle', () => {
  it('shares an in-flight initialization and waits for another gesture after a failed load', async () => {
    const load = deferred(); Context.load = () => load.promise;
    const { runtime, hooks, time } = fixture();
    expect(runtime.status).toBe('uninitialized');
    runtime.unlock(); runtime.unlock(); runtime.unlock();
    expect(runtime.status).toBe('loading'); expect(Context.instances).toHaveLength(1);
    expect(Context.instances[0].audioWorklet.addModule).toHaveBeenCalledOnce();
    load.reject(new Error('network unavailable')); await settle();
    expect(runtime.status).toBe('retryable'); expect(hooks.failed).toHaveBeenCalledOnce();
    const old = Context.instances[0];
    expect(old.close).toHaveBeenCalledOnce(); expect(old.gain.disconnect).toHaveBeenCalledOnce();
    Context.load = () => Promise.resolve();
    time(999); runtime.unlock(); expect(Context.instances).toHaveLength(1);
    time(5000); await settle(); expect(Context.instances).toHaveLength(1);
    runtime.unlock(); await settle();
    expect(runtime.status).toBe('ready'); expect(Context.instances).toHaveLength(2);
    expect(Node.instances).toHaveLength(1); expect(hooks.ready).toHaveBeenCalledOnce();
  });
  it('finishes old graph cleanup before accepting another initialization', async () => {
    const close = deferred(); Context.close = () => close.promise;
    Context.load = () => Promise.reject(new Error('load failed'));
    const { runtime, time } = fixture(); runtime.unlock(); await settle();
    time(1000); runtime.unlock(); expect(Context.instances).toHaveLength(1);
    expect(runtime.status).toBe('loading');
    close.resolve(); await settle(); Context.load = () => Promise.resolve();
    runtime.unlock(); await settle(); expect(Context.instances).toHaveLength(2);
  });
  it('releases a partially connected node and its port after connection failure', async () => {
    Node.connectionFailure = true;
    const { runtime } = fixture(); runtime.unlock(); await settle();
    expect(runtime.status).toBe('retryable');
    expect(Node.instances[0].disconnect).toHaveBeenCalledOnce();
    expect(Node.instances[0].port.close).toHaveBeenCalledOnce();
    expect(Context.instances[0].close).toHaveBeenCalledOnce();
  });
  it('makes missing browser APIs terminal and keeps keyboard gestures harmless', () => {
    vi.stubGlobal('AudioWorkletNode', undefined);
    const { runtime } = fixture(); runtime.unlock(); runtime.unlock();
    expect(runtime.status).toBe('unsupported'); expect(Context.instances).toHaveLength(0);
  });
  it('throttles constructor failures without allocating autonomous retries', async () => {
    const construct = vi.fn(() => { throw new Error('No device'); });
    vi.stubGlobal('AudioContext', class { constructor() { construct(); } });
    const { runtime, time } = fixture(); runtime.unlock(); await settle();
    time(999); runtime.unlock(); expect(construct).toHaveBeenCalledOnce();
    time(1000); runtime.unlock(); await settle(); expect(construct).toHaveBeenCalledTimes(2);
  });
  it('invalidates pending load callbacks and disposes idempotently', async () => {
    const load = deferred(); Context.load = () => load.promise;
    const { runtime, hooks } = fixture(); runtime.unlock();
    const done = runtime.dispose(); expect(runtime.dispose()).toBe(done);
    load.resolve(); await done; await settle(); runtime.unlock();
    expect(runtime.status).toBe('disposed'); expect(hooks.ready).not.toHaveBeenCalled();
    expect(Context.instances[0].close).toHaveBeenCalledOnce(); expect(Node.instances).toHaveLength(0);
  });
  it('disconnects a ready graph and closes its control port', async () => {
    const { runtime } = fixture(); runtime.unlock(); await settle();
    const node = Node.instances[0];
    runtime.setGain(0.3); await runtime.dispose();
    expect(node.port.onmessage).toBeNull();
    expect(node.disconnect).toHaveBeenCalledOnce(); expect(node.port.close).toHaveBeenCalledOnce();
    expect(Context.instances[0].gain.gain.value).toBe(0);
  });
  it('recovers processor failure on a new context and ignores a stale error callback', async () => {
    const { runtime, time } = fixture(); runtime.unlock(); await settle();
    const failed = Node.instances[0].onprocessorerror!; failed(); await settle();
    time(1000); runtime.unlock(); await settle(); failed();
    expect(runtime.status).toBe('ready'); expect(Context.instances).toHaveLength(2);
    expect(Context.instances[1].close).not.toHaveBeenCalled();
  });
  it('does not let an old rejected resume destroy the replacement graph', async () => {
    const resume = deferred(); Context.resume = () => resume.promise;
    const { runtime, time } = fixture(); runtime.unlock(); await settle();
    Context.instances[0].state = 'suspended'; runtime.unlock();
    Node.instances[0].onprocessorerror!(); await settle();
    time(1000); runtime.unlock(); await settle();
    resume.reject(new Error('old resume failed')); await settle();
    expect(runtime.status).toBe('ready'); expect(Context.instances[1].close).not.toHaveBeenCalled();
  });
  it('treats a current rejected resume as a retryable graph failure', async () => {
    const { runtime } = fixture(); runtime.unlock(); await settle();
    Context.resume = () => Promise.reject(new Error('resume failed'));
    Context.instances[0].state = 'suspended'; runtime.unlock(); await settle();
    expect(runtime.status).toBe('retryable'); expect(Context.instances[0].close).toHaveBeenCalledOnce();
  });
});

const pause = (sequence: number, paused: boolean, reason: 'focus' | 'manual' = 'focus'): AudioMessage =>
  ({ type: 'pause', generation: 1, sequence, paused, reason, commands: [] });
const reset = (generation: number, paused = false): AudioMessage =>
  ({ type: 'reset', generation, paused, reason: 'focus', music: [], offset: 0, engine: null });
const applied = (generation: number, sequence: number) => ({ type: 'control-applied', generation, sequence });
async function readyFixture() {
  const result = fixture(); result.runtime.unlock(); await settle();
  result.runtime.setGain(0.3); result.runtime.post(reset(1));
  const node = Node.instances[0], gain = Context.instances[0].gain.gain;
  return { ...result, node, gain, reply: (data: unknown) => node.port.onmessage?.({ data }) };
}

describe('focus output mute', () => {
  it('keeps ordinary opening, commands and manual pause independent of replies', async () => {
    const { runtime, node, gain, reply } = await readyFixture();
    runtime.post({ type: 'commands', generation: 1, sequence: 1, commands: [] });
    runtime.post(pause(2, true, 'manual')); runtime.post(pause(3, false, 'manual'));
    expect(node.port.postMessage.mock.calls.every(([message]) => !message.confirm)).toBe(true);
    reply(applied(1, 3)); expect(gain.value).toBe(0.3);
  });
  it('mutes before posting focus pause and waits for its latest resume confirmation', async () => {
    const { runtime, node, gain, reply } = await readyFixture();
    node.port.postMessage.mockImplementationOnce(() => expect(gain.value).toBe(0));
    runtime.post(pause(1, true)); runtime.setGain(0.6);
    expect(gain.value).toBe(0);
    runtime.post(pause(2, false));
    expect(node.port.postMessage).toHaveBeenLastCalledWith({ ...pause(2, false), confirm: true });
    runtime.post({ type: 'commands', generation: 1, sequence: 3, commands: [] });
    runtime.setGain(0.15); await settle();
    expect(gain.value).toBe(0); // Neither time nor later sound commands replaces the pending control.
    reply(applied(1, 2)); expect(gain.value).toBe(0.15);
  });
  it('invalidates a resume on renewed focus loss and confirms a subsequent manual pause', async () => {
    const { runtime, gain, reply } = await readyFixture();
    runtime.post(pause(1, true)); runtime.post(pause(2, false)); runtime.post(pause(3, true));
    reply(applied(1, 2)); expect(gain.value).toBe(0);
    runtime.post(pause(4, false)); runtime.post(pause(5, true, 'manual'));
    reply(applied(1, 4)); expect(gain.value).toBe(0);
    reply(applied(1, 5)); expect(gain.value).toBe(0.3);
    runtime.post(pause(6, true)); reply(applied(1, 5)); expect(gain.value).toBe(0);
  });
  it('keeps resets muted and binds reopening to the newest reset generation', async () => {
    const { runtime, node, gain, reply } = await readyFixture();
    runtime.post(pause(1, true)); runtime.post(pause(2, false)); runtime.post(reset(2));
    runtime.setGain(0.5); runtime.post(reset(3));
    expect(node.port.postMessage).toHaveBeenLastCalledWith({ ...reset(3), confirm: true });
    reply(applied(1, 2)); reply(applied(2, 0)); expect(gain.value).toBe(0);
    reply(applied(3, 0)); expect(gain.value).toBe(0.5);
    runtime.post(reset(4, true)); expect(gain.value).toBe(0);
    expect(node.port.postMessage).toHaveBeenLastCalledWith(reset(4, true));
  });
  it('ignores malformed, unrelated and mismatched replies without releasing the mute', async () => {
    const { runtime, gain, reply } = await readyFixture();
    runtime.post(pause(1, true)); runtime.post(pause(2, false));
    for (const invalid of [null, undefined, 1, 'control-applied', {}, [],
      { type: '__lifecycle_dump', generation: 1, sequence: 2 },
      applied(2, 2), applied(1, 1), { ...applied(1, 2), sequence: '2' },
      { type: 'control-applied', sequence: 2 }]) {
      reply(invalid); expect(gain.value).toBe(0);
    }
    reply(applied(1, 2)); expect(gain.value).toBe(0.3);
  });
  it('reopens at the current target volume even when that target is zero', async () => {
    const { runtime, gain, reply } = await readyFixture();
    runtime.post(pause(1, true)); runtime.post(pause(2, false)); runtime.setGain(0);
    reply(applied(1, 2)); expect(gain.value).toBe(0);
    runtime.setGain(0.2); expect(gain.value).toBe(0.2);
  });
  it('ignores saved callbacks from a released graph and callbacks after disposal', async () => {
    const { runtime, node, time } = await readyFixture();
    runtime.post(pause(1, true)); runtime.post(pause(2, false));
    const staleReply = node.port.onmessage!;
    node.onprocessorerror!(); await settle(); time(1000); runtime.unlock(); await settle();
    const current = Node.instances[1], gain = Context.instances[1].gain.gain;
    expect(gain.value).toBe(0);
    runtime.setGain(0.3); runtime.post(reset(1, true)); runtime.post(pause(2, false));
    staleReply({ data: applied(1, 2) }); expect(gain.value).toBe(0);
    current.port.onmessage!({ data: applied(1, 2) }); expect(gain.value).toBe(0.3);
    runtime.post(pause(3, true)); runtime.post(pause(4, false));
    const disposedReply = current.port.onmessage!;
    await runtime.dispose(); disposedReply({ data: applied(1, 4) });
    expect(gain.value).toBe(0); expect(runtime.status).toBe('disposed');
  });
  for (const phase of ['mute', 'restore'] as const) {
    it(`releases the graph when the focus ${phase} gain write fails`, async () => {
      const { runtime, node, gain, hooks, reply } = await readyFixture();
      if (phase === 'restore') { runtime.post(pause(1, true)); runtime.post(pause(2, false)); }
      Object.defineProperty(gain, 'value', { get: () => 0, set: () => { throw new Error('native gain failed'); } });
      if (phase === 'mute') runtime.post(pause(1, true));
      else reply(applied(1, 2));
      await settle();
      expect(runtime.status).toBe('retryable'); expect(hooks.failed).toHaveBeenCalledOnce();
      expect(node.disconnect).toHaveBeenCalledOnce(); expect(node.port.close).toHaveBeenCalledOnce();
      expect(Context.instances[0].close).toHaveBeenCalledOnce(); expect(Context.instances).toHaveLength(1);
    });
    it(`releases the graph when the focus ${phase} control cannot be sent`, async () => {
      const { runtime, node, hooks } = await readyFixture();
      if (phase === 'restore') runtime.post(pause(1, true));
      node.port.postMessage.mockImplementationOnce(() => { throw new Error('port closed'); });
      runtime.post(pause(phase === 'mute' ? 1 : 2, phase === 'mute')); await settle();
      expect(runtime.status).toBe('retryable'); expect(hooks.failed).toHaveBeenCalledOnce();
      expect(node.disconnect).toHaveBeenCalledOnce(); expect(Context.instances).toHaveLength(1);
    });
  }
  it('retries ordinary failed gain writes without caching them as successful', async () => {
    const { runtime, gain } = await readyFixture();
    const setter = vi.fn().mockImplementationOnce(() => { throw new Error('try again'); });
    Object.defineProperty(gain, 'value', { set: setter });
    expect(() => runtime.setGain(0.6)).toThrow('try again');
    runtime.setGain(0.6); runtime.setGain(0.6);
    expect(setter).toHaveBeenCalledTimes(2); expect(runtime.status).toBe('ready');
  });
  it('prevents real transport scene resets and frame commits from bypassing focus mute', async () => {
    let runtime!: AudioRuntime;
    const transport = new AudioTransport(0.3, () => ({ music: [], offset: 0, engine: null }),
      hooks => runtime = new AudioRuntime(hooks));
    transport.unlock(); await settle();
    const node = Node.instances[0], gain = Context.instances[0].gain.gain;
    transport.setPaused(true, 'focus'); expect(gain.value).toBe(0);
    transport.stopScene(); expect(gain.value).toBe(0);
    const control = node.port.postMessage.mock.lastCall![0];
    expect(control).toMatchObject({ type: 'reset', confirm: true });
    transport.cue(CUE.shot); transport.commitFrame(); expect(gain.value).toBe(0);
    expect(node.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'commands' }));
    node.port.onmessage!({ data: applied(control.generation, 0) }); expect(gain.value).toBe(0.3);
    await runtime.dispose();
  });
});
