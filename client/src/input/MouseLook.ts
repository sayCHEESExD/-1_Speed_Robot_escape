import { CAMERA } from '@robot/shared';

/** Radians of rotation per pixel of mouse movement. */
const SENSITIVITY = 0.0026;

/** Pitch limits, so the camera can never flip over the player. */
const MIN_PITCH = -0.55;
const MAX_PITCH = 1.15;

/**
 * One wheel notch, per `WheelEvent.deltaMode`.
 *
 * The same physical notch arrives as ~100 pixels, 3 lines or 1 page depending
 * on the browser and the pointing device, so the raw `deltaY` is normalised to
 * notches before it means anything. Using it unscaled is how a trackpad ends up
 * zooming ten times faster than a mouse.
 */
const NOTCH_PER_DELTA = [1 / 100, 1 / 3, 1] as const;

/**
 * Mouse look for the third-person camera.
 *
 * Accumulates yaw and pitch from raw pointer deltas. It owns NOTHING else -
 * the camera reads these two angles and the player controller rotates its
 * movement input by the yaw, so looking around never moves the character and
 * moving never turns the camera.
 *
 * Pointer lock follows the PANEL state, not clicks:
 *
 *   gameplay        -> cursor hidden, mouse steers the camera
 *   a panel opens   -> lock released, cursor free for its buttons
 *   the panel closes-> lock retaken, camera resumes at once
 *   Escape          -> the browser releases; the lock is taken straight back
 *
 * A PANEL IS THE ONLY THING THAT SHOWS A CURSOR. Escape does not, and neither
 * does anything else: the browser forces the lock open on Escape and no page
 * can prevent that, so the release is treated as accidental and reversed. Two
 * things do the reversing, because neither is enough on its own - the lock is
 * re-requested, which browsers refuse for a moment after an Escape, and the
 * cursor is hidden in CSS meanwhile, which covers the gap until the player's
 * next keystroke or click makes the request stick.
 *
 * The player is never trapped: Escape still works at the browser's level every
 * time, and the shop and rebirth keys give a real cursor on demand.
 *
 * The lock is taken on the player's FIRST gesture rather than waiting for a
 * deliberate click on the world. A browser will not grant it without one, so
 * "automatic" can only mean "on the first thing the player does" - and since a
 * keypress counts, pressing W to walk is enough. There is no click-to-play
 * step.
 *
 * Shops are opened by key, not by clicking the world, so nothing here needs to
 * distinguish a click on a panel from a click on the game: while a panel is up
 * this source is suppressed outright.
 *
 * Touch look goes through the SAME accumulator via `addLookDelta`, so the
 * pitch limits, the yaw wrap and the suppression rule exist once and cannot
 * drift between the two devices.
 */
export class MouseLook {
  private canvas: HTMLElement | null = null;

  private yawValue = 0;
  private pitchValue = 0.22;
  /** Player zoom offset in world units. 0 is the authored framing. */
  private zoomValue = 0;
  private suppressed = false;
  /** True while the left button is down and the pointer is NOT locked. */
  private dragging = false;

  /**
   * Whether this browser has ever actually granted the lock.
   *
   * Only used to decide whether drag-to-look is needed. Where pointer lock
   * works, holding the button must NOT steer - the cursor is free for the UI
   * and dragging on the world would be a second, invisible camera control.
   * Where it is refused - a sandboxed frame, an embedded preview - dragging
   * stays as the fallback, because otherwise there is no way to look around
   * at all.
   */
  private lockEverGranted = false;

  /**
   * Whether the player has done anything yet.
   *
   * A page cannot lock the pointer before its first user gesture, so this
   * records that the gesture has happened and the lock may be taken - and
   * retaken - from then on.
   */
  private armed = false;

  /** Portal sensitivity setting, as a multiple of `SENSITIVITY`. */
  private sensitivityScale = 1;

  /**
   * A re-lock that is owed but has not been granted.
   *
   * A browser will not grant a lock from an Escape keystroke: the HTML spec
   * excludes Esc from the input events that count as user activation,
   * precisely so a page cannot instantly re-trap a cursor the user escaped.
   * The request is still made - some browsers and embeddings honour it - and
   * when it is refused the debt is remembered and paid off on the player's
   * very next real gesture, which is the W press or click they were about to
   * make anyway.
   *
   * Set whenever the lock is lost with no panel up, which is the definition of
   * a release nobody asked for.
   */
  private pendingLock = false;

