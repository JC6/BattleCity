import { GameAudio } from '../../../src/platform/audio';
import { GameEngine } from '../../../src/core/engine';
import { getLevel } from '../../../src/data/levels';

declare global { interface Window { __OPENING_TRACE__: { mark(kind: string, details?: object): void; harvest(): Promise<unknown> } } }
const audio = new GameAudio(0.3);
let stage = 0, prepared: GameEngine | undefined;
const mark = (kind: string, fields: object = {}) => window.__OPENING_TRACE__?.mark(kind, fields);
window.addEventListener('keydown', event => {
  mark('handler-start', { code: event.code });
  try {
    if (event.repeat || !['Enter', 'KeyJ'].includes(event.code)) return;
    event.preventDefault(); audio.unlock();
    if (event.code === 'KeyJ' && stage === 1) {
      stage = 2;
      prepared = new GameEngine(getLevel(2), { mode: 'single', stage: 2, seed: 12345 });
    } else if (event.code === 'Enter' && stage === 0) { audio.stopScene(); stage = 1; }
    else if (event.code === 'Enter' && stage === 2 && prepared) {
      audio.stopScene(); mark('sync-start'); audio.syncState(prepared.state); audio.commitFrame();
      mark('present-start'); stage = 3; mark('present-end');
    }
    document.body.dataset.stage = String(stage);
  } finally { mark('handler-end', { code: event.code }); }
});
window.addEventListener('pagehide', () => { void audio.dispose(); });
document.body.dataset.stage = '0';
