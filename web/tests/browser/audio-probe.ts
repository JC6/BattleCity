import { expect, type Page, type TestInfo } from '@playwright/test';
import { setTimeout as setDiagnosticTimeout, clearTimeout as clearDiagnosticTimeout } from 'node:timers';
import { observePcmShotFailure, pcmShotWindowFeatures, pcmWindowFeatures, restorePcmSnapshot, snapshotPcmWindow, type AudioCapture, type PcmPacket, type PcmFeatures, type PcmComparisonWindow, type PcmShotMatch, type PcmSnapshot, type PcmShotFailure, type PcmShotFailureObserver, type AudioTransportEntry } from './pcm-window';
export type { PcmShotFailureObserver } from './pcm-window';

// Playwright invokes function arguments; a string containing a function would
// only evaluate to that function. Embed the self-contained snapshot code once.
const snapshotPcmJson = new Function('request',
  `return JSON.stringify((${snapshotPcmWindow.toString()})(request));`) as
  (request: Parameters<typeof snapshotPcmWindow>[0]) => string;

interface PcmProbeOptions { observeScenes?: boolean; deferRecording?: boolean }
export interface PcmMeasurement {
  parameters: Parameters<typeof pcmWindowFeatures>[0]; snapshot: PcmSnapshot; features: PcmFeatures;
}
export type PcmMeasurementFailure = Pick<PcmMeasurement, 'parameters'> & Partial<Omit<PcmMeasurement, 'parameters'>> & {
  stage: 'coverage' | 'sampling' | 'measurement' | 'assertion'; error: unknown;
};
export interface PcmOpeningObservation {
  clock: 'AudioContext'; keyAt: number; onset: number | null; latencyMs: number | null;
  targetMs: number; targetExceeded: boolean | null; functionalLimitMs: number; rate: number;
}

export async function attachPcmFailure(testInfo: TestInfo, failure: PcmMeasurementFailure,
  measurement: string, anchors: Readonly<Record<string, number>>): Promise<void> {
  const error = failure.error instanceof Error
    ? { name: failure.error.name, message: failure.error.message, stack: failure.error.stack }
    : { name: 'Error', message: String(failure.error) };
  await testInfo.attach('audio-measurement-failure', {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ ...failure, error, measurement, anchors }, null, 2)),
  });
}

/** Test-only sidecar. The application's destination edge is delegated unchanged;
 * a zero-gain branch observes actual PCM, without driving game or AudioContext time. */
export async function installPcmProbe(page: Page, options: PcmProbeOptions = {}): Promise<void> {
  // The injected function is self-contained browser code, without imported closures.
  await page.addInitScript(`(${installPcmProbeInPage.toString()})(${JSON.stringify(options)});`);
}

