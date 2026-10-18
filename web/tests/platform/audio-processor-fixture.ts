import { expect, vi } from 'vitest';
import type { AudioMessage } from '../../src/platform/audio-protocol';
import type { ApuDriver } from '../../src/platform/apu-driver';
import type { ApuSynth } from '../../src/platform/apu-synth';
export interface Processor {
  port: { onmessage(event: { data: AudioMessage }): void; postMessage: ReturnType<typeof vi.fn> };
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  driver: ApuDriver; synth: ApuSynth; remaining: number;
}
export async function processorFixture(rate = 44100) {
  vi.resetModules(); let Type!: new () => Processor, current = 0;
  vi.stubGlobal('sampleRate', rate); vi.stubGlobal('currentFrame', 0);
  vi.stubGlobal('AudioWorkletProcessor', class { port = { onmessage: () => {}, postMessage: vi.fn() }; });
  vi.stubGlobal('registerProcessor', (_: string, type: new () => Processor) => { Type = type; });
  await import('../../src/platform/apu-worklet');
  const processor = new Type();
  const send = (data: AudioMessage) => processor.port.onmessage({ data });
  function render(samples: number, quantum = 128): Float32Array {
    const result = new Float32Array(samples);
    for (let index = 0; index < samples; index += quantum) {
      const output = new Float32Array(Math.min(quantum, samples - index));
      expect(processor.process([], [[output]])).toBe(true);
      result.set(output, index); current += output.length; vi.stubGlobal('currentFrame', current);
    }
    return result;
  }
  send({ type: 'reset', generation: 1, music: [], offset: 0, engine: null, paused: false, reason: 'manual' });
  return { processor, send, render, rate, now: () => current / rate };
}
