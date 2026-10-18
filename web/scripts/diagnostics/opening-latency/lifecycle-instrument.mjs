/** Temporary-copy instrumentation only. These hooks never enter the shipping source tree. */
export const LIFECYCLE_EVENTS = Object.freeze({ receipt: 1, reject: 2, queue: 3, replace: 4,
  clear: 5, execute: 6, expired: 7, pauseApplied: 8, focusOutput: 9 });
export const LIFECYCLE_COLUMNS = Object.freeze(['kind', 'frame', 'generation', 'sequence', 'cue',
  'createdAt', 'sentAt', 'value', 'relatedGeneration', 'relatedSequence', 'extra']);
export const LIFECYCLE_MESSAGE_TYPES = Object.freeze({ reset: 1, commands: 2, pause: 3 });
export const LIFECYCLE_REASONS = Object.freeze({ wrongGeneration: 1, staleSequence: 2, paused: 3,
  staleReset: 4, resetClear: 5, pauseClear: 6 });

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Instrumentation anchor changed: ${before.slice(0, 90)}`);
  return source.replace(before, after);
}

export function instrumentLifecycleMain(source) {
  return replaceOnce(source, '      node.port.postMessage(outgoing);',
    `      (globalThis as any).__LIFECYCLE_TRACE__?.mark('post-before', { ...outgoing, nodePresent: !!node }, this.context);
      node.port.postMessage(outgoing);
      (globalThis as any).__LIFECYCLE_TRACE__?.mark('post-after', { ...outgoing, nodePresent: !!node }, this.context);`);
}

export function instrumentLifecycleWorklet(source) {
  source = replaceOnce(source, '  constructor() { super();', `
  private readonly lifecycleRows = new Float64Array(512 * 11);
  // A separate fixed slot per cue preserves its original message after newer messages arrive.
  private readonly lifecycleSources = new Float64Array(28 * 4);
  private lifecycleCount = 0;
  private lifecycleDropped = 0;
  private lifecycleDumped = false;
  private lifecycleFocusPending = false;
  private lifecycleFocusGeneration = -1;
  private lifecycleFocusSequence = 0;
  private lifecycleRecord(kind: number, frame: number, generation: number, sequence: number,
    cue = -1, createdAt = -1, sentAt = -1, value = 0, relatedGeneration = 0, relatedSequence = 0, extra = 0): void {
    if (this.lifecycleCount === 512) { this.lifecycleDropped++; return; }
    const at = this.lifecycleCount++ * 11;
    this.lifecycleRows[at] = kind; this.lifecycleRows[at + 1] = frame;
    this.lifecycleRows[at + 2] = generation; this.lifecycleRows[at + 3] = sequence;
    this.lifecycleRows[at + 4] = cue; this.lifecycleRows[at + 5] = createdAt;
    this.lifecycleRows[at + 6] = sentAt; this.lifecycleRows[at + 7] = value;
    this.lifecycleRows[at + 8] = relatedGeneration; this.lifecycleRows[at + 9] = relatedSequence;
    this.lifecycleRows[at + 10] = extra;
  }
  private lifecycleCue(kind: number, frame: number, id: number, value = 0,
    relatedGeneration = 0, relatedSequence = 0): void {
    const at = id * 4;
    this.lifecycleRecord(kind, frame, this.lifecycleSources[at], this.lifecycleSources[at + 1], id,
      this.lifecycleSources[at + 2], this.lifecycleSources[at + 3], value, relatedGeneration, relatedSequence);
  }
  private lifecycleQueue(command: AudioCommand, sentAt: number): void {
    if (this.pending.has(command.id)) this.lifecycleCue(4, currentFrame, command.id, 0, this.generation, this.sequence);
    const at = command.id * 4;
    this.lifecycleSources[at] = this.generation; this.lifecycleSources[at + 1] = this.sequence;
    this.lifecycleSources[at + 2] = command.createdAt; this.lifecycleSources[at + 3] = sentAt;
    this.lifecycleCue(3, currentFrame, command.id, command.start ? 1 : 0);
  }
  private lifecycleClear(reason: number): void {
    for (const command of this.pending.values()) this.lifecycleCue(5, currentFrame, command.id, reason);
  }
  constructor() { super();`);
  source = replaceOnce(source, '  private receive(message: AudioMessage): void {', `  private receive(message: AudioMessage): void {
    if ((message as any).type === '__lifecycle_dump') {
      if (!this.lifecycleDumped) {
        this.lifecycleDumped = true;
        this.port.postMessage({ type: '__lifecycle_dump', schemaVersion: 1, stride: 11,
          rows: Array.from(this.lifecycleRows.subarray(0, this.lifecycleCount * 11)),
          dropped: this.lifecycleDropped, frame: currentFrame, rate: sampleRate });
      }
      return;
    }
    this.lifecycleRecord(1, currentFrame, message.generation, 'sequence' in message ? message.sequence : 0,
      -1, -1, -1, message.type === 'reset' ? 1 : message.type === 'commands' ? 2 : 3);`);
  source = replaceOnce(source, '      if (message.generation <= this.generation) return;',
    `      if (message.generation <= this.generation) {
        this.lifecycleRecord(2, currentFrame, message.generation, 0, -1, -1, -1, 4); return;
      }`);
  source = replaceOnce(source, '      this.generation = message.generation; this.sequence = 0; this.pending.clear();',
    `      this.lifecycleClear(5);
      this.generation = message.generation; this.sequence = 0; this.pending.clear();`);
  source = replaceOnce(source, '    if (message.generation !== this.generation || message.sequence <= this.sequence) return;',
    `    if (message.generation !== this.generation || message.sequence <= this.sequence) {
      this.lifecycleRecord(2, currentFrame, message.generation, message.sequence, -1, -1, -1,
        message.generation !== this.generation ? 1 : 2); return;
    }`);
  source = replaceOnce(source,
    '      for (const command of message.commands) if (AUDIO_TRACKS[command.id]) this.pending.set(command.id, { ...command, sentAt: currentFrame / sampleRate });',
    `      for (const command of message.commands) if (AUDIO_TRACKS[command.id]) {
        this.lifecycleQueue(command, currentFrame / sampleRate);
        this.pending.set(command.id, { ...command, sentAt: currentFrame / sampleRate });
      }`);
  source = replaceOnce(source,
    `          if (!command.start) this.driver.stop(command.id);
          else if (isPersistentCue(command.id)) this.driver.trigger(command.id);`,
    `          if (!command.start) {
            this.driver.stop(command.id); this.lifecycleCue(6, currentFrame, command.id, 0);
          } else if (isPersistentCue(command.id)) {
            this.driver.trigger(command.id); this.lifecycleCue(6, currentFrame, command.id, 1);
          }`);
  source = replaceOnce(source, '        this.pending.clear();', '        this.lifecycleClear(6); this.pending.clear();');
  source = replaceOnce(source, '    if (this.paused) return;', `    if (this.paused) {
      this.lifecycleRecord(2, currentFrame, message.generation, message.sequence, -1, -1, -1, 3); return;
    }`);
  source = replaceOnce(source,
    `    for (const command of message.commands) if (AUDIO_TRACKS[command.id])
      this.pending.set(command.id, { ...command, sentAt: message.sentAt });`,
    `    for (const command of message.commands) if (AUDIO_TRACKS[command.id]) {
      this.lifecycleQueue(command, message.sentAt);
      this.pending.set(command.id, { ...command, sentAt: message.sentAt });
    }`);
  source = replaceOnce(source, '    this.paused = paused; this.focusPaused = focus;',
    `    this.paused = paused; this.focusPaused = focus;
    this.lifecycleRecord(8, currentFrame, this.generation, this.sequence, -1, -1, -1, paused ? 1 : 0, 0, 0, focus ? 1 : 0);
    this.lifecycleFocusPending = paused && focus;
    this.lifecycleFocusGeneration = this.generation; this.lifecycleFocusSequence = this.sequence;`);
  source = replaceOnce(source,
    `      if (!command.start) this.driver.stop(command.id);
      else if (isPersistentCue(command.id) || isCueFresh(command.id,
        isCountCue(command.id) ? command.createdAt : command.sentAt, now)) this.driver.trigger(command.id);`,
    `      if (!command.start) {
        this.driver.stop(command.id); this.lifecycleCue(6, Math.round(now * sampleRate), command.id, 0);
      } else if (isPersistentCue(command.id) || isCueFresh(command.id,
        isCountCue(command.id) ? command.createdAt : command.sentAt, now)) {
        this.driver.trigger(command.id); this.lifecycleCue(6, Math.round(now * sampleRate), command.id, 1);
      } else this.lifecycleCue(7, Math.round(now * sampleRate), command.id, isCountCue(command.id) ? 1 : 0);`);
  return replaceOnce(source, '    for (let channel = 1;', `    if (this.lifecycleFocusPending && this.paused && this.focusPaused) {
      let peak = 0;
      for (let index = 0; index < output.length; index++) peak = Math.max(peak, Math.abs(output[index]));
      this.lifecycleRecord(9, currentFrame, this.lifecycleFocusGeneration, this.lifecycleFocusSequence,
        -1, -1, -1, peak, 0, 0, output.length);
      this.lifecycleFocusPending = false;
    }
    for (let channel = 1;`);
}

/** Serialized after the existing PCM probe, before application scripts; no imported closures. */
export function installLifecycleTimeline() {
  const events = [], graphs = new WeakMap(), nodes = new WeakMap();
  let dropped = 0, nextGraph = 0, harvestPromise;
  const graphOf = context => {
    if (!context) return null;
    if (!graphs.has(context)) graphs.set(context, ++nextGraph);
    return graphs.get(context);
  };
  const mark = (kind, details = {}, context = window.__AUDIO_PCM__?.context) => {
    if (events.length === 512) { dropped++; return; }
    const perfBefore = performance.now(), audioAt = context?.currentTime ?? null, perfAfter = performance.now();
    const entry = { ...details, kind, graph: graphOf(context), perfBefore, audioAt, perfAfter, state: context?.state ?? null };
    if (details.commands) entry.commands = details.commands.slice(0, 28).map(command => ({ ...command }));
    if (details.music) entry.music = details.music.slice(0, 28);
    if (details.type === 'reset') entry.sequence = 0;
    events.push(entry);
  };
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (...args) {
    const result = Reflect.apply(connect, this, args);
    const capture = window.__AUDIO_PCM__;
    if (this instanceof AudioWorkletNode && args[0] === capture?.gain && capture.context === this.context) {
      graphOf(this.context); nodes.set(this.context, this);
    }
    return result;
  };
  const eventMark = (kind, code) => {
    const capture = window.__AUDIO_PCM__;
    const anchor = capture?.events.at(-1);
    mark(kind === 'keydown' ? 'key' : 'blur', { code,
      pcmEventAt: anchor?.kind === kind && anchor?.code === code ? anchor.at : null });
  };
  window.addEventListener('keydown', event => { if (!event.repeat) eventMark('keydown', event.code); }, true);
  window.addEventListener('blur', () => eventMark('blur', ''), true);
  window.__LIFECYCLE_TRACE__ = {
    mark,
    harvest() {
      if (harvestPromise) return harvestPromise;
      harvestPromise = (async () => {
        const capture = window.__AUDIO_PCM__, context = capture?.context;
        mark('harvest', {}, context);
        const graph = graphOf(context), rate = context?.sampleRate ?? null;
        let worklet = null, error;
        try {
          const port = context && nodes.get(context)?.port;
          if (!port) throw new Error('Diagnostic Worklet port missing for the current PCM graph');
          worklet = await new Promise((resolve, reject) => {
            const listener = event => {
              if (event.data?.type !== '__lifecycle_dump') return;
              clearTimeout(timer); port.removeEventListener('message', listener); resolve(event.data);
            };
            const timer = setTimeout(() => {
              port.removeEventListener('message', listener); reject(new Error('Worklet diagnostic dump timed out'));
            }, 3000);
            port.addEventListener('message', listener); port.start(); port.postMessage({ type: '__lifecycle_dump' });
          });
          if (window.__AUDIO_PCM__?.context !== context) throw new Error('PCM graph changed during diagnostic harvest');
        } catch (cause) { error = String(cause); }
        return { schemaVersion: 1, graph, rate, graphs: nextGraph,
          main: { events: events.slice(), dropped }, worklet, ...(error ? { error } : {}) };
      })();
      return harvestPromise;
    },
  };
}