function installPcmProbeInPage({ observeScenes, deferRecording }: PcmProbeOptions): void {
    const capture: AudioCapture = { ready: false, gameReady: false, errors: [], rate: 0, packets: [], events: [], marks: [] };
    window.__AUDIO_PCM__ = capture;
    capture.recording = !deferRecording;
    let attachTap: (() => void) | undefined;
    let detachTap: (() => void) | undefined;
    let detachScene: (() => void) | undefined;
    let observedPort: MessagePort | undefined;
    const observeTransport = (node: AudioWorkletNode) => {
      const history = capture.transport ??= { entries: [], next: 0, dropped: 0, observationErrors: 0 };
      try {
        const port = node.port;
        if (port === observedPort) return;
        observedPort = port;
        const record = (direction: 'send' | 'receive', message: unknown) => {
          try {
            const value = message as AudioTransportEntry;
            if (!['reset', 'pause', 'commands', 'control-applied', 'frames', 'ack', 'progress'].includes(value.type)) return;
            const entry: AudioTransportEntry = { direction, wall: Date.now(), type: value.type, generation: value.generation };
            for (const field of ['sequence', 'at', 'tick', 'offset', 'paused', 'reason', 'confirm', 'accepted', 'credits', 'nextAt', 'sentAt', 'engine'] as const) {
              if (value[field] !== undefined) Object.assign(entry, { [field]: value[field] });
            }
            if (value.music) entry.music = value.music.slice(0, 28);
            if (value.commands) entry.commands = value.commands.slice(0, 28).map(command => ({ ...command }));
            if (value.start) entry.start = value.start.slice(0, 28);
            if (value.stop) entry.stop = value.stop.slice(0, 28);
            if (value.recovery) entry.recovery = value.recovery.slice(0, 12).map(group => ({ at: group.at, start: group.start.slice(0, 28) }));
            if (value.frames) entry.frames = value.frames.slice(0, 12).map(frame => ({ tick: frame.tick,
              ...(frame.createdAt === undefined ? {} : { createdAt: frame.createdAt }),
              start: frame.start.slice(0, 28), stop: frame.stop.slice(0, 28) }));
            if (history.entries.length < 512) history.entries.push(entry);
            else { history.entries[history.next] = entry; history.next = (history.next + 1) % 512; history.dropped++; }
          } catch { history.observationErrors++; }
        };
        const postMessage = port.postMessage;
        port.postMessage = (function (this: MessagePort, ...args: unknown[]) {
          const result = Reflect.apply(postMessage, this, args);
          record('send', args[0]);
          return result;
        }) as MessagePort['postMessage'];
        port.addEventListener('message', event => record('receive', event.data));
        // The application starts its own port for focus recovery confirmations.
        // Do not call start() or replace its message handler for observation.
      } catch { history.observationErrors++; }
    };
    const eventTime = (kind: 'keydown' | 'blur', code: string) => {
      if (capture.recording === false || !capture.context) return;
      if (capture.events.length >= 128) { capture.errors.push('Audio event observation exceeded its bounded capacity'); return; }
      capture.events.push({ kind, code, at: capture.context.currentTime });
    };
    // Capture phase timestamps the genuine event before the application handler;
    // browser RPC completion time is unrelated to this native audio clock.
    window.addEventListener('keydown', event => { if (!event.repeat) eventTime('keydown', event.code); }, true);
    window.addEventListener('blur', () => eventTime('blur', ''), true);
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = (function (this: AudioNode, ...args: unknown[]) {
      const result = Reflect.apply(connect, this, args);
      if (this instanceof AudioWorkletNode && args[0] === capture.gain) {
        capture.gameReady = true;
        observeTransport(this);
        // Register the sidecar after the real game module has finished loading.
        // Observation must not compete with the application's Worklet startup.
        attachTap?.(); attachTap = undefined;
      }
      if (!(this instanceof GainNode) || !(args[0] instanceof AudioDestinationNode)) return result;
      const context = this.context;
      if (!(context instanceof AudioContext) || args[0] !== context.destination) return result;
      if (capture.context === context) return result;
      if (capture.context) {
        // Native clocks restart on a new graph. Retain old evidence separately;
        // never mix its sample labels or key timestamps into the replacement.
        (capture.retiredGraphs ??= []).push({ context: capture.context, gain: capture.gain, rate: capture.rate,
          packets: capture.packets, events: capture.events, marks: capture.marks, transport: capture.transport });
        detachTap?.(); detachScene?.(); observedPort = undefined;
        capture.ready = false; capture.gameReady = false;
        capture.packets = []; capture.events = []; capture.marks = [];
        capture.transport = undefined; capture.recordFromFrame = undefined;
      }
      capture.context = context; capture.gain = this; capture.rate = context.sampleRate;
      if (observeScenes) {
        const arena = window.__BATTLECITY__?.renderScene();
        if (!arena?.events) throw new Error('Actual scene update events are unavailable for PCM observation');
        let lastKind = '', scoreTick = -1;
        const mark = (kind: string, tick?: number) => {
          if (capture.marks.length >= 64) { capture.errors.push('Audio scene observation exceeded its bounded capacity'); return; }
          capture.marks.push({ kind, at: context.currentTime, ...(tick === undefined ? {} : { tick }) });
        };
        const observe = () => {
          // Read-only observation after the actual fixed simulation and present(),
          // before canvas painting can delay the native audio-clock observation.
          // Production keyboard cases never enable or require this test harness.
          const scene = arena.presentation;
          if (scene && scene.kind === lastKind && scene.kind !== 'score') return;
          if (scene && context.state === 'running') {
            if (scene.kind !== lastKind) { lastKind = scene.kind; scoreTick = -1; mark(scene.kind); }
            if (scene.kind === 'score') {
              // Independent literal reference boundary: 35-frame lead + 9-frame
              // first count. No scoreTimeline call or synthetic tick advancement.
              const tick = Math.round(scene.elapsedMs * 60.0988 / 1000);
              if (scoreTick < 35 + 9 && tick >= 35 + 9) mark('score-count', tick);
              scoreTick = tick;
            }
          }
        };
        const originalFrame = arena.onFrame;
        const observedFrame = function (this: typeof arena, delta: number): void {
          originalFrame.call(this, delta); observe();
        };
        const detach = () => { if (arena.onFrame === observedFrame) arena.onFrame = originalFrame; };
        detachScene = detach;
        arena.onFrame = observedFrame;
        arena.events.once('shutdown', detach);
        arena.events.once('destroy', detach);
      }
      const module = `class PcmTap extends AudioWorkletProcessor {
        constructor(){super();this.chunks=[];this.frames=[];this.times=[];this.lengths=[];}
        process(inputs,outputs){
          const input=inputs[0][0],length=outputs[0][0].length;
          this.frames.push(currentFrame);this.times.push(currentTime);this.lengths.push(length);
          this.chunks.push(input?input.slice():new Float32Array(length));
          if(this.frames.length===16){const samples=new Float32Array(this.lengths.reduce((a,b)=>a+b,0));let offset=0;
            for(const chunk of this.chunks){samples.set(chunk,offset);offset+=chunk.length;}
            this.port.postMessage({frame:this.frames[0],frames:this.frames,times:this.times,lengths:this.lengths,samples},[samples.buffer]);
            this.chunks=[];this.frames=[];this.times=[];this.lengths=[];}
          return true;
        }
      } registerProcessor('battlecity-test-pcm',PcmTap);`;
      attachTap = () => {
        const url = URL.createObjectURL(new Blob([module], { type: 'text/javascript' }));
        void context.audioWorklet.addModule(url).then(() => {
          if (context !== capture.context || context.state === 'closed') return;
          const tap = new AudioWorkletNode(context, 'battlecity-test-pcm');
          const silent = context.createGain(); silent.gain.value = 0;
          Reflect.apply(connect, this, [tap]); Reflect.apply(connect, tap, [silent]); Reflect.apply(connect, silent, [context.destination]);
          detachTap = () => {
            tap.port.onmessage = null; tap.port.close();
            try { tap.disconnect(); silent.disconnect(); } catch { /* The old context may already be closed. */ }
          };
          tap.port.onmessage = (event: MessageEvent<PcmPacket>) => {
            if (context !== capture.context) return;
            capture.ready = true;
            if (!capture.recording) return;
            if (capture.recordFromFrame !== undefined) {
              const frame = event.data.frames.at(-1)!, length = event.data.lengths.at(-1)!;
              if (!Number.isInteger(frame) || frame < 0 || !Number.isInteger(length) || length <= 0) {
                capture.errors.push('Invalid PCM quantum labels'); return;
              }
              if (frame + length <= capture.recordFromFrame) return;
            }
            if (capture.packets.length >= 768) { capture.errors.push('PCM capture exceeded its bounded packet capacity'); return; }
            capture.packets.push(event.data);
          };
        }).catch(error => capture.errors.push(String(error))).finally(() => URL.revokeObjectURL(url));
      };
      return result;
    }) as AudioNode['connect'];
}

