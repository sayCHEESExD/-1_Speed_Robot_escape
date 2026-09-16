/**
 * The mech roster.
 *
 * A MECH is the movement vehicle, the progression ladder and the thing the
 * player actually looks at, all in one record. Everything a system needs to
 * know about one lives here and nowhere else, so adding a thirteenth is a new
 * entry in `ROBOTS` and nothing more - no movement code, no renderer branch
 * and no server case statement changes.
 *
 * THE PILOT IS INSIDE THE MACHINE. Every frame here is built around an OPEN
 * COCKPIT cut into the front of its chest: the pilot stands in it with their
 * legs and waist swallowed by the torso and only their head and shoulders
 * clear of the canopy rim. That is the single most important fact in this
 * file, and every proportion below exists to serve it.
 *
 * The frames are authored at PLAYING SIZE - about nine units to the top of the
 * shoulder blocks against a 3.2-unit pilot - so a mech is close to three times
 * the height of the person driving it and five times the width. There is no
 * scale-down step: what is written here is what stands in the world.
 */

/**
 * Blocky proportions, in world units, for the generic mech the client builds
 * every frame from.
 *
 * These are the numbers that decide whether a machine reads as a scout walker
 * or a siege platform, so they are data rather than per-frame modelling code:
 * one builder consumes the whole struct and there is no second way to make a
 * mech.
 */
export interface RobotShape {
  /** Chest block: width (X), height (Y) and depth (Z). */
  readonly torsoWidth: number;
  readonly torsoHeight: number;
  readonly torsoDepth: number;
  /**
   * THE COCKPIT: how wide and how deep the hollow in the chest is.
   *
   * It has to clear the pilot - the supplied rig is a little over one unit
   * across the shoulders - with room for the canopy frame around them. Too
   * narrow and the armour clips through their arms; too wide and the chest
   * stops reading as armour and starts reading as a doorway.
   */
  readonly cockpitWidth: number;
  readonly cockpitDepth: number;
  /**
   * How far the canopy rim sits BELOW the top of the chest.
   *
   * The rim is what the pilot's chest is level with, so this is really "how
   * much of the pilot shows". Zero would bury them to the eyes; too much and
   * they are standing in a bathtub.
   */
  readonly canopyDrop: number;
  /** The narrower waist block under the chest. */
  readonly waistWidth: number;
  readonly waistHeight: number;
  /** Shoulder blocks: how far out they sit and how big they are. */
  readonly shoulderSpread: number;
  readonly shoulderSize: number;
  /** Arms: thickness and the length of each of the two segments. */
  readonly armThickness: number;
  readonly upperArmLength: number;
  readonly forearmLength: number;
  /** Legs: how far apart the hips are, thickness, and segment lengths. */
  readonly hipSpread: number;
  readonly legThickness: number;
  readonly thighLength: number;
  readonly shinLength: number;
  /** The foot block the whole frame stands on. */
  readonly footLength: number;
  readonly footHeight: number;
}

/**
 * Flat, saturated paint. Hex, as three.js takes them.
 *
 * BRIGHT, and deliberately brighter than the building around them. The
 * facility is near-black and lit by a handful of lamps, so a machine painted
 * in the room's own greys is a silhouette - which is exactly what the first
 * pass produced, and why every frame here is a saturated colour a player can
 * name from across the hangar.
 */
export interface RobotPalette {
  /** The torso and the big armour plates. */
  readonly armor: number;
  /** The darker plates: the underside of the torso, the shoulder caps. */
  readonly armorDark: number;
  /** The exposed frame: joints, hips, the inside of a limb. */
  readonly frame: number;
  /** The trim stripe that runs down the plates. */
  readonly trim: number;
  /** The neon: eye strips, chest reactor, vents, thruster glow. */
  readonly glow: number;
}

/** Hardware bolted onto the generic mech. */
export type RobotFeature =
  /** A V-fin crest over the canopy brow. */
  | 'crest'
  /** Twin backpack thrusters. */
  | 'thrusters'
  /** A shoulder-mounted cannon. */
  | 'cannon'
  /** A hardpoint shield on the left arm. */
  | 'shield'
  /** Knee guards and ankle flares. */
  | 'greaves'
  /** A pair of folded wing binders on the back. */
  | 'binders'
  /** A glowing reactor core in the chest. */
  | 'reactor'
  /** Antenna spires rising from the shoulders. */
  | 'antenna'
  /** A heavy backpack with vent louvres. */
  | 'backpack'
  /** A halo ring of light hovering over the shoulders. */
  | 'halo';

