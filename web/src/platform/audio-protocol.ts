export interface AudioFrame { tick: number; start: number[]; stop: number[] }
export type AudioMessage =
  | { type: 'reset'; generation: number; start: number[]; offset: number; tick: number; recovery?: Array<{ at: number; start: number[] }> }
  | { type: 'pause'; generation: number; paused: boolean; reason: 'manual' | 'focus';
      tick: number; frames: AudioFrame[]; start: number[]; stop: number[] }
  | { type: 'frames'; generation: number; sequence: number; at: number; frames: AudioFrame[] };
export type AudioReply =
  | { type: 'ack'; generation: number; sequence: number; accepted: boolean; credits: number; nextAt?: number }
  | { type: 'progress'; generation: number; sequence: number; credits: number; nextAt: number };
