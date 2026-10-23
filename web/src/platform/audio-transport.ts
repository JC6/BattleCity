import { AUDIO_TRACKS, isPersistentCue } from './audio-cues';
import type { AudioCommand, PersistentAudio, PauseReason } from './audio-protocol';
import { AudioRuntime, type AudioRuntimeHooks } from './audio-runtime';

export type AudioEndpoint = Pick<AudioRuntime, 'status' | 'connected' | 'ready' | 'unlock' | 'setGain' | 'post' | 'dispose'>;
export type AudioRuntimeFactory = (hooks: AudioRuntimeHooks) => AudioEndpoint;

/** Coalesces semantic changes. The receiver's sample clock owns playback. */
export class AudioTransport {
  private readonly runtime: AudioEndpoint;
  private generation = 0;
  private sequence = 0;
  private paused = false;
  private reason: PauseReason = 'manual';
  private readonly pending = new Map<number, AudioCommand>();
  constructor(private readonly volume: number, private readonly snapshot: () => PersistentAudio,
    createRuntime: AudioRuntimeFactory = hooks => new AudioRuntime(hooks)) {
    this.runtime = createRuntime({
      ready: () => this.resetProcessor(),
      // Queue current state before resume() as well as after its completion.
      // Native context suspension may have stopped the audio clock meanwhile.
      blocked: () => this.resetProcessor(),
      resumed: () => this.resetProcessor(),
      failed: () => { this.generation++; this.pending.clear(); },
    });
  }
  unlock(): void { this.runtime.unlock(); }
  dispose(): Promise<void> { this.pending.clear(); return this.runtime.dispose(); }
  cue(id: number): void { this.queue(id, true); }
  stop(id: number): void { this.queue(id, false); }
  private queue(id: number, start: boolean): void {
    if (AUDIO_TRACKS[id] && this.runtime.ready && !this.paused && this.volume > 0)
      this.pending.set(id, { id, start });
  }
  /** Submit changes before painting, without advancing an audio or game tick. */
  commitFrame(): void {
    if (!this.runtime.ready || this.paused || this.volume <= 0) { this.pending.clear(); return; }
    if (!this.pending.size) return;
    const commands = [...this.pending.values()];
    // Retry a failed native gain write before consuming any first attack.
    this.runtime.setGain(this.volume);
    this.runtime.post({ type: 'commands', generation: this.generation, sequence: ++this.sequence, commands });
    this.pending.clear();
  }
  setPaused(paused: boolean, reason: PauseReason = 'manual'): void {
    if (this.runtime.status === 'disposed' || (this.paused === paused && (!paused || this.reason === reason))) return;
    this.paused = paused; this.reason = reason;
    const commands = [...this.pending.values()].filter(command => !command.start || isPersistentCue(command.id));
    this.pending.clear();
    if (this.runtime.connected) this.runtime.post({ type: 'pause', generation: this.generation,
      sequence: ++this.sequence, paused, reason, commands });
  }
  stopScene(): void {
    if (this.runtime.status === 'disposed') return;
    this.paused = false; this.reason = 'manual'; this.resetProcessor();
  }
  private resetProcessor(): void {
    this.pending.clear(); this.generation++; this.sequence = 0;
    if (!this.runtime.connected) return;
    // A new processor starts silent; first notes need no reply. The runtime
    // keeps an existing focus mute closed until this reset is confirmed.
    this.runtime.setGain(this.volume);
    this.runtime.post({ type: 'reset', generation: this.generation, ...this.snapshot(),
      paused: this.paused, reason: this.reason });
  }
}