/** How one robot moves, looks and is unlocked. */
export interface RobotDefinition {
  /** Stable id, used in saves and in the model cache. Never re-used. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /**
   * Slot number, 1-based and contiguous.
   *
   * The replicated `robotSlot` and the owned-robot bitmask are indexed by
   * this, so it is the wire identity and `id` is the human one.
   */
  readonly slot: number;
  /** Wins needed to claim it. Slot 1 is free. */
  readonly winsRequired: number;
  /**
   * SPEED PER SECOND, and the whole progression ladder.
   *
   * Speed ticks up on its own while the player is in the world - that is what
   * the "+1 Speed" of the title means - and the equipped robot is the rate. It
   * is the figure printed on the display sign as "+N Speed", so the number the
   * player is sold and the number they are paid are the same one.
   *
   * It is ALSO the per-stride rate for movement income: walking and running a
   * treadmill both feed the same figure through `SPEED.strideDistance`, which
   * is what makes the two equivalent rather than two economies.
   */
  readonly speedPerSecond: number;
  /** Multiplier on base movement speed. A better frame is a faster frame. */
  readonly moveBonus: number;
  /** Multiplier on jump velocity. */
  readonly jumpBonus: number;
  /**
   * Uniform scale applied to the built model.
   *
   * The shapes are authored at PLAYING SIZE, so this is a nudge rather than a
   * conversion: it runs from 1.00 on the starter to 1.12 on the last frame,
   * which is just enough that a player who has climbed the ladder can see they
   * are driving something heavier without the collision body - one radius and
   * one height for the whole roster - starting to lie about it.
   */
  readonly scale: number;
  /**
   * Where the rider sits, measured from the robot's own origin, before
   * `scale`.
   *
   * `y` is the height of the RIDER MODEL's own origin, not of the seat: the
   * supplied FBX puts its origin at the feet and its hip joints 1.21 units
   * above that, so a seat that looks right is `seatY - 1.21`. Setting it to
   * the seat height instead is what buries the rider's legs inside the torso.
   *
   * It is computed by the geometry builder from the shape rather than authored
   * per robot, because a mech's seat is a FACT about its torso - see
   * `riderSeatY` below.
   */
  readonly riderOffset: Readonly<{ x: number; y: number; z: number }>;
  /**
   * Distance in world units between two footfalls.
   *
   * Drives the walk cycle: the gait phase advances with DISTANCE COVERED, not
   * with wall-clock time, so a mech's stride stays tied to the ground going
   * past however fast its owner has levelled.
   */
  readonly strideLength: number;
  readonly shape: RobotShape;
  readonly palette: RobotPalette;
  readonly features: readonly RobotFeature[];
}

/**
 * Proportion presets, so twelve robots are twelve variations of four builds.
 *
 * The four read as four WEIGHT CLASSES at a glance, which is the point: a
 * player should be able to see that the thing on the upper deck is heavier
 * than the thing they are standing on without reading a sign.
 */
const BUILD = {
  /** Scout frames: light, long-legged, narrow shoulders. About 8.4 tall. */
  scout: {
    torsoWidth: 3.3,
    torsoHeight: 2.5,
    torsoDepth: 2.4,
    cockpitWidth: 1.7,
    cockpitDepth: 1.5,
    canopyDrop: 0.85,
    waistWidth: 2.1,
    waistHeight: 0.8,
    shoulderSpread: 2.7,
    shoulderSize: 1.6,
    armThickness: 0.95,
    upperArmLength: 1.9,
    forearmLength: 1.8,
    hipSpread: 1.35,
    legThickness: 1.25,
    thighLength: 1.85,
    shinLength: 1.85,
    footLength: 2.6,
    footHeight: 0.7,
  },
  /** Line frames: the standard mass-production mech. About 8.8 tall. */
  line: {
    torsoWidth: 3.7,
    torsoHeight: 2.6,
    torsoDepth: 2.6,
    cockpitWidth: 1.8,
    cockpitDepth: 1.6,
    canopyDrop: 0.9,
    waistWidth: 2.4,
    waistHeight: 0.85,
    shoulderSpread: 3.0,
    shoulderSize: 1.8,
    armThickness: 1.05,
    upperArmLength: 2.0,
    forearmLength: 1.9,
    hipSpread: 1.5,
    legThickness: 1.4,
    thighLength: 1.95,
    shinLength: 1.95,
    footLength: 2.8,
    footHeight: 0.75,
  },
  /** Command frames: broad shoulders, deep chest. About 9.1 tall. */
  command: {
    torsoWidth: 4.1,
    torsoHeight: 2.75,
    torsoDepth: 2.8,
    cockpitWidth: 1.9,
    cockpitDepth: 1.7,
    canopyDrop: 0.95,
    waistWidth: 2.7,
    waistHeight: 0.9,
    shoulderSpread: 3.35,
    shoulderSize: 2.05,
    armThickness: 1.15,
    upperArmLength: 2.1,
    forearmLength: 2.0,
    hipSpread: 1.65,
    legThickness: 1.55,
    thighLength: 2.05,
    shinLength: 2.05,
    footLength: 3.0,
    footHeight: 0.8,
  },
  /** Siege frames: enormous shoulders, a walking fortress. About 9.3 tall. */
  siege: {
    torsoWidth: 4.6,
    torsoHeight: 2.9,
    torsoDepth: 3.1,
    cockpitWidth: 2.0,
    cockpitDepth: 1.8,
    canopyDrop: 1.0,
    waistWidth: 3.0,
    waistHeight: 0.95,
    shoulderSpread: 3.8,
    shoulderSize: 2.35,
    armThickness: 1.3,
    upperArmLength: 2.15,
    forearmLength: 2.05,
    hipSpread: 1.8,
    legThickness: 1.72,
    thighLength: 2.1,
    shinLength: 2.1,
    footLength: 3.3,
    footHeight: 0.85,
  },
} as const satisfies Record<string, RobotShape>;

