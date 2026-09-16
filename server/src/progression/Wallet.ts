import { MAX_WINS } from '@robot/shared';
import type { PlayerState } from '../rooms/state/PlayerState.js';

/**
 * The ONE place Wins are added or removed.
 *
 * There are two things that want to move a player's Wins - finishing a stage
 * and claiming an robot - and they must not become two ways to take payment.
 * A second deduction path is exactly how a wallet ends up disagreeing with an
 * inventory, so both go through here.
 *
 * `wins` is a `uint32` on the wire, so every addition SATURATES at MAX_WINS
 * rather than wrapping: a player who banks a huge reward must not find their
 * wallet has reset.
 */
export const wallet = {
  /** Credit Wins, saturating at the replication ceiling. */
  add(player: PlayerState, amount: number): number {
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    const before = player.wins;
    player.wins = Math.min(MAX_WINS, Math.floor(before + amount));
    return player.wins - before;
  },

  /** True when the player can afford `cost`. */
  canAfford(player: PlayerState, cost: number): boolean {
    if (!Number.isFinite(cost) || cost < 0) return false;
    return player.wins >= Math.floor(cost);
  },

  /**
   * Deduct Wins.
   *
   * @returns false and changes nothing when the player cannot afford it, so a
   *          caller can never half-complete a purchase.
   */
  spend(player: PlayerState, cost: number): boolean {
    const price = Math.floor(Number.isFinite(cost) ? Math.max(0, cost) : 0);
    if (player.wins < price) return false;
    player.wins -= price;
    return true;
  },
};
