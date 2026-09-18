import { existsSync, readFileSync, renameSync } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import { logger } from '../util/logger.js';
import type {
  GrantRecord,
  GrantRepository,
  ProfileRepository,
  Storage,
  StoredProfile,
} from './PersistenceAdapter.js';
import { mergeSave, readProfile } from './profileFields.js';
import { WriteQueue, describe } from './WriteQueue.js';

const SCOPE = 'persistence';

/** How long a claimed grant is held before another claim may take it. */
const CLAIM_LEASE_MS = 60_000;

/** How long the webhook waits for a grant to be durable before answering 503. */
const RECORD_DURABLE_MS = 8000;

/**
 * One JSON document on disk, written ATOMICALLY and never thrown away.
 *
 * Atomic: to a temp file, fsynced, then renamed over the real one, so a crash
 * mid-write leaves the old file or the new one and never half of either.
 *
 * Never thrown away, which is the part that used to be missing:
 *
 *  - A leftover `.tmp` is inspected on open. If it parses it is a complete
 *    write that crashed before its rename, and it is NEWER than the real file,
 *    so it is promoted. If it does not parse it is a torn write, and it is
 *    moved aside - not deleted - and the real file is used.
 *  - A real file that does not parse is MOVED ASIDE and the store starts
 *    empty. The previous behaviour was to carry on empty and let the next
 *    write replace the bad file, which turned a recoverable corruption into
 *    every player's progression gone.
 */
class JsonDocument {
  readonly path: string;
  private readonly tempPath: string;
  private readonly directory: string;
  data: Record<string, unknown> = {};
  private readonly queue: WriteQueue<true>;

  constructor(directory: string, fileName: string) {
    this.directory = directory;
    this.path = joinPath(directory, fileName);
    this.tempPath = `${this.path}.tmp`;
    this.queue = new WriteQueue<true>(fileName, () => this.writeFile());
  }

  get pending(): number {
    return this.queue.pending;
  }

  /** Read the file, recovering from a torn write or a corrupt file. */
  load(): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (existsSync(this.tempPath)) {
      const parsed = tryParse(this.tempPath);
      if (parsed) {
        // A complete write that crashed before its rename: newer than the real
        // file, so it becomes the real file.
        renameSync(this.tempPath, this.path);
        logger.warn(SCOPE, `recovered ${this.tempPath} left by an interrupted write`);
      } else {
        const aside = `${this.tempPath}.partial-${stamp}`;
        renameSync(this.tempPath, aside);
        logger.warn(SCOPE, `moved a torn write aside to ${aside}; keeping ${this.path}`);
      }
    }

    if (!existsSync(this.path)) {
      this.data = {};
      return;
    }
    const parsed = tryParse(this.path);
    if (parsed) {
      this.data = parsed;
      return;
    }
    const aside = `${this.path}.corrupt-${stamp}`;
    renameSync(this.path, aside);
    this.data = {};
    logger.error(
      SCOPE,
      `${this.path} could not be parsed. It has been MOVED to ${aside} with its data ` +
        'intact, and the store is starting empty. Nothing overwrote it.',
    );
  }

  /** Queue a write of the whole document; resolves once it is on disk. */
  save(): Promise<void> {
    return this.queue.put('file', true);
  }

  drain(timeoutMs: number): Promise<boolean> {
    return this.queue.drain(timeoutMs);
  }

  private async writeFile(): Promise<void> {
    const payload = JSON.stringify(this.data);
    await mkdir(this.directory, { recursive: true });
    const handle = await open(this.tempPath, 'w');
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(this.tempPath, this.path);
  }
}

