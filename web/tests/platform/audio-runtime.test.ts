import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioRuntime, type AudioRuntimeHooks } from '../../src/platform/audio-runtime';

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
  const hooks: AudioRuntimeHooks = { ready: vi.fn(), resumed: vi.fn(), blocked: vi.fn(), failed: vi.fn(), reply: vi.fn() };
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
  it('disconnects a ready graph, closes its port and ignores its late replies', async () => {
    const { runtime, hooks } = fixture(); runtime.unlock(); await settle();
    const node = Node.instances[0], deliver = node.port.onmessage!;
    runtime.setGain(0.3); await runtime.dispose();
    deliver({ data: { type: 'ack', generation: 0, sequence: 1, accepted: true, credits: 12 } });
    expect(hooks.reply).not.toHaveBeenCalled(); expect(node.port.onmessage).toBeNull();
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
