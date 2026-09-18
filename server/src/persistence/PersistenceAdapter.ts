/**
 * Everything worth keeping about a player between sessions.
 *
 * Deliberately the DERIVING facts only: level, movement speed and the equipped
 * robot are all recomputed from these on load through the same formulas a
 * live session uses, so a tuning change reaches returning players too.
 *
 * A stored document may carry fields this build does not know about - written
 * by a newer build, or by an operator. Every store PRESERVES them: nothing here
 * ever replaces a whole document, and a field is only removed if it is one of
 * `CLEARABLE_FIELDS`.
 */
export interface StoredProfile {
  /** Lifetime Speed farmed. Level follows from it. */
  totalSpeed: number;
  /** Stage wins banked. */
  wins: number;
  /** Bitmask of robots claimed. The equipped one is the best of these. */
  ownedRobots: number;
  /** Rebirths performed. */
  rebirths: number;
  /** Bitmask of trails bought, and the one worn. Permanent unlocks. */
  ownedTrails: number;
  trailSlot: number;
  /** Highest stage ever finished. */
  bestStage: number;
  /**
   * The portal's display name and portrait as last seen.
   *
   * Stored so a board can name a player who is NOT in the room: the top of the
   * Wins board is mostly people who are offline.
   */
  displayName?: string;
  avatarUrl?: string;
  /**
   * PROVENANCE, written only by the first-login migration and never by a save.
   *
   * `migratedFrom` is on an ACCOUNT profile that was seeded from a browser's
   * guest progress, and names the guest key it came from. `migratedTo` is on
   * that GUEST profile, which is kept as a recovery copy, and names the account
   * it went to - a guest profile carrying it is never restored, never migrated
   * again and never shown on a board.
   */
  migratedFrom?: string;
  migratedTo?: string;
  /**
   * Bux transactions already credited INTO this document.
   *
   * Written in the same update as the Wins they added, so one document is the
   * single source of truth for "was this paid": a crash between claiming a
   * grant and saving the profile re-applies it rather than losing it, and a
   * re-claim of a grant whose save DID land is recognised and skipped.
   */
  appliedGrants?: string[];
  /** Wall clock of the last save. Newer wins when two copies disagree. */
  updatedAt: number;
}

/**
 * Optional fields a save may REMOVE when the session has no value for them.
 *
 * Only these. Provenance and grant history are never cleared by a save - a
 * session that did not load them must not be able to erase them - and a field
 * this build has never heard of is never touched at all.
 */
export const CLEARABLE_FIELDS = ['displayName', 'avatarUrl'] as const;

/** One Bux purchase, as recorded from Bloxity's webhook. */
export interface GrantRecord {
  readonly transactionId: string;
  /** Bloxity's own account id for the buyer - the raw `_id`, not a key. */
  readonly accountId: string;
  readonly sku: string;
  readonly wins: number;
  readonly createdAt: number;
}

/**
 * Profiles, ONE DOCUMENT PER PLAYER.
 *
 * Several pods share one database, so there is no whole-map snapshot anywhere
 * in this contract: a write names one key and changes only that document.
 */
export interface ProfileRepository {
  /**
   * The stored profile, or null if there is none.
   *
   * THROWS when storage cannot be read. "Could not read" and "does not exist"
   * are different answers, and treating the first as the second is how a
   * player gets let in on an empty profile that then autosaves over the real
   * one.
   */
  get(key: string): Promise<StoredProfile | null>;
  /**
   * Queue this snapshot as the latest for `key`.
   *
   * Never dropped: a failed write is retried with backoff until it lands, and
   * a newer snapshot for the same key simply replaces an older one still
   * waiting. The promise resolves when THIS snapshot, or a newer one, is
   * durable; callers that only want it saved eventually may ignore it.
   */
  put(key: string, profile: StoredProfile): Promise<void>;
  /**
   * Create the document only if none exists. Resolves true if it was created.
   *
   * The first-login migration's primitive: two sessions racing to seed one
   * account both call this, exactly one wins, and the loser reads the winner.
   */
  insertIfAbsent(key: string, profile: StoredProfile): Promise<boolean>;
  /** Set `migratedTo` on a guest profile. Only after its data was copied. */
  markMigrated(key: string, target: string): Promise<void>;
  /** Every profile, for the leaderboards. Throws if storage is unreadable. */
  loadAll(): Promise<Map<string, StoredProfile>>;
  /**
   * Import legacy profiles INSERT-ONLY. An existing document is never
   * replaced, so this is safe to run on every boot.
   *
   * @returns how many were newly inserted
   */
  importLegacy(profiles: ReadonlyMap<string, StoredProfile>): Promise<number>;
  /** How many keys have a write still waiting to land. */
  readonly pendingWrites: number;
}

/**
 * Bux purchases, durable and shared by every pod.
 *
 * The webhook is load-balanced across pods and may land on one the buyer is
 * not connected to, so grants cannot live in any pod's memory.
 */
export interface GrantRepository {
  /**
   * Record a paid purchase durably, keyed by its transaction id.
   *
   * @returns 'recorded' for a new transaction, 'duplicate' for one already
   *          stored. Throws if it could not be made durable - the webhook
   *          must then NOT answer 2xx, so Bloxity retries.
   */
  record(grant: GrantRecord): Promise<'recorded' | 'duplicate'>;
  /**
   * Atomically CLAIM every unsettled grant for an account.
   *
   * A claim is a lease: two pods can never hold the same grant at once, and a
   * grant whose claimer died before settling it becomes claimable again once
   * the lease runs out.
   */
  claim(accountId: string, claimer: string): Promise<GrantRecord[]>;
  /** Mark grants paid for good. Only after the profile holding them is durable. */
  settle(transactionIds: readonly string[]): Promise<void>;
}

/** One store, whichever backend it is. */
export interface Storage {
  readonly kind: 'mongo' | 'json';
  readonly profiles: ProfileRepository;
  readonly grants: GrantRepository;
  /** Make every queued write durable, or give up after `timeoutMs`. */
  flush(timeoutMs: number): Promise<void>;
  /** Release the connection. After `flush`, on shutdown only. */
  close(): Promise<void>;
}
