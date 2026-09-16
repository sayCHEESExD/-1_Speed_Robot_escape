/** Largest delta a single frame may report, in seconds. Guards against tab stalls. */
const MAX_DELTA = 0.1;

/**
 * requestAnimationFrame driver with a clamped delta.
 *
 * Kept separate from Game so the update order stays readable and so the loop
 * can be started, stopped and swapped independently of game logic.
 */
export class GameLoop {
  private readonly callback: (delta: number, now: number) => void;

  private handle = 0;
  private lastTime = 0;
  private running = false;

  constructor(callback: (delta: number, now: number) => void) {
    this.callback = callback;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.handle = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.handle);
  }

  private readonly tick = (now: number): void => {
    if (!this.running) return;
    this.handle = requestAnimationFrame(this.tick);

    // The first rAF timestamp can predate the performance.now() captured in
    // start(), producing a NEGATIVE delta. Clamp at both ends: a frame is
    // never shorter than zero, and never longer than MAX_DELTA.
    const elapsed = (now - this.lastTime) / 1000;
    const delta = Math.min(Math.max(elapsed, 0), MAX_DELTA);
    this.lastTime = now;

    this.callback(delta, now);
  };
}
