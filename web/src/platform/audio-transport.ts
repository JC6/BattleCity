import { AUDIO_TICK_HZ, isPersistentCue } from './audio-cues';
import type { AudioFrame, AudioMessage, AudioReply } from './audio-protocol';
import { AudioRuntime, type AudioRuntimeHooks } from './audio-runtime';

interface PendingFrame extends AudioFrame { queuedAt: number }
export interface PersistentAudio { start: readonly number[]; offset: number }
export type AudioEndpoint = Pick<AudioRuntime, 'status' | 'connected' | 'resumeSyncNeeded' | 'ready' | 'now' | 'unlock' | 'setGain' | 'post' | 'dispose'>;
export type AudioRuntimeFactory = (hooks: AudioRuntimeHooks) => AudioEndpoint;

/** Bounded simulation frames and generation/ACK barriers; no game event mapping. */
export class AudioTransport {
  private readonly runtime: AudioEndpoint;
  private generationReady = false;
  private sceneActive = false;
  private generation = 0;
  private sequence = 0;
  private rejectionFloor = 0;
  private tick = 0;
  private paused = false;
  private pauseReason: 'manual' | 'focus' = 'manual';
  private starts = new Set<number>();
  private stops = new Set<number>();
  private pending: PendingFrame[] = [];
  private inFlight = false;
  private credits = 12;
  private flushQueued = false;
  private nextTime = 0;
  constructor(private readonly volume: number, private readonly snapshot: () => PersistentAudio,
    createRuntime: AudioRuntimeFactory = hooks => new AudioRuntime(hooks)) {
    this.runtime = createRuntime({
      ready: () => { this.resetProcessor(); this.applyPause(); },
      resumed: () => { this.starts.clear(); this.stops.clear(); this.resynchronize(); },
      blocked: () => this.applyGain(),
      failed: () => {
        this.generation++; this.generationReady = false;
        this.starts.clear(); this.stops.clear(); this.pending = [];
        this.inFlight = false; this.credits = 12; this.nextTime = 0;
        this.rejectionFloor = this.sequence;
      },
      reply: message => this.receive(message),
    });
  }
  unlock(): void { this.runtime.unlock(); }
  dispose(): Promise<void> {
    if (this.runtime.status !== 'disposed') this.stopScene();
    return this.runtime.dispose();
  }
  private receive(message: AudioReply): void {
    if (message.generation !== this.generation) return;
    if (message.type === 'ack' && message.accepted === false) {
      // Any rejected outstanding batch lost authoritative ticks, even
      // when a later batch was already sent. Control barriers exclude
      // acknowledgements from the queue discarded by pause/reset.
      if (Number.isInteger(message.sequence) && message.sequence > this.rejectionFloor && message.sequence <= this.sequence) this.resynchronize();
      return;
    }
    const accepted = message.type === 'ack' && message.accepted === true && Number.isInteger(message.sequence)
      && message.sequence > this.rejectionFloor && message.sequence <= this.sequence && this.validCredits(message.credits);
    // FIFO reception of any current batch proves the scene reset ran.
    // Newer posts still reserve capacity until their own ACK arrives.
    if (accepted && !this.generationReady) { this.generationReady = true; this.applyGain(); }
    if (message.sequence !== this.sequence) return;
    if (message.type === 'ack') {
      if (!this.inFlight || !accepted) return;
      this.inFlight = false; this.credits = message.credits;
      if (typeof message.nextAt === 'number' && Number.isFinite(message.nextAt)) this.nextTime = Math.max(this.nextTime, message.nextAt);
    } else if (message.type === 'progress') {
      // An older consumption snapshot cannot restore capacity reserved
      // for a batch whose reception is still unacknowledged.
      if (this.inFlight || !this.validCredits(message.credits) || !Number.isFinite(message.nextAt)) return;
      this.credits = message.credits; this.nextTime = Math.max(this.nextTime, message.nextAt);
    } else return;
    this.flush();
  }

