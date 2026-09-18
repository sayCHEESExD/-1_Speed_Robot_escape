import { INITIAL_OWNED_ROBOTS } from '@robot/shared';
import { bloxityAuth, type Verification } from '../auth/BloxityAuth.js';
import { createStorage, type Storage, type StoredProfile } from '../persistence/index.js';
import { hasProgress } from '../persistence/profileFields.js';
import { describe } from '../persistence/WriteQueue.js';
import type { PlayerState } from '../rooms/state/PlayerState.js';
import { logger } from '../util/logger.js';

const SCOPE = 'profiles';

/**
 * THE RESERVED KEY SPACE for signed-in players: `bloxity:<accountId>`.
 *
 * A guest's key is their browser id, so a browser id that STARTS with this is
 * refused outright - otherwise a guest could simply name themselves into
 * somebody else's account.
 */
export const ACCOUNT_PREFIX = 'bloxity:';

/** Separates a guest key from its successors. Never allowed in a browser id. */
const SUCCESSOR = '~';

/** Most successor keys one browser may walk through. */
const MAX_SUCCESSORS = 16;

/** How often the leaderboard copy is refreshed from the shared store. */
const LEADERBOARD_REFRESH_MS = 60_000;

/** Most transaction ids a profile carries. Matches the store's own cap. */
const APPLIED_GRANTS_KEPT = 200;

export const accountKey = (accountId: string): string => `${ACCOUNT_PREFIX}${accountId}`;

/**
 * A browser id, or '' if it may not be used as one.
 *
 * Refused: anything in the reserved account space, anything carrying the
 * successor separator, and anything that is not a short plain token. A refused
 * id plays as an EPHEMERAL guest - in the game, with nothing restored and
 * nothing saved - which is exactly "gets nothing".
 */
export const sanitizeBrowserId = (raw: unknown): string => {
  if (typeof raw !== 'string') return '';
  const id = raw.trim();
  if (id.length === 0 || id.length > 64) return '';
  if (id.toLowerCase().startsWith(ACCOUNT_PREFIX)) return '';
  if (id.includes(SUCCESSOR)) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return '';
  return id;
};

/** Who a session is, as far as storage is concerned. */
export interface Identity {
  /**
   * `account` - a verified Bloxity login; `guest` - a browser id; `ephemeral`
   * - neither, so nothing is ever saved for it.
   */
  readonly kind: 'account' | 'guest' | 'ephemeral';
  /** Storage key. Empty for an ephemeral session. */
  readonly key: string;
  /** The raw Bloxity `_id`, for purchases. Only ever set when VERIFIED. */
  readonly accountId: string;
  /** The browser id this session presented, sanitised. */
  readonly browserId: string;
  /** How the token check went, so an `unavailable` one can be retried. */
  readonly verification: Verification['status'] | 'none';
}

export interface Resolved {
  readonly identity: Identity;
  /** The profile to restore - read from storage at THIS moment. Null = fresh. */
  readonly profile: StoredProfile | null;
  /** True when this resolution seeded an account from guest progress. */
  readonly migrated: boolean;
}

/**
 * Progression that outlives a session - on the ACCOUNT for signed-in players,
 * in the browser for guests.
 *
 * Every profile a session uses is READ FROM STORAGE AT JOIN TIME. Several pods
 * share one database, and a copy cached at boot would be stale the moment any
 * other pod saved that player. The only cache here is the leaderboard's, which
 * is allowed to be a minute old and refreshes itself.
 */
class ProfileStore {
  private storage: Storage | null = null;
  /** For the boards only. Newer `updatedAt` always wins a merge. */
  private readonly board = new Map<string, StoredProfile>();
  /** Bux transactions already credited, per key, carried into every save. */
  private readonly applied = new Map<string, string[]>();
  private refreshTimer: NodeJS.Timeout | null = null;

  /**
   * Open storage. NEVER throws and never waits for a database: a pod whose
   * database is down still boots and still answers its health probe.
   */
  open(): void {
    if (this.storage) return;
    this.storage = createStorage();
    void this.refreshBoard();
    this.refreshTimer = setInterval(() => void this.refreshBoard(), LEADERBOARD_REFRESH_MS);
    this.refreshTimer.unref?.();
  }

  get kind(): string {
    return this.store.kind;
  }

  get size(): number {
    return this.board.size;
  }

  get pendingWrites(): number {
    return this.store.profiles.pendingWrites;
  }

  private get store(): Storage {
    if (!this.storage) throw new Error('profile storage not opened');
    return this.storage;
  }

  // ---------------------------------------------------------------- identity

