import { EMPTY_INPUT, type PlayerInput } from '../core/types';

export interface LogicalPad {
  up: boolean; right: boolean; down: boolean; left: boolean;
  a: boolean; b: boolean; aPressed: boolean; bPressed: boolean;
}
const layouts = [
  ['KeyW', 'KeyD', 'KeyS', 'KeyA', 'KeyJ', 'KeyK'],
  ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'KeyN', 'KeyM'],
] as const;
const relevant = new Set<string>([...layouts[0], ...layouts[1], 'Enter', 'ShiftRight']);

/** Two Famicom pads. Scene changes require release; focus loss invalidates old keys. */
export class InputManager {
  private keys = new Set<string>();
  private blocked = new Set<string>();
  private edges = new Set<string>();
  constructor(start: () => void, select: () => void, gesture: () => void) {
    window.addEventListener('keydown', event => {
      if (!relevant.has(event.code)) return;
      event.preventDefault();
      if (event.repeat || this.keys.has(event.code) || this.blocked.has(event.code)) return;
      this.keys.add(event.code);
      gesture();
      if (event.code === 'Enter') start();
      else if (event.code === 'ShiftRight') select();
      else this.edges.add(event.code);
    });
    window.addEventListener('keyup', event => {
      this.keys.delete(event.code);
      this.blocked.delete(event.code);
    });
  }
  readPads(): LogicalPad[] {
    const result = layouts.map(([up, right, down, left, a, b]) => ({
      up: this.keys.has(up), right: this.keys.has(right),
      down: this.keys.has(down), left: this.keys.has(left),
      a: this.keys.has(a), b: this.keys.has(b),
      aPressed: this.edges.has(a), bPressed: this.edges.has(b),
    }));
    this.edges.clear();
    return result;
  }
  read(): PlayerInput[] {
    return this.readPads().map(pad => ({ ...EMPTY_INPUT,
      up: pad.up, right: pad.right, down: pad.down, left: pad.left,
      firePressed: pad.aPressed || pad.bPressed,
    }));
  }
  clear(): void {
    for (const key of this.keys) this.blocked.add(key);
    this.keys.clear(); this.edges.clear();
  }
  resetForFocus(): void {
    // A key released in another window never sends this page its keyup.
    // Repeated held events remain ignored, but the next fresh press must work.
    this.keys.clear(); this.blocked.clear(); this.edges.clear();
  }
}
