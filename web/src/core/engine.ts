import { GRID_SIZE, normalizeStage } from './constants';
import { moveEnemy } from './ai';
import { advanceBullets, destroyEnemy, enemyFire, fireBullet, resolveBulletHits, tankSlot, updateEffects } from './combat';
import { movePlayer } from './movement';
import { collectPowerUp, updatePowerUpTimers } from './powerups';
import { EXTRA_LIFE_SCORE, INTRO_MAP_TICKS, INTRO_TICKS, OUTRO_TICKS } from './rules';
import { awardCoopBonus } from './scoring';
import { spawnPlayer, updateSpawning, updateTankTimers } from './spawning';
import { type CoreContext, EMPTY_INPUT, Tile, type GameEvent, type GameOptions,
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
      tick: 0, battleTicks: 0, stage: normalizeStage(options.stage), mode: options.mode, phase: 'intro',
      pendingOutcome: null,
      tiles: [...level.tiles], brickMasks: level.tiles.map(tile => tile === Tile.Brick ? 15 : 0),
      players, tanks: [], bullets: [], powerUp: null, effects: [],
      spawned: 0, killed: 0, enemyQueue: [...level.enemies],
      spawnTimer: 0, freezeTicks: 0, fortifyTicks: 0, baseAlive: true,
      baseExplosionTicks: 0, lossBannerTicks: 0, eliminationPlayer: null, eliminationTicks: 0,
      rng: (options.seed ?? 0x19850909) >>> 0, introTicks: INTRO_TICKS - (options.customMap ? INTRO_MAP_TICKS : 0), outroTicks: 0,
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

    state.battleTicks++;
    updateEffects(this.context);
    updatePowerUpTimers(this.context);
    updateTankTimers(this.context);
    // DBF1 advances fixed tank slots 7→0, even after a respawn changes array order.
    for (const tank of [...state.tanks].sort((a, b) => tankSlot(b) - tankSlot(a))) {
      tank.moving = false;
      if (tank.spawnTicks > 0 || tank.deathTimer > 0) continue;
      if (tank.team === 'player') {
        const input = state.pendingOutcome === 'lost' ? EMPTY_INPUT : inputs[tank.playerIndex!] ?? EMPTY_INPUT;
        movePlayer(state, tank, input);
      } else {
        moveEnemy(state, tank);
      }
    }
    advanceBullets(this.context);
    // Firing follows old-shot movement: a new shot can collide now, but
    // remains at the barrel until the next frame. Players are checked 2P first.
    for (let index = state.players.length - 1; index >= 0; index--) {
      const tank = state.tanks.find(candidate => candidate.team === 'player' && candidate.playerIndex === index);
      if (state.pendingOutcome !== 'lost' && tank && inputs[index]?.firePressed) fireBullet(this.context, tank);
    }
    for (const tank of state.tanks.filter(candidate => candidate.team === 'enemy')
      .sort((a, b) => b.enemySlot! - a.enemySlot!)) enemyFire(this.context, tank);
    updateSpawning(this.context);
    resolveBulletHits(this.context);
    collectPowerUp(this.context,
      (tank, index) => destroyEnemy(this.context, tank, index));
    this.updateOutcome();
    return this.context.events;
  }

  /** Called once by the result presentation, at its original bonus boundary. */
  awardCoopBonus(): GameEvent[] {
    this.context.events = [];
    awardCoopBonus(this.context);
    return this.context.events;
  }

  private updateOutcome(): void {
    const state = this.state;
    const someoneAlive = state.players.some(player => !player.eliminated);
    let result: GameState['pendingOutcome'] = null;
    if (!state.baseAlive || !someoneAlive) result = 'lost';
    else if (state.killed === state.enemyQueue.length) result = 'won';
    if (state.baseExplosionTicks > 0) state.baseExplosionTicks--;
    if (result && state.pendingOutcome === null) {
      state.pendingOutcome = result;
      if (result === 'won') { state.outroTicks = state.eliminationTicks > 0 ? 256 : OUTRO_TICKS; return; }
    }
    if (result === 'lost') state.pendingOutcome = 'lost';
    if (state.pendingOutcome === null) return;
    if (state.outroTicks === 0) {
      if (state.baseExplosionTicks > 0) return;
      state.lossBannerTicks = 256; state.eliminationTicks = 0; state.outroTicks = 256; return;
    }
    if (state.lossBannerTicks > 0) state.lossBannerTicks--;
    if (--state.outroTicks === 0) {
      state.phase = state.pendingOutcome;
      this.context.events.push({ type: state.phase === 'won' ? 'stage-clear' : 'game-over' });
    }
  }
}
