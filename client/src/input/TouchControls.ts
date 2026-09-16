import type { InputState } from './InputState.js';

/**
 * The movement stick owns the bottom-left of the screen; a drag anywhere else
 * on the canvas turns the camera.
 *
 * Expressed as fractions of the viewport so the split holds in both
 * orientations and on any screen size.
 */
const ZONE_WIDTH = 0.5;
const ZONE_TOP = 0.32;

/** Stick radius, sized from the smaller viewport axis and then bounded. */
const RADIUS_VMIN = 0.15;
const RADIUS_MIN = 46;
const RADIUS_MAX = 84;

/** Deflection below which the stick reads as neutral, as a fraction of radius. */
const DEADZONE = 0.18;

/** Radians of camera rotation per pixel dragged. */
const LOOK_SENSITIVITY = 0.005;

/** Where the camera's yaw and pitch live. Implemented by `MouseLook`. */
export interface LookSink {
  addLookDelta(deltaX: number, deltaY: number): void;
}

/**
 * Touch controls: a virtual analog stick, a JUMP button, and
 * drag-to-look.
 *
 * This is a SOURCE, not a second movement system. It writes the same
 * `moveX`/`moveZ`/`jump` fields the keyboard writes, through the same
 * `InputManager`, into the same `MoveMessage` - so prediction, reconciliation,
 * treadmill entry and exit and every server check behave identically to
 * desktop. Nothing here knows what a player is.
 *
 * The stick's DEFLECTION is direction and nothing else. It used to pick a run
 * speed past a threshold, which was the phone's stand-in for Shift; there is
 * no sprint in this game any more, on either input.
 *
 * Pointer routing is by POINTER ID, so one finger can never drive two systems:
 * the first touch inside the stick zone claims movement, a touch anywhere else
 * on the canvas claims the camera, and the buttons capture their own pointer
 * and never reach the canvas at all.
 */
export class TouchControls {
  private readonly root: HTMLElement;
  private readonly stick: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly jumpButton: HTMLButtonElement;

  private canvas: HTMLElement | null = null;
  private readonly look: LookSink;

  /** Pointer currently driving each role, or null. */
  private movePointer: number | null = null;
  private lookPointer: number | null = null;

  /** Stick origin in client pixels, set where the finger first landed. */
  private originX = 0;
  private originY = 0;
  private radius = 64;

  /** Last look sample, for the per-move delta. */
  private lookX = 0;
  private lookY = 0;

  private moveX = 0;
  private moveZ = 0;

  /** Finger held on the jump button. */
  private jumpHeld = false;
  /**
   * A press that happened since the last sample.
   *
   * A tap can begin AND end inside one render frame, which would otherwise be
   * sampled as "never pressed". Latching it guarantees one frame of
   * `jump = true` followed by a frame of false - exactly the rising edge the
   * shared simulation's `jumpLatched` looks for, so a tap always buys its
   * launch even if the finger came off inside one frame. Holding buys nothing
   * beyond that: one press is one leap, on the button exactly as on the key.
   */
  private jumpPulse = false;

  private visible = false;
  private suppressed = false;

  constructor(look: LookSink) {
    this.look = look;

    this.root = document.createElement('div');
    this.root.className = 'aoe-touch';
    // The layer never eats events; only the button inside it does. The stick
    // is drawn here but READ from the canvas, so a finger that misses it still
    // works.
    this.root.hidden = true;

    this.stick = document.createElement('div');
    this.stick.className = 'aoe-touch__stick';
    this.knob = document.createElement('div');
    this.knob.className = 'aoe-touch__knob';
    this.stick.append(this.knob);

    this.jumpButton = document.createElement('button');
    this.jumpButton.className = 'aoe-touch__jump';
    this.jumpButton.type = 'button';
    this.jumpButton.setAttribute('aria-label', 'Jump');
    // A TAP, not a hold: one press is one leap, exactly as the space bar is,
    // and a phone player has no key cap to read that off.
    this.jumpButton.textContent = 'JUMP';

    this.root.append(this.stick, this.jumpButton);
    injectStyles();
  }

  /** True once the controls are on screen. */
  get isVisible(): boolean {
    return this.visible;
  }

