import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputManager } from '../../src/platform/input';

type KeyEvent = { code: string; repeat: boolean; preventDefault(): void };
let listeners: Map<string, (event: KeyEvent) => void>;
function key(type: string, code: string, repeat = false): void {
  listeners.get(type)!({ code, repeat, preventDefault: vi.fn() });
}
beforeEach(() => {
  listeners = new Map();
  vi.stubGlobal('window', { addEventListener: (type: string, handler: (event: KeyEvent) => void) => listeners.set(type, handler) });
});
afterEach(() => vi.unstubAllGlobals());

describe('classic controller input', () => {
  it('keeps A/B held separate from shot edges and isolates the players', () => {
    const input = new InputManager(vi.fn(), vi.fn(), vi.fn());
    for (const code of ['KeyD', 'KeyK', 'ArrowLeft', 'KeyN']) key('keydown', code);
    expect(input.read()).toMatchObject([{ right: true, left: false, firePressed: true }, { left: true, right: false, firePressed: true }]);
    expect(input.readPads()).toMatchObject([{ b: true, bPressed: false }, { a: true, aPressed: false }]);
    key('keydown', 'KeyK', true);
    expect(input.read()[0].firePressed).toBe(false);
    key('keyup', 'KeyK'); key('keydown', 'KeyK');
    expect(input.read()[0].firePressed).toBe(true);
  });
  it('requires release after scene transitions, including nonrepeat events', () => {
    const input = new InputManager(vi.fn(), vi.fn(), vi.fn());
    key('keydown', 'KeyD'); key('keydown', 'KeyJ');
    input.clear();
    key('keydown', 'KeyD'); key('keydown', 'KeyJ', true);
    expect(input.read()[0]).toMatchObject({ right: false, firePressed: false });
    key('keyup', 'KeyD'); key('keydown', 'KeyD');
    expect(input.read()[0].right).toBe(true);
  });
  it('invalidates held keys, pending edges and scene barriers after focus loss', () => {
    const start = vi.fn();
    const input = new InputManager(start, vi.fn(), vi.fn());
    key('keydown', 'Enter'); input.clear();
    key('keydown', 'KeyD'); key('keydown', 'KeyJ');
    input.resetForFocus();
    expect(input.read()[0]).toMatchObject({ right: false, firePressed: false });
    for (const code of ['Enter', 'KeyD', 'KeyJ']) key('keydown', code, true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(input.read()[0]).toMatchObject({ right: false, firePressed: false });
    // No in-page keyup: the physical release happened outside the document.
    for (const code of ['Enter', 'KeyD', 'KeyJ']) key('keydown', code);
    expect(start).toHaveBeenCalledTimes(2);
    expect(input.read()[0]).toMatchObject({ right: true, firePressed: true });
    expect(input.read()[0].firePressed).toBe(false);
  });
  it('makes Start/Select separate edges and prevents cross-screen Start', () => {
    let input: InputManager;
    const start = vi.fn(() => input.clear()), select = vi.fn();
    input = new InputManager(start, select, vi.fn());
    key('keydown', 'Enter'); key('keydown', 'Enter'); key('keydown', 'Enter', true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(input.read().every(player => !player.firePressed)).toBe(true);
    key('keyup', 'Enter'); key('keydown', 'Enter');
    expect(start).toHaveBeenCalledTimes(2);
    key('keydown', 'ShiftLeft'); expect(select).not.toHaveBeenCalled();
    key('keydown', 'ShiftRight'); key('keydown', 'ShiftRight', true);
    expect(select).toHaveBeenCalledTimes(1);
  });
});
