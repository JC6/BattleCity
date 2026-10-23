export interface AudioCommand { id: number; start: boolean }
export interface PersistentAudio { music: readonly number[]; offset: number; engine: number | null }
export type PauseReason = 'manual' | 'focus';
export type AudioReply = { type: 'control-applied'; generation: number; sequence: number };
export type AudioMessage =
  | ({ type: 'reset'; generation: number; paused: boolean; reason: PauseReason; confirm?: boolean } & PersistentAudio)
  | { type: 'pause'; generation: number; sequence: number; paused: boolean; reason: PauseReason; commands: AudioCommand[]; confirm?: boolean }
  | { type: 'commands'; generation: number; sequence: number; commands: AudioCommand[] };