  /**
   * The player asked for their cursor, and may keep it.
   *
   * The state this game used not to have, and the absence of which was the
   * whole bug: pointer lock hides the cursor, every panel opens from a rail
   * button, and a button you cannot see or click is not a menu. Escape used to
   * be treated as an accident and reversed, which left a mouse-and-keyboard
   * player permanently captured with no way into their own shops.
   *
   * So Escape is now a REQUEST, and it is honoured until the player says
   * otherwise by clicking the world. A panel closing still takes the lock
   * back, because closing a menu is that same "otherwise".
   */
  private cursorFree = false;

  get yaw(): number {
    return this.yawValue;
  }

  get pitch(): number {
    return this.pitchValue;
  }

  /**
   * How far the player has pushed the camera out, in world units.
   *
   * Already clamped, and RAW: the easing that makes a notch feel smooth belongs
   * to the camera, exactly as the follow smoothing does. This accumulator is
   * the player's request, not the shot.
   */
  get zoom(): number {
    return this.zoomValue;
  }

  /** True while the browser has the pointer captured. */
  get locked(): boolean {
    return !!this.canvas && document.pointerLockElement === this.canvas;
  }

  /** True while the player has their cursor and the HUD is clickable. */
  get isCursorFree(): boolean {
    return this.cursorFree || this.suppressed;
  }

  /**
   * Hand the cursor back, or take it again.
   *
   * The one entry point for the state, so the Escape key, a click on the world
   * and any future settings toggle cannot each keep their own idea of it.
   */
  setCursorFree(free: boolean): void {
    if (this.cursorFree === free) return;
    this.cursorFree = free;
    if (free) {
      this.dragging = false;
      this.pendingLock = false;
      if (this.locked) document.exitPointerLock();
    } else if (this.armed && !this.suppressed) {
      this.requestLock();
    }
    this.applyCursor();
  }

  /**
   * Scale mouse sensitivity, 1 being the game's own tuning.
   *
   * A MULTIPLIER rather than a replacement, so the portal's slider moves the
   * feel around the value this game was tuned at instead of redefining it.
   * Touch look goes through the same accumulator and is deliberately left
   * alone: a drag is already proportional to the finger's travel.
   */
  setSensitivityScale(scale: number): void {
    this.sensitivityScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  }

  attach(canvas: HTMLElement): void {
    this.canvas = canvas;
    canvas.addEventListener('mousedown', this.onMouseDown);
    // Bound to the CANVAS and not the window, for the same reason `mousedown`
    // is: every panel is DOM above it and stops the event first, so a wheel
    // aimed at a scrolling shop list can never also zoom the camera. Not
    // passive, because the page must not scroll underneath the game.
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('keydown', this.onFirstGesture);
    document.addEventListener('pointerlockchange', this.onLockChange);
  }

  detach(): void {
    this.canvas?.removeEventListener('mousedown', this.onMouseDown);
    this.canvas?.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('keydown', this.onFirstGesture);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.body.classList.remove('aoe-cursor-hidden');
    this.canvas = null;
  }

  /**
   * Stop looking while a panel owns the screen, and hand the cursor back.
   *
   * Releasing the lock is what makes the shop buttons clickable. Closing the
   * panel deliberately does NOT take it back: the player may well want to open
   * another shop, and re-grabbing the cursor the instant a panel closes is the
   * behaviour that makes a menu feel like it is fighting you. One click on the
   * world resumes play.
   */
  setSuppressed(suppressed: boolean): void {
    const wasSuppressed = this.suppressed;
    this.suppressed = suppressed;

    if (suppressed) {
      this.dragging = false;
      this.pendingLock = false;
      this.applyCursor();
      if (this.locked) document.exitPointerLock();
      return;
    }

    /*
     * A panel CLOSED. Not merely "no panel is open".
     *
     * The input layer calls this every single frame that nothing is up, so
     * anything unconditional here runs sixty times a second. Taking the lock
     * back on that basis put the cursor away one frame after Escape handed it
     * over - which is the exact behaviour `cursorFree` exists to remove.
     *
     * On a real close, the lock IS taken straight back: closing a menu is the
     * player saying they want to play on, so they should not also have to
     * click the world. If the browser refuses during its post-Escape cooldown,
     * `pendingLock` keeps the request alive until a gesture can pay it off.
     */
    if (!wasSuppressed) return;
    this.cursorFree = false;
    if (this.armed) {
      this.pendingLock = true;
      this.requestLock();
    }
    this.applyCursor();
  }

