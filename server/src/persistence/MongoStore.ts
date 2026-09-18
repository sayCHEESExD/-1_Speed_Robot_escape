import { MongoClient, MongoServerError, type Collection, type Db } from 'mongodb';
import { logger } from '../util/logger.js';
import type {
  GrantRecord,
  GrantRepository,
  ProfileRepository,
  Storage,
  StoredProfile,
} from './PersistenceAdapter.js';
import { readProfile, saveFields } from './profileFields.js';
import { WriteQueue, describe } from './WriteQueue.js';

const SCOPE = 'persistence';

/** How long a claimed grant is held before another claim may take it. */
const CLAIM_LEASE_MS = 60_000;

/**
 * How long one operation waits to find a usable server.
 *
 * SHORT, and that is deliberate. A join reads the profile inside `onAuth`, and
 * a database that is down must turn into a clean refusal the client's backoff
 * can retry - not a join that hangs until the seat reservation expires.
 */
const SERVER_SELECTION_MS = 4000;

/** Mongo's code for "that `_id` already exists". */
const DUPLICATE_KEY = 11000;

interface ProfileDoc {
  _id: string;
  [field: string]: unknown;
}

interface GrantDoc {
  _id: string;
  accountId: string;
  sku: string;
  wins: number;
  createdAt: number;
  claimedBy?: string;
  claimedAt?: number;
  settledAt?: number;
}

/**
 * The PRODUCTION store: the managed Mongo database Legion injects as
 * `MONGODB_URI`, isolated to this game and channel.
 *
 * Several pods share it, which is what every rule in here is for:
 *
 *  - ONE DOCUMENT PER PLAYER, keyed by the profile key, and every write names
 *    exactly one. There is no whole-collection snapshot anywhere, so a pod can
 *    never write another pod's players back to an older state.
 *  - IDEMPOTENT UPDATES, never replacements: `updateOne` with `$set` and an
 *    upsert, `$unset` only for the known clearable fields. A field this build
 *    does not know about survives every save.
 *  - A failed READ THROWS. It is not "no profile".
 *
 * Nothing here waits for the database at boot. The driver connects on the
 * first operation and reconnects on its own, so a database that is down when
 * the pod starts costs failed joins until it is back, never a pod that cannot
 * answer its health probe - which Legion would restart-loop.
 */
export class MongoStore implements Storage {
  readonly kind = 'mongo' as const;
  readonly profiles: ProfileRepository;
  readonly grants: GrantRepository;
  private readonly client: MongoClient;
  private readonly db: Db;
  private readonly queue: WriteQueue<StoredProfile>;
  /** Set on shutdown, so the background connect loop stops trying. */
  private closed = false;

