import { TRAIL_TIERS, isTrailOwned, trailBySlot, trailMask, type TrailTier } from '@robot/shared';
import type { PlayerState } from '../rooms/state/PlayerState.js';
import type { SpeedService } from './SpeedService.js';
import { wallet } from './Wallet.js';

/**
 * Minimum time between two successful purchases by one player.
 *
 * The already-owned check stops one item being paid for twice; this stops a
 * burst of requests draining the wallet across several items faster than a
 * person could click. Checked LAST, so a deterministic refusal is never
 * reported as a cooldown.
 */
const PURCHASE_COOLDOWN_MS = 350;

export type BuyTrailResult =
  | { readonly ok: true; readonly tier: TrailTier; readonly winsAfter: number }
  | {
      readonly ok: false;
      readonly reason: 'unknown-slot' | 'already-owned' | 'too-poor' | 'cooldown';
    };

export type EquipTrailResult =
  | { readonly ok: true; readonly slot: number }
  | { readonly ok: false; readonly reason: 'unknown-slot' | 'not-owned' };

/**
 * Server authority over the trail shop.
 *
 * Ported from the previous game's cosmetic service. Everything a client might
 * want to assert is checked against server state: the slot must exist, it must
 * not already be owned, the Wins must be there, and equipping is refused
 * outright for anything the player does not own.
 *
 * The client sends a slot number and NOTHING else - never a cost, never a
 * multiplier - so there is no figure in the message to forge. What a trail
 * multiplies is decided by the shared config and applied by the one movement
 * formula; this only decides what is owned and what is worn.
 */
export class TrailService {
  private readonly lastPurchaseAt = new Map<string, number>();

  initialise(player: PlayerState): void {
    this.lastPurchaseAt.delete(player.sessionId);
    this.sanitise(player);
  }

  forget(sessionId: string): void {
    this.lastPurchaseAt.delete(sessionId);
  }

  /** Validate and, if valid, sell a trail. */
  buy(player: PlayerState, slot: unknown, speeds: SpeedService): BuyTrailResult {
    const tier = this.tierOf(slot);
    if (!tier) return { ok: false, reason: 'unknown-slot' };

    if (isTrailOwned(player.ownedTrails, tier.slot)) {
      return { ok: false, reason: 'already-owned' };
    }
    if (!wallet.canAfford(player, tier.cost)) return { ok: false, reason: 'too-poor' };

    const now = Date.now();
    if (now - (this.lastPurchaseAt.get(player.sessionId) ?? 0) < PURCHASE_COOLDOWN_MS) {
      return { ok: false, reason: 'cooldown' };
    }

    // Payment, grant and equip together. Nothing between them can fail, so the
    // wallet and the inventory cannot end up disagreeing.
    if (!wallet.spend(player, tier.cost)) return { ok: false, reason: 'too-poor' };
    this.lastPurchaseAt.set(player.sessionId, now);
    player.ownedTrails |= trailMask(tier.slot);
    // A fresh purchase equips itself: the player asked for it, and it saves a
    // second round trip for the common case.
    player.trailSlot = tier.slot;
    speeds.syncDerived(player);

    return { ok: true, tier, winsAfter: player.wins };
  }

  /** Equip an owned trail, or slot 0 to take it off. */
  equip(player: PlayerState, slot: unknown, speeds: SpeedService): EquipTrailResult {
    if (typeof slot !== 'number' || !Number.isInteger(slot)) {
      return { ok: false, reason: 'unknown-slot' };
    }
    if (slot === 0) {
      player.trailSlot = 0;
      speeds.syncDerived(player);
      return { ok: true, slot: 0 };
    }

    const tier = this.tierOf(slot);
    if (!tier) return { ok: false, reason: 'unknown-slot' };
    if (!isTrailOwned(player.ownedTrails, tier.slot)) {
      return { ok: false, reason: 'not-owned' };
    }

    player.trailSlot = tier.slot;
    speeds.syncDerived(player);
    return { ok: true, slot: tier.slot };
  }

  /**
   * Drop an equipped trail the player turns out not to own.
   *
   * Belt and braces for a restored profile: `trailMultiplier` already returns
   * 1 for an unowned slot, so this only keeps the replicated state tidy rather
   * than guarding a payout.
   */
  sanitise(player: PlayerState): void {
    if (player.trailSlot === 0) return;
    if (!isTrailOwned(player.ownedTrails, player.trailSlot)) player.trailSlot = 0;
  }

  private tierOf(slot: unknown): TrailTier | undefined {
    if (typeof slot !== 'number' || !Number.isInteger(slot)) return undefined;
    return trailBySlot(slot) ?? TRAIL_TIERS.find((tier) => tier.slot === slot);
  }
}
