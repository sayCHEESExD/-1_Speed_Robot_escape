/**
 * Trails: the movement-speed cosmetic ladder, bought with stage Wins.
 *
 * Ported from the previous game and kept structurally identical. A trail
 * multiplies how fast the player ACTUALLY moves, and it does so by feeding the
 * one movement formula (`resolveMovementProfile`) through its
 * `extraMultiplier` parameter - never a second calculation of its own.
 *
 * Deliberately NOT a Speed-per-stride modifier: the equipped ROBOT owns that
 * axis. Keeping the two separate is what stops a cosmetic quietly multiplying
 * the wrong system.
 *
 * Ownership and the equipped slot are server state. The client asks to buy and
 * to equip, and renders whatever comes back.
 */

/** How the client draws a trail. Presentation only; never gameplay. */
export type TrailStyle = 'solid' | 'rainbow' | 'sparkle' | 'void';

export interface TrailTier {
  /** 1-based slot, matching the shop rows top to bottom. */
  readonly slot: number;
  readonly name: string;
  /** Wins deducted on purchase. */
  readonly cost: number;
  /** Multiplier applied to actual movement speed while equipped. */
  readonly multiplier: number;
  /** Base colour, as a hex integer. */
  readonly color: number;
  readonly style: TrailStyle;
}

/**
 * FIVE tiers, exactly as specified.
 *
 * Green 50 Wins x1.5, Blue 150 x2, Yellow 500 x3, Red 2,500 x4, Rainbow
 * 10,000 x5. The costs are pitched against this game's Win economy - stage
 * rewards start at 5 and 3 and climb hard - so the first trail is a handful of
 * early clears and the last is a real grind.
 *
 * These multipliers are STEEP compared with the previous game's, and that is
 * the specification rather than an accident: the level term in
 * `resolveMovementProfile` is deliberately soft-capped and the rebirth ladder
 * now climbs by half-steps, so a trail is where a player buys a real change of
 * pace. The obby's gaps are authored against a profile that includes one.
 *
 * The colours are the neon the rest of the world is lit in, so a trail belongs
 * to the hangar it was bought in.
 */
export const TRAIL_TIERS: readonly TrailTier[] = [
  { slot: 1, name: 'Green Trail', cost: 50, multiplier: 1.5, color: 0x38ff9e, style: 'solid' },
  { slot: 2, name: 'Blue Trail', cost: 150, multiplier: 2, color: 0x35e0ff, style: 'solid' },
  { slot: 3, name: 'Yellow Trail', cost: 500, multiplier: 3, color: 0xffe14d, style: 'sparkle' },
  { slot: 4, name: 'Red Trail', cost: 2_500, multiplier: 4, color: 0xff3d5e, style: 'solid' },
  { slot: 5, name: 'Rainbow Trail', cost: 10_000, multiplier: 5, color: 0xff3df0, style: 'rainbow' },
];

/**
 * Slots must fit `PlayerState.ownedTrails`, a uint16 bitmask - so sixteen, and
 * no more.
 */
export const MAX_TRAIL_SLOTS = 16;

/** Nothing equipped. */
export const NO_TRAIL = 0;

/** Look up a tier by its slot. */
export const trailBySlot = (slot: number): TrailTier | undefined =>
  TRAIL_TIERS.find((tier) => tier.slot === slot);

/** One bit per slot, so the whole inventory is a single replicated integer. */
export const trailMask = (slot: number): number => 1 << (Math.floor(slot) - 1);

/** True when the player has bought this tier. */
export const isTrailOwned = (owned: number, slot: number): boolean =>
  (owned & trailMask(slot)) !== 0;

/**
 * Movement multiplier from the equipped trail.
 *
 * Returns 1 for "none equipped" and for any slot that is not owned, so an
 * unowned or forged slot can only ever mean "no bonus" - never a bonus.
 */
export const trailMultiplier = (slot: number, owned: number): number => {
  const tier = trailBySlot(slot);
  if (!tier) return 1;
  return isTrailOwned(owned, tier.slot) ? tier.multiplier : 1;
};
