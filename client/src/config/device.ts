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