export async function beginPcmCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const pcm = window.__AUDIO_PCM__;
    if (pcm?.errors.length) throw new Error(pcm.errors.join('\n'));
    if (!pcm?.ready || !pcm.gameReady || pcm.context?.state !== 'running') throw new Error('Actual PCM observation is not ready');
    if (pcm.recording !== false || pcm.packets.length) throw new Error('PCM recording has already started');
    // Begin once after keyboard-only fixture preparation; never clear packets
    // or errors to make an overflowing or malformed recording pass.
    pcm.recordFromFrame = Math.round(pcm.context.currentTime * pcm.rate);
    pcm.recording = true;
  });
}

export async function audioReady(page: Page): Promise<void> {
  const handle = await page.waitForFunction(() => {
    const pcm = window.__AUDIO_PCM__;
    if (pcm?.errors.length) throw new Error(pcm.errors.join('\n'));
    return pcm?.ready === true && pcm.gameReady === true
      ? { ready: pcm.ready, gameReady: pcm.gameReady, errors: pcm.errors } : null;
  }, undefined, { polling: 'raf', timeout: 5000 });
  try { expect(await handle.jsonValue()).toEqual({ ready: true, gameReady: true, errors: [] }); }
  finally { await handle.dispose(); }
}
export async function audioTime(page: Page): Promise<number> {
  return page.evaluate(() => {
    const context = window.__AUDIO_PCM__?.context;
    if (!context || context.state !== 'running') throw new Error('Actual AudioContext is not running');
    return context.currentTime;
  });
}
export async function audioEventTime(page: Page, code: string, kind: 'keydown' | 'blur' = 'keydown'): Promise<number> {
  return page.evaluate(({ code, kind }) => {
    const event = window.__AUDIO_PCM__!.events.findLast(event => event.kind === kind && event.code === code);
    if (!event) throw new Error(`Actual audio-clock event was not observed: ${kind} ${code}`);
    return event.at;
  }, { code, kind });
}
export async function audioMarkTime(page: Page, kind: string, options: { after?: number; timeout?: number } = {}): Promise<number> {
  // The fixed-step observer already records scene timestamps. Read those marks
  // without scheduling extra compositor frames while native audio is running.
  const handle = await page.waitForFunction(({ kind, after }) =>
    window.__AUDIO_PCM__!.marks.findLast(mark => mark.kind === kind && mark.at > after) ?? null,
  { kind, after: options.after ?? -1 }, { polling: 25, timeout: options.timeout ?? 5000 });
  try {
    const mark = await handle.jsonValue();
    if (!mark) throw new Error(`Actual audio scene was not observed: ${kind}`);
    return mark.at;
  } finally { await handle.dispose(); }
}
export async function waitForAudioTime(page: Page, time: number): Promise<void> {
  // Native PCM coverage does not require compositor frames. A RAF observer can
  // add rendering work while the game's independent fixed-step timer is live.
  const handle = await page.waitForFunction(time => {
    const pcm = window.__AUDIO_PCM__;
    if (pcm?.errors.length) throw new Error(pcm.errors.join('\n'));
    const last = pcm?.packets.at(-1);
    return !!last && (last.frames.at(-1)! + last.lengths.at(-1)!) / pcm!.rate >= time;
  }, time, { polling: 25, timeout: 15000 });
  await handle.dispose();
}
async function readPcmSnapshot(page: Page, start: number, end: number): Promise<PcmSnapshot> {
  // Send one JSON string, avoiding Playwright's recursive object serializer on
  // the game's thread. PCM remains base64 bytes; Node still validates every
  // quantum label and analyzes the exact snapshot retained for failures.
  const json = await page.evaluate(snapshotPcmJson, { start, end, measure: true });
  return JSON.parse(json) as PcmSnapshot;
}
async function measuredPcm(page: Page, parameters: Parameters<typeof pcmWindowFeatures>[0]): Promise<PcmFeatures> {
  const snapshot = await readPcmSnapshot(page, parameters.start, parameters.end);
  return pcmWindowFeatures(parameters, restorePcmSnapshot(snapshot));
}
/** Retain the exact raw window analyzed in Node; diagnostic failures must never
 * replace the original wait, sampling or measurement error. */
