import { EMPTY_INPUT, type Direction, type GameMode, type PlayerInput } from '../core/types';

const movement = ['up', 'right', 'down', 'left'] as const;
const arrows = ['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'];
const letters = ['KeyW', 'KeyD', 'KeyS', 'KeyA'];
const relevant = new Set([...arrows, ...letters, 'KeyJ', 'Space', 'Enter']);
type TouchControl = Direction | 'fire';

export class InputManager {
  active = false;
  mode: GameMode = 'single';
  private keys = new Set<string>();
  private pressed = [false, false];
  private pointers = new Map<number, TouchControl | null>();
  private touchButtons: HTMLElement[] = [];
  constructor(private pause: () => void, private gesture: () => void, private canPause: () => boolean) {
    window.addEventListener('keydown', event => {
      if (event.target instanceof HTMLElement && event.target.matches('input, select, textarea')) return;
      if (event.code === 'Escape') {
        if (this.canPause()) { event.preventDefault(); if (!event.repeat) { this.gesture(); this.pause(); } }
        return;
      }
      if (!this.active || !relevant.has(event.code)) return;
      event.preventDefault();
      if (event.repeat && !this.keys.has(event.code)) return;
      this.gesture();
      if (!event.repeat && !this.keys.has(event.code)) {
        if (event.code === 'KeyJ' || (this.mode === 'single' && event.code === 'Space')) this.pressed[0] = true;
        if (this.mode === 'coop' && event.code === 'Enter') this.pressed[1] = true;
      }
      this.keys.add(event.code);
    });
    window.addEventListener('keyup', event => { this.keys.delete(event.code); });
  }
  attachTouch(root: HTMLElement): void {
    this.touchButtons = [...root.querySelectorAll<HTMLElement>('[data-control]')];
    root.addEventListener('pointerdown', event => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-control]');
      if (!button || !this.active) return;
      event.preventDefault();
      this.gesture();
      button.setPointerCapture(event.pointerId);
      const control = button.dataset.control! as TouchControl;
      this.pointers.set(event.pointerId, control);
      button.classList.add('held');
      if (control === 'fire') this.pressed[0] = true;
    });
    root.addEventListener('pointermove', event => {
      const current = this.pointers.get(event.pointerId);
      if (!this.pointers.has(event.pointerId) || current === 'fire') return;
      const button = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-control]');
      const control = button && root.contains(button) ? button.dataset.control as TouchControl : null;
      const next = control && control !== 'fire' ? control : null;
      if (next !== current) {
        this.pointers.set(event.pointerId, next);
        this.paintTouch();
      }
    });
    const release = (event: PointerEvent) => { this.pointers.delete(event.pointerId); this.paintTouch(); };
    root.addEventListener('pointerup', release);
    root.addEventListener('pointercancel', release);
    root.addEventListener('lostpointercapture', release);
  }
  read(): PlayerInput[] {
    const touch = new Set(this.pointers.values());
    const inputs = [this.player(0, touch), this.player(1, touch)];
    this.pressed = [false, false];
    return inputs;
  }
  clear(): void {
    this.keys.clear(); this.pointers.clear(); this.pressed = [false, false];
    this.touchButtons.forEach(button => button.classList.remove('held'));
  }
  private player(index: 0 | 1, touch: Set<TouchControl | null>): PlayerInput {
    const result = { ...EMPTY_INPUT };
    if (!this.active) return result;
    movement.forEach((direction, position) => {
      result[direction] = index === 0
        ? this.keys.has(letters[position]) || (this.mode === 'single' && this.keys.has(arrows[position])) || touch.has(direction)
        : this.keys.has(arrows[position]);
    });
    result.firePressed = this.pressed[index];
    return result;
  }
  private paintTouch(): void {
    const touch = new Set(this.pointers.values());
    this.touchButtons.forEach(button => {
      button.classList.toggle('held', touch.has(button.dataset.control! as TouchControl));
    });
  }
}
