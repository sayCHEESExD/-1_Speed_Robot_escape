import { formatSpeed } from '@robot/shared';
import { injectHudStyles } from './hudStyles.js';

/**
 * Most popups on screen at once.
 *
 * A hard ceiling rather than a hope. Speed arrives on every state patch - the
 * server sends twenty a second - and a system that made one node per patch
 * would put hundreds of elements in the document inside a minute. The pool is
 * allocated once at construction and reused for ever; a spawn that finds
 * nothing free retires the oldest instead of growing.
 */
const POOL_SIZE = 14;

/** Seconds one popup stays on screen. Must match the CSS animation. */
const LIFETIME = 1.15;

/**
 * The floating "+N" a player sees when they earn Speed.
 *
 * Fed by an ACCUMULATOR rather than by raw patches: Speed rises continuously
 * while riding, so a popup per increment would be an unreadable stream. The
 * gain is banked and released on a fixed cadence, which means a slow trickle
 * reads as "+2" and a treadmill sprint reads as "+200" without either case
 * being special-cased.
 *
 * Every position is randomised inside a band that deliberately avoids the
 * three things already on screen - the Wins counter at the top, the rail down
 * the left and the Speed/Level bar along the bottom - so a popup can never
 * cover the HUD at any window shape.
 */
export class SpeedPopups {
  private readonly root: HTMLDivElement;
  private readonly pool: HTMLDivElement[] = [];

  /** Indices of nodes currently free, used as a stack. */
  private readonly free: number[] = [];
  /** Nodes in flight, oldest first, so the pool can always make room. */
  private readonly live: { index: number; timer: number }[] = [];

  /** Speed earned since the last popup was released. */
  private pending = 0;
  /** Seconds until the next release. */
  private cooldown = 0;

  /** Last replicated total, so only a real INCREASE counts. */
  private lastTotal = -1;

  /**
   * Where the last few popups went, in percent.
   *
   * Purely so a new one can be nudged off the last one. Two popups landing on
   * exactly the same spot is the one way a random placement reads as a bug
   * rather than as variety.
   */
  private readonly recent: { x: number; y: number }[] = [];

  constructor(parent: HTMLElement) {
    injectHudStyles();

    this.root = document.createElement('div');
    this.root.className = 'aoe-pops';
    parent.appendChild(this.root);

    for (let i = 0; i < POOL_SIZE; i += 1) {
      const node = document.createElement('div');
      node.className = 'aoe-pop aoe-font';
      node.innerHTML =
        /*
         * THE SPEED ICON, and the asset set supplies one: `shoe.png`.
         *
         * A popup here is a Speed gain and nothing else, so it wears the Speed
         * icon. Trophy would have said "you won a stage" and trail would have
         * said "you are wearing something" - both are different events with
         * their own effects already, and borrowing either would have made
         * three unrelated things look alike.
         */
        '<img class="aoe-pop__icon" src="/ui/shoe.png" alt="" draggable="false">' +
        '<span class="aoe-pop__value"></span>';
      node.hidden = true;
      this.root.appendChild(node);
      this.pool.push(node);
      this.free.push(i);
    }
  }

  /**
   * Note the player's replicated Speed total.
   *
   * Only an INCREASE spawns anything. The total is on every patch whether or
   * not it changed, so comparing against the last one is what separates "the
   * player earned something" from "the server described them again". The first
   * reading only establishes the baseline - joining a session with a restored
   * profile must not fire a popup for a lifetime of Speed.
   */
  observe(totalSpeed: number): void {
    if (!Number.isFinite(totalSpeed)) return;
    if (this.lastTotal < 0) {
      this.lastTotal = totalSpeed;
      return;
    }
    if (totalSpeed > this.lastTotal) this.pending += totalSpeed - this.lastTotal;
    this.lastTotal = totalSpeed;
  }

  /** Reset the baseline, e.g. after a rebirth drops the total to zero. */
  resetBaseline(): void {
    this.lastTotal = -1;
    this.pending = 0;
  }

  update(delta: number): void {
    this.cooldown -= Math.max(0, delta);
    if (this.cooldown > 0) return;

    // A fixed cadence, so the rate is bounded no matter how fast Speed comes
    // in. Whatever accumulated since the last one is shown as a single figure.
    this.cooldown = 0.26;
    if (this.pending < 1) return;

    const amount = Math.floor(this.pending);
    this.pending -= amount;
    this.spawn(amount);
  }

  dispose(): void {
    for (const entry of this.live) window.clearTimeout(entry.timer);
    this.live.length = 0;
    this.root.remove();
  }

  private spawn(amount: number): void {
    // Nothing free: retire the oldest rather than allocate. The ceiling is the
    // point of the pool.
    if (this.free.length === 0) {
      const oldest = this.live.shift();
      if (!oldest) return;
      window.clearTimeout(oldest.timer);
      this.release(oldest.index);
    }

    const index = this.free.pop();
    if (index === undefined) return;
    const node = this.pool[index];
    if (!node) return;

    const value = node.querySelector('.aoe-pop__value');
    if (value) value.textContent = `+${formatSpeed(amount)}`;

    // A random spot inside the band that misses every HUD element. Expressed
    // in percentages, so it holds at any aspect ratio.
    //
    // Re-rolled a few times if it lands on top of a popup that is still on
    // screen: perfectly overlapping figures are unreadable, and are the one
    // way a random placement reads as a bug rather than as variety.
    let x = 0;
    let y = 0;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      x = 26 + Math.random() * 56;
      y = 26 + Math.random() * 34;
      const clash = this.recent.some(
        (at) => Math.abs(at.x - x) < 11 && Math.abs(at.y - y) < 9,
      );
      if (!clash) break;
    }
    this.recent.push({ x, y });
    if (this.recent.length > 5) this.recent.shift();

    node.style.left = `${x}%`;
    node.style.top = `${y}%`;
    // A little rotation and scale variety, so two popups never look stamped.
    node.style.setProperty('--aoe-pop-tilt', `${(Math.random() * 2 - 1) * 7}deg`);
    node.style.setProperty('--aoe-pop-scale', `${0.88 + Math.random() * 0.28}`);

    node.hidden = false;
    // Restart the animation: removing the class, forcing a reflow and adding
    // it back is the only reliable way to replay a CSS animation on a reused
    // node.
    node.classList.remove('aoe-pop--run');
    void node.offsetWidth;
    node.classList.add('aoe-pop--run');

    const timer = window.setTimeout(() => {
      const at = this.live.findIndex((entry) => entry.index === index);
      if (at >= 0) this.live.splice(at, 1);
      this.release(index);
    }, LIFETIME * 1000);

    this.live.push({ index, timer });
  }

  private release(index: number): void {
    const node = this.pool[index];
    if (!node) return;
    node.hidden = true;
    node.classList.remove('aoe-pop--run');
    this.free.push(index);
  }
}