  /**
   * Work out who a joining client is and READ their profile.
   *
   * Throws if storage cannot be read. The caller - `onAuth` - must then refuse
   * the join: letting a player in on an empty profile would have their first
   * autosave write over the real one.
   */
  async resolveJoin(token: unknown, rawBrowserId: unknown): Promise<Resolved> {
    const browserId = sanitizeBrowserId(rawBrowserId);
    const verification: Verification | null =
      typeof token === 'string' && token.length > 0 ? await bloxityAuth.verify(token) : null;

    if (verification?.status === 'verified') {
      return this.enterAccount(verification.accountId, browserId, null);
    }
    return this.enterGuest(browserId, verification?.status ?? 'none');
  }

  /**
   * Resolve a signed-in account, seeding it from guest progress on first login.
   *
   * @param live the session's CURRENT guest state when signing in mid-session.
   *             It is newer than the last autosave, so it - not the stored
   *             guest profile - is what an empty account is seeded from.
   */
  async enterAccount(
    accountId: string,
    browserId: string,
    live: { key: string; profile: StoredProfile } | null,
  ): Promise<Resolved> {
    const key = accountKey(accountId);
    const identity: Identity = {
      kind: 'account',
      key,
      accountId,
      browserId,
      verification: 'verified',
    };

    // The account ALWAYS wins. Browser data never touches an account that
    // already has a profile.
    const existing = await this.store.profiles.get(key);
    if (existing) return this.loaded({ identity, profile: existing, migrated: false });

    // No account profile: seed it from this browser's guest progress, if any.
    const source = live ?? (browserId ? await this.findGuest(browserId) : null);
    if (!source || !source.key || !hasProgress(source.profile, INITIAL_OWNED_ROBOTS)) {
      return this.loaded({ identity, profile: null, migrated: false });
    }

    const seeded: StoredProfile = {
      ...copyProgress(source.profile),
      migratedFrom: source.key,
      updatedAt: Date.now(),
    };
    if (live) {
      // The recovery copy is the live state, which may never have been saved.
      await this.store.profiles.put(source.key, live.profile);
    }
    const inserted = await this.store.profiles.insertIfAbsent(key, seeded);
    if (!inserted) {
      // Another session seeded it first. Theirs stands; read it back.
      const winner = await this.store.profiles.get(key);
      logger.info(SCOPE, `account ${key} was seeded concurrently; using the stored copy`);
      return this.loaded({ identity, profile: winner, migrated: false });
    }
    // ONLY now, with the account's copy durable, is the guest copy marked. A
    // crash between the two leaves a duplicate - never a loss.
    await this.store.profiles.markMigrated(source.key, key);
    this.board.delete(source.key);
    logger.info(SCOPE, `migrated guest ${source.key} -> ${key} on first login`);
    return this.loaded({ identity, profile: seeded, migrated: true });
  }

  /** Resolve a guest - or an ephemeral session if the browser id was refused. */
  async enterGuest(browserId: string, verification: Identity['verification']): Promise<Resolved> {
    if (!browserId) {
      return {
        identity: { kind: 'ephemeral', key: '', accountId: '', browserId: '', verification },
        profile: null,
        migrated: false,
      };
    }
    const guest = await this.findGuest(browserId);
    if (!guest.key) {
      logger.warn(SCOPE, `browser ${browserId} exhausted its guest keys; playing ephemeral`);
      return {
        identity: { kind: 'ephemeral', key: '', accountId: '', browserId, verification },
        profile: null,
        migrated: false,
      };
    }
    return this.loaded({
      identity: { kind: 'guest', key: guest.key, accountId: '', browserId, verification },
      profile: guest.profile,
      migrated: false,
    });
  }

  /**
   * The guest profile this browser should play on.
   *
   * Normally just the browser id. But once a browser's guest progress has been
   * migrated into an account, that profile is a RECOVERY COPY: never restored,
   * never migrated again. Signing out then gives a FRESH guest, and its
   * progress needs somewhere to live that is not the recovery copy - so it
   * moves to `<id>~2`, then `<id>~3` if that one is migrated too. Each
   * successor only ever holds progress earned after the previous migration, so
   * one browser can never seed the SAME progress into two accounts.
   */
  private async findGuest(browserId: string): Promise<{ key: string; profile: StoredProfile | null }> {
    for (let n = 1; n <= MAX_SUCCESSORS; n += 1) {
      const key = n === 1 ? browserId : `${browserId}${SUCCESSOR}${n}`;
      const profile = await this.store.profiles.get(key);
      if (!profile || !profile.migratedTo) return { key, profile };
    }
    return { key: '', profile: null };
  }

  private loaded(resolved: Resolved): Resolved {
    const key = resolved.identity.key;
    if (key) this.applied.set(key, [...(resolved.profile?.appliedGrants ?? [])]);
    return resolved;
  }

  // ------------------------------------------------------------ restore/save

