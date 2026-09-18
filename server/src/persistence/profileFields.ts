import { CLEARABLE_FIELDS, type StoredProfile } from './PersistenceAdapter.js';

/** The progression fields every save writes, all non-negative numbers. */
const NUMERIC_FIELDS = [
  'totalSpeed',
  'wins',
  'ownedRobots',
  'rebirths',
  'ownedTrails',
  'trailSlot',
  'bestStage',
  'updatedAt',
] as const;

/** Most transaction ids a profile remembers. Enough to cover any crash window. */
const APPLIED_GRANTS_KEPT = 200;

const numeric = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/**
 * A stored document, read back into a profile WITHOUT losing anything.
 *
 * The known numeric fields are coerced - a missing one reads as zero, which is
 * exactly what a profile written before that field existed means - and EVERY
 * other field is carried through untouched, including ones this build has
 * never heard of. A loader that rebuilt each profile from a fixed list of
 * fields is how names were silently dropped on a restart before.
 */
export const readProfile = (raw: unknown): StoredProfile | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...source };
  delete out['_id'];
  for (const field of NUMERIC_FIELDS) out[field] = numeric(source[field]);
  for (const field of ['displayName', 'avatarUrl', 'migratedFrom', 'migratedTo'] as const) {
    if (field in source && typeof source[field] !== 'string') delete out[field];
  }
  if ('appliedGrants' in source) {
    const list = Array.isArray(source['appliedGrants'])
      ? (source['appliedGrants'] as unknown[]).filter((id): id is string => typeof id === 'string')
      : [];
    out['appliedGrants'] = list;
  }
  return out as unknown as StoredProfile;
};

/**
 * What a SAVE writes, and what it removes.
 *
 * `set` is the progression, the name, the grant history when the session holds
 * one, and the timestamp. `unset` is only ever a CLEARABLE field the session
 * has no value for. Provenance (`migratedFrom`, `migratedTo`) is absent from
 * both on purpose: only the migration writes those, so a session that never
 * loaded them cannot erase them.
 */
export const saveFields = (
  profile: StoredProfile,
): { set: Record<string, unknown>; unset: string[] } => {
  const set: Record<string, unknown> = {};
  for (const field of NUMERIC_FIELDS) set[field] = numeric(profile[field]);
  const unset: string[] = [];
  for (const field of CLEARABLE_FIELDS) {
    const value = profile[field];
    if (typeof value === 'string' && value.length > 0) set[field] = value;
    else unset.push(field);
  }
  if (Array.isArray(profile.appliedGrants)) {
    set['appliedGrants'] = profile.appliedGrants.slice(-APPLIED_GRANTS_KEPT);
  }
  return { set, unset };
};

/** The same save applied to a plain object, for the JSON store. */
export const mergeSave = (
  existing: Record<string, unknown> | undefined,
  profile: StoredProfile,
): Record<string, unknown> => {
  const { set, unset } = saveFields(profile);
  const next: Record<string, unknown> = { ...(existing ?? {}), ...set };
  for (const field of unset) delete next[field];
  return next;
};

/**
 * Does this profile hold anything worth keeping?
 *
 * The first-login migration only seeds an account from a guest who has
 * actually played - an empty guest profile would just stamp `migratedTo` on a
 * browser for nothing and make it look migrated.
 */
export const hasProgress = (profile: StoredProfile | null, initialRobots: number): boolean => {
  if (!profile) return false;
  return (
    profile.totalSpeed > 0 ||
    profile.wins > 0 ||
    profile.rebirths > 0 ||
    profile.bestStage > 0 ||
    profile.ownedTrails > 0 ||
    (profile.ownedRobots & ~initialRobots) !== 0
  );
};
