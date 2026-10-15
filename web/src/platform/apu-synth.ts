import { AUDIO_CPU_HZ } from './audio-cues';

const LENGTHS = [10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14,
  12, 16, 24, 18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30];
const NOISE_PERIODS = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
const DUTIES = [0b00000001, 0b00000011, 0b00001111, 0b11111100];
const FRAME_BOUNDARIES = [7457, 14913, 22371, 29829, 37281];
const ENVELOPE_CHANNELS = [0, 1, 3];
function applyLfsrMatrix(matrix: Uint16Array, state: number): number {
  let result = 0;
  for (let bit = 0; bit < 15; bit++) if (state & (1 << bit)) result ^= matrix[bit];
  return result;
}
// Fixed, bounded powers of the native 15-bit LFSR transition. They let a quiet
// quantum retain noise phase without stepping a muted generator 10x per sample.
const NOISE_JUMPS = [1, 6].map(tap => {
  const powers: Uint16Array[] = [Uint16Array.from({ length: 15 }, (_, bit) => {
    const state = 1 << bit;
    return (state >> 1) | (((state ^ (state >> tap)) & 1) << 14);
  })];
  for (let power = 1; power < 31; power++) {
    const previous = powers[power - 1]; powers.push(Uint16Array.from(previous, state => applyLfsrMatrix(previous, state)));
  }
  return powers;
});
interface Channel {
  registers: Uint8Array; timer: number; clock: number; phase: number; length: number;
  envelope: number; divider: number; envelopeStart: boolean; sweepDivider: number; sweepReload: boolean;
}

/** Four-channel digital APU model. CPU-clocked timers, 5-step envelope/length
 * clocks, pulse sweep, triangle linear counter, and the 15-bit noise LFSR are
 * independent of the output sample rate. Analog filtering is an approximation. */
export class ApuSynth {
  private readonly channels: Channel[] = Array.from({ length: 4 }, () => ({ registers: new Uint8Array(4),
    timer: 0, clock: 0, phase: 0, length: 0, envelope: 0, divider: 0, envelopeStart: false,
    sweepDivider: 0, sweepReload: false }));
  private linear = 0;
  private linearReload = false;
  private noise = 1;
  private deferredNoiseSteps = 0;
  private sequencer = 0;
  private sequencerStep = 0;
  private previousInput = 0;
  private hp90 = 0;
  private hp440 = 0;
  private previous90 = 0;
  private low = 0;
  private readonly cyclesPerSample: number;
  private readonly high90: number;
  private readonly high440: number;
  private readonly low14k: number;
  constructor(sampleRate: number) {
    this.cyclesPerSample = AUDIO_CPU_HZ / sampleRate;
    this.high90 = Math.exp(-2 * Math.PI * 90 / sampleRate);
    this.high440 = Math.exp(-2 * Math.PI * 440 / sampleRate);
    this.low14k = 1 - Math.exp(-2 * Math.PI * 14000 / sampleRate);
  }

  reset(): void {
    for (const channel of this.channels) {
      channel.registers.fill(0); channel.timer = channel.clock = channel.phase = channel.length = 0;
      channel.envelope = channel.divider = channel.sweepDivider = 0;
      channel.envelopeStart = channel.sweepReload = false;
    }
    this.linear = 0; this.linearReload = false; this.noise = 1; this.deferredNoiseSteps = 0; this.sequencer = 0; this.sequencerStep = 0;
    this.clearFilters();
  }

  clearFilters(): void { this.previousInput = this.hp90 = this.hp440 = this.previous90 = this.low = 0; }

