import { existsSync, readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import { serverConfig } from '../config/serverConfig.js';
import { logger } from '../util/logger.js';
import { JsonStore } from './JsonStore.js';
import { MongoStore } from './MongoStore.js';
import type { Storage, StoredProfile } from './PersistenceAdapter.js';
import { readProfile } from './profileFields.js';
import { describe } from './WriteQueue.js';

export type {
  GrantRecord,
  GrantRepository,
  ProfileRepository,
  Storage,
  StoredProfile,
} from './PersistenceAdapter.js';

const SCOPE = 'persistence';

/** How often a legacy import that could not reach the database is retried. */
const IMPORT_RETRY_MS = 30_000;

/**
 * THE ONLY PLACE A CONCRETE STORE IS NAMED.
 *
 * `MONGODB_URI` set - which Legion does for every backend pod - means the
 * managed database, shared by every pod of this game and channel and surviving
 * restarts, idle scale-to-zero and deploys. Unset means the JSON file in the
 * data directory, which is the development store and nothing more: on Legion a
 * pod's filesystem goes when the pod does.
 *
 * Opening NEVER waits for the database and never throws for it. A pod whose
 * database is down still boots and still answers `/health`; it refuses joins
 * until the database is back, which the client's join backoff retries.
 */
export const createStorage = (): Storage => {
  const uri = process.env['MONGODB_URI']?.trim();
  if (!uri) {
    logger.info(SCOPE, 'MONGODB_URI not set: using the JSON file store (development only)');
    return new JsonStore(serverConfig.dataDir);
  }
  logger.info(SCOPE, 'MONGODB_URI set: using the managed MongoDB store');
  const store = new MongoStore(uri);
  void importLegacyProfiles(store);
  return store;
};

/**
 * Seed the database from a `profiles.json` left in the data directory.
 *
 * INSERT-ONLY (`$setOnInsert`): a profile the database already has is never
 * touched, so this is safe on every boot and can only ever add players who
 * were missing. Retried in the background until the database answers.
 */
const importLegacyProfiles = async (store: Storage): Promise<void> => {
  const path = joinPath(serverConfig.dataDir, 'profiles.json');
  if (!existsSync(path)) return;

  let legacy: Map<string, StoredProfile>;
  try {
    legacy = parseLegacy(readFileSync(path, 'utf8'));
  } catch (error) {
    logger.error(SCOPE, `legacy ${path} could not be parsed; nothing imported: ${describe(error)}`);
    return;
  }
  if (legacy.size === 0) return;

  for (;;) {
    try {
      const inserted = await store.profiles.importLegacy(legacy);
      logger.info(
        SCOPE,
        `legacy import from ${path}: ${inserted} new, ${legacy.size - inserted} already present`,
      );
      return;
    } catch (error) {
      logger.warn(SCOPE, `legacy import waiting for the database: ${describe(error)}`);
      await new Promise((resolve) => setTimeout(resolve, IMPORT_RETRY_MS).unref?.());
    }
  }
};

/** Read a legacy file. Keys in the reserved account space are never imported. */
export const parseLegacy = (text: string): Map<string, StoredProfile> => {
  const raw: unknown = JSON.parse(text);
  const out = new Map<string, StoredProfile>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.toLowerCase().startsWith('bloxity:')) continue;
    const profile = readProfile(value);
    if (profile) out.set(key, profile);
  }
  return out;
};
