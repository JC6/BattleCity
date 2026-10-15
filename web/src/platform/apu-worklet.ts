import { ApuDriver } from './apu-driver';
import { ApuSynth } from './apu-synth';
import { AUDIO_TICK_HZ, CUE, isPersistentCue } from './audio-cues';

declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

export interface AudioFrame { tick: number; start: number[]; stop: number[] }
export type AudioMessage =
  | { type: 'reset'; generation: number; start: number[]; offset: number; tick: number; recovery?: Array<{ at: number; start: number[] }> }
  | { type: 'pause'; generation: number; paused: boolean; reason: 'manual' | 'focus';
      tick: number; frames: AudioFrame[]; start: number[]; stop: number[] }
  | { type: 'frames'; generation: number; sequence: number; at: number; frames: AudioFrame[] };
export type AudioReply =
  | { type: 'ack'; generation: number; sequence: number; accepted: boolean; credits: number; nextAt?: number }
  | { type: 'progress'; generation: number; sequence: number; credits: number; nextAt: number };
interface QueuedAudioFrame extends AudioFrame { sourceSample: number }

class BattleCityApu extends AudioWorkletProcessor {
  private readonly synth = new ApuSynth(sampleRate);
  private readonly driver = new ApuDriver((channel, register, value) => this.synth.write(channel, register, value));
  private readonly pauseSynth = new ApuSynth(sampleRate);
  private readonly pauseDriver = new ApuDriver((channel, register, value) => this.pauseSynth.write(channel, register, value));
  private generation = 0;
  private paused = false;
  private focusPaused = false;
  private pauseUntil = 0;
  private queue: QueuedAudioFrame[] = [];
  private position = 0;
  private recovery: Array<{ at: number; start: number[] }> = [];
  private recoveryGeneration: number | null = null;
  private nextSample = 0;
  private sequence = 0;
  private pendingAcceptedSequence: number | null = null;
  private lastTick = -1;
  private lastFreshTick: number | null = null;
  private live = false;
  private tailSamples = 0;
  private readonly frameSamples = sampleRate / AUDIO_TICK_HZ;

  constructor() { super(); this.port.onmessage = (event: MessageEvent<AudioMessage>) => this.receive(event.data); }
  private receive(message: AudioMessage): void {
    if (message.type === 'reset') {
      if (message.generation < this.generation) return;
      this.generation = message.generation; this.queue = []; this.position = 0; this.sequence = 0;
      this.pendingAcceptedSequence = null;
      this.nextSample = currentFrame;
      this.driver.reset(); this.synth.reset(); this.pauseDriver.reset(); this.pauseSynth.reset();
      this.live = false; this.lastTick = message.tick; this.tailSamples = 0;
      this.lastFreshTick = null;
      if (this.recoveryGeneration !== message.generation) {
        this.recoveryGeneration = message.generation;
        this.recovery = (message.recovery ?? [])
          .map(group => ({ at: group.at, start: group.start.filter(id => !isPersistentCue(id)) }))
          .filter(group => group.start.length > 0).slice(-12);
      }
      for (const id of message.start) this.driver.trigger(id);
      // Late unlock seeks only persistent music; short events are never queued.
      for (let tick = 0; tick < Math.min(600, message.offset); tick++) this.driver.tick();
      this.live = this.driver.hasActivity();
      return;
    }
    if (message.generation !== this.generation) return;
    if (message.type === 'pause') {
      this.lastFreshTick = null;
      if (message.paused || this.paused) this.recovery = [];
      if (message.paused) this.synchronizePause(message);
      this.paused = message.paused; this.focusPaused = message.reason === 'focus';
      this.queue = []; this.position = 0;
      this.pendingAcceptedSequence = null;
      this.nextSample = currentFrame;
      if (message.paused && !this.focusPaused) {
        this.pauseDriver.reset(); this.pauseSynth.reset(); this.pauseDriver.trigger(CUE.pause); this.pauseUntil = currentFrame;
      } else { this.pauseDriver.reset(); this.pauseSynth.reset(); }
      return;
    }
    if (message.sequence <= this.sequence) {
      // Delivery acknowledgement can repeat; accepted frames must not.
      if (message.sequence === this.pendingAcceptedSequence) this.pendingAcceptedSequence = null;
      this.acknowledge(message.sequence, true); return;
    }
    if (this.paused || message.frames.length > this.credits()) {
      this.recovery = [];
      this.acknowledge(message.sequence, false); return;
    }
    if (!message.frames.length) {
      this.sequence = message.sequence; this.pendingAcceptedSequence = null;
      this.acknowledge(message.sequence, true); return;
    }
    const sourceSample = Math.round(message.at * sampleRate);
    this.queue = this.queue.slice(this.position); this.position = 0;
    // Appended batches share the already scheduled playback cursor. A fresh
    // queue retains the previous final hardware frame before its next write.
    if (!this.queue.length) this.nextSample = Math.max(this.nextSample, sourceSample);
    this.queue.push(...message.frames.map((frame, index) => ({ ...frame, sourceSample: sourceSample + index * this.frameSamples })));
    this.sequence = message.sequence; this.pendingAcceptedSequence = message.sequence;
  }

