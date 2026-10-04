import { GRID_SIZE, normalizeStage } from './constants';
import type { CoreContext } from './context';
import { moveEnemy } from './ai';
import { destroyEnemy, enemyFire, fireBullet, updateBullets, updateEffects } from './combat';
import { movePlayer } from './movement';
import { collectPowerUp, updatePowerUpTimers } from './powerups';
import { EXTRA_LIFE_SCORE, INTRO_TICKS, OUTRO_TICKS } from './rules';
import { awardCoopBonus } from './scoring';
import { spawnPlayer, updateSpawning, updateTankTimers } from './spawning';
import { EMPTY_INPUT, Tile, type GameEvent, type GameOptions,
  type GameState, type LevelDefinition, type PlayerInput, type PlayerState } from './types';

export class GameEngine {
  readonly state: GameState;
  private id = 0;
  private readonly context: CoreContext;
  private phaseBeforePause: 'intro' | 'playing' = 'intro';

  constructor(level: LevelDefinition, options: GameOptions) {
    if (level.tiles.length !== GRID_SIZE * GRID_SIZE) throw new Error('A level must contain 26 × 26 tiles');
    if (!level.enemies.length) throw new Error('A level must contain an enemy wave');
    const players: PlayerState[] = Array.from({ length: options.mode === 'coop' ? 2 : 1 }, (_, index) => {
      const carry = options.players?.[index];
      return {
        index: index as 0 | 1, score: carry?.score ?? 0, lives: carry?.lives ?? 2,
        stars: carry?.stars ?? 0, nextExtraLife: carry?.nextExtraLife ?? EXTRA_LIFE_SCORE,
        eliminated: carry?.eliminated ?? false,
        kills: [0, 0, 0, 0], respawnTicks: carry?.eliminated ? 0 : 1,
      };
    });
    // The data layer resolves stage 35's composition for the second round.
    // Rules never substitute a fabricated or independently duplicated wave.
    this.state = {
      tick: 0, stage: normalizeStage(options.stage), mode: options.mode, phase: 'intro',
      pendingOutcome: null,
      tiles: [...level.tiles], brickMasks: level.tiles.map(tile => tile === Tile.Brick ? 15 : 0),
      players, tanks: [], bullets: [], powerUp: null, effects: [],
      spawned: 0, killed: 0, enemyQueue: [...level.enemies],
      spawnTimer: 0, freezeTicks: 0, fortifyTicks: 0, baseAlive: true,
      rng: (options.seed ?? 0x19850909) >>> 0, introTicks: INTRO_TICKS, outroTicks: 0,
    };
    this.context = { state: this.state, events: [], nextId: () => ++this.id };
    for (const player of players) if (!player.eliminated) spawnPlayer(this.context, player.index);
  }

  setPaused(paused: boolean): void {
    if (paused && (this.state.phase === 'intro' || this.state.phase === 'playing')) {
      this.phaseBeforePause = this.state.phase;
      this.state.phase = 'paused';
    } else if (!paused && this.state.phase === 'paused') this.state.phase = this.phaseBeforePause;
  }

  step(inputs: readonly PlayerInput[]): GameEvent[] {
    const state = this.state;
    this.context.events = [];
    if (state.phase === 'paused' || state.phase === 'won' || state.phase === 'lost') return [];
    state.tick++;
    if (state.phase === 'intro') {
      state.introTicks--;
      if (state.introTicks === 0) {
        state.phase = 'playing';
        this.context.events.push({ type: 'stage-start' });
      }
      return this.context.events;
    }

    updateEffects(this.context);
    updatePowerUpTimers(this.context);
    updateTankTimers(this.context);
    if (state.pendingOutcome !== 'lost') {
      updateSpawning(this.context);
      for (const tank of state.tanks) {
        tank.moving = false;
        if (tank.spawnTicks > 0) continue;
        if (tank.team === 'player') {
          const input = inputs[tank.playerIndex!] ?? EMPTY_INPUT;
          movePlayer(state, tank, input);
          if (input.firePressed) fireBullet(this.context, tank);
        } else {
          moveEnemy(state, tank);
          enemyFire(this.context, tank);
        }
      }
    }
    updateBullets(this.context);
    if (state.pendingOutcome !== 'lost') collectPowerUp(this.context,
      (tank, index) => destroyEnemy(this.context, tank, index));
    this.updateOutcome();
    return this.context.events;
  }

  private updateOutcome(): void {
    const state = this.state;
    const someoneAlive = state.players.some(player => player.respawnTicks > 0 ||
      state.tanks.some(tank => tank.team === 'player' && tank.playerIndex === player.index));
    let result: GameState['pendingOutcome'] = null;
    if (!state.baseAlive || !someoneAlive) result = 'lost';
    else if (state.killed === state.enemyQueue.length) result = 'won';
    if (result && state.pendingOutcome === null) {
      state.pendingOutcome = result;
      state.outroTicks = OUTRO_TICKS;
    } else if (result === 'lost') state.pendingOutcome = 'lost';

    if (state.pendingOutcome === 'lost') {
      for (const tank of state.tanks) tank.moving = false;
    }

    if (state.outroTicks > 0) {
      state.outroTicks--;
      if (state.outroTicks === 0 && state.pendingOutcome) {
        state.phase = state.pendingOutcome;
        awardCoopBonus(this.context);
        if (state.phase === 'won') {
          this.context.events.push({ type: 'stage-clear' });
        } else this.context.events.push({ type: 'game-over' });
      }
    }
  }
}