export async function pcmMeasurement(page: Page, start: number, end: number, frequencies: readonly number[] = [],
  onFailure?: (failure: PcmMeasurementFailure) => void | Promise<void>): Promise<PcmMeasurement> {
  const parameters = { start, end, frequencies: [...frequencies] };
  let snapshot: PcmSnapshot | undefined;
  let stage: PcmMeasurementFailure['stage'] = 'coverage';
  return observePcmShotFailure(async () => {
    await waitForAudioTime(page, end);
    stage = 'sampling';
    snapshot = await readPcmSnapshot(page, start, end);
    stage = 'measurement';
    const features = pcmWindowFeatures(parameters, restorePcmSnapshot(snapshot));
    return { parameters, snapshot, features };
  }, () => ({ parameters, snapshot, stage }), onFailure);
}
export async function pcmFeatures(page: Page, start: number, end: number, frequencies: readonly number[] = []): Promise<PcmFeatures> {
  return (await pcmMeasurement(page, start, end, frequencies)).features;
}
/** Acquisition observes its own failures once; assertions retain that same sample. */
export async function pcmAssert(page: Page, start: number, end: number, frequencies: readonly number[],
  assertion: (features: PcmFeatures) => void | Promise<void>,
  onFailure?: (failure: PcmMeasurementFailure) => void | Promise<void>): Promise<PcmFeatures> {
  const measurement = await pcmMeasurement(page, start, end, frequencies, onFailure);
  return observePcmShotFailure(async () => {
    await assertion(measurement.features);
    return measurement.features;
  }, () => ({ ...measurement, stage: 'assertion' as const }), onFailure);
}
/** Opening availability and first-note quality have separate windows. The
 * 90ms observation is not a gate or a hardware keyboard-to-speaker measurement. */
