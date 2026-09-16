import { rebirthMultiplier } from './rebirth.js';
import { trailMultiplier } from './trails.js';

/**
 * Speed farming and the level curve.
 *
 * SPEED IS EARNED BY WALKING FORWARD - OR BY RUNNING A BELT.
 *
 * There is no passive tick, no per-second income for existing, no jump bonus,
 * no distance bonus, no sprint bonus and no treadmill bonus. A player standing
 * in the middle of the hangar earns exactly nothing, however long they stand
 * there, and a player holding W against a wall earns exactly nothing either -
 * the mech has to actually be under way.
 *
 * A TREADMILL IS THE ONE PLACE A STATIONARY MECH EARNS, and it is not really
 * an exception: a machine on a running deck IS walking, and the only reason it
 * covers no ground is that the belt is covering it instead. So the bay pays
 * the ordinary rate for as long as a mech is standing on a rig - no bonus, no
 * tier, no multiplier, and no key to hold, because holding one would just walk
 * the player off the end of the belt. Farming is therefore a PLACE the player
 * has to walk to and stay in, which is what the bay was built for.
 *
 * While it IS under way the rate is fixed, and it is the product of exactly
 * three things:
 *
 *     equipped robot's Speed/s  x  rebirth multiplier  x  trail multiplier
 *
 * IT IS PAID IN WHOLE TICKS, one every `SPEED.grantInterval` of movement, and
 * each tick is worth that entire product. A mech that says "+2 SPEED/S" pays
 * TWO in one go, once a second, and the popup over the player's head reads
 * "+2" - the same figure as the mech's own rating and the same figure the shop
 * advertises. Dribbling it out continuously was arithmetically identical and
 * read completely differently: a +2 mech spent its whole life showing "+1"
 * popups, because the fraction that had accumulated when the popup fired was
 * never the mech's rate.
 *
 * Nothing else may enter it. Not level, not distance covered, not how long the
 * step was in the sense of paying more for a longer one, not a random roll,
 * not which belt is under the machine. The same three facts always produce the
 * same figure, which is the point: a player who swaps mechs should see the
 * number change, and a player who stands in one place for five minutes should
 * see it not change at all.
 *
 * `speedGainPerSecond` below is the ONE place that product is computed and
 * `earnsSpeed` is the ONE place the conditions are judged. The server calls
 * both; the client only ever displays the replicated total.
 */
export interface SpeedConfig {
  /**
   * Seconds of movement one Speed tick is worth.
   *
   * The whole rate is paid at each of these and nothing is paid between them,
   * so what the player sees float up is the mech's own figure rather than
   * whatever fraction had piled up. One second, because the rate the whole
   * game advertises is a rate PER SECOND - "+2 Speed/s" on the bay plate, the
   * shop row and the HUD all mean this tick.
   */
  readonly grantInterval: number;
  /**
   * Ground speed below which the mech counts as NOT MOVING, in units/second.
   *
   * The whole difference between earning and not earning, so it is a real
   * threshold rather than a test against zero: a mech settling on a platform,
   * being nudged by a conveyor or resting against a wall drifts by fractions
   * of a unit a second, and paying for that is paying for standing still.
   */
  readonly movingSpeed: number;
  /**
   * Largest distance the server will credit from a single simulated step.
   *
   * Expressed as a multiple of the step's own maximum honest travel, so it
   * scales with the player's authoritative speed instead of throttling a fast
   * player back to a beginner's cap. A teleport still pays nothing.
   */
  readonly creditSlack: number;
  /** Speed needed to go from level 1 to level 2. */
  readonly baseRequirement: number;
  /** Each level costs this much more than the one before. */
  readonly growth: number;
}

/**
 * Tuned to reproduce the reference art EXACTLY.
 *
 * `baseRequirement` 100 and `growth` 1.1 give 100, 110, 121, 133, 146 - which
 * is the specified "level 3 requires 121, level 4 requires 133" and the
 * "30 / 146" the level bar shows at level 5. Every later level continues the
 * same geometric climb, so nothing in the ladder is hardcoded past these two
 * numbers.
 */
export const SPEED: SpeedConfig = {
  grantInterval: 1,
  movingSpeed: 1.5,
  creditSlack: 1.6,
  baseRequirement: 100,
  growth: 1.1,
};

/**
 * THE Speed rate, in Speed per second of actual forward travel.
 *
 * The one formula, and the only three factors allowed in it. Every caller -
 * the server that pays it, a test that checks it, anything that ever wants to
 * display it - goes through here, so there is exactly one answer to "what is
 * this player earning" and no second system to disagree with it.
 *
 * `trailMultiplier` returns 1 for a slot the player does not own, so a forged
 * slot can only ever mean no bonus.
 */
export const speedGainPerSecond = (
  robotSpeedPerSecond: number,
  rebirths: number,
  trailSlot: number,
  ownedTrails: number,
): number => {
  const rate = Number.isFinite(robotSpeedPerSecond) ? Math.max(0, robotSpeedPerSecond) : 0;
  return rate * rebirthMultiplier(rebirths) * trailMultiplier(trailSlot, ownedTrails);
};

