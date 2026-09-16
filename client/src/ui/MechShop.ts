import {
  ROBOTS,
  formatSpeed,
  hasStand,
  ownsRobot,
} from '@robot/shared';
import { Panel } from './Panel.js';

/** One rendered row, kept so a state change is a few writes, not a rebuild. */
interface Row {
  readonly slot: number;
  readonly element: HTMLDivElement;
  readonly button: HTMLButtonElement;
}

/**
 * The mech shop.
 *
 * The display deck in the hangar is the PRIMARY shop and this is the complete
 * one. It exists for two reasons, in this order:
 *
 *  1. The deck is two storeys of FIVE, which is ten plinths for twelve robots.
 *     Slots 11 and 12 have nowhere to stand, and a third storey or a crowded
 *     row would have broken the layout the game is meant to look like. This is
 *     the route to them.
 *  2. A player wants to see the whole ladder - what is next, what it costs and
 *     how far off it is - without walking the deck twice. A shop that can only
 *     be read by standing in front of each item is a shop with no catalogue.
 *
 * It is the same PURCHASE either way: the row sends a slot number and nothing
 * else, and `RobotService` applies the identical Wins check it applies to a
 * player standing on a plinth. There is no cost in any message this sends, so
 * there is nothing in the request to forge - and buying is still a deliberate
 * act, because somebody had to press the button.
 *
 * The equipped frame is NOT chosen here and there is no "wear" button: the
 * server always equips the best robot owned, which is what makes a purchase
 * incapable of being a downgrade. A row therefore says either BUY or OWNED.
 */
export class MechShop extends Panel {
  private readonly rows: Row[] = [];

  private wins = 0;
  private owned = 0;
  private equipped = 0;

  constructor(parent: HTMLElement, actions: { buy: (slot: number) => void }) {
    super(parent, 'mech', 'Mechs');

    const note = document.createElement('p');
    note.className = 'aoe-panel__note';
    note.textContent =
      'Speed is earned by walking forward. A better mech earns more of it per ' +
      'second on the move. You always ride the best one you own.';
    this.body.appendChild(note);

    for (const robot of ROBOTS) {
      const element = document.createElement('div');
      element.className = 'aoe-row';

      const swatch = document.createElement('div');
      swatch.className = 'aoe-row__swatch';
      // The frame's own armour over its own neon, so a row is recognisable as
      // the thing standing on the deck rather than as a coloured square.
      swatch.style.background = `linear-gradient(135deg, ${css(robot.palette.armor)} 55%, ${css(
        robot.palette.glow,
      )} 55%)`;

      const text = document.createElement('div');
      text.className = 'aoe-row__text';
      const name = document.createElement('div');
      name.className = 'aoe-row__name';
      name.textContent = robot.name;
      const meta = document.createElement('div');
      meta.className = 'aoe-row__meta';
      // The two numbers a mech is sold on, plus where to find it. The last
      // part matters: a player who reads "Bay 3" knows to go and look, and a
      // player who reads "Prototype" knows not to go looking for a plinth that
      // does not exist.
      meta.textContent =
        `+${formatSpeed(robot.speedPerSecond)} Speed/s · ` +
        `${robot.winsRequired === 0 ? 'Free' : `${formatSpeed(robot.winsRequired)} Wins`} · ` +
        `${hasStand(robot.slot) ? `Bay ${robot.slot}` : 'Prototype'}`;
      text.append(name, meta);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'aoe-row__buy';
      button.addEventListener('click', () => {
        if (ownsRobot(this.owned, robot.slot)) return;
        actions.buy(robot.slot);
      });

      element.append(swatch, text, button);
      this.body.appendChild(element);
      this.rows.push({ slot: robot.slot, element, button });
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

  /** True when at least one mech can be afforded right now. */
  get hasAffordable(): boolean {
    return ROBOTS.some(
      (robot) => !ownsRobot(this.owned, robot.slot) && this.wins >= robot.winsRequired,
    );
  }

  protected override onOpened(): void {
    this.render();
  }

  private render(): void {
    for (const row of this.rows) {
      const robot = ROBOTS.find((entry) => entry.slot === row.slot);
      if (!robot) continue;

      const owned = ownsRobot(this.owned, robot.slot);
      const equipped = this.equipped === robot.slot;

      row.element.classList.toggle('aoe-row--owned', owned && !equipped);
      row.element.classList.toggle('aoe-row--equipped', equipped);

      if (equipped) row.button.textContent = 'RIDING';
      else if (owned) row.button.textContent = 'OWNED';
      else row.button.textContent = formatSpeed(robot.winsRequired);

      row.button.disabled = owned || this.wins < robot.winsRequired;
    }
  }
}

/** A palette entry as a CSS colour. */
const css = (value: number): string => `#${value.toString(16).padStart(6, '0')}`;