/** The hip line: where the legs meet the waist. */
export const hipHeightOf = (shape: RobotShape): number =>
  shape.footHeight + shape.shinLength + shape.thighLength;

/**
 * THE COCKPIT FLOOR, derived from the shape rather than authored.
 *
 * The pilot STANDS on it, inside the chest, so this is the height their own
 * model origin goes to - not a seat, and not the top of anything. Everything
 * above it is decided by the pilot proportions: the supplied rig is 3.2 tall,
 * so with the canopy rim a little under the chest top, roughly the top third
 * of them is clear of the armour and the rest is inside it.
 *
 * Computed once here, and every frame riderOffset.y comes out of it. Authoring
 * the number per frame is how one entry ends up with its pilot buried to the
 * eyes and the next with one standing on the roof.
 *
 * Measured from the mech own origin, which the geometry builder puts at the
 * GROUND between the feet.
 */
export const cockpitFloorY = (shape: RobotShape): number =>
  hipHeightOf(shape) + shape.waistHeight;

/** Height of the canopy rim - the line the pilot chest clears. */
export const canopyRimY = (shape: RobotShape): number =>
  cockpitFloorY(shape) + shape.torsoHeight - shape.canopyDrop;

/** Top of the shoulder blocks: the tallest part of the machine itself. */
export const shoulderTopY = (shape: RobotShape): number =>
  cockpitFloorY(shape) + shape.torsoHeight + shape.shoulderSize * 0.25;

/**
 * Kept for the renderer, which still needs to know where a standing humanoid
 * hip line sits relative to its own origin when it poses one.
 */
export const RIDER_HIP_HEIGHT = 1.21;

/**
 * Where the pilot model goes, in mech space.
 *
 * Their FEET are on the cockpit floor - they are standing at the controls, not
 * sitting on a saddle - and they are set back from centre so the canopy brow
 * is in front of their face rather than through it.
 */
const seat = (shape: RobotShape): { x: number; y: number; z: number } => ({
  x: 0,
  z: -shape.cockpitDepth * 0.12,
  y: cockpitFloorY(shape),
});

/**
 * The roster, in display order.
 *
 * The unlock ladder is authored EXACTLY as specified, and the `speedPerSecond`
 * column IS the ladder: 1, 2, 5, 25, 50, 75, 100, 250, 500, 750, 1000, 2000.
 * `moveBonus` climbs far more gently than the income does - a late robot earns
 * two thousand times what the starter does and moves about twice as fast -
 * because movement speed is what the obby has to stay readable at, and income
 * is not.
 */