  /** Only after the driver has muted all channels and a finite filter tail has
   * drained. Keep hardware frame clocks and oscillator/LFSR phases equivalent
   * to sample-by-sample silence; no PCM or filter work is needed. */
  advanceSilence(samples: number): void {
    this.flushNoiseSteps();
    while (samples > 0) {
      const untilBoundary = Math.max(1, Math.ceil((FRAME_BOUNDARIES[this.sequencerStep] - this.sequencer) / this.cyclesPerSample));
      const count = Math.min(samples, untilBoundary);
      const beforeBoundary = count === untilBoundary ? count - 1 : count;
      if (beforeBoundary) {
        const cycles = beforeBoundary * this.cyclesPerSample;
        this.sequencer += cycles; this.advanceSilentTimers(cycles);
      }
      if (count === untilBoundary) {
        this.sequencer += this.cyclesPerSample; this.clockFrame(); this.advanceSilentTimers(this.cyclesPerSample);
      }
      samples -= count;
    }
  }
  private advanceSilentTimers(cycles: number): void {
    for (let index = 0; index < 2; index++) {
      const channel = this.channels[index], period = 2 * (channel.timer + 1);
      channel.clock += cycles;
      const steps = Math.floor(channel.clock / period);
      channel.clock -= steps * period; channel.phase = (channel.phase + steps) & 7;
    }
    const triangle = this.channels[2];
    if (triangle.length && this.linear && triangle.timer > 1) {
      const period = triangle.timer + 1; triangle.clock += cycles;
      const steps = Math.floor(triangle.clock / period);
      triangle.clock -= steps * period; triangle.phase = (triangle.phase + steps) & 31;
    }
    const noise = this.channels[3], period = NOISE_PERIODS[noise.registers[2] & 15];
    noise.clock += cycles;
    let steps = Math.floor(noise.clock / period); noise.clock -= steps * period;
    const powers = NOISE_JUMPS[noise.registers[2] >> 7];
    for (let power = 0; steps > 0; power++, steps = Math.floor(steps / 2)) if (steps & 1) this.noise = applyLfsrMatrix(powers[power], this.noise);
  }
  private clockFrame(): void {
    if (this.sequencerStep !== 3) this.quarterFrame();
    if (this.sequencerStep === 1 || this.sequencerStep === 4) this.halfFrame();
    if (++this.sequencerStep === 5) { this.sequencer -= 37282; this.sequencerStep = 0; }
  }

  write(channelIndex: number, register: number, value: number): void {
    const channel = this.channels[channelIndex];
    if (channelIndex === 3 && register === 2) this.flushNoiseSteps();
    channel.registers[register] = value;
    if (register === 1 && channelIndex < 2) channel.sweepReload = true;
    if (register === 2 && channelIndex < 3) channel.timer = (channel.timer & 0x700) | value;
    if (register === 3) {
      channel.timer = (channel.timer & 0xff) | ((value & 7) << 8);
      channel.length = LENGTHS[value >> 3];
      channel.envelopeStart = true;
      if (channelIndex < 2) { channel.phase = 0; channel.clock = 0; }
      if (channelIndex === 2) this.linearReload = true;
    }
  }