  /**
   * Arm the lock and take it as soon as the browser allows.
   *
   * Called from the first real user gesture. Kept separate from the gesture
   * handlers so an embedding host - a portal SDK owning its own menu and
   * pointer-lock lifecycle - has one method to drive instead of having to
   * synthesise clicks.
   */
  engage(): void {
    this.armed = true;
    if (!this.suppressed) this.requestLock();
    this.applyCursor();
  }

  /**
   * Hand the lock and the cursor back to whatever is embedding the game.
   *
   * Disarms as well as releasing, which is what separates this from a panel
   * opening: a suppressed source is still playing and takes the lock back the
   * moment the panel closes, whereas a released one has stopped, shows a
   * cursor and waits to be engaged again.
   */
  release(): void {
    this.dragging = false;
    this.pendingLock = false;
    this.armed = false;
    if (this.locked) document.exitPointerLock();
    this.applyCursor();
  }

  /**
   * Toggle the lock. This is the ONLY thing that ever acquires it.
   *
   * Bound to the canvas, so it hears clicks on the game world and nothing
   * else: every panel, button and backdrop is DOM above the canvas and stops
   * the event before it arrives. That is what keeps a click on a shop from
   * grabbing the cursor the player is using to click it.
   */
  /**
   * Any keypress is a user gesture, and the first one arms the lock.
   *
   * This is what removes the click-to-play step: the player presses W to walk
   * and the cursor disappears on the same keystroke. Escape is excluded - it
   * is how the player asks to be LET OUT, so it must never be the thing that
   * puts them back in.
   */
  private readonly onFirstGesture = (event: KeyboardEvent): void => {
    // Escape can never carry the activation a lock needs, so it is not the
    // keystroke that restores one - it only ever loses it.
    if (event.key === 'Escape') return;
    if (!this.armed) {
      this.engage();
      return;
    }
    // The cursor is out because the player asked for it. Typing does not
    // cancel that - only clicking the world does - or every keystroke aimed at
    // the game would snatch back a cursor aimed at a button.
    if (this.cursorFree) return;
    // A re-lock the browser refused during a panel close, paid off by the
    // first keystroke that DOES carry user activation.
    if (this.pendingLock && !this.locked && !this.suppressed) this.requestLock();
  };

  /** A click on the world resumes play after Escape released the lock. */
  private readonly onMouseDown = (event: MouseEvent): void => {
    if (this.suppressed || event.button !== 0) return;
    this.armed = true;
    // Bound to the CANVAS, so this only ever hears clicks on the game world -
    // every panel and button is DOM above it and stops the event first. A
    // click on the world is the player saying they are done with the cursor.
    this.cursorFree = false;
    if (this.locked) return;

    // Only where the lock is refused outright does holding the button steer;
    // see `lockEverGranted`.
    this.dragging = !this.lockEverGranted;
    this.requestLock();
  };

  /**
   * The lock was gained or lost.
   *
   * Nothing is re-acquired here. Escape, a tab switch and the browser's own
   * release all land in the same place - cursor visible, camera still - and
   * the player takes control back by clicking the world.
   */
  private readonly onLockChange = (): void => {
    if (this.locked) {
      this.lockEverGranted = true;
      this.pendingLock = false;
      // A granted lock supersedes drag-to-look; the two must never both steer.
      this.dragging = false;
      this.applyCursor();
      return;
    }

    this.dragging = false;
    /*
     * Lost the lock with no panel up.
     *
     * That is Escape, an alt-tab, or the browser's own release, and all three
     * mean the same thing: the player wants their cursor. It used to be
     * treated as an accident and reversed on the next keystroke, which is what
     * made the rail buttons unclickable on a desktop - the cursor came back
     * for a moment and was taken away again before it could reach one.
     *
     * Now it is accepted. The camera stops, the cursor appears over the HUD,
     * and one click on the world resumes play.
     */
    if (!this.suppressed && this.armed) this.cursorFree = true;
    this.applyCursor();
  };

