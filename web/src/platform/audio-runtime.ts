import type { AudioMessage, AudioReply } from './audio-protocol';
import workletURL from './apu-worklet.ts?worker&url';

export type AudioRuntimeState = 'uninitialized' | 'loading' | 'ready' | 'retryable' | 'unsupported' | 'disposed';
export interface AudioRuntimeHooks {
  ready(): void;
  resumed(): void;
  blocked(): void;
  failed(): void;
}

/** Owns one native graph. Only a user gesture can create or retry it. */
export class AudioRuntime {
  private state: AudioRuntimeState = 'uninitialized';
  private context?: AudioContext;
  private gain?: GainNode;
  private gainParameter?: AudioParam;
  private gainValue?: number;
  private desiredGain = 0;
  private focusMuted = false;
  private pendingControl?: { generation: number; sequence: number };
  private node?: AudioWorkletNode;
  private attempt = 0;
  private retryAt = 0;
  private resumePending = false;
  private cleanup: Promise<void> = Promise.resolve();
  constructor(private readonly hooks: AudioRuntimeHooks, private readonly clock = () => performance.now()) {}
  get status(): AudioRuntimeState { return this.state; }
  get connected(): boolean { return this.node !== undefined; }
  get ready(): boolean { return this.connected && this.context?.state === 'running' && !this.resumePending; }
  get now(): number { return this.context?.currentTime ?? 0; }

  unlock(): void {
    if (this.state === 'disposed' || this.state === 'unsupported') return;
    if (this.state === 'retryable' && this.clock() < this.retryAt) return;
    // A failed graph stays loading until close() settles. Never overlap graphs.
    if (this.state === 'loading' && !this.context) return;
    if (typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined') {
      this.state = 'unsupported'; return;
    }
    let attempt = this.attempt;
    try {
      if (!this.context) {
        attempt = ++this.attempt;
        this.state = 'loading';
        this.resumePending = false;
        const context = this.context = new AudioContext();
        if (!context.audioWorklet?.addModule) { this.fail(attempt, true); return; }
        this.gain = context.createGain(); this.gainParameter = this.gain.gain;
        this.gainParameter.value = 0; this.gainValue = 0;
        this.gain.connect(context.destination);
        // Each retry needs a new context: Worklet module failures are cached per
        // Worklet instance, so resetting a Promise alone cannot recover.
        void context.audioWorklet.addModule(workletURL).then(() => {
          if (!this.current(attempt)) return;
          const node = this.node = new AudioWorkletNode(context, 'battlecity-apu', {
            numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
          });
          node.connect(this.gain!);
          node.onprocessorerror = () => this.fail(attempt);
          node.port.onmessage = (event: MessageEvent<unknown>) => {
            if (!this.current(attempt) || this.node !== node) return;
            this.receive(event.data, attempt);
          };
          this.state = 'ready'; this.resumePending = context.state !== 'running';
          this.hooks.ready();
        }).catch(() => this.fail(attempt));
      }
      const context = this.context!;
      const nativeState = context.state;
      if (nativeState === 'closed') { this.fail(attempt); return; }
      const running = nativeState === 'running';
      if (!running) { this.resumePending = true; this.hooks.blocked(); }
      if (!running || this.resumePending) {
        void context.resume().then(() => {
          if (!this.current(attempt) || !this.resumePending || !this.node || context.state !== 'running') return;
          this.resumePending = false; this.hooks.resumed();
        }).catch(() => this.fail(attempt));
      }
    } catch { this.fail(attempt); }
  }

  setGain(value: number): void {
    this.desiredGain = value;
    this.applyGain(this.focusMuted ? 0 : value);
  }
  private applyGain(value: number): void {
    if (!this.gainParameter || value === this.gainValue) return;
    // Cache only successful writes; a failed native setter must be retryable.
    this.gainParameter.value = value; this.gainValue = value;
  }
  post(message: AudioMessage): void {
    const node = this.node, attempt = this.attempt;
    if (!node) return;
    let outgoing = message;
    try {
      if (message.type !== 'commands') {
        if (message.paused && message.reason === 'focus') {
          this.focusMuted = true; this.pendingControl = undefined;
          // Mute the output before waiting for the Worklet control message.
          this.applyGain(0);
        } else if (this.focusMuted) {
          this.pendingControl = { generation: message.generation,
            sequence: message.type === 'reset' ? 0 : message.sequence };
          outgoing = { ...message, confirm: true };
        }
      }
      node.port.postMessage(outgoing);
    } catch (error) {
      if (message.type === 'commands') throw error;
      this.fail(attempt);
    }
  }
  private receive(data: unknown, attempt: number): void {
    const pending = this.pendingControl;
    if (!this.focusMuted || !pending || !data || typeof data !== 'object') return;
    const reply = data as Partial<AudioReply>;
    if (reply.type !== 'control-applied' || reply.generation !== pending.generation ||
      reply.sequence !== pending.sequence) return;
    try {
      this.applyGain(this.desiredGain);
      this.focusMuted = false; this.pendingControl = undefined;
    } catch { this.fail(attempt); }
  }
  private current(attempt: number): boolean { return attempt === this.attempt && this.state !== 'disposed'; }
  private fail(attempt: number, unsupported = false): void {
    if (!this.current(attempt)) return;
    ++this.attempt; this.state = 'loading'; this.resumePending = true;
    this.retryAt = this.clock() + 1000;
    this.cleanup = this.release();
    this.hooks.failed();
    const failedAttempt = this.attempt;
    void this.cleanup.then(() => {
      if (this.current(failedAttempt)) this.state = unsupported ? 'unsupported' : 'retryable';
    });
  }
  private release(): Promise<void> {
    const context = this.context, node = this.node, gain = this.gain;
    this.context = undefined; this.node = undefined; this.gain = undefined;
    this.gainParameter = undefined; this.gainValue = undefined;
    this.desiredGain = 0; this.focusMuted = false; this.pendingControl = undefined;
    // Every cleanup is attempted even when a native operation fails.
    try { if (gain) gain.gain.value = 0; } catch { /* Disconnect below still silences it. */ }
    try { if (node) { node.port.onmessage = null; node.onprocessorerror = null; } } catch { /* Continue releasing. */ }
    try { node?.disconnect(); } catch { /* Already disconnected. */ }
    try { node?.port.close(); } catch { /* Already closed. */ }
    try { gain?.disconnect(); } catch { /* Already disconnected. */ }
    try { return context ? context.close().catch(() => {}) : Promise.resolve(); }
    catch { return Promise.resolve(); }
  }
  dispose(): Promise<void> {
    if (this.state === 'disposed') return this.cleanup;
    ++this.attempt; this.state = 'disposed'; this.resumePending = true;
    const previous = this.cleanup;
    this.cleanup = Promise.all([previous, this.release()]).then(() => {});
    return this.cleanup;
  }
}
