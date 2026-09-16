/**
 * What kind of pointer this browser actually has.
 *
 * Kept away from the input sources themselves so there is exactly one answer
 * to "is this a touch device", and so the desktop path can never be replaced
 * by accident: touch controls are ADDED to the existing pipeline, never
 * swapped in for it.
 */

/**
 * True for a phone or tablet: the primary pointer is coarse AND there is no
 * hover.
 *
 * Deliberately stricter than `maxTouchPoints > 0`, which is also true of a
 * touchscreen laptop. Such a machine keeps the untouched desktop layout until
 * someone actually puts a finger on it - see `onFirstTouch`.
 */
export const isTouchPrimary = (): boolean => {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(pointer: coarse) and (hover: none)').matches;
};

/** True if the device can produce touch events at all, hybrid machines included. */
export const hasTouchSupport = (): boolean => {
  if (typeof window === 'undefined') return false;
  return (navigator.maxTouchPoints ?? 0) > 0 || 'ontouchstart' in window;
};

/**
 * Call `callback` the first time a real finger touches the screen.
 *
 * This is what makes a hybrid device - a touchscreen laptop, a Surface, an
 * iPad with a trackpad - correct in both modes: it boots as a desktop and only
 * grows touch controls once they are demonstrably wanted. The listener removes
 * itself, so it costs nothing after the first touch.
 *
 * @returns a function that cancels the wait
 */
export const onFirstTouch = (callback: () => void): (() => void) => {
  if (typeof window === 'undefined') return () => undefined;

  const handler = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') return;
    cancel();
    callback();
  };
  const cancel = (): void => {
    window.removeEventListener('pointerdown', handler, true);
  };

  window.addEventListener('pointerdown', handler, true);
  return cancel;
};

/**
 * THE ONE PLACE THAT DECIDES A DEVICE IS SMALL.
 *
 * Not "is it touch": a desk with a touchscreen has a desktop GPU and a desktop
 * memory budget, and giving it a phone's budget would be a downgrade nobody
 * asked for. What matters here is a MOBILE GPU - a coarse pointer with no
 * hover, which is a phone or a tablet.
 *
 * Read once and cached. It cannot change without a reload, and it is asked for
 * in the middle of building the world.
 */
let mobileGpu: boolean | null = null;
export const isMobileGpu = (): boolean => {
  if (mobileGpu === null) mobileGpu = isTouchPrimary();
  return mobileGpu;
};

/**
 * Longest edge any canvas-drawn world texture may have.
 *
 * THIS IS A MEMORY BUDGET, not a sharpness setting, and it is the single most
 * expensive number in the client. World signs are sized from their WORLD size
 * at a fixed pixels-per-unit, and with no ceiling a stage gate 46 units across
 * became a 2944 x 704 canvas - eight megapixels, thirty-three megabytes on the
 * GPU, for two words. Thirty stages of those was 237 MB of texture on its own,
 * and the whole scene came to 369 MB: past what a phone will hand a single tab,
 * which is why one froze rather than merely running slowly.
 *
 * A sign is read from tens of units away. At this cap a stage gate still gets
 * over a hundred pixels of glyph height, which is more than the screen it is
 * being read on can show.
 */
export const maxTextureEdge = (): number => (isMobileGpu() ? 768 : 1280);