const tryParse = (path: string): Record<string, unknown> | null => {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

interface StoredGrant extends GrantRecord {
  claimedBy?: string;
  claimedAt?: number;
  settledAt?: number;
}

/**
 * The development store: two JSON files in the data directory.
 *
 * One process owns them, so there is no cross-pod concern here - but it keeps
 * the SAME per-key contract as the database, so every path above it behaves
 * identically whichever store is underneath.
 */
export class JsonStore implements Storage {
  readonly kind = 'json' as const;
  readonly profiles: ProfileRepository;
  readonly grants: GrantRepository;
  private readonly profileDoc: JsonDocument;
  private readonly grantDoc: JsonDocument;

  constructor(directory: string) {
    this.profileDoc = new JsonDocument(directory, 'profiles.json');
    this.grantDoc = new JsonDocument(directory, 'grants.json');
    this.profileDoc.load();
    this.grantDoc.load();
    logger.info(
      SCOPE,
      `JSON store at ${directory}: ${Object.keys(this.profileDoc.data).length} profile(s), ` +
        `${Object.keys(this.grantDoc.data).length} grant(s)`,
    );

    const docs = this.profileDoc;
    const grants = this.grantDoc;

    this.profiles = {
      get: async (key) => readProfile(docs.data[key]),
      put: (key, profile) => {
        docs.data[key] = mergeSave(docs.data[key] as Record<string, unknown> | undefined, profile);
        return docs.save();
      },
      insertIfAbsent: async (key, profile) => {
        if (docs.data[key] !== undefined) return false;
        docs.data[key] = { ...profile };
        await docs.save();
        return true;
      },
      markMigrated: async (key, target) => {
        const existing = (docs.data[key] as Record<string, unknown> | undefined) ?? {};
        docs.data[key] = { ...existing, migratedTo: target };
        await docs.save();
      },
      loadAll: async () => {
        const out = new Map<string, StoredProfile>();
        for (const [key, raw] of Object.entries(docs.data)) {
          const profile = readProfile(raw);
          if (profile) out.set(key, profile);
        }
        return out;
      },
      importLegacy: async (legacy) => {
        let inserted = 0;
        for (const [key, profile] of legacy) {
          if (docs.data[key] !== undefined) continue;
          docs.data[key] = { ...profile };
          inserted += 1;
        }
        if (inserted > 0) await docs.save();
        return inserted;
      },
      get pendingWrites() {
        return docs.pending;
      },
    };

    this.grants = {
      record: async (grant) => {
        if (grants.data[grant.transactionId] !== undefined) return 'duplicate';
        grants.data[grant.transactionId] = { ...grant };
        await withTimeout(grants.save(), RECORD_DURABLE_MS, 'grant write');
        return 'recorded';
      },
      claim: async (accountId, claimer) => {
        const now = Date.now();
        const claimed: GrantRecord[] = [];
        for (const raw of Object.values(grants.data)) {
          const grant = raw as StoredGrant;
          if (grant.accountId !== accountId || grant.settledAt) continue;
          if (grant.claimedAt && now - grant.claimedAt < CLAIM_LEASE_MS) continue;
          grant.claimedBy = claimer;
          grant.claimedAt = now;
          claimed.push(pickGrant(grant));
        }
        if (claimed.length > 0) await grants.save();
        return claimed;
      },
      settle: async (ids) => {
        const now = Date.now();
        for (const id of ids) {
          const grant = grants.data[id] as StoredGrant | undefined;
          if (grant) grant.settledAt = now;
        }
        if (ids.length > 0) await grants.save();
      },
    };
  }

  async flush(timeoutMs: number): Promise<void> {
    const [profiles, grants] = await Promise.all([
      this.profileDoc.drain(timeoutMs),
      this.grantDoc.drain(timeoutMs),
    ]);
    if (!profiles || !grants) {
      logger.error(SCOPE, 'shutdown flush timed out with JSON writes still pending');
    }
  }

  async close(): Promise<void> {
    // Nothing to release: the files are closed after every write.
  }
}

const pickGrant = (grant: StoredGrant): GrantRecord => ({
  transactionId: grant.transactionId,
  accountId: grant.accountId,
  sku: grant.sku,
  wins: grant.wins,
  createdAt: grant.createdAt,
});

/** Reject if `promise` has not settled within `ms`. The work itself carries on. */
export const withTimeout = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} not durable after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(describe(error)));
      },
    );
  });