/** What the server observed about one simulated step. */
export interface EarningStep {
  /** True when the player commanded FORWARD movement (W) this step. */
  readonly forward: boolean;
  /** Distance the authoritative position actually moved, in world units. */
  readonly distance: number;
  /** Seconds the step covered. */
  readonly seconds: number;
  /** Largest distance this step could honestly have covered. */
  readonly maxDistance: number;
  /** True when the mech is running a treadmill belt. */
  readonly onTreadmill: boolean;
}

/**
 * Does this step earn Speed at all?
 *
 * THREE conditions, and all three must hold:
 *
 *  1. The player asked to go forward. W, or the stick pushed forward. Not
 *     strafing, not reversing, not nothing. A TREADMILL SKIPS THIS: the belt
 *     is doing the walking, and a key held on one would only carry the player
 *     off the rig.
 *  2. The mech ACTUALLY MOVED. Held against a wall, wedged in a corner or
 *     stopped dead by a crusher, the position does not change and the step
 *     pays nothing - holding a key is not travel.
 *  3. The movement was possible. Anything beyond what the player's own
 *     authoritative speed could cover is a teleport, and a teleport pays
 *     nothing at all.
 *
 * A TREADMILL answers all three by itself, and is therefore tested FIRST: none
 * of the three questions can sensibly be asked of a machine whose GROUND is
 * what is moving. It earns the same fixed rate as walking the hangar floor -
 * not more, because there is no belt bonus, no tier and no multiplier anywhere
 * on the bay.
 */
export const earnsSpeed = (step: EarningStep): boolean => {
  if (step.seconds <= 0) return false;
  if (step.onTreadmill) return true;
  if (!step.forward) return false;
  if (step.distance > step.maxDistance) return false;
  return step.distance >= SPEED.movingSpeed * step.seconds;
};

/**
 * Speed needed to advance FROM `level` to the next one.
 *
 * Rounded, and the rounding is load-bearing: the HUD prints this figure and
 * `totalSpeedToReach` sums the same rounded values, so the bar's "30 / 146"
 * and the level it is attached to can never be a fraction apart.
 */
export const speedForNextLevel = (level: number): number => {
  const step = Math.max(1, Math.floor(level));
  return Math.round(SPEED.baseRequirement * SPEED.growth ** (step - 1));
};

/** Where a lifetime Speed total sits on the level curve. */
export interface LevelProgress {
  /** Current level. Everyone starts at 1. */
  readonly level: number;
  /** Speed earned toward the next level. */
  readonly into: number;
  /** Speed needed for the next level. */
  readonly required: number;
  /** 0..1 fill for the level bar. */
  readonly fraction: number;
  /** True when the level cap has been reached and the bar is full. */
  readonly capped: boolean;
}

/**
 * Resolve a lifetime Speed total into a level and a bar position.
 *
 * Closed-form rather than a loop: the curve is geometric, and at a large total
 * a per-level loop would run a hundred times per HUD update for an answer
 * algebra gives directly. The loop that follows only ever corrects a
 * floating-point boundary by one level either way.
 */
export const resolveLevel = (totalSpeed: number, levelCap: number): LevelProgress => {
  const cap = Math.max(1, Math.floor(levelCap));
  const total = Number.isFinite(totalSpeed) ? Math.max(0, totalSpeed) : 0;

  // Cumulative cost of reaching level L is base * (g^(L-1) - 1) / (g - 1).
  const g = SPEED.growth;
  const base = SPEED.baseRequirement;
  const ratio = (total * (g - 1)) / base + 1;
  let level = Math.floor(Math.log(Math.max(ratio, 1)) / Math.log(g)) + 1;
  level = Math.max(1, Math.min(level, cap));

  // Rounding in `speedForNextLevel` means the closed form can be a level out
  // at a boundary. Two cheap corrections settle it exactly.
  while (level > 1 && totalSpeedToReach(level) > total) level -= 1;
  while (level < cap && totalSpeedToReach(level + 1) <= total) level += 1;

  if (level >= cap) {
    const required = speedForNextLevel(cap);
    return { level: cap, into: required, required, fraction: 1, capped: true };
  }

  const required = speedForNextLevel(level);
  const into = total - totalSpeedToReach(level);
  return {
    level,
    into,
    required,
    fraction: required > 0 ? Math.min(Math.max(into / required, 0), 1) : 0,
    capped: false,
  };
};

/** Cumulative Speed needed to have REACHED `level`. Level 1 costs nothing. */
export const totalSpeedToReach = (level: number): number => {
  const target = Math.max(1, Math.floor(level));
  if (target <= 1) return 0;
  // Summed rather than closed-form so it agrees exactly with the rounded
  // per-level figures the HUD shows. Bounded by the level cap, so this is at
  // most a few hundred iterations and is only called at a level boundary.
  let total = 0;
  for (let i = 1; i < target; i += 1) total += speedForNextLevel(i);
  return total;
};

/**
 * Compact display form used by the HUD: 940, 13.2K, 453.6K, 3.1M.
 *
 * Matches the reference art's casing (an upper-case K) and its one decimal
 * place. Lives in shared so the server can log the figures the player sees.
 */
export const formatSpeed = (value: number): string => {
  const amount = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (amount >= 1_000_000_000_000) return `${(amount / 1_000_000_000_000).toFixed(1)}T`;
  if (amount >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(1)}B`;
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(2).replace(/0$/, '')}K`;
  return Math.floor(amount).toString();
};
