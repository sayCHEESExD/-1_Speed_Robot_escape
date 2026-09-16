import { formatSpeed } from '@robot/shared';
import { ICONS, injectHudStyles } from './hudStyles.js';

/**
 * The Wins total, upper centre.
 *
 * A trophy and a number, exactly as the reference art frames it. The figure is
 * replicated server state - Wins are granted by `StageService` and by nothing
 * else - so this only ever renders what it is told.
 *
 * It pops when the total RISES. Wins only ever go up through an award, so an
 * increase is the one honest signal that something was earned; a patch that
 * merely repeats the same total changes nothing, which is what stops the
 * effect firing twice for one stage.
 */
export class WinsCounter {
  private readonly root: HTMLDivElement;
  private readonly value: HTMLDivElement;

  private last = -1;
  private popTimer = 0;

  constructor(parent: HTMLElement) {
    injectHudStyles();

    this.root = document.createElement('div');
    this.root.className = 'aoe-wins aoe-font';

    const icon = document.createElement('div');
    icon.className = 'aoe-wins__icon';
    icon.innerHTML = ICONS.trophy;

    this.value = document.createElement('div');
    this.value.className = 'aoe-wins__value';
    this.value.textContent = '0';

    this.root.append(icon, this.value);
    parent.appendChild(this.root);
  }

  /** @param wins the replicated total. */
  update(wins: number): void {
    if (wins === this.last) return;
    const rose = wins > this.last && this.last >= 0;
    this.last = wins;
    this.value.textContent = formatSpeed(wins);

    if (!rose) return;
    // Restarting the animation needs the class off, a reflow, then on.
    this.root.classList.remove('aoe-wins--pop');
    void this.root.offsetWidth;
    this.root.classList.add('aoe-wins--pop');
    window.clearTimeout(this.popTimer);
    this.popTimer = window.setTimeout(
      () => this.root.classList.remove('aoe-wins--pop'),
      560,
    );
  }

  dispose(): void {
    window.clearTimeout(this.popTimer);
    this.root.remove();
  }
}
