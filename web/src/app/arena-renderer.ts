import type { ArenaScene } from '../game/arena';
import type { AppRenderer } from './ports';

/** The only application adapter that knows the Phaser scene. */
export class ArenaRenderer implements AppRenderer {
  constructor(private readonly scene: ArenaScene) {}
  get state() { return this.scene.state; }
  set state(value: AppRenderer['state']) { this.scene.state = value; }
  get hudState() { return this.scene.hudState; }
  set hudState(value: AppRenderer['hudState']) { this.scene.hudState = value; }
  get draft() { return this.scene.draft; }
  set draft(value: AppRenderer['draft']) { this.scene.draft = value; }
  get presentation() { return this.scene.presentation; }
  set presentation(value: AppRenderer['presentation']) { this.scene.presentation = value; }
  resetAnimation(): void { this.scene.resetAnimation(); }
  observeStep(state: NonNullable<AppRenderer['state']>): void { this.scene.observeStep(state); }
}
