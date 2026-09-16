import { injectHudStyles } from './hudStyles.js';

/** Trophies sent per award. Enough to read as a handful, few enough to follow. */
const COUNT = 7;

/** Seconds one trophy spends in the air. Must match the CSS animation. */
const FLIGHT = 0.62;

/** Seconds between one trophy leaving and the next. */
const STAGGER = 0.055;

/**
 * Trophies flying from the player to the Wins counter.
 *
 * The one job: make an award feel like it went somewhere. A number that simply
 * changes is a number nobody notices, and this stage was the whole run.
 *
 * Screen-space and CSS-driven, so it costs the renderer nothing: the mount's
 * position is projected to the screen ONCE when the award lands, and every
 * trophy is then an absolutely-positioned image animating between two fixed
 * points. Nothing here runs per frame and nothing here touches the scene.
 *
 * The pool is fixed and reused, for the same reason the Speed popups' is: an
 * effect that allocated per award would leave a growing pile of dead nodes in
 * the document over a long session.
 */
export class WinFlight {
  private readonly root: HTMLDivElement;
  private readonly pool: HTMLImageElement[] = [];
  private readonly timers: number[] = [];

  /** Next node to use. Wraps, so a burst reuses the oldest first. */
  private cursor = 0;

  constructor(parent: HTMLElement) {
    injectHudStyles();

    this.root = document.createElement('div');
    this.root.className = 'aoe-flight';
    parent.appendChild(this.root);

    for (let i = 0; i < COUNT; i += 1) {
      const node = document.createElement('img');
      node.className = 'aoe-flight__cup';
      node.src = '/ui/trophy.png';
      node.alt = '';
      node.draggable = false;
      node.hidden = true;
      this.root.appendChild(node);
      this.pool.push(node);
    }
  }

  /**
   * Send a handful of trophies from a screen point to the Wins counter.
   *
   * @param fromX where the mount is, in CSS pixels
   * @param fromY the same
   */
  play(fromX: number, fromY: number): void {
    const target = document.querySelector('.aoe-wins__icon');
    if (!target) return;
    const box = target.getBoundingClientRect();
    const toX = box.left + box.width / 2;
    const toY = box.top + box.height / 2;

    for (let i = 0; i < COUNT; i += 1) {
      const node = this.pool[this.cursor];
      this.cursor = (this.cursor + 1) % this.pool.length;
      if (!node) continue;

      // Scattered around the mount rather than stacked on it, so seven
      // trophies read as a handful instead of as one thick one.
      const angle = (i / COUNT) * Math.PI * 2 + Math.random() * 0.6;
      const spread = 26 + Math.random() * 34;
      const startX = fromX + Math.cos(angle) * spread;
      const startY = fromY + Math.sin(angle) * spread * 0.6;

      node.style.setProperty('--aoe-fx', `${startX}px`);
      node.style.setProperty('--aoe-fy', `${startY}px`);
      node.style.setProperty('--aoe-tx', `${toX}px`);
      node.style.setProperty('--aoe-ty', `${toY}px`);
      // An arc rather than a straight line: the trophies lift before they
      // travel, which is what stops seven of them looking like one slide.
      node.style.setProperty('--aoe-mx', `${(startX + toX) / 2}px`);
      node.style.setProperty('--aoe-my', `${Math.min(startY, toY) - 70 - Math.random() * 50}px`);
      node.style.animationDelay = `${i * STAGGER}s`;

      node.hidden = false;
      node.classList.remove('aoe-flight__cup--run');
      // Removing the class, forcing a reflow and adding it back is the only
      // reliable way to replay a CSS animation on a reused node.
      void node.offsetWidth;
      node.classList.add('aoe-flight__cup--run');

      const index = this.cursor;
      window.clearTimeout(this.timers[index] ?? 0);
      this.timers[index] = window.setTimeout(
        () => {
          node.hidden = true;
          node.classList.remove('aoe-flight__cup--run');
        },
        (FLIGHT + i * STAGGER) * 1000 + 60,
      );
    }
  }

  dispose(): void {
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.length = 0;
    this.root.remove();
  }
}
