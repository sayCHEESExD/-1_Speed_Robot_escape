import type { GrantRecord } from '../persistence/index.js';
import { logger } from '../util/logger.js';
import { profileStore } from './ProfileStore.js';

const SCOPE = 'bux';

/**
 * What a SKU is worth, in Wins.
 *
 * The PRICE is not here and must never be: Bloxity charges the Bux from its
 * own catalogue, keyed by the game slug, and this server is only ever told
 * which SKU was bought. What this table decides is the other half - what the
 * game hands over - and that half belongs to the game.
 *
 * An unknown SKU grants nothing and is logged. The webhook still answers 2xx:
 * refusing it would have Bloxity refund a purchase that was genuinely made,
 * and a SKU this build has not heard of is far more likely to be a catalogue
 * that moved ahead of a deploy than an attack.
 */
const SKU_WINS: Readonly<Record<string, number>> = {
  wins_small: 250,
  wins_large: 1500,
};

/** SKUs that grant something other than Wins, so they are not "unknown". */
const KNOWN_NON_WINS = new Set(['speed_boost_1h']);

/**
 * Purchases that have been paid for and not yet handed over - DURABLY, in the
 * same store as the profiles, and shared by every pod.
 *
 * It used to be two in-memory collections. That lost every unclaimed purchase
 * on a restart, a deploy or an idle scale-to-zero, and it could not work across
 * pods at all: Bloxity load-balances webhooks over the game's live pods, so a
 * purchase routinely arrives on a pod the buyer is not connected to.
 *
 * The lifecycle of one purchase, and why it is paid EXACTLY ONCE:
 *
 *  1. RECORD - the webhook stores it under its transaction id, which is
 *     unique, so a retried webhook is recognised and not paid twice. Only once
 *     it is durable does the webhook answer 2xx.
 *  2. CLAIM - the buyer's session atomically takes it on a short lease. Two
 *     pods can never hold the same grant at once.
 *  3. APPLY - Wins go on through the wallet, and the transaction id goes into
 *     the SAME profile document as the Wins, in the same write.
 *  4. SETTLE - only after that profile write is durable. A pod that dies
 *     between claim and settle simply lets the lease expire; the grant is
 *     claimed again, and the transaction id already in the profile (if the
 *     write did land) stops it being applied a second time.
 */
class BuxGrants {
  /**
   * Record a paid purchase against the buyer's Bloxity account.
   *
   * THROWS if it could not be made durable, and the webhook must then answer
   * non-2xx so Bloxity retries. The retry is then either recorded or, if the
   * first write did land after all, recognised as a duplicate.
   */
  async record(accountId: string, transactionId: string, sku: string): Promise<'recorded' | 'duplicate'> {
    const wins = SKU_WINS[sku] ?? 0;
    if (wins === 0 && !KNOWN_NON_WINS.has(sku)) {
      logger.warn(SCOPE, `unknown sku "${sku}" - nothing to grant`);
    }
    const outcome = await profileStore.grants.record({
      transactionId,
      accountId,
      sku,
      wins,
      createdAt: Date.now(),
    });
    if (outcome === 'duplicate') {
      logger.info(SCOPE, `duplicate webhook for ${transactionId}, ignored`);
    } else {
      logger.info(SCOPE, `recorded ${sku} (+${wins} wins) for ${accountId} [${transactionId}]`);
    }
    return outcome;
  }

  /** Atomically take everything waiting for a VERIFIED account. */
  claim(accountId: string, claimer: string): Promise<GrantRecord[]> {
    return profileStore.grants.claim(accountId, claimer);
  }

  /** Mark grants paid for good. Only after the profile holding them is durable. */
  settle(transactionIds: readonly string[]): Promise<void> {
    return profileStore.grants.settle(transactionIds);
  }
}

export const buxGrants = new BuxGrants();