  /**
   * Apply a profile onto fresh player state.
   *
   * Only the DERIVING facts are restored. Level, movement speed, jump velocity
   * and the equipped robot are recomputed by their own services from these.
   */
  restore(profile: StoredProfile | null, player: PlayerState): boolean {
    if (!profile) return false;
    player.totalSpeed = profile.totalSpeed;
    player.wins = profile.wins;
    // A profile saved before the roster existed owns nothing; the starter is
    // free, so it is always granted rather than leaving the player unmounted.
    player.ownedRobots = profile.ownedRobots | INITIAL_OWNED_ROBOTS;
    player.rebirths = profile.rebirths;
    player.ownedTrails = profile.ownedTrails;
    player.trailSlot = profile.trailSlot;
    player.bestStage = profile.bestStage;
    player.displayName = profile.displayName ?? '';
    player.avatarUrl = profile.avatarUrl ?? '';
    return true;
  }

  /** The player's live state as a profile snapshot. */
  snapshot(key: string, player: PlayerState): StoredProfile {
    const applied = this.applied.get(key);
    return {
      totalSpeed: player.totalSpeed,
      wins: player.wins,
      ownedRobots: player.ownedRobots,
      rebirths: player.rebirths,
      ownedTrails: player.ownedTrails,
      trailSlot: player.trailSlot,
      bestStage: player.bestStage,
      displayName: player.displayName,
      avatarUrl: player.avatarUrl,
      ...(applied && applied.length > 0 ? { appliedGrants: applied } : {}),
      updatedAt: Date.now(),
    };
  }

  /**
   * Save a session. Resolves once the write is DURABLE - callers that only
   * want it saved eventually can ignore the promise; the write is queued and
   * retried until it lands either way.
   */
  save(key: string, player: PlayerState): Promise<void> {
    if (!key) return Promise.resolve();
    const snapshot = this.snapshot(key, player);
    this.board.set(key, snapshot);
    return this.store.profiles.put(key, snapshot);
  }

  /** Record a Bux transaction as credited INTO this key's next save. */
  noteApplied(key: string, transactionId: string): void {
    const list = this.applied.get(key) ?? [];
    list.push(transactionId);
    if (list.length > APPLIED_GRANTS_KEPT) list.splice(0, list.length - APPLIED_GRANTS_KEPT);
    this.applied.set(key, list);
  }

  /** Has this transaction already been credited into this key? */
  hasApplied(key: string, transactionId: string): boolean {
    return this.applied.get(key)?.includes(transactionId) ?? false;
  }

  /** A session has left; its grant bookkeeping can go with it. */
  forget(key: string): void {
    this.applied.delete(key);
  }

  get grants(): Storage['grants'] {
    return this.store.grants;
  }

  // ---------------------------------------------------------------- boards

  /**
   * Every profile the boards may show.
   *
   * A migrated guest copy is excluded: its progress now belongs to an account,
   * and showing both would put the same player on the board twice.
   */
  *entries(): IterableIterator<[string, StoredProfile]> {
    for (const entry of this.board) {
      if (!entry[1].migratedTo) yield entry;
    }
  }

  /** Pull the shared store into the board copy. Never throws. */
  private async refreshBoard(): Promise<void> {
    try {
      const all = await this.store.profiles.loadAll();
      for (const [key, profile] of all) {
        const mine = this.board.get(key);
        if (!mine || profile.updatedAt >= mine.updatedAt || profile.migratedTo) {
          this.board.set(key, profile);
        }
      }
    } catch (error) {
      logger.warn(SCOPE, `leaderboard refresh could not read storage: ${describe(error)}`);
    }
  }

  /** Make every queued write durable, then close. Shutdown only. */
  async shutdown(timeoutMs: number): Promise<void> {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (!this.storage) return;
    await this.storage.flush(timeoutMs);
    await this.storage.close();
  }
}

/** Progression fields only - never provenance, never grant history. */
const copyProgress = (profile: StoredProfile | null): StoredProfile => ({
  totalSpeed: profile?.totalSpeed ?? 0,
  wins: profile?.wins ?? 0,
  ownedRobots: profile?.ownedRobots ?? 0,
  rebirths: profile?.rebirths ?? 0,
  ownedTrails: profile?.ownedTrails ?? 0,
  trailSlot: profile?.trailSlot ?? 0,
  bestStage: profile?.bestStage ?? 0,
  ...(profile?.displayName ? { displayName: profile.displayName } : {}),
  ...(profile?.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
  updatedAt: profile?.updatedAt ?? 0,
});

/**
 * Process-wide singleton. A room dies with its last client, so per-room
 * storage would lose a player the moment they were briefly alone.
 */
export const profileStore = new ProfileStore();