export const ROBOTS: readonly RobotDefinition[] = [
  {
    id: 'scrapwalker',
    name: 'Scrap Walker',
    slot: 1,
    winsRequired: 0,
    speedPerSecond: 1,
    moveBonus: 1,
    jumpBonus: 1,
    scale: 1.0,
    riderOffset: seat(BUILD.scout),
    strideLength: 4.6,
    shape: BUILD.scout,
    palette: {
      armor: 0xa08a6e,
      armorDark: 0x6f5c46,
      frame: 0x4a4036,
      trim: 0xd9c49c,
      glow: 0xd8ff3a,
    },
    features: [],
  },
  {
    id: 'boltrunner',
    name: 'Bolt Runner',
    slot: 2,
    winsRequired: 3,
    speedPerSecond: 2,
    moveBonus: 1.04,
    jumpBonus: 1,
    scale: 1.01,
    riderOffset: seat(BUILD.scout),
    strideLength: 4.6,
    shape: BUILD.scout,
    palette: {
      armor: 0x5fa8d8,
      armorDark: 0x35708f,
      frame: 0x27455a,
      trim: 0xbfe8ff,
      glow: 0x7df9ff,
    },
    features: ['crest'],
  },
  {
    id: 'neonlancer',
    name: 'Neon Lancer',
    slot: 3,
    winsRequired: 15,
    speedPerSecond: 5,
    moveBonus: 1.09,
    jumpBonus: 1.02,
    scale: 1.02,
    riderOffset: seat(BUILD.line),
    strideLength: 4.8,
    shape: BUILD.line,
    palette: {
      armor: 0x6f7de0,
      armorDark: 0x414c9a,
      frame: 0x2b3168,
      trim: 0xc3cbff,
      glow: 0x38ff9e,
    },
    features: ['crest', 'thrusters'],
  },
  {
    id: 'magmaframe',
    name: 'Magma Frame',
    slot: 4,
    winsRequired: 100,
    speedPerSecond: 25,
    moveBonus: 1.15,
    jumpBonus: 1.04,
    scale: 1.03,
    riderOffset: seat(BUILD.line),
    strideLength: 4.8,
    shape: BUILD.line,
    palette: {
      armor: 0xd8663a,
      armorDark: 0x8f3a1c,
      frame: 0x54210f,
      trim: 0xffb27a,
      glow: 0xff7a1e,
    },
    features: ['thrusters', 'greaves', 'reactor'],
  },
  {
    id: 'voltcrusher',
    name: 'Volt Crusher',
    slot: 5,
    winsRequired: 500,
    speedPerSecond: 50,
    moveBonus: 1.22,
    jumpBonus: 1.06,
    scale: 1.04,
    riderOffset: seat(BUILD.line),
    strideLength: 4.9,
    shape: BUILD.line,
    palette: {
      armor: 0x9a6ce0,
      armorDark: 0x63409a,
      frame: 0x3c2663,
      trim: 0xdcc4ff,
      glow: 0xd46bff,
    },
    features: ['cannon', 'greaves', 'reactor'],
  },
  {
    id: 'ironsentinel',
    name: 'Iron Sentinel',
    slot: 6,
    winsRequired: 1_000,
    speedPerSecond: 75,
    moveBonus: 1.3,
    jumpBonus: 1.08,
    scale: 1.05,
    riderOffset: seat(BUILD.command),
    strideLength: 5.1,
    shape: BUILD.command,
    palette: {
      armor: 0x9aa8bc,
      armorDark: 0x63707f,
      frame: 0x3f4854,
      trim: 0xdfe8f5,
      glow: 0x35e0ff,
    },
    features: ['shield', 'greaves', 'antenna', 'reactor'],
  },
  {
    id: 'stormcaster',
    name: 'Storm Caster',
    slot: 7,
    winsRequired: 2_000,
    speedPerSecond: 100,
    moveBonus: 1.4,
    jumpBonus: 1.1,
    scale: 1.06,
    riderOffset: seat(BUILD.command),
    strideLength: 5.1,
    shape: BUILD.command,
    palette: {
      armor: 0x54b0c4,
      armorDark: 0x2f707f,
      frame: 0x1e4753,
      trim: 0xc0efff,
      glow: 0x7df9ff,
    },
    features: ['cannon', 'thrusters', 'binders', 'reactor'],
  },
  {
    id: 'phantomstrider',
    name: 'Phantom Strider',
    slot: 8,
    winsRequired: 10_000,
    speedPerSecond: 250,
    moveBonus: 1.52,
    jumpBonus: 1.12,
    scale: 1.07,
    riderOffset: seat(BUILD.command),
    strideLength: 5.2,
    shape: BUILD.command,
    palette: {
      armor: 0x6a6480,
      armorDark: 0x413c52,
      frame: 0x282433,
      trim: 0xb8aede,
      glow: 0x54ff9f,
    },
    features: ['binders', 'antenna', 'greaves', 'reactor', 'thrusters'],
  },
  {
    id: 'titanbreaker',
    name: 'Titan Breaker',
    slot: 9,
    winsRequired: 25_000,
    speedPerSecond: 500,
    moveBonus: 1.66,
    jumpBonus: 1.15,
    scale: 1.08,
    riderOffset: seat(BUILD.siege),
    strideLength: 5.4,
    shape: BUILD.siege,
    palette: {
      armor: 0xd8a93c,
      armorDark: 0x8f6c18,
      frame: 0x55400d,
      trim: 0xffe6a0,
      glow: 0xffe14d,
    },
    features: ['cannon', 'shield', 'backpack', 'greaves', 'reactor'],
  },
  {
    id: 'novaparagon',
    name: 'Nova Paragon',
    slot: 10,
    winsRequired: 35_000,
    speedPerSecond: 750,
    moveBonus: 1.8,
    jumpBonus: 1.18,
    scale: 1.09,
    riderOffset: seat(BUILD.siege),
    strideLength: 5.4,
    shape: BUILD.siege,
    palette: {
      armor: 0xdfe6f2,
      armorDark: 0xa5b0c4,
      frame: 0x6c7484,
      trim: 0xffffff,
      glow: 0x5df2ff,
    },
    features: ['crest', 'binders', 'halo', 'greaves', 'reactor', 'thrusters'],
  },
  {
    id: 'omegawarden',
    name: 'Omega Warden',
    slot: 11,
    winsRequired: 50_000,
    speedPerSecond: 1_000,
    moveBonus: 1.95,
    jumpBonus: 1.22,
    scale: 1.1,
    riderOffset: seat(BUILD.siege),
    strideLength: 5.5,
    shape: BUILD.siege,
    palette: {
      armor: 0x3f6ac4,
      armorDark: 0x27427f,
      frame: 0x18294f,
      trim: 0xa8c4ff,
      glow: 0x38ff9e,
    },
    features: [
      'cannon',
      'shield',
      'backpack',
      'antenna',
      'greaves',
      'reactor',
      'thrusters',
    ],
  },
  {
    id: 'voidcolossus',
    name: 'Void Colossus',
    slot: 12,
    winsRequired: 100_000,
    speedPerSecond: 2_000,
    moveBonus: 2.15,
    jumpBonus: 1.26,
    scale: 1.12,
    riderOffset: seat(BUILD.siege),
    strideLength: 5.6,
    shape: BUILD.siege,
    palette: {
      armor: 0x6a45b8,
      armorDark: 0x422a75,
      frame: 0x271846,
      trim: 0xc9a8ff,
      glow: 0xff3df0,
    },
    features: [
      'crest',
      'cannon',
      'shield',
      'binders',
      'backpack',
      'halo',
      'antenna',
      'greaves',
      'reactor',
      'thrusters',
    ],
  },
];

