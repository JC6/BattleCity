import { vi } from 'vitest';
import type { AudioMessage } from '../../src/platform/audio-protocol';

export class Context {
  static instances: Context[] = [];
  static initialState = 'running';
  static load = () => Promise.resolve();
  static resume = async (context: Context) => { context.state = 'running'; };
  static close = () => Promise.resolve();
  state = Context.initialState; currentTime = 0; destination = {}; sampleRate = 44100;
  gain = { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
  audioWorklet = { addModule: vi.fn(() => Context.load()) };
  resume = vi.fn(() => Context.resume(this));
  close = vi.fn(() => { this.state = 'closed'; return Context.close(); });
  createGain() { return this.gain; }
  constructor() { Context.instances.push(this); }
}
export class Node {
  static instances: Node[] = [];
  static connectionFailure = false;
  port = { postMessage: vi.fn<(message: AudioMessage) => void>(), close: vi.fn(),
    onmessage: null as null | ((event: { data: unknown }) => void) };
  onprocessorerror: (() => void) | null = null;
  connect = vi.fn(() => { if (Node.connectionFailure) throw new Error('connect failed'); });
  disconnect = vi.fn();
  get messages(): AudioMessage[] { return this.port.postMessage.mock.calls.map(([message]) => message); }
  constructor() { Node.instances.push(this); }
}
export function installNativeAudio(): void {
  Context.instances = []; Context.initialState = 'running';
  Context.load = Context.close = () => Promise.resolve();
  Context.resume = async context => { context.state = 'running'; };
  Node.instances = []; Node.connectionFailure = false;
  vi.stubGlobal('AudioContext', Context); vi.stubGlobal('AudioWorkletNode', Node);
}
export async function settle(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}
