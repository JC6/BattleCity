import type { GameState, Tank } from '../core/types';

interface Track { x: number; y: number; distance: number; seenTick: number }

/** Presentation history advances once per simulation step, never per render. */
export class TankAnimation {
  private tracks = new Map<number, Track>();
  private lastTick = -1;

  reset(): void { this.tracks.clear(); this.lastTick = -1; }

  observe(state: GameState): void {
    if (state.phase === 'paused' || state.tick === this.lastTick) return;
    if (state.tick < this.lastTick) this.reset();
    this.lastTick = state.tick;
    for (const tank of state.tanks) {
      const previous = this.tracks.get(tank.id);
      // moveTank advances one native pixel per accepted simulation step.
      // Perpendicular grid alignment can change both coordinates by more than
      // that; it must not add tread travel. Cadence/blocked frames add nothing.
      const travel = previous && tank.moving && tank.spawnTicks === 0
        ? Math.min(1, Math.abs(tank.x - previous.x) + Math.abs(tank.y - previous.y)) : 0;
      if (previous) {
        previous.x = tank.x; previous.y = tank.y;
        previous.distance += travel; previous.seenTick = state.tick;
      } else {
        this.tracks.set(tank.id, { x: tank.x, y: tank.y, distance: 0, seenTick: state.tick });
      }
    }
    for (const id of this.tracks.keys()) {
      if (this.tracks.get(id)!.seenTick !== state.tick) this.tracks.delete(id);
    }
  }

  frame(tank: Tank): 0 | 1 { return (Math.floor((this.tracks.get(tank.id)?.distance ?? 0) / 2) & 1) as 0 | 1; }
}