  private credits(): number { return 12 - (this.queue.length - this.position); }
  private acknowledge(sequence: number, accepted: boolean): void {
    const reply: AudioReply = { type: 'ack', generation: this.generation, sequence, accepted, credits: this.credits() };
    this.port.postMessage(reply);
  }
  private acknowledgePending(): boolean {
    const sequence = this.pendingAcceptedSequence;
    if (sequence === null) return false;
    this.pendingAcceptedSequence = null;
    const reply: AudioReply = { type: 'ack', generation: this.generation, sequence, accepted: true,
      credits: this.credits(), nextAt: this.nextSample / sampleRate };
    this.port.postMessage(reply); return true;
  }
  private synchronizePause(message: Extract<AudioMessage, { type: 'pause' }>): void {
    // The game can be one or more ticks ahead of the scheduled audio batch. Catch
    // its sustained driver state up silently before freezing; queued shots,
    // tally clicks and other short attacks must not replay after Start.
    const pending = message.frames.length <= 12 ? message.frames : [];
    let queued = this.position, discarded = 0;
    const target = Math.max(this.lastTick, Math.min(message.tick, this.lastTick + 600));
    while (this.lastTick < target) {
      const tick = this.lastTick + 1;
      while (queued < this.queue.length && this.queue[queued].tick < tick) queued++;
      while (discarded < pending.length && pending[discarded].tick < tick) discarded++;
      const first = this.queue[queued]?.tick === tick ? this.queue[queued++] : undefined;
      const second = pending[discarded]?.tick === tick ? pending[discarded++] : undefined;
      for (const frame of [first, second]) if (frame) {
        for (const id of frame.stop) this.driver.stop(id);
        for (const id of frame.start) if (isPersistentCue(id)) this.driver.trigger(id);
      }
      this.driver.tick(); this.lastTick = tick;
    }
    // A scene can be paused before its very first simulated tick. Preserve its
    // pending music start for the next driver tick without starting an old attack.
    for (const id of message.stop) this.driver.stop(id);
    for (const id of message.start) if (isPersistentCue(id)) this.driver.trigger(id);
    this.updateActivity();
  }
  private updateActivity(): void {
    const active = this.driver.hasActivity();
    if (this.live && !active) this.tailSamples = Math.ceil(sampleRate * 0.08);
    this.live = active;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0];
    if (!output) { this.acknowledgePending(); return true; }
    let pauseActive = this.paused && !this.focusPaused && this.pauseDriver.hasActivity();
    let consumed = false;
    for (let index = 0; index < output.length; index++) {
      const frame = currentFrame + index;
      if (this.paused) {
        if (!pauseActive) { output.fill(0, index); break; }
        if (frame >= this.pauseUntil) {
          this.pauseDriver.tick(true); this.pauseUntil += this.frameSamples;
          pauseActive = this.pauseDriver.hasActivity();
        }
        output[index] = this.pauseSynth.sample(); continue;
      }
      while (this.position < this.queue.length && frame >= this.nextSample) {
        const command = this.queue[this.position++];
        consumed = true;
        // Expiry keeps the sender's original clock. A fresh but delayed command
        // gets a full hardware frame before the next write or mute; rebasing its
        // playback time must never make an expired attack fresh again.
        const late = frame - command.sourceSample > this.frameSamples * 2;
        // The driver writes a fresh decoded note on its next advanced step.
        // That first output frame must survive even if this next step is late.
        const freshOutput = command.tick > this.lastTick && this.lastTick === this.lastFreshTick;
        // Recovery retains the unsent attack's original age until an actual
        // driver step, so receiving a reset cannot revive a later stale attack.
        let recovered: Set<number> | undefined;
        if (command.tick > this.lastTick && this.recovery.length) {
          const recovery = this.recovery; this.recovery = []; recovered = new Set<number>();
          for (const group of recovery) {
            const age = frame - group.at * sampleRate;
            if (age >= 0 && age <= this.frameSamples * 2) for (const id of group.start) recovered.add(id);
          }
        }
        const freshRecovery = !!recovered?.size;
        if (!late || freshOutput || freshRecovery) this.nextSample = Math.max(this.nextSample, frame);
        if (command.tick > this.lastTick) {
          if (recovered) for (const id of recovered) this.driver.trigger(id);
          for (const id of command.stop) this.driver.stop(id);
          // Delayed short attacks expire, while a scene's sustained music must
          // survive and advance through the queued authoritative ticks.
          for (const id of command.start) if (!late || isPersistentCue(id)) this.driver.trigger(id);
          this.driver.tick();
          if (!late || freshRecovery) this.lastFreshTick = command.tick;
          this.lastTick = command.tick; this.updateActivity();
        }
        // Expired steps catch up silently on their original clock. Keeping
        // their inherited playback delay would also expire fresh queued attacks.
        // Fresh steps and their next hardware write retain a complete frame.
        this.nextSample = (late && !freshOutput && !freshRecovery ? Math.min(this.nextSample, command.sourceSample) : this.nextSample) + this.frameSamples;
      }
      if (this.live) output[index] = this.synth.sample();
      else if (this.tailSamples > 0) {
        output[index] = this.synth.sample();
        if (--this.tailSamples === 0) this.synth.clearFilters();
      } else {
        const next = this.position < this.queue.length ? Math.ceil(this.nextSample - currentFrame) : output.length;
        const length = Math.min(output.length - index, Math.max(1, next - index));
        this.synth.advanceSilence(length); output.fill(0, index, index + length); index += length - 1;
      }
    }
    if (!this.acknowledgePending() && consumed) {
      const reply: AudioReply = { type: 'progress', generation: this.generation, sequence: this.sequence,
        credits: this.credits(), nextAt: this.nextSample / sampleRate };
      this.port.postMessage(reply);
    }
    for (let channel = 1; channel < outputs[0].length; channel++) outputs[0][channel].set(output);
    return true;
  }
}
registerProcessor('battlecity-apu', BattleCityApu);
