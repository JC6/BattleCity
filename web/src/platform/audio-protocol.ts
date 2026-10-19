/** Native-context seconds; never carry these timestamps into another graph. */
export interface AudioCommand { id: number; start: boolean; createdAt: number }
export interface PersistentAudio { music: readonly number[]; offset: number; engine: number | null }
export type PauseReason = 'manual' | 'focus';
export type AudioReply = { type: 'control-applied'; generation: number; sequence: number };
// createdAt is never refreshed during delivery.
export type AudioMessage =
  | ({ type: 'reset'; generation: number; paused: boolean; reason: PauseReason; confirm?: boolean } & PersistentAudio)
  | { type: 'pause'; generation: number; sequence: number; paused: boolean; reason: PauseReason; commands: AudioCommand[]; confirm?: boolean }
  | { type: 'commands'; generation: number; sequence: number; commands: AudioCommand[] };
