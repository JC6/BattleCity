export type Direction = 'up' | 'right' | 'down' | 'left';
export type GameMode = 'single' | 'coop';
export type GamePhase = 'intro' | 'playing' | 'paused' | 'won' | 'lost';
export type EnemyKind = 'basic' | 'fast' | 'power' | 'armor';
export type PowerUpKind = 'helmet' | 'timer' | 'shovel' | 'star' | 'grenade' | 'tank';

export enum Tile {
  Empty = 0,
  Brick = 1,
  Steel = 2,
  Water = 3,
  Forest = 4,
  Ice = 5,
}

export interface PlayerInput {
  up: boolean;
  right: boolean;
  down: boolean;
  left: boolean;
  firePressed: boolean;
}

export interface LevelDefinition {
  tiles: Tile[];
  enemies: EnemyKind[];
}

export interface PlayerCarry {
  score: number;
  lives: number;
  stars: number;
  nextExtraLife: number;
  /** Distinguishes a living player's last tank from permanent elimination. */
  eliminated?: boolean;
}

export interface PlayerState extends PlayerCarry {
  index: 0 | 1;
  eliminated: boolean;
  kills: [number, number, number, number];
  respawnTicks: number;
}

export interface Tank {
  id: number;
  team: 'player' | 'enemy';
  playerIndex: 0 | 1 | null;
  /** Enemy slot: 0–3 in single player, 0–5 in coop; null for players. */
  enemySlot: number | null;
  kind: EnemyKind;
  x: number;
  y: number;
  direction: Direction;
  hp: number;
  stars: number;
  shieldTicks: number;
  spawnTicks: number;
  stunTicks: number;
  aiTicks: number;
  slideTicks: number;
  moving: boolean;
  carryingPowerUp: boolean;
}

export interface Bullet {
  id: number;
  team: 'player' | 'enemy';
  playerIndex: 0 | 1 | null;
  /** Fixed enemy gun slot survives its firing tank's destruction; null for players. */
  enemySlot: number | null;
  x: number;
  y: number;
  direction: Direction;
  speed: number;
  steelPower: boolean;
  /** A hit occupies its original gun slot during the short impact animation. */
  impactTicks?: number;
}

export interface PowerUp {
  kind: PowerUpKind;
  x: number;
  y: number;
}

export interface Effect {
  kind: 'explosion' | 'points';
  /** Logical-pixel center for both explosions and score labels. */
  x: number;
  y: number;
  remainingTicks: number;
  value?: number;
}

export interface GameEvent {
  type: 'fire' | 'hit' | 'explosion' | 'powerup' | 'extra-life' | 'stage-start' | 'game-over' | 'stage-clear';
}

export interface GameState {
  tick: number;
  stage: number;
  mode: GameMode;
  phase: GamePhase;
  /** A pending loss is final; a pending win can still be overwritten by a loss. */
  pendingOutcome: 'won' | 'lost' | null;
  tiles: Tile[];
  brickMasks: number[];
  players: PlayerState[];
  tanks: Tank[];
  bullets: Bullet[];
  powerUp: PowerUp | null;
  effects: Effect[];
  spawned: number;
  killed: number;
  enemyQueue: EnemyKind[];
  spawnTimer: number;
  freezeTicks: number;
  fortifyTicks: number;
  baseAlive: boolean;
  rng: number;
  introTicks: number;
  outroTicks: number;
}

export interface GameOptions {
  mode: GameMode;
  stage: number;
  seed?: number;
  players?: PlayerCarry[];
}

export const EMPTY_INPUT: Readonly<PlayerInput> = Object.freeze({
  up: false, right: false, down: false, left: false, firePressed: false,
});
