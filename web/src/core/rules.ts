import { GRID_SIZE, normalizeStage } from './constants';
import type { EnemyKind, GameMode, PowerUpKind } from './types';

// Gameplay timing and movement cadence use fixed simulation ticks.
export const INTRO_TICKS = 120;
export const OUTRO_TICKS = 128;
export const SPAWN_TICKS = 28;
export const RESPAWN_TICKS = 48;
export const SPAWN_SHIELD_TICKS = 3 * 64;
export const HELMET_TICKS = 10 * 64;
export const FREEZE_TICKS = 10 * 64;
export const FORTIFY_TICKS = 20 * 64;
export const FRIENDLY_STUN_TICKS = 200;
export const ICE_SLIDE_STEPS = 28;
export const EXTRA_LIFE_SCORE = 20_000;
export const ENEMY_KINDS: readonly EnemyKind[] = ['basic', 'fast', 'power', 'armor'];
export const ENEMY_SCORE: Readonly<Record<EnemyKind, number>> = {
  basic: 100, fast: 200, power: 300, armor: 400,
};
export const POWER_UP_TABLE: readonly PowerUpKind[] = [
  'helmet', 'timer', 'shovel', 'star', 'grenade', 'tank', 'grenade', 'star',
];
export const FORTRESS_CELLS: readonly number[] = [
  23 * GRID_SIZE + 11, 23 * GRID_SIZE + 12,
  23 * GRID_SIZE + 13, 23 * GRID_SIZE + 14,
  24 * GRID_SIZE + 11, 24 * GRID_SIZE + 14,
  25 * GRID_SIZE + 11, 25 * GRID_SIZE + 14,
];

export function spawnInterval(stage: number, mode: GameMode): number {
  // Stages 36–70 keep stage 35's difficulty; completing 70 restarts at 1.
  return 190 - Math.min(normalizeStage(stage), 35) * 4 - (mode === 'coop' ? 20 : 0);
}

export function maximumEnemies(mode: GameMode): number {
  return mode === 'coop' ? 6 : 4;
}

export function playerMovementTick(tick: number): boolean {
  return (tick & 3) !== 2;
}

export function enemyMovementTick(tick: number, enemySlot: number): boolean {
  // Alternate enemy movement frames according to each spawn slot's parity.
  return ((tick ^ enemySlot) & 1) !== 0;
}

export function timerDuration(maximumTicks: number, tick: number): number {
  // Timers expire on the shared frame counter's multiples of 64,
  // rather than starting a fresh 64-frame interval on each pickup.
  return maximumTicks - (tick & 63);
}
