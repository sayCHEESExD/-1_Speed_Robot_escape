import { formatSpeed, resolveLevel, type LevelProgress } from '@robot/shared';

/**
 * How many segments the reactor gauge is divided into.
 *
 * TWENTY, and the number matters: it is enough that a segment lighting up is a
 * frequent small reward on the way to a level, and few enough that a player
 * can count the remaining ones at a glance without reading the figure. A
 * continuous bar gives neither.
 */
const SEGMENTS = 20;

/**
 * THE MECH TELEMETRY BLOCK.
 *
 * Not a progress bar with a number over it - a readout panel bolted to the
 * bottom of the screen, framed like a piece of the machine and laid out the
 * way an instrument is:
 *
 *   ┌─ SPEED ─────────────────────── OUTPUT ─┐
 *   │            1.24K  u/s                  │
 *   ├────────────────────────────────────────┤
 *   │ LV 05 │████████████░░░░░░░░│  31 / 146  │
 *   └────────────────────────────────────────┘
 *
 * Everything it shows is SERVER-AUTHORITATIVE state. It renders the replicated
 * lifetime Speed total and the level that follows from it through the shared
 * formula - it never awards, predicts or derives progress of its own.
 *
 * THE LEVEL IS AN ENERGY GAUGE, deliberately. Levelling in this game is the
 * machine getting more powerful, so the meter is a reactor charge filling in
 * discrete cells rather than a bar sliding along a track: a mech does not have
 * a progress bar, it has a power plant with a readout on it.
 */
export class SpeedHud {
  private readonly root: HTMLDivElement;
  private readonly speedValue: HTMLSpanElement;
  private readonly levelChip: HTMLDivElement;
  private readonly cells: HTMLDivElement[] = [];
  private readonly amountLabel: HTMLDivElement;

  private lastTotal = -1;
  private lastLevel = -1;
  private lastCap = -1;
  private lastFilled = -1;

  constructor(parent: HTMLElement) {
    injectStyles();

    this.root = el('div', 'mech-hud');

    // ---- the readout head -------------------------------------------------
    const head = el('div', 'mech-hud__head');
    const label = el('span', 'mech-hud__label');
    label.textContent = 'DRIVE OUTPUT';
    const readout = el('div', 'mech-hud__readout');
    this.speedValue = el('span', 'mech-hud__value');
    this.speedValue.textContent = '0';
    const unit = el('span', 'mech-hud__unit');
    unit.textContent = 'SPEED';
    readout.append(this.speedValue, unit);
    head.append(label, readout);

    // ---- the reactor gauge ------------------------------------------------
    const gauge = el('div', 'mech-hud__gauge');

    this.levelChip = el('div', 'mech-hud__chip');
    this.levelChip.textContent = 'LV 1 / 50';

    const cells = el('div', 'mech-hud__cells');
    for (let i = 0; i < SEGMENTS; i += 1) {
      const cell = el('div', 'mech-hud__cell');
      cells.appendChild(cell);
      this.cells.push(cell);
    }

    this.amountLabel = el('div', 'mech-hud__amount');
    this.amountLabel.textContent = '0 / 0';

    gauge.append(this.levelChip, cells, this.amountLabel);

    // The corner brackets. Four absolutely-positioned marks that turn a
    // rectangle into an instrument housing, which is most of what makes this
    // read as equipment rather than as a web page.
    for (const corner of ['tl', 'tr', 'bl', 'br']) {
      this.root.appendChild(el('span', `mech-hud__corner mech-hud__corner--${corner}`));
    }

    this.root.append(head, gauge);
    parent.appendChild(this.root);
  }

  /**
   * @param totalSpeed lifetime Speed farmed, replicated from the server
   * @param levelCap   highest reachable level for this player
   */
  update(totalSpeed: number, levelCap: number): void {
    const progress = resolveLevel(totalSpeed, levelCap);

    if (totalSpeed !== this.lastTotal) {
      this.lastTotal = totalSpeed;
      this.speedValue.textContent = formatSpeed(totalSpeed);
      this.renderGauge(progress);
    }

    /*
     * The chip prints the level AND THE CAP, which is the whole reason it is
     * re-rendered when either one moves.
     *
     * The cap is not a constant - it is whatever the next rebirth requires -
     * so "LV 5 / 50" becomes "LV 5 / 75" the moment a rebirth lands, without
     * the level itself having changed. Watching only the level would leave the
     * old ceiling on screen until the next level-up.
     */
    if (progress.level !== this.lastLevel || levelCap !== this.lastCap) {
      const levelled = progress.level !== this.lastLevel;
      this.lastLevel = progress.level;
      this.lastCap = levelCap;
      this.levelChip.textContent = `LV ${progress.level} / ${levelCap}`;
      if (levelled) {
        // A brief surge marks the moment a level - and a permanent power rise -
        // is gained. Restarting the animation needs the reflow in between.
        this.root.classList.remove('mech-hud--surge');
        void this.root.offsetWidth;
        this.root.classList.add('mech-hud--surge');
      }
    }
  }