  /**
   * Show a cursor only while a panel owns the screen.
   *
   * Guarded on `lockEverGranted` so it can never hide a cursor the player
   * still needs: where pointer lock is refused outright - a sandboxed frame,
   * an embedded preview - the rail buttons are the only way into the shops and
   * they have to stay clickable.
   */
  private applyCursor(): void {
    const hide =
      this.armed && this.lockEverGranted && !this.suppressed && !this.cursorFree;
    document.body.classList.toggle('aoe-cursor-hidden', hide);
  }

  /**
   * Ask for the lock, tolerating every way a browser can say no.
   *
   * The request rejects on its own promise in sandboxed frames and during the
   * browser's own post-Escape cooldown. Neither is a fault - drag-to-look
   * still works - so it is caught rather than left to surface as an unhandled
   * rejection.
   */
  private requestLock(): void {
    if (!this.canvas || this.locked || this.suppressed || this.cursorFree) return;
    const request = this.canvas.requestPointerLock?.() as unknown;
    if (request instanceof Promise) request.catch(() => undefined);
  }

  private readonly onMouseUp = (): void => {
    this.dragging = false;
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (this.suppressed) return;
    if (!this.locked && !this.dragging) return;
    const sensitivity = SENSITIVITY * this.sensitivityScale;
    this.addLookDelta(event.movementX * sensitivity, event.movementY * sensitivity);
  };

  /**
   * Apply a look delta already scaled to RADIANS.
   *
   * The one place yaw and pitch are written. Mouse movement and touch drags
   * both arrive here, so neither can invent its own pitch clamp.
   */
  addLookDelta(deltaYaw: number, deltaPitch: number): void {
    if (this.suppressed) return;
    if (!Number.isFinite(deltaYaw) || !Number.isFinite(deltaPitch)) return;

    this.yawValue -= deltaYaw;
    this.pitchValue += deltaPitch;

    // Wrapping keeps the accumulated yaw finite over a long session.
    if (this.yawValue > Math.PI) this.yawValue -= Math.PI * 2;
    else if (this.yawValue < -Math.PI) this.yawValue += Math.PI * 2;

    this.pitchValue =
      this.pitchValue < MIN_PITCH
        ? MIN_PITCH
        : this.pitchValue > MAX_PITCH
          ? MAX_PITCH
          : this.pitchValue;
  }

  /**
   * The wheel pushes the camera out and pulls it in.
   *
   * Deliberately NOT gated on the pointer lock, unlike looking. Zoom is a
   * framing preference rather than an act of aiming, and the moment it is most
   * wanted is while standing in the arena reading a board with the cursor
   * out - which is exactly when the lock is not held.
   */
  private readonly onWheel = (event: WheelEvent): void => {
    if (this.suppressed) return;
    event.preventDefault();
    const notches = event.deltaY * (NOTCH_PER_DELTA[event.deltaMode] ?? NOTCH_PER_DELTA[0]);
    // Scrolling DOWN pushes the camera away, which is the convention every
    // other third-person game in this style uses.
    this.addZoomDelta(notches * CAMERA.zoomStep);
  };

  /**
   * Apply a zoom delta already scaled to WORLD UNITS.
   *
   * The one place the zoom is written and the only place it is clamped, so a
   * pinch gesture added later cannot invent a second set of limits - the same
   * arrangement `addLookDelta` has for the pitch clamp.
   */
  addZoomDelta(delta: number): void {
    if (this.suppressed || !Number.isFinite(delta)) return;
    const next = this.zoomValue + delta;
    this.zoomValue =
      next < CAMERA.zoomMin
        ? CAMERA.zoomMin
        : next > CAMERA.zoomMax
          ? CAMERA.zoomMax
          : next;
  }

  private readonly onBlur = (): void => {
    this.dragging = false;
  };
}
