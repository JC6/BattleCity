import { Buffer } from 'node:buffer';
import { setTimeout as setDiagnosticTimeout, clearTimeout as clearDiagnosticTimeout } from 'node:timers';
import type { AudioMessage } from '../../src/platform/audio-protocol';

export interface PcmPacket { frame: number; times: number[]; frames: number[]; lengths: number[]; samples: Float32Array }
export interface AudioEvent { kind: 'keydown' | 'blur'; code: string; at: number }
export interface AudioMark { kind: string; at: number; tick?: number }
type AudioReset = Extract<AudioMessage, { type: 'reset' }>;
export interface AudioCapture {
  ready: boolean; gameReady: boolean; errors: string[]; rate: number; context?: AudioContext; gain?: GainNode; packets: PcmPacket[];
  events: AudioEvent[]; marks: AudioMark[]; recording?: boolean; recordFromFrame?: number; firstReset?: AudioReset;
  activateTap?: () => void;
  retiredGraphs?: Array<{ context: AudioContext; gain?: GainNode; rate: number; packets: PcmPacket[];
    events: AudioEvent[]; marks: AudioMark[]; firstReset?: AudioReset }>;
}
declare global { interface Window { __AUDIO_PCM__?: AudioCapture } }
export interface PcmFeatures { rms: number; peak: number; onset: number | null; amplitudes: number[]; samples: number; rate: number; idleReady?: boolean }
export interface PcmBandScan { duration: number; step: number; minimumAmplitude: number }
export interface PcmComparisonWindow { duration: number; step: number }
export interface PcmShotPhase { start: number; frequency: number; amplitude: number; concentration: number }
export interface PcmShotMatch { band: PcmFeatures; bandStart: number; phases: [PcmShotPhase, PcmShotPhase, PcmShotPhase] }
export interface PcmPauseMatch {
  onset: number; notes: { frequency: number; start: number; end: number; minimumAmplitude: number }[];
  phrase: PcmFeatures; silence: PcmFeatures;
}
export interface PcmSnapshot {
  ready: boolean; gameReady: boolean; errors: string[]; rate: number;
  packets: (Omit<PcmPacket, 'samples'> & { samplesBase64: string })[];
}
export interface PcmShotParameters { start: number; end: number; frequencies: readonly number[]; minimumAmplitude: number }
export interface PcmShotFailure {
  parameters: PcmShotParameters; snapshot?: PcmSnapshot; match?: PcmShotMatch; error: unknown;
  stage: 'coverage' | 'sampling' | 'measurement';
}

export type PcmShotFailureObserver = (failure: PcmShotFailure) => void | Promise<void>;

/** Failure attachments are diagnostic only: retain the exact original failure,
 * even if obtaining or saving its evidence also fails. */
export async function observePcmShotFailure<T, Evidence extends object = Omit<PcmShotFailure, 'error'>>(
  work: () => Promise<T>, details: () => Evidence,
  onFailure?: (failure: Evidence & { error: unknown }) => void | Promise<void>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (onFailure) {
      let timer: ReturnType<typeof setDiagnosticTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => onFailure({ ...details(), error })),
          new Promise<never>((_, reject) => {
            timer = setDiagnosticTimeout(() => reject(new Error('PCM failure observation timed out')), 3000);
          }),
        ]);
      } catch { /* Keep the assertion or sampling failure. */ }
      finally { if (timer !== undefined) clearDiagnosticTimeout(timer); }
    }
    throw error;
  }
}

/** This self-contained function is the only measurement code sent to the page.
 * Copy complete intersecting packets, retaining their offsets and labels. The
 * final real packet also proves how much native audio has actually arrived. */
export function snapshotPcmWindow({ start, end }: { start: number; end: number }, capture?: AudioCapture): PcmSnapshot {
  const pcm = capture ?? window.__AUDIO_PCM__!;
  if (pcm.errors.length) throw new Error(pcm.errors.join('\n'));
  if (pcm.packets.length > 768) throw new Error('PCM capture exceeded its bounded packet capacity');
  const first = Math.ceil(start * pcm.rate), last = Math.floor(end * pcm.rate);
  const packets = pcm.packets.filter((packet, index) => index === pcm.packets.length - 1 ||
    packet.frames.some((frame, index) => frame < last && frame + packet.lengths[index] > first));
  const snapshot: PcmSnapshot = { ready: pcm.ready, gameReady: pcm.gameReady, errors: [...pcm.errors], rate: pcm.rate,
    packets: packets.map(packet => {
      if (!(packet.samples instanceof Float32Array)) throw new Error('Malformed PCM packet');
      const bytes = new Uint8Array(packet.samples.buffer, packet.samples.byteOffset, packet.samples.byteLength);
      // Native byte encoding avoids materializing/spreading thousands of JS
      // characters on the game's thread while audio is playing.
      const native = bytes as Uint8Array & { toBase64?: () => string };
      let samplesBase64: string;
      if (typeof native.toBase64 === 'function') samplesBase64 = native.toBase64();
      else {
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        samplesBase64 = btoa(binary);
      }
      return { frame: packet.frame, times: [...packet.times], frames: [...packet.frames], lengths: [...packet.lengths],
        samplesBase64 };
    }) };
  return snapshot;
}

