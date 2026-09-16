import { serverConfig } from '../config/serverConfig.js';
import { JsonFilePersistence } from './JsonFilePersistence.js';
import type { PersistenceAdapter } from './PersistenceAdapter.js';

export type { PersistenceAdapter, StoredProfile } from './PersistenceAdapter.js';

/**
 * The ONLY place a concrete adapter is named.
 *
 * Swapping the shipped JSON file for a database is a change to this function
 * and to nothing else - everything above the boundary holds a
 * `PersistenceAdapter` and knows no more than that.
 */
export const createPersistence = (): PersistenceAdapter =>
  new JsonFilePersistence(serverConfig.dataDir);
