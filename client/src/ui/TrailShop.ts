import { TRAIL_TIERS, formatSpeed, isTrailOwned } from '@robot/shared';
import { Panel } from './Panel.js';

/** One rendered row, kept so a state change is a few writes, not a rebuild. */
interface Row {
  readonly slot: number;
  readonly element: HTMLDivElement;
  readonly button: HTMLButtonElement;
}

/**
 * The trail shop.
 *
 * Ported from the previous game's cosmetic shop. Every row only ever ASKS -
 * the server owns the wallet and the inventory, and this renders whatever
 * comes back. There is no cost or multiplier in any message it sends, only a
 * slot number, so there is nothing in the request to forge.
 *
 * A trail multiplies actual MOVEMENT SPEED, which is why the row says so: it
 * is the one cosmetic in the game with a gameplay effect, and hiding that
 * would make the prices look arbitrary.
 */
export class TrailShop extends Panel {
  private readonly rows: Row[] = [];

  private wins = 0;
  private owned = 0;
  private equipped = 0;

  constructor(
    parent: HTMLElement,
    actions: { buy: (slot: number) => void; equip: (slot: number) => void },
  ) {
    super(parent, 'trail', 'Trails');

    const note = document.createElement('p');
    note.className = 'aoe-panel__note';
    note.textContent = 'Trails multiply your movement speed. Buy with Wins.';
    this.body.appendChild(note);

    for (const tier of TRAIL_TIERS) {
      const element = document.createElement('div');
      element.className = 'aoe-row';

      const swatch = document.createElement('div');
      swatch.className = 'aoe-row__swatch';
      swatch.style.background = `#${tier.color.toString(16).padStart(6, '0')}`;

      const text = document.createElement('div');
      text.className = 'aoe-row__text';
      const name = document.createElement('div');
      name.className = 'aoe-row__name';
      name.textContent = tier.name;
      const meta = document.createElement('div');
      meta.className = 'aoe-row__meta';
      meta.textContent = `x${tier.multiplier} Speed · ${formatSpeed(tier.cost)} Wins`;
      text.append(name, meta);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'aoe-row__buy';
      button.addEventListener('click', () => {
        // Owned means "wear it"; not owned means "buy it". One button, because
        // a shop row with two is a shop row nobody reads.
        if (isTrailOwned(this.owned, tier.slot)) {
          actions.equip(this.equipped === tier.slot ? 0 : tier.slot);
        } else {
          actions.buy(tier.slot);
        }
      });

      element.append(swatch, text, button);
      this.body.appendChild(element);
      this.rows.push({ slot: tier.slot, element, button });
    }

    this.render();
  }

  /** Mirror the replicated wallet and inventory. */
  setInventory(wins: number, owned: number, equipped: number): void {
    if (wins === this.wins && owned === this.owned && equipped === this.equipped) return;
    this.wins = wins;
    this.owned = owned;
    this.equipped = equipped;
    this.render();
  }

  /** True when at least one trail can be afforded right now. */
  get hasAffordable(): boolean {
    return TRAIL_TIERS.some(
      (tier) => !isTrailOwned(this.owned, tier.slot) && this.wins >= tier.cost,
    );
  }

  protected override onOpened(): void {
    this.render();
  }

  private render(): void {
    for (const row of this.rows) {
      const tier = TRAIL_TIERS.find((entry) => entry.slot === row.slot);
      if (!tier) continue;

      const owned = isTrailOwned(this.owned, tier.slot);
      const equipped = this.equipped === tier.slot;

      row.element.classList.toggle('aoe-row--owned', owned && !equipped);
      row.element.classList.toggle('aoe-row--equipped', equipped);

      if (equipped) row.button.textContent = 'WORN';
      else if (owned) row.button.textContent = 'WEAR';
      else row.button.textContent = `${formatSpeed(tier.cost)}`;

      row.button.disabled = !owned && this.wins < tier.cost;
    }
  }
}