/** Decode in Node without rounding samples or repairing raw quantum metadata. */
export function restorePcmSnapshot(snapshot: PcmSnapshot): AudioCapture {
  return { ready: snapshot.ready, gameReady: snapshot.gameReady, errors: snapshot.errors, rate: snapshot.rate,
    events: [], marks: [], packets: snapshot.packets.map(({ samplesBase64, ...packet }) => {
      const bytes = Buffer.from(samplesBase64, 'base64');
      if (bytes.length % Float32Array.BYTES_PER_ELEMENT) throw new Error('Malformed PCM packet sample bytes');
      return { ...packet, samples: new Float32Array(Uint8Array.from(bytes).buffer) };
    }) };
}

/** Analyze the captured raw quanta in Node. Unit fixtures supply the same
 * capture directly; no spectral calculation runs on the game's main thread. */
export function pcmWindowFeatures({ start, end, frequencies, scan, idle, comparison }: { start: number; end: number; frequencies: number[]; scan?: PcmBandScan; idle?: boolean; comparison?: PcmComparisonWindow }, capture?: AudioCapture): PcmFeatures {
  const pcm = capture ?? window.__AUDIO_PCM__!;
  if (pcm.errors.length) throw new Error(pcm.errors.join('\n'));
  if (!Number.isInteger(pcm.rate) || pcm.rate <= 0 || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('Invalid PCM measurement interval');
  if (comparison && (!idle || !Number.isFinite(comparison.duration) || comparison.duration <= 0 || comparison.duration > 0.5 ||
      !Number.isFinite(comparison.step) || comparison.step <= 0 || comparison.step > comparison.duration ||
      0.5 / comparison.step > 128 || !frequencies.length)) throw new Error('Invalid bounded PCM baseline comparison');
  if (idle) {
    const duration = 0.25;
    if (scan || end - start < duration * 2 || (end - start) / duration > 16) throw new Error('Invalid bounded PCM idle interval');
    const packet = pcm.packets.at(-1);
    const availableEnd = packet ? (packet.frames.at(-1)! + packet.lengths.at(-1)!) / pcm.rate : 0;
    // Independent reference timers $10/$18 and their positive sweep place the
    // enemy engine near 58..66Hz. It owns pulse 2 only after the stage phrase.
    const engineBand = Array.from({ length: 9 }, (_, index) => 58 + index);
    let previousStart: number | undefined, measured: PcmFeatures | undefined;
    for (let index = 0; ; index++) {
      const candidate = start + index * duration;
      if (candidate + duration > Math.min(end, availableEnd)) break;
      measured = pcmWindowFeatures({ start: candidate, end: candidate + duration, frequencies: [...engineBand, 1045.428154] }, pcm);
      const engine = Math.max(...measured.amplitudes.slice(0, engineBand.length));
      const music = measured.amplitudes[engineBand.length];
      if (measured.rms > 0.001 && engine > 0.0005 && music < 0.001 && music < engine) {
        if (previousStart !== undefined) {
          const first = pcmWindowFeatures({ start: previousStart, end: previousStart + duration, frequencies }, pcm);
          const second = pcmWindowFeatures({ start: candidate, end: candidate + duration, frequencies }, pcm);
          // Take each frequency's larger native amplitude; choosing the quieter
          // window would weaken the later movement/shot comparisons.
          const amplitudes = first.amplitudes.map((value, index) => Math.max(value, second.amplitudes[index]));
          if (comparison) {
            const finalStart = candidate + duration - comparison.duration;
            const count = Math.ceil((finalStart - previousStart) / comparison.step);
            for (let index = 0; index <= count; index++) {
              // Cover the entire qualified pair, including a final window flush
              // with its right boundary. Every short baseline window is evidence.
              const at = Math.min(previousStart + index * comparison.step, finalStart);
              const window = pcmWindowFeatures({ start: at, end: at + comparison.duration, frequencies }, pcm);
              for (let frequency = 0; frequency < amplitudes.length; frequency++) amplitudes[frequency] = Math.max(amplitudes[frequency], window.amplitudes[frequency]);
            }
          }
          return { rms: Math.min(first.rms, second.rms), peak: Math.max(first.peak, second.peak),
            onset: first.onset ?? second.onset, amplitudes,
            samples: first.samples + second.samples, rate: pcm.rate, idleReady: true };
        }
        previousStart = candidate;
      } else previousStart = undefined;
    }
    if (!measured) throw new Error('Incomplete first PCM idle interval');
    if (availableEnd >= end) throw new Error(`Stable native PCM idle was absent throughout the bounded interval ${start}–${end}`);
    return { ...measured, amplitudes: [], idleReady: false };
  }
  if (scan) {
    if (!Number.isFinite(scan.duration) || scan.duration <= 0 || scan.duration > end - start ||
        !Number.isFinite(scan.step) || scan.step <= 0 || scan.step > scan.duration ||
        !Number.isFinite(scan.minimumAmplitude) || scan.minimumAmplitude <= 0 || !frequencies.length ||
        (end - start) / scan.step > 128) throw new Error('Invalid bounded PCM band scan');
    const packet = pcm.packets.at(-1);
    const availableEnd = packet ? (packet.frames.at(-1)! + packet.lengths.at(-1)!) / pcm.rate : 0;
    let measured: PcmFeatures | undefined;
    for (let index = 0; ; index++) {
      const candidate = start + index * scan.step;
      if (candidate + scan.duration > Math.min(end, availableEnd)) break;
      // Every candidate is a complete, independently validated raw interval.
      // An invalid earlier window must fail instead of being skipped to a tone.
      measured = pcmWindowFeatures({ start: candidate, end: candidate + scan.duration, frequencies }, pcm);
      if (Math.max(...measured.amplitudes) > scan.minimumAmplitude) return measured;
    }
    if (!measured) throw new Error('Incomplete first PCM band-scan interval');
    if (availableEnd >= end) throw new Error(`PCM band was absent throughout the bounded interval ${start}–${end}`);
    return measured;
  }
  const { first, samples } = pcmSamples(start, end, pcm);
  let energy = 0, peak = 0, onset: number | null = null;
  for (let index = 0; index < samples.length; index++) {
    const value = samples[index];
    if (!Number.isFinite(value)) throw new Error('Non-finite PCM sample');
    energy += value * value; peak = Math.max(peak, Math.abs(value));
    if (onset === null && Math.abs(value) > 0.002) onset = (first + index) / pcm.rate;
  }
  // Apply Hann once, then rotate each frequency's phase without per-sample
  // trigonometry. Sample values, timing and the spectrum's scaling are unchanged.
  const weighted = new Float64Array(frequencies.length ? samples.length : 0);
  for (let index = 0; index < weighted.length; index++) {
    weighted[index] = samples[index] * (0.5 - 0.5 * Math.cos(2 * Math.PI * index / (samples.length - 1)));
  }
  const amplitudes = frequencies.map(frequency => {
    const angle = 2 * Math.PI * frequency / pcm.rate, rotateReal = Math.cos(angle), rotateImaginary = Math.sin(angle);
    let real = 0, imaginary = 0, phaseReal = 1, phaseImaginary = 0;
    for (let index = 0; index < samples.length; index++) {
      real += weighted[index] * phaseReal; imaginary += weighted[index] * phaseImaginary;
      const nextReal = phaseReal * rotateReal - phaseImaginary * rotateImaginary;
      phaseImaginary = phaseImaginary * rotateReal + phaseReal * rotateImaginary; phaseReal = nextReal;
    }
    return 4 * Math.hypot(real, imaginary) / samples.length;
  });
  return { rms: Math.sqrt(energy / samples.length), peak, onset, amplitudes, samples: samples.length, rate: pcm.rate };
}

/** Match the reference timer95 positive shift2 attack, independently of cue
 * messages or production sound tables. Noise and unrelated notes can pass the
 * broad band alone; all three descending tones must exceed that same gate. */
export function pcmShotWindowFeatures({ start, end, frequencies, minimumAmplitude }: {
  start: number; end: number; frequencies: number[]; minimumAmplitude: number;
}, pcm: AudioCapture): PcmShotMatch | null {
  if (pcm.errors.length) throw new Error(pcm.errors.join('\n'));
  if (pcm.packets.length > 768) throw new Error('PCM capture exceeded its bounded packet capacity');
  if (!Number.isInteger(pcm.rate) || pcm.rate <= 0 || !Number.isFinite(start) || !Number.isFinite(end) ||
      start < 0 || end - start < 0.025 || end - start > 1 + 1e-9 ||
      !Number.isFinite(minimumAmplitude) || minimumAmplitude < 0.002 ||
      frequencies.length !== 27 || frequencies.some((frequency, index) => frequency !== 600 + 25 * index)) {
    throw new Error('Invalid bounded PCM shot scan');
  }
  const packet = pcm.packets.at(-1);
  const availableEnd = packet ? (packet.frames.at(-1)! + packet.lengths.at(-1)!) / pcm.rate : 0;
  if (!Number.isFinite(availableEnd) || availableEnd < 0) throw new Error('Invalid PCM quantum labels');
  const limit = Math.min(end, availableEnd), duration = 0.008, step = 0.002;
  // Early success may precede the deadline, but cannot conceal a gap or NaN
  // elsewhere in the event interval that this native snapshot already covers.
  if (Math.floor(limit * pcm.rate) - Math.ceil(start * pcm.rate) >= 2) {
    pcmWindowFeatures({ start, end: limit, frequencies: [] }, pcm);
  }
  const grid = Array.from({ length: 49 }, (_, index) => 300 + 25 * index);
  const targets = [940.006828, 755.816301, 607.939198];
  const earlier: [PcmShotPhase[], PcmShotPhase[]] = [[], []];
  const adjacent = (first: PcmShotPhase, second: PcmShotPhase) =>
    second.start - first.start >= 0.004 - 1e-9 && second.start - first.start <= 0.018 + 1e-9;
  // At most 497 overlapping windows cover the one-second capture.
  // Validate each raw interval before classifying it, including quiet windows.
  for (let index = 0; start + index * step + duration <= limit + 1e-9; index++) {
    const at = start + index * step;
    const measured = pcmWindowFeatures({ start: at, end: at + duration, frequencies: grid }, pcm);
    let peak = 0;
    for (let frequency = 1; frequency < grid.length; frequency++) {
      if (measured.amplitudes[frequency] > measured.amplitudes[peak]) peak = frequency;
    }
    let total = 0, concentrated = 0;
    for (let frequency = 0; frequency < grid.length; frequency++) {
      const energy = measured.amplitudes[frequency] ** 2;
      total += energy;
      if (Math.abs(grid[frequency] - grid[peak]) <= 125) concentrated += energy;
    }
    const concentration = total > 0 ? concentrated / total : 0;
    const stage = targets.findIndex(frequency => Math.abs(grid[peak] - frequency) <= 50);
    if (stage < 0 || concentration < 0.8 || measured.amplitudes[peak] <= minimumAmplitude) continue;
    const phase = { start: at, frequency: grid[peak], amplitude: measured.amplitudes[peak], concentration };
    if (stage < 2) { earlier[stage].push(phase); continue; }
    for (const second of earlier[1]) {
      if (!adjacent(second, phase)) continue;
      for (const first of earlier[0]) {
        if (!adjacent(first, second)) continue;
        // Keep the original 25ms/8ms broad-band scan grid, but bind its window
        // to the first two tones' centers instead of an unrelated louder cue.
        const firstIndex = Math.max(0, Math.ceil((second.start + duration / 2 - 0.025 - start) / 0.008 - 1e-9));
        const lastIndex = Math.floor((first.start + duration / 2 - start) / 0.008 + 1e-9);
        for (let bandIndex = firstIndex; bandIndex <= lastIndex; bandIndex++) {
          const bandStart = start + bandIndex * 0.008;
          if (bandStart + 0.025 > limit + 1e-9) break;
          const band = pcmWindowFeatures({ start: bandStart, end: bandStart + 0.025, frequencies }, pcm);
          if (Math.max(...band.amplitudes) > minimumAmplitude) return { band, bandStart, phases: [first, second, phase] };
        }
      }
    }
  }
  if (availableEnd >= end) throw new Error(`Player-shot PCM signature was absent throughout the bounded interval ${start}–${end}`);
  return null;
}

/** Shared raw-window validation; neither analyzer fills gaps or repairs timestamps. */
function pcmSamples(start: number, end: number, pcm: AudioCapture): { first: number; samples: Float32Array } {
  const first = Math.ceil(start * pcm.rate), last = Math.floor(end * pcm.rate);
  if (last - first < 2) throw new Error('PCM measurement interval is too short');
  const samples = new Float32Array(last - first);
  let filled = 0, expectedFrame: number | undefined;
  // A startup gap before this window cannot invalidate later measured audio.
  // Inside the window, gaps, duplicates and reordered quanta remain failures;
  // no deduplication, zero filling or timestamp repair is performed.
  for (const packet of pcm.packets) {
    if (!packet.frames.some((frame, index) => frame < last && frame + packet.lengths[index] > first)) continue;
    if (packet.frames.length !== packet.lengths.length || packet.frames.length !== packet.times.length ||
        packet.frame !== packet.frames[0] || !(packet.samples instanceof Float32Array)) throw new Error('Malformed PCM packet');
    let offset = 0;
    for (let index = 0; index < packet.frames.length; index++) {
      const frame = packet.frames[index], length = packet.lengths[index];
      if (!Number.isInteger(frame) || frame < 0 || !Number.isInteger(length) || length <= 0) throw new Error('Invalid PCM quantum labels');
      if (!Number.isFinite(packet.times[index]) || Math.abs(packet.times[index] * pcm.rate - frame) > 1) throw new Error('PCM frame/time labels disagree');
      const lo = Math.max(frame, first), hi = Math.min(frame + length, last);
      if (hi > lo) {
        if (expectedFrame !== undefined && frame !== expectedFrame) throw new Error(`Discontinuous PCM quantum in measurement: ${frame} != ${expectedFrame}`);
        expectedFrame = frame + length;
        const source = packet.samples.subarray(offset + lo - frame, offset + hi - frame);
        if (source.length !== hi - lo) throw new Error('PCM packet sample count disagrees with raw quantum lengths');
        samples.set(source, lo - first); filled += hi - lo;
      }
      offset += length;
    }
    if (offset !== packet.samples.length) throw new Error('PCM packet sample count disagrees with raw quantum lengths');
  }
  if (filled !== samples.length) throw new Error(`Incomplete PCM interval ${filled}/${samples.length}`);
  return { first, samples };
}

/** EE2C pause: C5 D5 E5 C6 D6 E6 (four ticks each), G5 (twelve).
 * Literal reference pitches/durations deliberately do not import game tables.
 * The independent pause voice begins after a silent decode frame. This finds
 * candidates only; all seven timed notes must match before accepting an onset.
 */
export function pcmPauseWindowFeatures(start: number, pcm: AudioCapture): PcmPauseMatch {
  const end = start + 2;
  if (pcm.packets.length > 768) throw new Error('PCM capture exceeded its bounded packet capacity');
  pcmWindowFeatures({ start, end, frequencies: [] }, pcm); // Validate the entire interval, including its tail.
  const { first, samples } = pcmSamples(start, end, pcm);
  const frequencies = [522.714077, 585.658704, 658.004779, 1045.428154, 1165.216797, 1316.009559, 782.243444];
  const tick = 1 / 60.0988, minimumSilence = Math.ceil(pcm.rate * 0.008);
  let zeroes = 0, armed = false;
  for (let index = 0; index < samples.length; index++) {
    if (samples[index] === 0) { if (++zeroes >= minimumSilence) armed = true; continue; }
    zeroes = 0;
    if (!armed || Math.abs(samples[index]) <= 0.002) continue;
    armed = false;
    const onset = (first + index) / pcm.rate;
    if (onset + 0.82 > end) break;
    const notes: PcmPauseMatch['notes'] = [];
    for (let note = 0; note < frequencies.length; note++) {
      const noteStart = onset + note * 4 * tick, duration = (note === 6 ? 12 : 4) * tick;
      let minimumAmplitude = Infinity;
      // Overlapping 20ms windows cover every note except its 8ms transition
      // margins. In particular, the long final note cannot be replaced by a blip.
      for (let offset = 0.008; offset + 0.020 <= duration - 0.008; offset += 0.010) {
        const value = pcmWindowFeatures({ start: noteStart + offset, end: noteStart + offset + 0.020, frequencies }, pcm);
        const amplitude = value.amplitudes[note];
        if (amplitude <= 0.002 || value.amplitudes.some((other, at) => at !== note && other >= amplitude)) {
          minimumAmplitude = 0; break;
        }
        minimumAmplitude = Math.min(minimumAmplitude, amplitude);
      }
      if (!minimumAmplitude) break;
      notes.push({ frequency: frequencies[note], start: noteStart, end: noteStart + duration, minimumAmplitude });
    }
    if (notes.length === frequencies.length) return { onset, notes,
      phrase: pcmWindowFeatures({ start: onset + 0.08, end: onset + 0.22, frequencies: [] }, pcm),
      silence: pcmWindowFeatures({ start: onset + 0.68, end: onset + 0.82, frequencies: [] }, pcm) };
  }
  throw new Error(`Complete pause PCM signature was absent throughout ${start}–${end}`);
}