  constructor(uri: string) {
    this.client = new MongoClient(uri, {
      serverSelectionTimeoutMS: SERVER_SELECTION_MS,
      connectTimeoutMS: SERVER_SELECTION_MS,
      retryWrites: true,
      retryReads: true,
    });
    // The database named in the URI. Legion scopes the URI to this game and
    // channel, so this is the only database the credentials can see anyway.
    this.db = this.client.db();
    const profiles: Collection<ProfileDoc> = this.db.collection<ProfileDoc>('profiles');
    const grants: Collection<GrantDoc> = this.db.collection<GrantDoc>('grants');

    this.queue = new WriteQueue<StoredProfile>('profile', async (key, profile) => {
      const { set, unset } = saveFields(profile);
      const update: Record<string, unknown> = { $set: set };
      // An empty `$unset` is an error in Mongo, not a no-op.
      if (unset.length > 0) {
        update['$unset'] = Object.fromEntries(unset.map((field) => [field, '']));
      }
      await profiles.updateOne({ _id: key }, update, { upsert: true });
    });

    const queue = this.queue;

    this.profiles = {
      get: async (key) => readProfile(await profiles.findOne({ _id: key })),
      put: (key, profile) => queue.put(key, profile),
      insertIfAbsent: async (key, profile) => {
        try {
          const result = await profiles.updateOne(
            { _id: key },
            { $setOnInsert: stripId(profile) },
            { upsert: true },
          );
          return result.upsertedCount === 1;
        } catch (error) {
          // Two upserts for one new `_id` can race inside the server itself;
          // the loser sees a duplicate key, which means exactly "not me".
          if (isDuplicate(error)) return false;
          throw error;
        }
      },
      markMigrated: async (key, target) => {
        await profiles.updateOne({ _id: key }, { $set: { migratedTo: target } }, { upsert: true });
      },
      loadAll: async () => {
        const out = new Map<string, StoredProfile>();
        for (const doc of await profiles.find({}).toArray()) {
          const profile = readProfile(doc);
          if (profile) out.set(doc._id, profile);
        }
        return out;
      },
      importLegacy: async (legacy) => {
        if (legacy.size === 0) return 0;
        // `$setOnInsert` only: an existing document is NEVER replaced, so
        // running this on every boot can only ever add missing profiles.
        const result = await profiles.bulkWrite(
          [...legacy].map(([key, profile]) => ({
            updateOne: {
              filter: { _id: key },
              update: { $setOnInsert: stripId(profile) },
              upsert: true,
            },
          })),
          { ordered: false },
        );
        return result.upsertedCount;
      },
      get pendingWrites() {
        return queue.pending;
      },
    };

    this.grants = {
      record: async (grant) => {
        try {
          await grants.insertOne({
            _id: grant.transactionId,
            accountId: grant.accountId,
            sku: grant.sku,
            wins: grant.wins,
            createdAt: grant.createdAt,
          });
          return 'recorded';
        } catch (error) {
          if (isDuplicate(error)) return 'duplicate';
          throw error;
        }
      },
      claim: async (accountId, claimer) => {
        const claimed: GrantRecord[] = [];
        // One document at a time, each claim ATOMIC: `findOneAndUpdate` is the
        // guarantee that two pods can never both take the same grant.
        for (;;) {
          const now = Date.now();
          const doc = await grants.findOneAndUpdate(
            {
              accountId,
              settledAt: { $exists: false },
              $or: [{ claimedAt: { $exists: false } }, { claimedAt: { $lt: now - CLAIM_LEASE_MS } }],
            },
            { $set: { claimedBy: claimer, claimedAt: now } },
            { returnDocument: 'after' },
          );
          if (!doc) break;
          claimed.push({
            transactionId: doc._id,
            accountId: doc.accountId,
            sku: doc.sku,
            wins: doc.wins,
            createdAt: doc.createdAt,
          });
        }
        return claimed;
      },
      settle: async (ids) => {
        if (ids.length === 0) return;
        await grants.updateMany({ _id: { $in: [...ids] } }, { $set: { settledAt: Date.now() } });
      },
    };

    void this.prepare(grants);
  }

  /**
   * Connect and create indexes, in the background.
   *
   * Never awaited by boot. A failure is logged LOUDLY and retried: the pod
   * keeps answering `/health` either way, and the first operation that needs
   * the database simply fails until it is back.
   */
  private async prepare(grants: Collection<GrantDoc>): Promise<void> {
    for (let attempt = 1; !this.closed; attempt += 1) {
      try {
        await this.client.connect();
        await grants.createIndex({ accountId: 1, settledAt: 1 });
        logger.info(SCOPE, `MongoDB connected (database "${this.db.databaseName}")`);
        return;
      } catch (error) {
        logger.error(
          SCOPE,
          `MongoDB UNAVAILABLE (attempt ${attempt}): ${describe(error)} - joins will be ` +
            'refused until it is reachable; /health keeps answering.',
        );
        await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, attempt * 2000)).unref?.());
      }
    }
  }

  async flush(timeoutMs: number): Promise<void> {
    const landed = await this.queue.drain(timeoutMs);
    if (!landed) {
      logger.error(
        SCOPE,
        `shutdown flush timed out with ${this.queue.pending} profile write(s) still pending`,
      );
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.client.close();
  }
}

const stripId = (profile: StoredProfile): Record<string, unknown> => {
  const copy: Record<string, unknown> = { ...profile };
  delete copy['_id'];
  return copy;
};

const isDuplicate = (error: unknown): boolean =>
  error instanceof MongoServerError && error.code === DUPLICATE_KEY;
