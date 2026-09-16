import { hasTouchSupport, isTouchPrimary, onFirstTouch } from '../config/device.js';
import { createInputState, type InputState } from './InputState.js';
import { KeyboardSource } from './KeyboardSource.js';
import { MouseLook } from './MouseLook.js';
import { TouchControls } from './TouchControls.js';

/**
 * Aggregates every input source into a single normalised InputState.
 *
 * Keyboard and touch are peers here: both merge into the same snapshot, so the
 * player controller, the prediction, the network message and every
 * server-authoritative rule downstream cannot tell them apart. There is no
 * mobile movement path and no mobile build - one game, two ways to hold it.
 */
export class InputManager {
  private readonly state: InputState = createInputState();
  private readonly keyboard = new KeyboardSource();
  /** Camera look. Feeds the camera, never the character's movement. */
  readonly look = new MouseLook();
  /** Virtual stick, jump button and drag-to-look. Hidden on desktop. */
  private readonly touch = new TouchControls(this.look);
  /** Cancels the wait for a first touch on a hybrid device. */
  private cancelTouchWatch: (() => void) | null = null;

  /** True while a full-screen panel owns the input. */
  private suppressed = false;

  /** True once the on-screen touch controls are showing. */
  get touchActive(): boolean {
    return this.touch.isVisible;
  }

  /**
   * Stop feeding movement to the player without detaching the sources.
   *
   * Used while a shop or the rebirth panel is up, so the character does not
   * run off behind the popup. The keyboard keeps listening, so releasing a key
   * while a panel is open is still noticed and the player does not inherit a
   * stuck key the moment it closes.
   */
  setSuppressed(suppressed: boolean): void {
    this.suppressed = suppressed;
    // Looking around is suppressed with the same call, and the pointer lock is
    // released so the panel's own buttons can be clicked.
    this.look.setSuppressed(suppressed);
    // The touch layer also drops any finger it was tracking, so a stick held
    // when a shop opened cannot survive behind it.
    this.touch.setSuppressed(suppressed);
  }

  attach(canvas: HTMLElement): void {
    this.keyboard.attach();
    this.look.attach(canvas);
    this.touch.attach(canvas, canvas.parentElement ?? document.body);

    // A phone or tablet gets the controls immediately. A touchscreen LAPTOP
    // boots as a desktop and only grows them once a finger actually arrives,
    // so the desktop layout is never altered on a machine being used as one.
    if (isTouchPrimary()) {
      this.showTouchControls();
    } else if (hasTouchSupport()) {
      this.cancelTouchWatch = onFirstTouch(() => this.showTouchControls());
    }
  }

  detach(): void {
    this.keyboard.detach();
    this.look.detach();
    this.touch.detach();
    this.cancelTouchWatch?.();
    this.cancelTouchWatch = null;
  }

  /** Recompute the snapshot for this frame. */
  sample(): Readonly<InputState> {
    this.state.moveX = 0;
    this.state.moveZ = 0;
    this.state.jump = false;

    this.keyboard.apply(this.state);
    // Additive, so a keyboard and a stick can be used at once on a hybrid
    // device without either cancelling the other.
    this.touch.apply(this.state);

    // A panel is up: keep sampling (so held keys are tracked) but hand the
    // player a neutral snapshot. Closing the panel restores control on the
    // very next frame, with no latch to clear.
    if (this.suppressed) {
      this.state.moveX = 0;
      this.state.moveZ = 0;
      this.state.jump = false;
      return this.state;
    }

    // Normalise so diagonals are not faster than cardinals. The stick is
    // already clamped to a magnitude of 1, so this only ever bites when two
    // sources are pushed at once.
    const magnitude = Math.hypot(this.state.moveX, this.state.moveZ);
    if (magnitude > 1) {
      this.state.moveX /= magnitude;
      this.state.moveZ /= magnitude;
    }

    return this.state;
  }

  private showTouchControls(): void {
    this.cancelTouchWatch?.();
    this.cancelTouchWatch = null;
    this.touch.show();
    document.body.classList.add('aoe-touch-mode');
  }
}
