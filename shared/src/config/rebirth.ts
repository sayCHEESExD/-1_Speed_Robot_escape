/**
 * Rebirth: the prestige ladder.
 *
 * Ported from the previous game's rebirth system and kept behaviourally
 * identical - a rebirth trades the current level curve for a permanently higher
 * ceiling and a bigger multiplier, and deliberately leaves everything the
 * player earned OUTSIDE that curve alone. Wins and owned robots are permanent
 * unlocks and survive a rebirth untouched.
 *
 * Data-driven: `REBIRTH_TIERS` is the authored head of the ladder and
 * `EXTENSION` continues the same pattern for ever after it, so adding a third
 * rebirth is one row in a table rather than a new branch anywhere.
 */

/** One rung of the ladder. */
export interface RebirthTier {
  /** How many rebirths the player will have AFTER performing this one. */
  readonly index: number;
  /** Level that must be reached before this rebirth may be performed. */
  readonly requiredLevel: number;
  /** Speed multiplier granted once it has been performed. */
  readonly multiplier: number;
}

/**
 * The authored rungs.
 *
 * As specified: a fresh player is capped at level 50 on a x1 multiplier;
 * rebirth 1 costs reaching 50 and grants x1.5 with a cap of 75; rebirth 2
 * costs 75 and grants x2 with a cap of 100. Everything past the table
 * continues by `EXTENSION` - +0.5x and +25 levels for ever - so the ladder
 * never runs out and a fourth rung is a row here rather than a branch
 * anywhere.
 */
export const REBIRTH_TIERS: readonly RebirthTier[] = [
  { index: 1, requiredLevel: 50, multiplier: 1.5 },
  { index: 2, requiredLevel: 75, multiplier: 2 },
];

/** How the ladder continues once the authored table is exhausted. */
const EXTENSION = {
  /** Extra levels required per rebirth beyond the last authored one. */
  levelsPerRebirth: 25,
  /** Extra multiplier per rebirth beyond the last authored one. */
  multiplierPerRebirth: 0.5,
} as const;

/**
 * The largest level and rebirth count that can be replicated.
 *
 * `PlayerState.level`, `maxLevel` and `rebirths` are all `uint32`, so a figure
 * past this WRAPS on the wire - and a wrapped level cap is worse than a cap,
 * because it silently drops a player's ceiling to nothing. Clamping saturates
 * instead.
 */
export const MAX_REPLICATED_LEVEL = 4294967295;

/** The rung a player with `count` rebirths is working toward. */
export const nextRebirthTier = (count: number): RebirthTier => {
  const done = Math.max(0, Math.floor(count));
  const authored = REBIRTH_TIERS[done];
  if (authored) return authored;

  // Past the table: continue the same pattern rather than stopping.
  const last = REBIRTH_TIERS[REBIRTH_TIERS.length - 1] as RebirthTier;
  const beyond = done - REBIRTH_TIERS.length + 1;
  return {
    index: done + 1,
    requiredLevel: last.requiredLevel + beyond * EXTENSION.levelsPerRebirth,
    multiplier: last.multiplier + beyond * EXTENSION.multiplierPerRebirth,
  };
};

/**
 * Highest level reachable at this rebirth count.
 *
 * It is exactly the level the NEXT rebirth needs, which is what makes reaching
 * the cap and unlocking the rebirth the same moment - the cap is a gate, never
 * a dead end.
 */
export const maxLevelForRebirth = (count: number): number =>
  Math.min(nextRebirthTier(count).requiredLevel, MAX_REPLICATED_LEVEL);

/** Speed multiplier granted by `count` completed rebirths. */
export const rebirthMultiplier = (count: number): number => {
  const done = Math.max(0, Math.floor(count));
  if (done <= 0) return 1;
  const authored = REBIRTH_TIERS[done - 1];
  if (authored) return authored.multiplier;
  const last = REBIRTH_TIERS[REBIRTH_TIERS.length - 1] as RebirthTier;
  const beyond = done - REBIRTH_TIERS.length;
  return last.multiplier + beyond * EXTENSION.multiplierPerRebirth;
};

/** A player may rebirth once they have reached their current max level. */
export const canRebirth = (level: number, count: number): boolean =>
  Math.floor(level) >= maxLevelForRebirth(count);