  attach(canvas: HTMLElement, container: HTMLElement): void {
    this.canvas = canvas;
    container.append(this.root);
    this.measure();

    canvas.addEventListener('pointerdown', this.onCanvasDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('resize', this.measure);

    this.jumpButton.addEventListener('pointerdown', this.onJumpDown);
    this.jumpButton.addEventListener('pointerup', this.onJumpUp);
    this.jumpButton.addEventListener('pointercancel', this.onJumpUp);
    this.jumpButton.addEventListener('pointerleave', this.onJumpUp);
    // A tap must never also fire the browser's synthesised click.
    this.jumpButton.addEventListener('contextmenu', preventDefault);
  }

  detach(): void {
    this.canvas?.removeEventListener('pointerdown', this.onCanvasDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('resize', this.measure);
    this.jumpButton.removeEventListener('pointerdown', this.onJumpDown);
    this.jumpButton.removeEventListener('pointerup', this.onJumpUp);
    this.jumpButton.removeEventListener('pointercancel', this.onJumpUp);
    this.jumpButton.removeEventListener('pointerleave', this.onJumpUp);
    this.jumpButton.removeEventListener('contextmenu', preventDefault);
    this.root.remove();
    this.canvas = null;
  }

  /** Put the controls on screen. Idempotent. */
  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.root.hidden = false;
    this.measure();
  }

  /**
   * Stop reading touches while a panel owns the screen.
   *
   * Every in-flight pointer is released, so a finger that was on the stick
   * when a shop opened cannot leave the player walking behind the popup.
   */
  setSuppressed(suppressed: boolean): void {
    this.suppressed = suppressed;
    this.root.classList.toggle('aoe-touch--hidden', suppressed);
    if (suppressed) this.releaseAll();
  }

  /** Merge this source's contribution into the shared input state. */
  apply(state: InputState): void {
    state.moveX += this.moveX;
    state.moveZ += this.moveZ;
    if (this.jumpHeld || this.jumpPulse) state.jump = true;
    this.jumpPulse = false;
  }

  // ------------------------------------------------------------- pointers

  /**
   * A touch landed on the canvas.
   *
   * Buttons are DOM siblings above the canvas, so a tap on one is never seen
   * here at all - which is what stops the action buttons from turning the
   * camera underneath them.
   */
  private readonly onCanvasDown = (event: PointerEvent): void => {
    if (this.suppressed || !this.visible) return;
    if (event.pointerType === 'mouse') return;

    if (this.movePointer === null && this.inStickZone(event.clientX, event.clientY)) {
      this.movePointer = event.pointerId;
      this.originX = event.clientX;
      this.originY = event.clientY;
      this.placeStick();
      this.stick.classList.add('aoe-touch__stick--active');
      this.updateStick(event.clientX, event.clientY);
      event.preventDefault();
      return;
    }

    if (this.lookPointer === null) {
      this.lookPointer = event.pointerId;
      this.lookX = event.clientX;
      this.lookY = event.clientY;
      event.preventDefault();
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.suppressed) return;

    if (event.pointerId === this.movePointer) {
      this.updateStick(event.clientX, event.clientY);
      event.preventDefault();
      return;
    }

    if (event.pointerId === this.lookPointer) {
      // Routed through the same accumulator the mouse uses, so touch and mouse
      // share one set of pitch limits and one yaw wrap.
      this.look.addLookDelta(
        (event.clientX - this.lookX) * LOOK_SENSITIVITY,
        (event.clientY - this.lookY) * LOOK_SENSITIVITY,
      );
      this.lookX = event.clientX;
      this.lookY = event.clientY;
      event.preventDefault();
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId === this.movePointer) this.releaseStick();
    if (event.pointerId === this.lookPointer) this.lookPointer = null;
  };

  private readonly onJumpDown = (event: PointerEvent): void => {
    if (this.suppressed) return;
    // The canvas must never see this: it would start a camera drag under the
    // button.
    event.stopPropagation();
    event.preventDefault();
    this.jumpHeld = true;
    this.jumpPulse = true;
    this.jumpButton.classList.add('aoe-touch__jump--down');
    // Capture keeps the press alive if the thumb slides off the button, but a
    // pointer that has already ended makes it throw - which must never take
    // the press down with it.
    try {
      this.jumpButton.setPointerCapture(event.pointerId);
    } catch {
      // No capture; the window-level pointerup still releases the button.
    }
  };

  private readonly onJumpUp = (event: PointerEvent): void => {
    event.stopPropagation();
    this.jumpHeld = false;
    this.jumpButton.classList.remove('aoe-touch__jump--down');
    try {
      if (this.jumpButton.hasPointerCapture(event.pointerId)) {
        this.jumpButton.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Already released by the browser when the pointer ended.
    }
  };

  // -------------------------------------------------------------- helpers

  private inStickZone(x: number, y: number): boolean {
    return x < window.innerWidth * ZONE_WIDTH && y > window.innerHeight * ZONE_TOP;
  }

  private readonly measure = (): void => {
    const vmin = Math.min(window.innerWidth, window.innerHeight);
    this.radius = Math.max(RADIUS_MIN, Math.min(vmin * RADIUS_VMIN, RADIUS_MAX));
    this.stick.style.setProperty('--aoe-stick-radius', `${this.radius}px`);
    /*
     * PUBLISHED ON THE ROOT, because the HUD has to lay out AROUND the thumb
     * controls and cannot otherwise know how big they are.
     *
     * The radius is computed here, in JS, from `vmin` - so a stylesheet that
     * wanted to leave room for the stick previously had to guess at a pixel
     * figure and hope. Every guess is wrong on some phone. With the real
     * number on `:root` the telemetry block and the rail can be sized by
     * arithmetic against it, and a change to `RADIUS_VMIN` moves them both.
     */
    document.documentElement.style.setProperty(
      '--aoe-stick-radius',
      `${this.radius}px`,
    );
    if (this.movePointer === null) this.placeStickAtRest();
  };

  private placeStick(): void {
    this.stick.style.left = `${this.originX}px`;
    this.stick.style.top = `${this.originY}px`;
  }

  /** Resting position: bottom-left, inside the safe area. */
  private placeStickAtRest(): void {
    this.stick.style.left = '';
    this.stick.style.top = '';
  }

  private updateStick(x: number, y: number): void {
    const dx = x - this.originX;
    const dy = y - this.originY;
    const distance = Math.hypot(dx, dy);

    // Clamped to the radius, so magnitude can never exceed 1.
    const deflection = Math.min(distance / this.radius, 1);

    if (deflection < DEADZONE || distance < 1e-4) {
      this.moveX = 0;
      this.moveZ = 0;
      this.knob.style.transform = 'translate(-50%, -50%)';
      return;
    }

    // Rescale past the deadzone so the first millimetre of real travel starts
    // from zero rather than jumping to the deadzone value.
    const magnitude = (deflection - DEADZONE) / (1 - DEADZONE);
    const dirX = dx / distance;
    const dirY = dy / distance;

    this.moveX = dirX * magnitude;
    // Screen Y grows downward; forward is up the screen.
    this.moveZ = -dirY * magnitude;

    const knobX = dirX * deflection * this.radius;
    const knobY = dirY * deflection * this.radius;
    this.knob.style.transform = `translate(calc(-50% + ${knobX}px), calc(-50% + ${knobY}px))`;
  }

  private releaseStick(): void {
    this.movePointer = null;
    this.moveX = 0;
    this.moveZ = 0;
    this.knob.style.transform = 'translate(-50%, -50%)';
    this.stick.classList.remove('aoe-touch__stick--active');
    this.placeStickAtRest();
  }

  private releaseAll(): void {
    this.releaseStick();
    this.lookPointer = null;
    this.jumpHeld = false;
    this.jumpPulse = false;
    this.jumpButton.classList.remove('aoe-touch__jump--down');
  }
}

const preventDefault = (event: Event): void => event.preventDefault();

let stylesInjected = false;

const injectStyles = (): void => {
  if (stylesInjected) return;
  stylesInjected = true;

  const style = document.createElement('style');
  style.textContent = `
/*
 * The touch layer itself is inert - the STICK is drawn here but read from the
 * canvas underneath, so a finger that lands beside it still steers. Only the
 * action button takes events.
 */
:root {
  /*
   * THE ACTION BUTTON'S SIZE, declared once and used by the HUD as well.
   *
   * The block along the bottom of the screen has to end before this begins,
   * so the figure cannot live only on the button.
   */
  --aoe-jump-size: clamp(74px, 17vmin, 108px);
}

.aoe-touch {
  position: fixed;
  inset: 0;
  z-index: 22;
  pointer-events: none;
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
}
.aoe-touch[hidden] { display: none; }
.aoe-touch--hidden { opacity: 0; pointer-events: none; }

/*
 * The stick base is a PILOT'S RETICLE, not a translucent pill.
 *
 * Same lime hairline and dark glass as every panel in the interface, plus the
 * crosshair a targeting ring has. It is the one piece of UI a phone player
 * looks at for the entire session, so it belonging to the machine matters more
 * here than anywhere else.
 */
.aoe-touch__stick {
  --aoe-stick-radius: 64px;
  position: fixed;
  left: calc(var(--aoe-safe-l, 0px) + 26px + var(--aoe-stick-radius));
  top: auto;
  bottom: calc(var(--aoe-safe-b, 0px) + 26px);
  width: calc(var(--aoe-stick-radius) * 2);
  height: calc(var(--aoe-stick-radius) * 2);
  margin: calc(var(--aoe-stick-radius) * -1) 0 0 calc(var(--aoe-stick-radius) * -1);
  border: 1px solid rgba(216, 255, 58, 0.55);
  border-radius: 50%;
  background-color: rgba(6, 12, 20, 0.4);
  /* The crosshair: two hairlines through the centre, drawn with gradients so
     the whole reticle stays one element and one paint. */
  background-image:
    linear-gradient(90deg, rgba(216, 255, 58, 0) 46%, rgba(216, 255, 58, 0.5) 46%,
      rgba(216, 255, 58, 0.5) 54%, rgba(216, 255, 58, 0) 54%),
    linear-gradient(0deg, rgba(216, 255, 58, 0) 46%, rgba(216, 255, 58, 0.5) 46%,
      rgba(216, 255, 58, 0.5) 54%, rgba(216, 255, 58, 0) 54%);
  box-shadow: inset 0 0 24px rgba(216, 255, 58, 0.1);
  opacity: 0.55;
  transition: opacity 140ms ease;
}
/* While engaged the base is positioned from its CENTRE at the touch point. */
.aoe-touch__stick--active {
  bottom: auto;
  opacity: 0.9;
  transition: none;
}
.aoe-touch__knob {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 44%;
  height: 44%;
  transform: translate(-50%, -50%);
  border: 1px solid rgba(216, 255, 58, 0.95);
  border-radius: 50%;
  background: rgba(216, 255, 58, 0.24);
  box-shadow: 0 0 14px rgba(216, 255, 58, 0.55);
}

.aoe-touch__jump {
  position: fixed;
  right: calc(var(--aoe-safe-r, 0px) + 24px);
  bottom: calc(var(--aoe-safe-b, 0px) + 34px);
  width: var(--aoe-jump-size);
  height: var(--aoe-jump-size);
  padding: 0;
  /*
   * THE ONE ACTION CONTROL, and it is a hex plate with a lit rim.
   *
   * Cut as a hexagon rather than a circle because nothing else in this
   * interface is round, and lit in cyan - the colour this game uses for where
   * you land - since a jump is the only input that decides where that is.
   */
  border: 0;
  border-radius: 0;
  clip-path: polygon(25% 2%, 75% 2%, 100% 50%, 75% 98%, 25% 98%, 0 50%);
  background-color: rgba(0, 229, 255, 0.22);
  background-image: linear-gradient(180deg, rgba(0, 229, 255, 0.4), rgba(0, 229, 255, 0.06));
  color: #d8fbff;
  font: 700 clamp(14px, 3.4vmin, 20px)/1 ui-monospace, "SF Mono", "Cascadia Mono",
    "Consolas", monospace;
  letter-spacing: 0.18em;
  text-shadow: 0 0 10px rgba(0, 229, 255, 0.9);
  filter: drop-shadow(0 0 10px rgba(0, 229, 255, 0.35));
  pointer-events: auto;
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
}
/* Pressed: the plate sinks and the rim floods, the way a lit control does. */
.aoe-touch__jump--down {
  transform: translateY(3px);
  background-image: linear-gradient(180deg, rgba(0, 229, 255, 0.75), rgba(0, 229, 255, 0.25));
  filter: drop-shadow(0 0 18px rgba(0, 229, 255, 0.8));
}
`;
  document.head.append(style);
};
