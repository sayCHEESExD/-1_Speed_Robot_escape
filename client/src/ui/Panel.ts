import { injectHudStyles } from './hudStyles.js';

/**
 * How many panels are open.
 *
 * The input layer polls this to suppress movement while a panel owns the
 * screen. A COUNT rather than a boolean, so two panels closing in the wrong
 * order cannot leave the game permanently suppressed.
 */
let openCount = 0;

export const anyPanelOpen = (): boolean => openCount > 0;

/**
 * A modal panel: a titled box over a dimmed backdrop.
 *
 * Shared by the rebirth confirmation and the trail shop, so the two cannot
 * drift apart visually and the open/close accounting exists once.
 */
export class Panel {
  protected readonly root: HTMLDivElement;
  protected readonly body: HTMLDivElement;

  private open = false;

  /**
   * @param iconHtml optional markup for a mark to the LEFT of the title.
   *
   * Markup rather than a URL because the rail tiles already hold their icons
   * that way - some are supplied images and some are inline SVG, and a panel
   * that took a path could only ever show one of the two kinds.
   */
  constructor(parent: HTMLElement, variant: string, title: string, iconHtml?: string) {
    injectHudStyles();

    this.root = document.createElement('div');
    this.root.className = `aoe-panel aoe-panel--${variant}`;
    this.root.hidden = true;

    const box = document.createElement('div');
    box.className = 'aoe-panel__box';

    const head = document.createElement('div');
    head.className = 'aoe-panel__head aoe-font';
    const heading = document.createElement('span');
    heading.className = 'aoe-panel__title';
    heading.textContent = title;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'aoe-panel__close aoe-font';
    close.textContent = '✕';
    close.addEventListener('click', () => this.setOpen(false));

    if (iconHtml) {
      const mark = document.createElement('span');
      mark.className = 'aoe-panel__mark';
      mark.innerHTML = iconHtml;
      head.append(mark);
    }
    head.append(heading, close);

    this.body = document.createElement('div');
    this.body.className = 'aoe-panel__body';

    box.append(head, this.body);
    this.root.appendChild(box);

    // Clicking the dimmed backdrop closes; clicking the box itself must not.
    this.root.addEventListener('click', (event) => {
      if (event.target === this.root) this.setOpen(false);
    });
    box.addEventListener('click', (event) => event.stopPropagation());

    parent.appendChild(this.root);
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    this.root.hidden = !open;
    openCount += open ? 1 : -1;
    if (openCount < 0) openCount = 0;
    if (open) this.onOpened();
  }

  /** Hook for a subclass that needs to refresh its contents when shown. */
  protected onOpened(): void {
    /* nothing by default */
  }

  dispose(): void {
    if (this.open) this.setOpen(false);
    this.root.remove();
  }
}
