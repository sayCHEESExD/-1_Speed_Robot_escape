import { canRebirth, maxLevelForRebirth, nextRebirthTier, rebirthMultiplier } from '@robot/shared';
import type { PlayerState } from '../rooms/state/PlayerState.js';
import type { SpeedService } from './SpeedService.js';

/** Outcome of a rebirth attempt. */
export type RebirthResult =
  | { readonly ok: true; readonly rebirths: number; readonly multiplier: number }
  | { readonly ok: false; readonly reason: 'not-eligible' };

/**
 * Server authority over rebirths.
 *
 * Ported from the previous game's rebirth service and behaviourally identical.
 * A rebirth trades the current level curve for a permanently higher ceiling and
 * a bigger Speed multiplier. What it must NOT touch is anything the player
 * earned OUTSIDE that curve: Wins, owned robots and owned trails are
 * permanent unlocks and survive untouched.
 *
 * The client sends an empty message. Eligibility is decided here from the
 * server's own level and rebirth count, so there is nothing in the request that
 * could be wrong and nothing to validate.
 */
export class RebirthService {
  /**
   * Refresh the cap that follows from the rebirth count.
   *
   * Deliberately does NOT write `moveMultiplier`. Movement speed has exactly
   * one evaluator - `SpeedService` - because it is the only place that knows
   * every modifier feeding the shared formula. This class computing its own
   * would silently drop the equipped trail.
   */
  sync(player: PlayerState): void {
    player.maxLevel = maxLevelForRebirth(player.rebirths);
  }

  /** True once the player has reached their current max level. */
  isEligible(player: PlayerState): boolean {
    return canRebirth(player.level, player.rebirths);
  }

  /** The level the next rebirth needs, for the HUD's locked state. */
  requiredLevel(player: PlayerState): number {
    return nextRebirthTier(player.rebirths).requiredLevel;
  }

  /**
   * Perform a rebirth.
   *
   * Resets the level curve and everything derived from it, raises the cap and
   * the multiplier, and deliberately leaves Wins, robots and trails alone.
   */
  rebirth(player: PlayerState, speeds: SpeedService): RebirthResult {
    if (!this.isEligible(player)) return { ok: false, reason: 'not-eligible' };

    player.rebirths += 1;
    // Level FOLLOWS from lifetime Speed, so clearing the Speed total is what
    // actually returns the player to level 1. Setting the level alone would be
    // undone by the next credit.
    player.totalSpeed = 0;
    player.level = 1;

    this.sync(player);
    // Movement speed, jump velocity and the cap all re-derive through the one
    // formula rather than being written here.
    speeds.syncDerived(player);

    return {
      ok: true,
      rebirths: player.rebirths,
      multiplier: rebirthMultiplier(player.rebirths),
    };
  }
}
