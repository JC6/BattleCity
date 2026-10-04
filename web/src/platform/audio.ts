import type { GameEvent } from '../core/types';

export class GameAudio {
  private context?: AudioContext;
  private gain?: GainNode;
  private volume: number;
  constructor(volume: number) { this.volume = volume; }
  unlock(): void {
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.gain = this.context.createGain();
        this.gain.gain.value = this.volume * 0.13;
        this.gain.connect(this.context.destination);
      }
      void this.context.resume().catch(() => {});
    } catch { /* The game remains playable when audio is unavailable. */ }
  }
  setVolume(volume: number): void {
    this.volume = volume;
    if (this.gain && this.context) this.gain.gain.setValueAtTime(volume * 0.13, this.context.currentTime);
  }
  play(events: GameEvent[]): void {
    if (!this.context || !this.gain || this.context.state !== 'running' || !this.volume) return;
    for (const event of events) {
      switch (event.type) {
        case 'fire': this.tone(500, 110, 0.07); break;
        case 'hit': this.tone(160, 40, 0.055); break;
        case 'explosion': this.tone(85, 20, 0.22, 'triangle'); break;
        case 'powerup': this.melody([660, 880, 1100], 0.08); break;
        case 'extra-life': this.melody([440, 660, 880, 1320], 0.09); break;
        case 'stage-start': this.melody([330, 440, 550, 660, 880], 0.09); break;
        case 'stage-clear': this.melody([440, 550, 660, 880], 0.12); break;
        case 'game-over': this.melody([440, 330, 220, 110], 0.16); break;
      }
    }
  }
  private melody(notes: number[], length: number): void {
    notes.forEach((note, index) => this.tone(note, note, length * 0.8, 'square', index * length));
  }
  private tone(start: number, end: number, duration: number, type: OscillatorType = 'square', delay = 0): void {
    const context = this.context!;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const at = context.currentTime + delay;
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(start, at);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, end), at + duration);
    envelope.gain.setValueAtTime(0.65, at);
    envelope.gain.exponentialRampToValueAtTime(0.001, at + duration);
    oscillator.connect(envelope);
    envelope.connect(this.gain!);
    oscillator.start(at);
    oscillator.stop(at + duration);
    oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
  }
}