  sample(): number {
    const cycles = this.cyclesPerSample;
    this.sequencer += cycles;
    // 4017=C0 selects the reference's 5-step frame sequencer.
    if (this.sequencer >= FRAME_BOUNDARIES[this.sequencerStep]) {
      this.clockFrame();
    }
    let pulse = 0;
    for (let index = 0; index < 2; index++) {
      const channel = this.channels[index];
      channel.clock += cycles;
      const period = 2 * (channel.timer + 1);
      const steps = Math.floor(channel.clock / period);
      channel.clock -= steps * period; channel.phase = (channel.phase + steps) & 7;
      const target = this.sweepTarget(index);
      if (channel.length && channel.timer >= 8 && target <= 0x7ff &&
          (DUTIES[channel.registers[0] >> 6] >> channel.phase & 1)) pulse += this.volume(channel);
    }
    const triangle = this.channels[2];
    if (triangle.length && this.linear && triangle.timer > 1) {
      triangle.clock += cycles;
      const period = triangle.timer + 1, steps = Math.floor(triangle.clock / period);
      triangle.clock -= steps * period; triangle.phase = (triangle.phase + steps) & 31;
    }
    // Zero reg0 is the driver's triangle mute; do not retain its DAC DC level.
    const triangleOutput = triangle.length && this.linear && triangle.registers[0] ?
      (triangle.phase < 16 ? 15 - triangle.phase : triangle.phase - 16) : 0;
    const noise = this.channels[3];
    if (noise.length) this.flushNoiseSteps();
    noise.clock += cycles;
    const noisePeriod = NOISE_PERIODS[noise.registers[2] & 15];
    // A muted voice defers LFSR work while retaining every native timer step.
    // Materialize its phase before audible output or noise settings change.
    if (!noise.length) {
      const steps = Math.floor(noise.clock / noisePeriod);
      noise.clock -= steps * noisePeriod; this.deferredNoiseSteps += steps;
      if (this.deferredNoiseSteps >= 0x40000000) this.flushNoiseSteps();
    } else while (noise.clock >= noisePeriod) {
      noise.clock -= noisePeriod;
      const tap = noise.registers[2] & 0x80 ? 6 : 1;
      this.noise = (this.noise >> 1) | (((this.noise ^ (this.noise >> tap)) & 1) << 14);
    }
    const noiseOutput = noise.length && !(this.noise & 1) ? this.volume(noise) : 0;
    const tnd = triangleOutput / 8227 + noiseOutput / 12241;
    const input = (pulse ? 95.88 / (8128 / pulse + 100) : 0) + (tnd ? 159.79 / (1 / tnd + 100) : 0);
    this.hp90 = this.high90 * (this.hp90 + input - this.previousInput); this.previousInput = input;
    this.hp440 = this.high440 * (this.hp440 + this.hp90 - this.previous90); this.previous90 = this.hp90;
    this.low += this.low14k * (this.hp440 - this.low);
    return this.low;
  }

  private flushNoiseSteps(): void {
    let steps = this.deferredNoiseSteps;
    if (!steps) return;
    this.deferredNoiseSteps = 0;
    const powers = NOISE_JUMPS[this.channels[3].registers[2] >> 7];
    for (let power = 0; steps > 0; power++, steps = Math.floor(steps / 2)) {
      if (steps & 1) this.noise = applyLfsrMatrix(powers[power], this.noise);
    }
  }

  private volume(channel: Channel): number { return channel.registers[0] & 0x10 ? channel.registers[0] & 15 : channel.envelope; }
  private quarterFrame(): void {
    for (const index of ENVELOPE_CHANNELS) {
      const channel = this.channels[index];
      if (channel.envelopeStart) {
        channel.envelopeStart = false; channel.envelope = 15; channel.divider = channel.registers[0] & 15;
      } else if (channel.divider) channel.divider--;
      else {
        channel.divider = channel.registers[0] & 15;
        if (channel.envelope) channel.envelope--; else if (channel.registers[0] & 0x20) channel.envelope = 15;
      }
    }
    const triangle = this.channels[2];
    if (this.linearReload) this.linear = triangle.registers[0] & 0x7f;
    else if (this.linear) this.linear--;
    if (!(triangle.registers[0] & 0x80)) this.linearReload = false;
  }
  private sweepTarget(index: number): number {
    const channel = this.channels[index], sweep = channel.registers[1];
    const delta = channel.timer >> (sweep & 7);
    return sweep & 8 ? channel.timer - delta - (index === 0 ? 1 : 0) : channel.timer + delta;
  }
  private halfFrame(): void {
    for (let index = 0; index < 4; index++) {
      const channel = this.channels[index], control = channel.registers[0];
      if (!(control & (index === 2 ? 0x80 : 0x20)) && channel.length) channel.length--;
      if (index >= 2) continue;
      const sweep = channel.registers[1], target = this.sweepTarget(index);
      if (!channel.sweepDivider && sweep & 0x80 && sweep & 7 && channel.timer >= 8 && target <= 0x7ff) channel.timer = target;
      if (!channel.sweepDivider || channel.sweepReload) {
        channel.sweepDivider = (sweep >> 4) & 7; channel.sweepReload = false;
      } else channel.sweepDivider--;
    }
  }
}