  setPaused(paused: boolean, reason: 'manual' | 'focus' = 'manual'): void {
    if (this.paused === paused && (!paused || this.pauseReason === reason)) return;
    this.paused = paused; this.pauseReason = reason;
    this.sequence++; this.rejectionFloor = this.sequence;
    const discarded = this.pending;
    this.pending = []; this.inFlight = false; this.credits = 12; this.nextTime = 0;
    this.applyPause(discarded);
    this.starts.clear(); this.stops.clear();
  }
  private applyPause(frames: PendingFrame[] = []): void {
    this.applyGain();
    this.post({ type: 'pause', generation: this.generation, paused: this.paused, reason: this.pauseReason,
      tick: this.tick, frames: frames.map(({ tick, start, stop }) => ({ tick, start, stop })),
      start: [...this.starts], stop: [...this.stops] });
    // Prove FIFO reset/unpause reception without advancing an actual driver
    // step. The gain must open before a real attack can reach the processor.
    if (this.runtime.connected && !this.paused && !this.runtime.resumeSyncNeeded && !this.generationReady && !this.inFlight) {
      this.sequence++; this.inFlight = true;
      this.post({ type: 'frames', generation: this.generation, sequence: this.sequence, at: this.nextTime, frames: [] });
    }
  }
  private applyGain(): void {
    const target = this.paused
      ? (this.pauseReason === 'manual' ? this.volume : 0)
      : (!this.runtime.resumeSyncNeeded && this.generationReady && this.sceneActive ? this.volume : 0);
    this.runtime.setGain(target);
  }
  stopScene(): void {
    this.generation++; this.pending = []; this.starts.clear(); this.stops.clear(); this.inFlight = false; this.credits = 12;
    this.rejectionFloor = this.sequence;
    this.nextTime = 0; this.sceneActive = false; this.paused = false;
    this.resetProcessor(); this.applyPause();
  }
  cue(id: number): void {
    if (this.ready()) { this.starts.add(id); this.sceneActive = true; this.applyGain(); }
  }
  stop(id: number): void { if (this.ready()) this.stops.add(id); }
  private ready(): boolean { return this.runtime.ready && !this.paused && this.volume > 0; }
  /** Once at the end of each actual simulation tick, after cues/state sync. */
  advanceTick(): void {
    this.tick++;
    if (!this.ready()) { this.starts.clear(); this.stops.clear(); return; }
    // A reset scene has no driver work until a real cue starts. The zero-frame
    // control proof does not need a simulated step or reserve FIFO capacity.
    const silentLead = !this.sceneActive && !this.snapshot().start.length && !this.starts.size && !this.stops.size;
    if (silentLead) return;
    this.pending.push({ tick: this.tick, start: [...this.starts], stop: [...this.stops], queuedAt: this.runtime.now });
    this.starts.clear(); this.stops.clear();
    if (this.pending.length > 12) {
      // A stalled render/audio port gets a fresh generation at the current
      // music offset. This advances persistent state silently and discards
      // expired attacks instead of stretching the song or replaying a burst.
      const now = this.pending[this.pending.length - 1].queuedAt;
      const recovery = this.pending
        .filter(frame => now - frame.queuedAt >= 0 && now - frame.queuedAt <= 2 / AUDIO_TICK_HZ)
        .map(frame => ({ at: frame.queuedAt, start: frame.start.filter(id => !isPersistentCue(id)) }))
        .filter(frame => frame.start.length > 0).slice(-12);
      this.resynchronize(recovery);
    }
    if (!this.flushQueued) {
      this.flushQueued = true; queueMicrotask(() => { this.flushQueued = false; this.flush(); });
    }
  }
  /** Submit actual fixed steps before the frame paints its canvas. */
  commitFrame(): void { this.flush(); }
  private flush(): void {
    if (!this.generationReady || !this.credits || !this.pending.length || !this.ready()) return;
    // A failed native gain setter must not let the already proved generation
    // submit its first attack while still muted. A cached success avoids another setter.
    this.applyGain();
    const now = this.runtime.now;
    // Preserve completed ticks and persistent state, without replaying attacks
    // that expired while processor capacity was unavailable. A recovery keeps
    // its original creation clock separate from playback deadlines and game ticks.
    const count = Math.min(this.pending.length, this.credits);
    const frames = this.pending.splice(0, count).map(({ tick, start, stop, queuedAt }) => ({ tick, stop,
      start: now - queuedAt > 2 / AUDIO_TICK_HZ ? start.filter(isPersistentCue) : start }));
    this.nextTime = Math.max(this.nextTime, now);
    // Reserve unacknowledged posts too. FIFO reception makes only the latest
    // ACK's credit snapshot safe to restore across these bounded batches.
    this.credits -= count; this.inFlight = true; this.sequence++;
    this.post({ type: 'frames', generation: this.generation, sequence: this.sequence, at: this.nextTime, frames });
    this.nextTime += frames.length / AUDIO_TICK_HZ;
  }
  private validCredits(credits: unknown): credits is number {
    return typeof credits === 'number' && Number.isInteger(credits) && credits >= 0 && credits <= 12;
  }
  private resynchronize(recovery: { at: number; start: number[] }[] = []): void {
    // Persistent state seeks the authoritative offset. Only local overflow may
    // retain unposted, still-fresh attacks on their original native clocks.
    this.generation++; this.pending = []; this.inFlight = false; this.credits = 12; this.nextTime = 0;
    this.rejectionFloor = this.sequence;
    this.resetProcessor(recovery); this.applyPause();
  }
  private resetProcessor(recovery: { at: number; start: number[] }[] = []): void {
    const persistent = this.snapshot(), start = [...persistent.start];
    // Native gain blocks the old scene while its asynchronous reset is pending.
    // An empty scene stays silent after ACK; recovered persistent state and a
    // new real cue can activate only after FIFO reception proves this reset ran.
    this.generationReady = false; this.sceneActive ||= start.length > 0; this.applyGain();
    this.post({ type: 'reset', generation: this.generation, start, offset: persistent.offset, tick: this.tick,
      ...(recovery.length ? { recovery } : {}) });
  }
  private post(message: AudioMessage): void { this.runtime.post(message); }
}
