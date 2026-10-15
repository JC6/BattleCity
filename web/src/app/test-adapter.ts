import { EMPTY_INPUT, type GameMode, type GameState, type PlayerInput, type Tile } from '../core/types';
import type { GameEngine } from '../core/engine';
import type { ConstructionState } from '../core/construction';
import type { AppRenderer } from './ports';

interface TestAccess {
  engine(): GameEngine | null;
  inGame(): boolean;
  construction: ConstructionState;
  render: AppRenderer;
  start(mode: GameMode, stage: number): void;
  openEditor(): void;
  updateDraft(): void;
  playEditor(mode: GameMode): void;
  finish(): void;
  present(): void;
}
/** Included only in test builds. Clone at the test boundary, never per render. */
export function createAppTestAdapter(access: TestAccess) {
  return {
    state: (): GameState | null => {
      const engine = access.engine(); return engine ? structuredClone(engine.state) : null;
    },
    presentation: () => structuredClone(access.render.presentation),
    start: (mode: GameMode = 'single', stage = 1) => access.start(mode, stage),
    step: (count = 1, inputs: PlayerInput[] = [{ ...EMPTY_INPUT }, { ...EMPTY_INPUT }]): void => {
      const engine = access.engine(); if (!engine) return;
      for (let i = 0; i < Math.min(10000, Math.max(0, count)); i++) {
        engine.step(inputs); access.render.observeStep(engine.state);
      }
      if (access.inGame() && ['won', 'lost'].includes(engine.state.phase)) access.finish();
      else access.present();
    },
    debug: (patch: Partial<GameState>) => { const engine = access.engine(); if (engine) Object.assign(engine.state, patch); },
    openEditor: () => access.openEditor(),
    editor: () => ({ cursor: access.construction.cursor, selectedCode: access.construction.selectedCode }),
    setEditorTile: (index: number, tile: Tile): void => { if (access.construction.setTile(index, tile)) access.updateDraft(); },
    getEditorTiles: () => [...access.construction.tiles],
    playEditor: (mode: GameMode = 'single') => access.playEditor(mode),
  };
}
export type AppTestAdapter = ReturnType<typeof createAppTestAdapter>;