export async function expectOpeningPcm(page: Page, keyAt: number, options: {
  checkVoices?: boolean;
  onFailure?: (failure: PcmMeasurementFailure) => void | Promise<void>;
  onObservation?: (observation: PcmOpeningObservation) => void | Promise<void>;
} = {}): Promise<number> {
  const limit = 0.5, target = 0.09;
  const opening = await pcmAssert(page, keyAt, keyAt + limit, [], async value => {
    const latency = value.onset === null ? null : value.onset - keyAt;
    if (options.onObservation) {
      let timer: ReturnType<typeof setDiagnosticTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => options.onObservation!({ clock: 'AudioContext', keyAt, onset: value.onset,
            latencyMs: latency === null ? null : latency * 1000, targetMs: target * 1000,
            targetExceeded: latency === null ? null : latency > target,
            functionalLimitMs: limit * 1000, rate: value.rate })),
          new Promise<void>(resolve => { timer = setDiagnosticTimeout(resolve, 3000); }),
        ]);
      } catch { /* Optional observations cannot replace the PCM verdict. */ }
      finally { if (timer !== undefined) clearDiagnosticTimeout(timer); }
    }
    expect(value.onset, 'Stage music must start within the 500ms PCM window').not.toBeNull();
    expect(value.onset!).toBeGreaterThanOrEqual(keyAt);
    expect(value.onset!).toBeLessThan(keyAt + limit);
    expect(value.peak).toBeLessThan(0.5);
  }, options.onFailure);
  const onset = opening.onset!;
  // Reference timer pitches: C5 pulse, G3 pulse, C3 triangle. Anchor quality
  // to the first actual onset, so silence before it cannot dilute the RMS.
  await pcmAssert(page, onset + 0.015, onset + 0.10,
    options.checkVoices ? [522.714, 195.57, 130.678] : [], value => {
      expect(value.rms).toBeGreaterThan(0.008);
      expect(value.peak).toBeLessThan(0.5);
      if (options.checkVoices) {
        expect(value.amplitudes[0]).toBeGreaterThan(0.005);
        expect(value.amplitudes[1]).toBeGreaterThan(0.003);
        expect(value.amplitudes[2]).toBeGreaterThan(0.001);
      }
    }, options.onFailure);
  return onset;
}
export async function pcmIdleWindow(page: Page, start: number, end: number, frequencies: readonly number[], comparison?: PcmComparisonWindow): Promise<PcmFeatures> {
  await waitForAudioTime(page, start + 0.5);
  let measured: PcmFeatures | undefined;
  await expect.poll(async () => {
    measured = await measuredPcm(page, { start, end, frequencies: [...frequencies], idle: true, comparison });
    return measured.idleReady;
  }, { timeout: 15000 }).toBe(true);
  return measured!;
}
export async function pcmBandWindow(page: Page, start: number, end: number, frequencies: readonly number[], minimumAmplitude: number,
  duration = 0.2, step = 0.05): Promise<PcmFeatures> {
  await waitForAudioTime(page, start + duration);
  let measured: PcmFeatures | undefined;
  await expect.poll(async () => {
    measured = await measuredPcm(page, { start, end, frequencies: [...frequencies],
      scan: { duration, step, minimumAmplitude } });
    return Math.max(...measured.amplitudes);
  }, { timeout: 15000 }).toBeGreaterThan(minimumAmplitude);
  return measured!;
}
export async function pcmShotWindow(page: Page, start: number, end: number, frequencies: readonly number[], minimumAmplitude: number,
  onFailure?: PcmShotFailureObserver): Promise<PcmShotMatch> {
  const parameters = { start, end, frequencies, minimumAmplitude };
  let snapshot: PcmSnapshot | undefined;
  let stage: PcmShotFailure['stage'] = 'coverage';
  return observePcmShotFailure(async () => {
    // Observe coverage cheaply until the original bounded window is complete.
    // Exporting partial PCM while the attack is still playing can itself stall
    // the main thread, delaying the real tick/ACK traffic being measured.
    await waitForAudioTime(page, end);
    stage = 'sampling';
    snapshot = await readPcmSnapshot(page, start, end);
    stage = 'measurement';
    const measured = pcmShotWindowFeatures({ ...parameters, frequencies: [...frequencies] }, restorePcmSnapshot(snapshot));
    if (!measured) throw new Error('The original PCM shot window was not fully captured');
    return measured;
  }, () => ({ parameters, snapshot, stage }), onFailure);
}
