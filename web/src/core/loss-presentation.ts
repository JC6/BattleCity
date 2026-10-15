import { moveEnemy } from './ai';
import { advanceBullets, enemyFire, resolveBulletHits, tankSlot, updateEffects } from './combat';
import type { CoreContext } from './context';
import { updatePowerUpTimers } from './powerups';
import { updateEnemySpawning, updateTankTimers } from './spawning';
import type { GameState } from './types';

/** A disposable battlefield animation; its results never return to the engine. */
export class LossPresentationWorld {
  readonly state: GameState;
  private readonly context: CoreContext;

  constructor(finalState: GameState) {
    if (finalState.phase !== 'lost') throw new Error('Loss presentation requires a finished loss.');
    this.state = structuredClone(finalState);
    this.state.pendingOutcome = 'lost';
    let id = Math.max(0, ...this.state.tanks.map(tank => tank.id), ...this.state.bullets.map(bullet => bullet.id));
    this.context = { state: this.state, events: [], nextId: () => ++id };
  }

  /** Advance one existing game tick, without player input or outcome transitions. */
  step(): void {
    const state = this.state;
    this.context.events = [];
    state.tick++;
    updateEffects(this.context);
    updatePowerUpTimers(this.context);
    updateTankTimers(this.context);
    for (const tank of [...state.tanks].sort((a, b) => tankSlot(b) - tankSlot(a))) {
      tank.moving = false;
      if (tank.team !== 'enemy' || tank.spawnTicks > 0) continue;
      moveEnemy(state, tank);
    }
    advanceBullets(this.context);
    for (const tank of state.tanks.filter(candidate => candidate.team === 'enemy')
      .sort((a, b) => b.enemySlot! - a.enemySlot!)) enemyFire(this.context, tank);
    updateEnemySpawning(this.context);
    // Combat can change this clone's actors, terrain and counters. The UI must
    // read HUD and final scores from the engine's unchanged terminal state.
    resolveBulletHits(this.context);
    this.context.events = [];
  }
}