  dispose(): void {
    this.root.remove();
  }

  /**
   * Light the charged cells and print the figure.
   *
   * The cell count is compared before anything is written: the Speed total
   * changes twenty times a second and the FILL changes about once in fifty of
   * those, so re-classing twenty elements on every patch would be the most
   * expensive thing in the HUD for no visible difference.
   */
  private renderGauge(progress: LevelProgress): void {
    const filled = progress.capped
      ? SEGMENTS
      : Math.min(SEGMENTS, Math.floor(progress.fraction * SEGMENTS));

    if (filled !== this.lastFilled) {
      this.lastFilled = filled;
      for (let i = 0; i < this.cells.length; i += 1) {
        const cell = this.cells[i];
        if (!cell) continue;
        cell.classList.toggle('is-lit', i < filled);
        // The leading cell pulses, so a gauge that is filling never looks
        // like a gauge that has stopped.
        cell.classList.toggle('is-edge', i === filled && filled < SEGMENTS);
      }
    }

    this.amountLabel.textContent = progress.capped
      ? 'MAX'
      : `${formatSpeed(progress.into)} / ${formatSpeed(progress.required)}`;
  }
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  return node;
};

let stylesInjected = false;

/** One stylesheet for the telemetry block, injected on first construction. */
const injectStyles = (): void => {
  if (stylesInjected) return;
  stylesInjected = true;

  const style = document.createElement('style');
  style.textContent = `
:root {
  /* THE HUD PALETTE, and it is the facility's own. One place to change it. */
  --mech-lime: #d8ff3a;
  --mech-cyan: #00e5ff;
  --mech-magenta: #ff2fd0;
  --mech-glass: rgba(6, 12, 20, 0.82);
  --mech-edge: rgba(216, 255, 58, 0.55);
  --mech-grid: rgba(216, 255, 58, 0.14);
  /*
   * A CONDENSED TECHNICAL FACE for every figure in the HUD.
   *
   * Tabular numerals are the point: a Speed readout that reflows as it counts
   * is a readout nobody can watch. Every platform already has one of these, so
   * it costs no bytes - and shipping a font file would be the single largest
   * asset in a build that has almost none.
   */
  --mech-mono: ui-monospace, "SF Mono", "Cascadia Mono", "Consolas",
    "Roboto Mono", monospace;
  --mech-display: "Arial Black", "Arial Bold", Arial, system-ui, sans-serif;
}

.mech-hud {
  position: fixed;
  left: 50%;
  bottom: 2.6vh;
  transform: translateX(-50%);
  width: min(620px, 82vw);
  padding: 9px 16px 11px;
  pointer-events: none;
  user-select: none;
  z-index: 20;

  /*
   * THE HOUSING: dark glass over a faint grid, inside a lime hairline, with
   * the two lower corners cut off.
   *
   * The cut corners are doing the most work of anything here. A rectangle is a
   * web page; a rectangle with its corners chamfered is a panel in a machine,
   * and it costs one clip-path.
   */
  background-color: var(--mech-glass);
  background-image:
    linear-gradient(90deg, var(--mech-grid) 1px, transparent 1px),
    linear-gradient(0deg, var(--mech-grid) 1px, transparent 1px);
  background-size: 22px 22px;
  border: 1px solid var(--mech-edge);
  clip-path: polygon(
    0 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%,
    14px 100%, 0 calc(100% - 14px)
  );
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.6),
    0 10px 28px rgba(0, 0, 0, 0.55),
    inset 0 0 26px rgba(216, 255, 58, 0.06);
}

/* The corner brackets, drawn as two borders each. */
.mech-hud__corner {
  position: absolute;
  width: 13px;
  height: 13px;
  border: 2px solid var(--mech-lime);
}
.mech-hud__corner--tl { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
.mech-hud__corner--tr { top: -1px; right: -1px; border-left: 0; border-bottom: 0; }
.mech-hud__corner--bl { bottom: -1px; left: 12px; border-right: 0; border-top: 0; }
.mech-hud__corner--br { bottom: -1px; right: 12px; border-left: 0; border-top: 0; }

/* ---- the readout head --------------------------------------------------- */
.mech-hud__head {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 12px;
  margin-bottom: 8px;
}
/*
 * The rubric. Small, spaced, and in the facility's lime: it names the
 * instrument the way a real one is labelled - etched into the housing rather
 * than printed next to the number.
 */
.mech-hud__label {
  font-family: var(--mech-mono);
  font-size: clamp(8px, 1vw, 11px);
  letter-spacing: 0.34em;
  color: var(--mech-lime);
  opacity: 0.75;
  white-space: nowrap;
}
.mech-hud__readout {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.mech-hud__value {
  font-family: var(--mech-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  font-size: clamp(26px, 4.2vw, 46px);
  line-height: 1;
  color: #ffffff;
  /* A cyan bloom rather than a black rim: this is a lit display, and a figure
   * with a cartoon outline would belong to a different game. */
  text-shadow:
    0 0 6px rgba(0, 229, 255, 0.85),
    0 0 20px rgba(0, 229, 255, 0.35);
}
.mech-hud__unit {
  font-family: var(--mech-mono);
  font-size: clamp(10px, 1.3vw, 14px);
  letter-spacing: 0.24em;
  color: var(--mech-cyan);
  opacity: 0.85;
}

/* ---- the reactor gauge -------------------------------------------------- */
.mech-hud__gauge {
  display: flex;
  align-items: center;
  gap: 10px;
}
/*
 * The level chip: a hexagonal tag, the way a unit designation is stencilled on
 * a machine.
 */
.mech-hud__chip {
  flex: 0 0 auto;
  padding: 5px 13px;
  font-family: var(--mech-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  font-size: clamp(11px, 1.45vw, 16px);
  letter-spacing: 0.08em;
  color: #06120a;
  background: linear-gradient(180deg, var(--mech-lime), #9fd400);
  clip-path: polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%);
  white-space: nowrap;
}
/*
 * THE CELLS. Twenty of them, in a grid so they share the width exactly
 * however wide the screen is - a flex row with a gap leaves a ragged last cell
 * at some widths, which on an instrument reads as a fault.
 */
.mech-hud__cells {
  flex: 1 1 auto;
  display: grid;
  grid-template-columns: repeat(${SEGMENTS}, 1fr);
  gap: 2px;
  height: clamp(16px, 2.1vw, 24px);
  padding: 2px;
  border: 1px solid rgba(216, 255, 58, 0.28);
  background: rgba(0, 0, 0, 0.45);
}
.mech-hud__cell {
  background: rgba(216, 255, 58, 0.07);
  /* Sheared, so the charge reads as flowing left to right rather than as a row
   * of switches. */
  transform: skewX(-14deg);
  transition: background-color 120ms linear, box-shadow 120ms linear;
}
.mech-hud__cell.is-lit {
  background: var(--mech-lime);
  box-shadow: 0 0 7px rgba(216, 255, 58, 0.75);
}
/* The leading cell breathes, so a gauge that is filling never looks stopped. */
.mech-hud__cell.is-edge {
  background: rgba(216, 255, 58, 0.5);
  animation: mech-pulse 900ms ease-in-out infinite;
}
@keyframes mech-pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}
.mech-hud__amount {
  flex: 0 0 auto;
  min-width: 8.5ch;
  text-align: right;
  font-family: var(--mech-mono);
  font-variant-numeric: tabular-nums;
  font-size: clamp(11px, 1.45vw, 16px);
  color: var(--mech-cyan);
  white-space: nowrap;
}

/* A level-up runs a charge across the whole housing. */
.mech-hud--surge {
  animation: mech-surge 620ms ease-out;
}
@keyframes mech-surge {
  0% { box-shadow: 0 0 0 0 rgba(216, 255, 58, 0.9), 0 10px 28px rgba(0, 0, 0, 0.55); }
  60% { box-shadow: 0 0 0 14px rgba(216, 255, 58, 0), 0 10px 28px rgba(0, 0, 0, 0.55); }
  100% { box-shadow: 0 0 0 0 rgba(216, 255, 58, 0), 0 10px 28px rgba(0, 0, 0, 0.55); }
}

/*
 * Touch controls own the bottom corners, so the block lifts clear of them.
 *
 * The stack from the bottom of a phone screen up is: thumb controls, this, and
 * then the Speed-gain popups' band well above. Each offset here is what leaves
 * the next one room.
 */
body.aoe-touch-mode .mech-hud {
  bottom: calc(2.6vh + 128px);
  width: min(540px, 88vw);
}

@media (prefers-reduced-motion: reduce) {
  .mech-hud__cell,
  .mech-hud__cell.is-edge,
  .mech-hud--surge { transition: none; animation: none; }
}
`;
  document.head.appendChild(style);
};
