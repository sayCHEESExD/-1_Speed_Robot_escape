import { logger } from '../util/logger.js';

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

/** One purchase, waiting for its player to be somewhere it can be applied. */
export interface PendingGrant {
  readonly transactionId: string;
  readonly sku: string;
  readonly wins: number;
}

/**
 * Purchases that have been paid for and not yet handed over.
 *
 * A QUEUE rather than a direct write, and that is the whole design. The
 * webhook arrives on the HTTP thread at a moment of Bloxity's choosing; the
 * player may be live in a room with their Wins held in replicated state that
 * the autosave will write over the stored profile a few seconds later.
 * Crediting the stored profile directly would therefore be a credit that
 * vanishes on the next save. So the webhook only ever RECORDS, and the room
 * applies what is waiting - on join, and on a slow timer for a player who was
 * already in when they bought something.
 *
 * Transaction ids are remembered so a webhook Bloxity retries - which it will,
 * if this server was slow to answer - pays out once.
 */
class BuxGrants {
  /** Queued grants, by Bloxity user id. */
  private readonly pending = new Map<string, PendingGrant[]>();
  /** Every transaction already accepted, so a retry is not a second payout. */
  private readonly seen = new Set<string>();

  /**
   * Record a paid purchase.
   *
   * @returns false only if this transaction was already recorded.
   */
  record(bloxityId: string, transactionId: string, sku: string): boolean {
    if (!bloxityId || !transactionId) return false;
    if (this.seen.has(transactionId)) {
      logger.info(SCOPE, `duplicate webhook for ${transactionId}, ignored`);
      return false;
    }
    this.seen.add(transactionId);

    const wins = SKU_WINS[sku] ?? 0;
    if (wins === 0 && !KNOWN_NON_WINS.has(sku)) {
      logger.warn(SCOPE, `unknown sku "${sku}" - nothing to grant`);
    }

    const queue = this.pending.get(bloxityId) ?? [];
    queue.push({ transactionId, sku, wins });
    this.pending.set(bloxityId, queue);
    logger.info(
      SCOPE,
      `queued ${sku} (+${wins} wins) for ${bloxityId} [${transactionId}]`,
    );
    return true;
  }

  /** Take everything waiting for a player. Empties the queue. */
  drain(bloxityId: string): PendingGrant[] {
    if (!bloxityId) return [];
    const queue = this.pending.get(bloxityId);
    if (!queue || queue.length === 0) return [];
    this.pending.delete(bloxityId);
    return queue;
  }

  /** True if anyone at all is owed something, so the tick can skip the work. */
  get hasPending(): boolean {
    return this.pending.size > 0;
  }
}

export const buxGrants = new BuxGrants();