/** Slot -> definition. Built once; slots are contiguous from 1. */
const BY_SLOT: ReadonlyMap<number, RobotDefinition> = new Map(
  ROBOTS.map((robot) => [robot.slot, robot]),
);

/** The robot every player starts on. Free, and the only one owned at join. */
export const STARTER_ROBOT_SLOT = 1;

/**
 * The robot in a slot, or the starter when the slot is unknown.
 *
 * Never throws: a slot arriving from a save file or a stale client must
 * degrade to the starter rather than take a room down.
 */
export const robotForSlot = (slot: number): RobotDefinition => {
  const found = BY_SLOT.get(Math.floor(slot));
  if (found) return found;
  return BY_SLOT.get(STARTER_ROBOT_SLOT) as RobotDefinition;
};

/** Bit for one slot in the owned-robots mask. Slot 1 is bit 0. */
export const robotBit = (slot: number): number => 1 << (Math.floor(slot) - 1);

/** True when `ownedMask` includes this slot. */
export const ownsRobot = (ownedMask: number, slot: number): boolean =>
  (ownedMask & robotBit(slot)) !== 0;

/** The owned mask a brand new profile starts with. */
export const INITIAL_OWNED_ROBOTS = robotBit(STARTER_ROBOT_SLOT);

/**
 * The best robot a mask owns.
 *
 * "Best" is by `speedPerSecond`, which is the ladder the display deck is
 * ordered by, so equipping the best owned can never be a downgrade after a
 * purchase. `moveBonus` rises with it and never steps down between two
 * consecutive robots, so the same choice is never a downgrade on the course
 * either.
 */
export const bestOwnedRobot = (ownedMask: number): RobotDefinition => {
  let best = robotForSlot(STARTER_ROBOT_SLOT);
  for (const robot of ROBOTS) {
    if (!ownsRobot(ownedMask, robot.slot)) continue;
    if (robot.speedPerSecond > best.speedPerSecond) best = robot;
  }
  return best;
};
