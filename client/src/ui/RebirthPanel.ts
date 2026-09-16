import {
  maxLevelForRebirth,
  nextRebirthTier,
  rebirthMultiplier,
} from '@robot/shared';
import { ICONS } from './hudStyles.js';
import { Panel } from './Panel.js';

/**
 * The rebirth confirmation.
 *
 * Laid out as a BEFORE and AFTER pair, exactly as the reference art frames it:
 * the two things a rebirth changes shown side by side with an arrow between
 * them, so what is being traded is legible at a glance rather than buried in a
 * paragraph. Speed on the blue row, the level ceiling on the pink one. It is
 * the one irreversible button in the game, and the cost - the level reset - is
 * stated in red under the swap rather than left to be inferred.
 *
 * There is ONE button and it is the rebirth. A "skip" beside it would be a
 * second control that does nothing a closed panel does not already do, on the
 * one screen where the player is being asked to think about an irreversible
 * choice.
 *
 * The button only ever ASKS. Eligibility is decided by the server from its own
 * level and rebirth count, and this panel's enabled state is a mirror of the
 * replicated figures rather than a second opinion about them.
 */
export class RebirthPanel extends Panel {
  private readonly beforeSpeed: HTMLSpanElement;
  private readonly afterSpeed: HTMLSpanElement;
  private readonly beforeLevel: HTMLSpanElement;
  private readonly afterLevel: HTMLSpanElement;
  private readonly barFill: HTMLDivElement;
  private readonly barLabel: HTMLSpanElement;
  private readonly action: HTMLButtonElement;

  private level = 1;
  private rebirths = 0;

  constructor(parent: HTMLElement, onRebirth: () => void) {
    super(parent, 'rebirth', 'Rebirth!', ICONS.rebirth);

    const grid = document.createElement('div');
    grid.className = 'aoe-rb';

    /*
     * Two rows, each a card, an arrow and a card. Built once and only ever
     * re-labelled, so a redraw never touches the layout.
     *
     * There are no "Before" and "After" column headings: each card already
     * names its own figure - "Speed: x1.0" - and the arrow between them says
     * which way it is going. Headings would be a third thing to read for
     * something the row has already said twice.
     */
    const speedRow = this.row(grid, 'speed');
    const levelRow = this.row(grid, 'level');
    this.beforeSpeed = speedRow[0];
    this.afterSpeed = speedRow[1];
    this.beforeLevel = levelRow[0];
    this.afterLevel = levelRow[1];

    const warning = document.createElement('p');
    warning.className = 'aoe-rb__warn aoe-font';
    warning.textContent = 'Rebirth resets your levels!';

    const bar = document.createElement('div');
    bar.className = 'aoe-rb__bar';
    this.barFill = document.createElement('div');
    this.barFill.className = 'aoe-rb__fill';
    this.barLabel = document.createElement('span');
    this.barLabel.className = 'aoe-rb__barlabel aoe-font';
    bar.append(this.barFill, this.barLabel);

    this.action = document.createElement('button');
    this.action.type = 'button';
    this.action.className = 'aoe-action aoe-rb__go aoe-font';
    this.action.textContent = 'Rebirth';
    this.action.addEventListener('click', () => {
      if (this.action.disabled) return;
      onRebirth();
      this.setOpen(false);
    });

    this.body.append(grid, warning, bar, this.action);
    this.render();
  }

  /** Mirror the replicated progression. */
  setProgress(level: number, rebirths: number): void {
    if (level === this.level && rebirths === this.rebirths) return;
    this.level = level;
    this.rebirths = rebirths;
    this.render();
  }

  /** True when the server would accept a rebirth right now. */
  get isEligible(): boolean {
    return this.level >= nextRebirthTier(this.rebirths).requiredLevel;
  }

  protected override onOpened(): void {
    this.render();
  }

  /**
   * One before / arrow / after row, appended to the three-column grid.
   *
   * Returns the two value spans, which are the only parts a redraw touches.
   */
  private row(grid: HTMLDivElement, variant: string): [HTMLSpanElement, HTMLSpanElement] {
    const card = (): HTMLSpanElement => {
      const box = document.createElement('div');
      box.className = `aoe-rb__card aoe-rb__card--${variant}`;
      const value = document.createElement('span');
      value.className = 'aoe-font';
      box.appendChild(value);
      grid.appendChild(box);
      return value;
    };

    const before = card();

    const arrow = document.createElement('span');
    arrow.className = 'aoe-rb__arrow';
    arrow.setAttribute('aria-hidden', 'true');
    grid.appendChild(arrow);

    return [before, card()];
  }

  private render(): void {
    const tier = nextRebirthTier(this.rebirths);
    const eligible = this.isEligible;
    const cap = maxLevelForRebirth(this.rebirths);

    /*
     * ONE decimal on every multiplier, always.
     *
     * The ladder steps by halves - x1, x1.5, x2, x2.5 - so a bare `x1` beside
     * an `x1.5` reads as two different KINDS of number and the comparison the
     * whole panel exists for stops being instant. `toFixed(1)` makes both
     * sides the same shape, which is what the art shows.
     */
    this.beforeSpeed.textContent = `Speed: x${rebirthMultiplier(this.rebirths).toFixed(1)}`;
    this.afterSpeed.textContent = `Speed: x${tier.multiplier.toFixed(1)}`;
    this.beforeLevel.textContent = `Max Level: ${cap}`;
    this.afterLevel.textContent = `Max Level: ${maxLevelForRebirth(this.rebirths + 1)}`;

    const shown = Math.min(this.level, cap);
    this.barFill.style.width = `${Math.min(Math.max(shown / cap, 0), 1) * 100}%`;
    this.barLabel.textContent = `${shown} / ${cap}`;

    this.action.disabled = !eligible;
    this.action.textContent = eligible ? 'Rebirth' : `Level ${tier.requiredLevel} required`;
  }
}
