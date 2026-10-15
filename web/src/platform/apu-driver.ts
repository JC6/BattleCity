import { AUDIO_TRACKS, NOTE_PERIODS } from './audio-cues';

export type RegisterWriter = (channel: number, register: number, value: number) => void;
interface Slot { flag: number; channel: number; registers: Uint8Array; pointer: number; duration: number; remaining: number }

/** The reference's two-pass, fixed-slot sequencer (EA7E–ECAC). Slot priority
 * and the one-frame delay between decoding a note and writing it are deliberate. */
export class ApuDriver {
  private readonly slots: Slot[] = Array.from({ length: 28 }, () => ({
    flag: 0, channel: 0, registers: new Uint8Array(4), pointer: 0, duration: 0, remaining: 0,
  }));
  private readonly loops = new Uint8Array(3);
  private readonly claimed = new Uint8Array(4);
  constructor(private readonly write: RegisterWriter) {}

  trigger(id: number): void { if (AUDIO_TRACKS[id]) this.slots[id].flag = 1; }
  stop(id: number): void { const slot = this.slots[id]; if (slot) { slot.flag = 0; slot.channel = 0; } }
  active(id: number): boolean { return !!this.slots[id]?.flag; }
  /** A stopped slot can still own its hardware channel for this final frame. */
  hasActivity(): boolean {
    for (const slot of this.slots) if (slot.flag) return true;
    for (const claimed of this.claimed) if (claimed) return true;
    return false;
  }
  reset(): void {
    for (const slot of this.slots) { slot.flag = 0; slot.channel = 0; slot.pointer = 0; slot.remaining = 0; slot.duration = 0; slot.registers.fill(0); }
    this.loops.fill(0);
    this.claimed.fill(0);
    for (let channel = 0; channel < 4; channel++) this.write(channel, 0, channel === 2 ? 0 : 0x10);
  }

  tick(pauseOnly = false): void {
    const limit = pauseOnly ? 1 : 28;
    this.claimed.fill(0);
    for (let id = 0; id < limit; id++) {
      const slot = this.slots[id];
      if (!slot.flag || !slot.channel) continue;
      const channel = (slot.channel - 1) % 4;
      if (this.claimed[channel]) continue;
      this.claimed[channel] = 1;
      if (slot.channel >= 5) continue;
      slot.channel += 4;
      for (let register = 0; register < 4; register++) this.write(channel, register, slot.registers[register]);
    }
    for (let channel = 0; channel < 4; channel++) if (!this.claimed[channel]) this.write(channel, 0, channel === 2 ? 0 : 0x10);
    for (let id = 0; id < limit; id++) {
      const slot = this.slots[id], data = AUDIO_TRACKS[id];
      if (!slot.flag || !data) continue;
      if (slot.flag === 1) {
        slot.flag = 2; slot.channel = data[0]; slot.registers[0] = data[1];
        slot.registers[1] = data[2]; slot.registers[2] = 0; slot.registers[3] = data[3];
        slot.pointer = 4; slot.duration = 0;
        if (slot.channel === 4) slot.registers[2] = data[slot.pointer++];
      } else if (--slot.remaining !== 0) continue;
      this.decode(id, slot, data);
    }
  }

  private decode(id: number, slot: Slot, data: readonly number[]): void {
    // Bounded decoding protects the realtime thread even if a future track is malformed.
    for (let operations = 0; operations < 128; operations++) {
      const byte = data[slot.pointer++];
      if (byte === undefined) break;
      if (byte < 0x60) {
        const timer = NOTE_PERIODS[byte >> 3] >> (byte & 7);
        slot.registers[2] = timer & 0xff;
        slot.registers[3] = (slot.registers[3] & 0xf8) | (timer >> 8);
        if (slot.channel >= 5) slot.channel -= 4;
        slot.remaining = slot.duration || 256;
        return;
      }
      if (byte === 0x60) { slot.remaining = slot.duration || 256; return; }
      if (byte < 0xe8) { slot.duration = byte - 0x60; continue; }
      if (byte === 0xe8) { this.stop(id); return; }
      if (byte === 0xef) { this.loops.fill(0); continue; }
      if (byte >= 0xf0 && byte <= 0xf2) {
        const counter = byte - 0xf0, repeat = data[slot.pointer++], target = data[slot.pointer++];
        this.loops[counter]++;
        if (this.loops[counter] === repeat) this.loops[counter] = 0;
        else slot.pointer = target;
        continue;
      }
      if (byte === 0xf9) { slot.pointer = data[slot.pointer]; continue; }
      if (byte >= 0xf3 && byte <= 0xf8) { slot.pointer++; continue; }
      const value = data[slot.pointer++];
      if (value === undefined) break;
      if (byte === 0xe9) slot.registers[0] = (slot.registers[0] & 0x3f) | value;
      else if (byte === 0xea) slot.registers[0] = (slot.registers[0] & 0xc0) | value;
      else if (byte === 0xeb) slot.registers[0] = (slot.registers[0] & 0xf0) | value;
      else if (byte === 0xec) slot.registers[1] = value;
      else if (byte === 0xed) slot.registers[3] = value;
      else if (byte === 0xee) slot.registers[0] = value;
      else break;
    }
    this.stop(id);
  }
}
