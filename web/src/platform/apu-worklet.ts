import { ApuDriver } from './apu-driver';
import { ApuSynth } from './apu-synth';
import { AUDIO_TICK_HZ, AUDIO_TRACKS, CUE, isPersistentCue } from './audio-cues';
import type { AudioCommand, AudioMessage, AudioReply } from './audio-protocol';

declare const sampleRate: number;
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

class BattleCityApu extends AudioWorkletProcessor {
  private readonly synth = new ApuSynth(sampleRate);
  private readonly driver = new ApuDriver((channel, register, value) => this.synth.write(channel, register, value));
  private readonly pauseSynth = new ApuSynth(sampleRate);
  private readonly pauseDriver = new ApuDriver((channel, register, value) => this.pauseSynth.write(channel, register, value));
  private generation = -1;
  private sequence = 0;
  private readonly pending = new Map<number, AudioCommand>();
  private paused = false;
  private focusPaused = false;
  private remaining = 0;
  private pauseRemaining = 0;
  private resumeSilent = false;
  private live = false;
  private tailSamples = 0;
  private readonly frameSamples = sampleRate / AUDIO_TICK_HZ;

  constructor() { super(); this.port.onmessage = (event: MessageEvent<AudioMessage>) => this.receive(event.data); }
  private receive(message: AudioMessage): void {
    if (message.type === 'reset') {
      if (message.generation <= this.generation) return;
      this.generation = message.generation; this.sequence = 0; this.pending.clear();
      this.driver.reset(); this.synth.reset(); this.live = false; this.tailSamples = 0;
      this.remaining = 0; this.resumeSilent = false;
      for (const id of message.music) if (isPersistentCue(id)) this.driver.trigger(id);
      // Recovery alone seeks finite music. Engine loops start at the current state.
      for (let tick = 0; tick < Math.min(600, message.offset); tick++) this.driver.tick();
      if (message.engine === CUE.playerEngine || message.engine === CUE.enemyEngine) this.driver.trigger(message.engine);
      this.live = this.driver.hasActivity();
      this.setPaused(message.paused, message.reason === 'focus');
      if (message.confirm) this.confirmControl(message.generation, 0);
      return;
    }
    if (message.generation !== this.generation || message.sequence <= this.sequence) return;
    this.sequence = message.sequence;
    if (message.type === 'pause') {
      // Preserve music received before its first audio tick, without decoding an
      // extra tick or replaying an attack discarded by the pause boundary.
      for (const command of message.commands) if (AUDIO_TRACKS[command.id]) this.pending.set(command.id, command);
      if (message.paused) {
        for (const command of this.pending.values()) {
          if (!command.start) this.driver.stop(command.id);
          else if (isPersistentCue(command.id)) this.driver.trigger(command.id);
        }
        this.pending.clear();
        for (let id = 0; id < AUDIO_TRACKS.length; id++) if (!isPersistentCue(id)) this.driver.stop(id);
        this.live = this.driver.hasActivity(); this.tailSamples = 0; this.synth.clearFilters();
        // The next ordinary tick clears stopped hardware channels before any
        // resumed sample; it does not advance the frozen fractional phase early.
        this.resumeSilent = true;
      }
      this.setPaused(message.paused, message.reason === 'focus');
      if (message.confirm) this.confirmControl(message.generation, message.sequence);
      return;
    }
    if (this.paused) return;
    for (const command of message.commands) if (AUDIO_TRACKS[command.id])
      this.pending.set(command.id, command);
  }
  private confirmControl(generation: number, sequence: number): void {
    const reply: AudioReply = { type: 'control-applied', generation, sequence };
    this.port.postMessage(reply);
  }
  private setPaused(paused: boolean, focus: boolean): void {
    this.paused = paused; this.focusPaused = focus;
    this.pauseDriver.reset(); this.pauseSynth.reset(); this.pauseRemaining = 0;
    if (paused && !focus) this.pauseDriver.trigger(CUE.pause);
  }
  private step(): void {
    for (const command of this.pending.values()) {
      if (!command.start) this.driver.stop(command.id);
      else this.driver.trigger(command.id);
    }
    this.pending.clear(); this.driver.tick(); this.resumeSilent = false;
    const active = this.driver.hasActivity();
    if (this.live && !active) this.tailSamples = Math.ceil(sampleRate * 0.08);
    this.live = active;
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0]?.[0];
    if (!output) return true;
    for (let index = 0; index < output.length; index++) {
      if (this.paused) {
        if (this.focusPaused || !this.pauseDriver.hasActivity()) { output.fill(0, index); break; }
        if (this.pauseRemaining <= 0) { this.pauseDriver.tick(true); this.pauseRemaining += this.frameSamples; }
        this.pauseRemaining--; output[index] = this.pauseSynth.sample(); continue;
      }
      if (!this.live && !this.tailSamples && !this.pending.size) {
        this.remaining = 0; this.synth.advanceSilence(output.length - index); output.fill(0, index); break;
      }
      if (this.remaining <= 0) {
        this.step(); this.remaining += this.frameSamples;
      }
      this.remaining--;
      if (this.resumeSilent) output[index] = 0;
      else if (this.live) output[index] = this.synth.sample();
      else if (this.tailSamples > 0) {
        output[index] = this.synth.sample();
        if (--this.tailSamples === 0) this.synth.clearFilters();
      } else { output[index] = 0; this.synth.advanceSilence(1); }
    }
    for (let channel = 1; channel < outputs[0].length; channel++) outputs[0][channel].set(output);
    return true;
  }
}
registerProcessor('battlecity-apu', BattleCityApu);
