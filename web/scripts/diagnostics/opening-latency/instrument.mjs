/** Applied only to a frozen temporary source tree, never to the shipping sources. */
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Instrumentation anchor changed: ${before.slice(0, 90)}`);
  return source.replace(before, after);
}

export function instrumentMain(source, file) {
  const mark = (kind, fields = '{}') => `(globalThis as any).__OPENING_TRACE__?.mark('${kind}', ${fields});`;
  if (file === 'src/platform/input.ts') {
    source = replaceOnce(source, 'this.keydown = event => {', `this.keydown = event => {
      ${mark('handler-start', '{ code: event.code }')} try {`);
    return replaceOnce(source, 'else this.edges.add(event.code);\n    };', `else this.edges.add(event.code);
      } finally { ${mark('handler-end', '{ code: event.code }')} }
    };`);
  }
  if (file === 'src/platform/audio-runtime.ts') return replaceOnce(source,
    '      node.port.postMessage(outgoing);',
    `      ${mark('post-before', '{ type: outgoing.type, generation: outgoing.generation, sequence: "sequence" in outgoing ? outgoing.sequence : 0 }')}
      node.port.postMessage(outgoing);
      ${mark('post-after', '{ type: outgoing.type, generation: outgoing.generation, sequence: "sequence" in outgoing ? outgoing.sequence : 0 }')}`);
  if (file === 'src/app/controller.ts') {
    source = replaceOnce(source, 'this.audio.syncState(engine.state); this.audio.commitFrame();\n    this.present();',
      `${mark('sync-start')} this.audio.syncState(engine.state); this.audio.commitFrame();
    ${mark('present-start')} this.present(); ${mark('present-end')}`);
    return source;
  }
  throw new Error(`Unexpected main source: ${file}`);
}

// Numeric records: kind, sample frame, generation, sequence, detail.
// 1/2/3 receive reset/commands/pause; 4 accepted commands; 5 apply;
// 6/7 first/second tick; 8 first nonzero; 9 first sample above post-gain PCM threshold.
export function instrumentWorklet(source) {
  source = replaceOnce(source, '  constructor() { super();', `
  private readonly openingRows = new Float64Array(512 * 5);
  private openingCount = 0;
  private openingDropped = 0;
  private openingTicks = 2;
  private openingNonzero = false;
  private openingThreshold = false;
  private openingRecord(kind: number, frame: number, generation = this.generation, sequence = this.sequence, detail = 0): void {
    if (this.openingCount === 512) { this.openingDropped++; return; }
    const index = this.openingCount++ * 5;
    this.openingRows[index] = kind; this.openingRows[index + 1] = frame;
    this.openingRows[index + 2] = generation; this.openingRows[index + 3] = sequence;
    this.openingRows[index + 4] = detail;
  }
  constructor() { super();`);
  source = replaceOnce(source, '  private receive(message: AudioMessage): void {', `  private receive(message: AudioMessage): void {
    if ((message as any).type === '__opening_dump') {
      this.port.postMessage({ type: '__opening_dump', rows: Array.from(this.openingRows.subarray(0, this.openingCount * 5)),
        dropped: this.openingDropped, frame: currentFrame, rate: sampleRate }); return;
    }
    this.openingRecord(message.type === 'reset' ? 1 : message.type === 'commands' ? 2 : 3,
      currentFrame, message.generation, 'sequence' in message ? message.sequence : 0);`);
  source = replaceOnce(source, '    if (this.paused) return;\n    for (const command', `    if (this.paused) return;
    this.openingTicks = 0; this.openingNonzero = false; this.openingThreshold = false;
    this.openingRecord(4, currentFrame);
    for (const command`);
  source = replaceOnce(source, '  private step(now: number): void {', `  private step(now: number): void {
    if (this.pending.size) this.openingRecord(5, Math.round(now * sampleRate), this.generation, this.sequence, this.pending.size);`);
  source = replaceOnce(source, 'this.pending.clear(); this.driver.tick(); this.resumeSilent = false;',
    `this.pending.clear(); this.driver.tick(); this.resumeSilent = false;
    if (this.openingTicks < 2) this.openingRecord(6 + this.openingTicks++, Math.round(now * sampleRate));`);
  return replaceOnce(source, '    for (let channel = 1;', `    if (!this.openingThreshold) for (let index = 0; index < output.length; index++) {
      if (!this.openingNonzero && output[index] !== 0) {
        this.openingNonzero = true; this.openingRecord(8, currentFrame + index);
      }
      if (Math.abs(Math.fround(output[index] * 0.3)) > 0.002) {
        this.openingThreshold = true; this.openingRecord(9, currentFrame + index); break;
      }
    }
    for (let channel = 1;`);
}

/** Self-contained function serialized into the diagnostic pages before their scripts. */
export function installTimeline() {
  const events = [], timestamps = [], graphs = new WeakMap();
  let dropped = 0, nextGraph = 0, gameNode;
  const mark = (kind, details = {}) => {
    if (events.length === 512) { dropped++; return; }
    const context = window.__AUDIO_PCM__?.context;
    if (context && !graphs.has(context)) graphs.set(context, ++nextGraph);
    const perfBefore = performance.now(), audioAt = context?.currentTime ?? null, perfAfter = performance.now();
    events.push({ kind, ...details, graph: context ? graphs.get(context) : null,
      perfBefore, audioAt, perfAfter, state: context?.state ?? null });
  };
  const timestamp = label => {
    const context = window.__AUDIO_PCM__?.context;
    const result = { label, perfBefore: performance.now(), supported: typeof context?.getOutputTimestamp === 'function' };
    try { if (result.supported) Object.assign(result, context.getOutputTimestamp()); }
    catch (error) { result.error = String(error); }
    result.perfAfter = performance.now(); timestamps.push(result);
  };
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (...args) {
    const result = Reflect.apply(connect, this, args);
    if (this instanceof AudioWorkletNode && args[0] === window.__AUDIO_PCM__?.gain) gameNode = this;
    return result;
  };
  window.addEventListener('keydown', event => {
    if (!event.repeat) {
      mark('key', { code: event.code, pcmEventAt: window.__AUDIO_PCM__?.events.at(-1)?.at ?? null });
      timestamp('key:' + event.code);
    }
  }, true);
  window.__OPENING_TRACE__ = {
    mark,
    async harvest() {
      mark('harvest'); timestamp('harvest');
      const port = gameNode?.port;
      if (!port) throw new Error('Diagnostic Worklet port missing');
      const worklet = await new Promise((resolve, reject) => {
        const listener = event => {
          if (event.data?.type !== '__opening_dump') return;
          clearTimeout(timer); port.removeEventListener('message', listener); resolve(event.data);
        };
        const timer = setTimeout(() => { port.removeEventListener('message', listener); reject(new Error('Worklet diagnostic dump timed out')); }, 3000);
        port.addEventListener('message', listener); port.start(); port.postMessage({ type: '__opening_dump' });
      });
      return { events, timestamps, dropped, graphs: nextGraph, worklet };
    },
  };
}
