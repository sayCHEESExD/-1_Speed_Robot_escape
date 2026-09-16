import type { InputState } from './InputState.js';

const KEY_BINDINGS: Readonly<Record<string, keyof BindingTargets>> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  /*
   * Space is the JUMP, and it is the only action key.
   *
   * THERE IS NO SPRINT BINDING, and Shift is deliberately absent from this
   * table: the mech has one gait, so a modifier key has nothing to modify.
   * Binding it to nothing here is what makes that true everywhere - the input
   * state carries no such field, so nothing downstream can read one.
   */
  Space: 'jump',
};

interface BindingTargets {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
}

/** Desktop keyboard input. One of possibly several sources feeding InputManager. */
export class KeyboardSource {
  private readonly held: BindingTargets = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
  };

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  /** Merge this source's contribution into the shared input state. */
  apply(state: InputState): void {
    if (this.held.forward) state.moveZ += 1;
    if (this.held.back) state.moveZ -= 1;
    if (this.held.right) state.moveX += 1;
    if (this.held.left) state.moveX -= 1;
    if (this.held.jump) state.jump = true;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const binding = KEY_BINDINGS[event.code];
    if (!binding) return;
    if (event.repeat) return;
    this.held[binding] = true;
    // Stop Space from scrolling the page behind the canvas.
    if (event.code === 'Space') event.preventDefault();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    const binding = KEY_BINDINGS[event.code];
    if (!binding) return;
    this.held[binding] = false;
  };

  /** Losing focus must not leave a key stuck down. */
  private readonly onBlur = (): void => {
    this.held.forward = false;
    this.held.back = false;
    this.held.left = false;
    this.held.right = false;
    this.held.jump = false;
  };
}
