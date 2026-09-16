import type { Aabb } from '../types/math.js';
import { ROBOTS, robotForSlot, type RobotDefinition } from './robots.js';
import { MOVEMENT, resolveMovementProfile } from './movement.js';
import { totalSpeedToReach } from './speed.js';

/**
 * The world, as pure data.
 *
 * Everything the player can stand on, bump into or be killed by is defined
 * here, and both the renderer and the authoritative server read the same
 * arrays. There are no world coordinates anywhere else - a platform the client
 * draws but the server does not know about is the one bug this file exists to
 * make impossible.
 *
 * The world is LINEAR along +Z: a wide neon HANGAR, then thirty stages of dark
 * futuristic obstacle course lit by glowing lava, laser strips and sign panels.
 *
 * WHAT MAKES THIS COURSE DIFFERENT from the flying game before it is that the
 * mech JUMPS and nothing else. There is no meter, no thrust and no second
 * airborne mechanic, so every gap and every step in this file is authored
 * against one pair of numbers - `gapFor` and `riseFor`, both derived from the
 * ballistic arc a player at the stage's own recommended level actually has.
 * Nothing here may ask for a leap that arc cannot make.
 */

/** What a solid is for. Presentation reads this; the simulation does not. */
export type SolidKind =
  /** The dark panelled deck plating the course runs on. */
  | 'floor'
  /** The hangar's own floor: the same plating, a shade deeper. */
  | 'lobby'
  /** The raised deck of the treadmill bay and the robot display platforms. */
  | 'training'
  /** A raised armour block to hop onto or over. */
  | 'block'
  /** A steel catwalk or grating bridge. */
  | 'plank'
  /** A full-height support column to weave around. */
  | 'pillar'
  /** Torn hull plate and wreckage: the collapsed sections. */
  | 'ruin'
  /** The small win pad at the player's LEFT at a stage's end. */
  | 'winPad'
  /**
   * The RETURN pad at the player's RIGHT at a stage's end.
   *
   * Sends the player back to the hangar and pays NOTHING. It exists because
   * banking a stage is not the only reason to want to go back - a player who
   * has already banked this one, or who came to look, needs a way out that is
   * not dying - and because a pad that paid would be a second way to take
   * payment for the same stage.
   */
  | 'returnPad'
  /** A robot display plinth. */
  | 'stand'
  /** A platform that periodically sinks. Rendered with a warning flash. */
  | 'sinking'
  /** Frictionless polished plating. Slippery, via the surface region on it. */
  | 'ice'
  /** Dark cast alloy: bulkheads, towers, the steppers over the lava. */
  | 'stone'
  /** A structural girder, laid as a walkway. */
  | 'log'
  /** Black machine steel: press frames and the rails they run in. */
  | 'metal'
  /**
   * The course ROOF.
   *
   * Never stood on and never bumped into sideways - `resolveAxis` skips any
   * solid whose underside is above the rider's head - so its whole job is to
   * be the thing `resolveCeiling` stops a climb against.
   */
  | 'ceiling'
  /**
   * A HARD-LIGHT platform: glowing, thin, and hanging in mid-air.
   *
   * The signature surface of this game and the one the player learns to look
   * for. Neon cyan, lit from inside, and placed exactly where the course wants
   * the player to land.
   */
  | 'rune';

/** One axis-aligned solid. */
export interface CourseSolid extends Aabb {
  readonly kind: SolidKind;
  /** Stage this belongs to; -1 for the hangar. */
  readonly stage: number;
}

/**
 * A solid that rises and sinks as a pure function of TIME.
 *
 * Both sides evaluate `sinkingOffsetAt`, so a platform is in the same place on
 * every machine with nothing replicated and nothing to forge. The cycle is
 * deliberately four-part - up, warning flash, sunk, rising - because a
 * platform that vanished without warning would be a coin flip rather than a
 * decision.
 *
 * It is also the game's TIMED DOOR: a tall block authored across a corridor is
 * a shutter that drops into the floor and comes back, which is the same
 * mechanic seen from the side. There is deliberately no separate door type.
 */
export interface SinkingSolid extends CourseSolid {
  /** Seconds for one complete up-warn-down-up cycle. */
  readonly cycle: number;
  /** Offset into the cycle, so a field of platforms is never in lockstep. */
  readonly phase: number;
  /** Seconds of the cycle spent fully up and steady. */
  readonly steady: number;
  /** Seconds of visible flashing before it drops. */
  readonly warn: number;
  /** Seconds spent out of reach at the bottom. */
  readonly sunk: number;
  /** How far it drops. Far enough to be genuinely gone. */
  readonly depth: number;
}

/**
 * A pool of something lethal, under the platforms.
 *
 * The bottom of the world in most of this course. `surfaceY` is where the pool
 * is drawn and `deathY` is barely below it, so falling in reads as being
 * swallowed rather than as a long drop into nothing.
 */
export interface HazardPool {
  readonly stage: number;
  /**
   * What the pool is made of. PRESENTATION ONLY.
   *
   * Lava, void and coolant kill identically and by the same rule; the
   * difference is what the player is looking at while it happens, which is the
   * whole reason a dozen stages can share one mechanic without reading as one
   * stage built a dozen times.
   */
  readonly surface: 'lava' | 'void' | 'water';
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly surfaceY: number;
  readonly deathY: number;
}

/**
 * The previous games called this quicksand, and half the codebase still reads
 * better with the old word for "the pit under the platforms".
 */
export type QuicksandRegion = HazardPool;

/** How a hazard moves. */
export type HazardKind =
  /** Sweeps side to side across the corridor. A moving wall, or one panel of one. */
  | 'sweeper'
  /** Rolls down the corridor toward the player, then recycles to the top. */
  | 'roller'
  /**
   * Orbits a fixed centre in the horizontal plane.
   *
   * The workhorse of the later stages: a rotating beam, a turntable arm and a
   * laser lance are all this, at different radii and rates. Several placed at
   * one centre with stepped radii make a BAR rather than a ball, which is how
   * a beam and its hub are drawn without any new physics.
   */
  | 'spinner'
  /**
   * Falls from above onto a fixed spot, rests, and rises again.
   *
   * Falling masonry and overhead presses are the same hazard: the difference
   * is how far it falls and how long it waits. It hovers for most of its cycle
   * so the shadow underneath is a real warning rather than a formality.
   */
  | 'faller'
  /** Orbits like a spinner, drawn as a column of charged plasma. */
  | 'tornado'
  /**
   * A STATIC bed of emitters.
   *
   * Does not move at all, and that is why it belongs here rather than among
   * the solids: it is a killer with a position, tested by exactly the same
   * code every other hazard is, so a spike field costs the collision model
   * nothing it was not already paying.
   */
  | 'spike';

/**
 * A killer.
 *
 * Position is a pure function of TIME, so the server evaluates it from its own
 * clock and the client from the replicated one. There is no hazard state to
 * replicate and nothing for a client to assert.
 */
export interface CourseHazard {
  readonly kind: HazardKind;
  readonly stage: number;
  /** Centre of the sweep, or the lane a roller runs down. */
  readonly x: number;
  readonly y: number;
  /** Resting Z for a sweeper; ignored by a roller, which uses from/to. */
  readonly z: number;
  readonly radius: number;
  /**
   * Sweeper: half-amplitude in X.
   * Spinner / tornado: orbit radius about (`x`, `z`).
   * Faller: how far above `y` it hovers before it drops.
   * Roller / spike: unused.
   */
  readonly sweep: number;
  /**
   * Sweeper / spinner / tornado: radians per second.
   * Roller: units per second down the lane.
   * Faller: seconds for one complete hover-fall-rest-rise cycle.
   * Spike: unused.
   */
  readonly rate: number;
  /** Offset so a row of hazards is never in lockstep. */
  readonly phase: number;
  /** Roller: the Z it starts from (the far end) and rolls toward. */
  readonly fromZ: number;
  readonly toZ: number;
}

/** Scenery the client draws and the simulation ignores. */
export type DecorationKind =
  /** A dead comms mast: a bare pylon and a few broken cross-arms. */
  | 'tree'
  /**
   * A grating panel sitting at platform height with NO solid under it.
   *
   * The trap: it reads as somewhere to land and is not.
   */
  | 'falseFloor'
  /** A gantry arch: two uprights and a lit lintel. Its solids are separate. */
  | 'arch'
  /** A drifting bank of vented steam, high above the world. */
  | 'cloud'
  /** A blocky chunk of debris. Rubble on the deck. */
  | 'rock'
  /** A sheet of falling coolant down a bulkhead. */
  | 'waterfall'
  /** A wall strip light: a bracket with a neon bar in it. */
  | 'torch'
  /** A floor beacon: a glowing bollard on a base. */
  | 'brazier'
  /** A floating power cell, slowly turning. */
  | 'crystal'
  /** A hanging cable run, from the roof down into the dark. */
  | 'chain';

export interface Decoration {
  readonly kind: DecorationKind;
  readonly stage: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
  readonly rotationY: number;
}

/**
 * A patch of ground that changes how the mech HANDLES on it.
 *
 * Three mechanics need this and they are the same one pointed in different
 * directions: polished plating lowers `grip` so a run keeps its momentum
 * through a turn, conveyor bays add a constant push, and a launch pad throws
 * the mech into the air. All three are read by `stepPlayer` itself, so the
 * server's simulation and the client's prediction cannot handle differently -
 * which for a surface whose whole point is the feel of the controls is the
 * difference between a stage and a rubber-banding mess.
 */
export interface SurfaceRegion {
  readonly stage: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  /**
   * Multiplier on ground acceleration AND braking, 1 being normal plating.
   *
   * Below 1 is polished: slower to speed up, far slower to stop or turn. It
   * scales both, deliberately - lowering only the braking would make it a
   * place where the mech is simply harder to stop, rather than one where it is
   * harder to steer.
   */
  readonly grip: number;
  /** Constant sideways push, world units per second squared. */
  readonly windX: number;
  /** Constant push along the course. Negative holds the player back. */
  readonly windZ: number;
  /**
   * LAUNCH PAD: upward velocity handed to a mech standing on it, or 0.
   *
   * A pure function of position like every other field here, applied inside
   * the shared step, so the client predicts exactly the arc the server
   * simulates. It is a SET rather than an add: a pad throws every mech to the
   * same height whatever it arrived doing, which is what makes a pad a
   * measurable route rather than a speed-dependent gamble.
   */
  readonly boost: number;
}

/**
 * A stretch of world that is WIDER than the running corridor.
 *
 * The hangar is one by definition; the sentinel's bay and the turntable arena
 * are the others. Movement clamps to whatever this says, the floor is laid at
 * the same width, and the renderer builds its walls from the same list - so a
 * wide area cannot end up with a floor and a boundary that disagree.
 */
export interface WideArea {
  readonly minZ: number;
  readonly maxZ: number;
  readonly halfWidth: number;
}

/** One stage. */
export interface StageDefinition {
  /** 1-based, as shown on the gate. */
  readonly index: number;
  readonly name: string;
  readonly difficulty: string;
  /** Advisory only - shown on the gate, never enforced. */
  readonly recommendedLevel: number;
  /**
   * Lifetime Speed the recommended level corresponds to.
   *
   * DERIVED from `recommendedLevel` through the same curve the player actually
   * levels on, never authored beside it.
   */
  readonly recommendedSpeed: number;
  /**
   * Slot of the robot the stage is built for.
   *
   * Advisory, shown on the gate beside the level, and it is the frame whose
   * `moveBonus`/`jumpBonus` the stage's own gaps were measured against - so
   * the figures a stage is authored to and the figures it advertises are one
   * statement.
   */
  readonly recommendedRobot: number;
  readonly startZ: number;
  readonly endZ: number;
  /** Centre of the small win pad at the player's LEFT at the stage end. */
  readonly winPadX: number;
  readonly winPadZ: number;
  /** Centre of the RETURN pad at the player's RIGHT at the stage end. */
  readonly returnPadX: number;
  readonly returnPadZ: number;
  /** Wins awarded for reaching it. */
  readonly winReward: number;
}

/** Global world metrics. */
export const COURSE = {
  /**
   * Half-width of the running corridor.
   *
   * Every lateral position in the stages is expressed as a FRACTION of this
   * (see `lane`), so widening the world moves the obstacles with it instead of
   * leaving them clustered down the middle of a wider floor.
   */
  halfWidth: 46,
  /** Top of the course floor. Everything is measured from here. */
  floorY: 0,
  /** Thickness of a floor slab, so a slab has an underside to head-butt. */
  floorThickness: 6,
  /**
   * Height of the facility's bulkheads. Visual; the X clamp is what holds.
   *
   * ENORMOUS on purpose. A mech is nine units tall, so a wall at forty read as
   * a pen with a machine in it; at a hundred and ten the player cannot see the
   * top of it from the floor, which is the whole difference between standing
   * in a room and standing in a building.
   */
  wallHeight: 110,

  /**
   * The bottom of the world.
   *
   * A REAL surface, drawn under the whole map. Without it a fall shows the
   * underside of the course and an infinite void, which is what makes a world
   * look unfinished; with it, falling reads as dropping into a pit that was
   * always there.
   */
  pitFloorY: -34,

  /**
   * Hangar footprint.
   *
   * Wider than the previous game's lobby, because this one has to hold a
   * TWO-STOREY display deck down one side and a treadmill bay down the other
   * with open ground between them - and the open ground is the point.
   */
  lobbyHalfWidth: 94,
  lobbyStartZ: -172,
  lobbyEndZ: 0,

  /** Bridge from one stage's end to the next stage's run-up. */
  stageGap: 38,
  /** How many stages exist. */
  stageCount: 30,
} as const;

/**
 * Surface of a lava pool, relative to the floor it replaces.
 *
 * Deep enough that the platforms above it read as suspended, shallow enough
 * that the glow lights their undersides.
 */
const POOL_Y = -9;

interface StageTuning {
  readonly name: string;
  readonly difficulty: string;
  /**
   * Level the stage is built around.
   *
   * The ramp respects the rebirth ladder: the cap is 50 before any rebirth and
   * 25 more per rebirth after, so stage 5 at 22 is inside a first run, stage
   * 12 at 62 wants one rebirth, and stage 30 at 168 wants five. Nothing here
   * asks for a level the ladder cannot reach.
   */
  readonly recommendedLevel: number;
  /**
   * Slot of the robot the stage is tuned for.
   *
   * Read straight off the roster rather than invented here, so the gate
   * advertises a frame a player can actually go and buy, and the gap maths
   * uses that frame's own bonuses.
   */
  readonly recommendedRobot: number;
}

/**
 * What a mech can do on ONE JUMP.
 *
 * THE pair of numbers this whole course is authored against, and both are
 * derived rather than guessed: the impulse is `jumpVelocity`, gravity brings
 * it back in `2v/g` seconds, and the mech travels at its own run speed for
 * that whole time.
 *
 * The two behave DIFFERENTLY as a player progresses, and that asymmetry is
 * what this course's difficulty is built on:
 *
 *  - `reach` runs away. Travel speed is multiplied by level, by rebirth, by
 *    the robot and by the trail, so a late-game pilot covers a hundred and
 *    fifty units in one leap. Width alone therefore cannot be difficulty.
 *  - `rise` barely moves. Jump velocity is deliberately tuned to scale far
 *    more gently than travel speed (see `resolveMovementProfile`), and the
 *    height a leap reaches goes as its SQUARE over a fixed gravity - which
 *    works out at about seven units at the start of the game and fourteen at
 *    the end of it.
 *
 * So ELEVATION is the gate and width is the texture. Every step in this file
 * is sized against `rise` and every gap against `reach`, which is why a stage
 * stays exactly as hard to climb at level 160 as it was at level 20.
 */
interface Ballistic {
  /** Horizontal distance one jump covers. */
  readonly reach: number;
  /** Height one jump reaches. */
  readonly rise: number;
}

/**
 * The ballistic figures for a given profile.
 *
 * Exported so `verify-course` checks every gap against the same function that
 * authored it, rather than against a copy of the formula that is free to
 * drift.
 */
export const ballisticFor = (runSpeed: number, jumpVelocity: number): Ballistic => ({
  reach: runSpeed * ((2 * jumpVelocity) / MOVEMENT.gravity),
  rise: (jumpVelocity * jumpVelocity) / (2 * MOVEMENT.gravity),
});

/**
 * What a player the stage was BUILT FOR can do.
 *
 * Resolved from the stage's own advertised level and robot - the two figures
 * on its gate - through the same movement formula the simulation runs, so the
 * numbers a stage is authored against are the numbers the player it is
 * advertised to actually has. No trail is assumed: a stage must be clearable
 * by somebody who has bought none.
 */
const ballisticAtStage = (tuning: StageTuning): Ballistic => {
  const robot = robotForSlot(tuning.recommendedRobot);
  const profile = resolveMovementProfile(
    tuning.recommendedLevel,
    0,
    robot.moveBonus,
    robot.jumpBonus,
  );
  return ballisticFor(profile.moveSpeed, profile.jumpVelocity);
};

/** The base profile: level 1, no rebirths, the starter frame. */
const BASE_BALLISTIC: Ballistic = (() => {
  const starter = robotForSlot(1);
  const profile = resolveMovementProfile(1, 0, starter.moveBonus, starter.jumpBonus);
  return ballisticFor(profile.moveSpeed, profile.jumpVelocity);
})();

/**
 * The gap a stage should use, given how far through the ladder it is.
 *
 * Scaled from the BASE ballistic reach rather than the stage's own, and that
 * is deliberate: a stage-30 gap scaled to a level-168 leap would be a hundred
 * and fifty units across and the stage would be three thousand units long for
 * eight crossings. Width is the TEXTURE of a crossing - how committing it
 * feels - and `riseFor` is what makes it a crossing at all.
 *
 * The ceiling of 0.72 keeps every gap comfortably inside a beginner's own
 * leap, because a player who wandered into stage 25 should find it lethal, not
 * impassable.
 *
 * @param t 0 at the first stage, 1 at the last
 */
const gapFor = (t: number): number => BASE_BALLISTIC.reach * (0.42 + t * 0.3);

/**
 * The CLIMB a stage should use between two platforms.
 *
 * THE number that keeps this course fair. Scaled from the ballistic rise of
 * the player the stage is built for, and kept WELL under it: a step the
 * recommended pilot cannot make is a wall, not a stage, and there is no second
 * mechanic here to bail them out.
 *
 * Takes the stage's tuning rather than a fraction, because the rise it has to
 * fit inside depends on the profile the stage is played at and on nothing
 * else.
 */
const riseFor = (tuning: StageTuning): number => ballisticAtStage(tuning).rise * 0.42;

/**
 * Every stage, in one table.
 *
 * Name, difficulty word, recommended level and recommended ROBOT for all
 * thirty, so tuning the ladder is editing rows here rather than hunting
 * through builders. The gap and the climb each stage is built from are derived
 * from these rows through `gapFor` and `riseFor`, which is what keeps a
 * stage's difficulty and the figures on its gate the same statement.
 */
const STAGE_TUNING: readonly StageTuning[] = [
  { name: 'Mech Hangar Escape', difficulty: 'EASY', recommendedLevel: 1, recommendedRobot: 1 },
  { name: 'Reactor Platform', difficulty: 'EASY', recommendedLevel: 4, recommendedRobot: 1 },
  { name: 'Falling Machinery', difficulty: 'EASY', recommendedLevel: 8, recommendedRobot: 2 },
  { name: 'Industrial Maze', difficulty: 'EASY', recommendedLevel: 14, recommendedRobot: 2 },
  { name: 'Energy Bridge', difficulty: 'NORMAL', recommendedLevel: 22, recommendedRobot: 3 },
  { name: 'Reactor Core', difficulty: 'NORMAL', recommendedLevel: 30, recommendedRobot: 3 },
  { name: 'Moving Cargo Platforms', difficulty: 'NORMAL', recommendedLevel: 38, recommendedRobot: 3 },
  { name: 'Laser Grid Facility', difficulty: 'NORMAL', recommendedLevel: 46, recommendedRobot: 4 },
  { name: 'Mechanical Crusher Hall', difficulty: 'HARD', recommendedLevel: 54, recommendedRobot: 4 },
  { name: 'Suspended Factory', difficulty: 'HARD', recommendedLevel: 62, recommendedRobot: 4 },
  { name: 'Vertical Reactor Shaft', difficulty: 'HARD', recommendedLevel: 70, recommendedRobot: 5 },
  { name: 'Collapsing Platforms', difficulty: 'HARD', recommendedLevel: 78, recommendedRobot: 5 },
  { name: 'Giant Gear Facility', difficulty: 'HARD', recommendedLevel: 86, recommendedRobot: 5 },
  { name: 'Energy Conveyor', difficulty: 'INSANE', recommendedLevel: 94, recommendedRobot: 6 },
  { name: 'Mech Testing Chamber', difficulty: 'INSANE', recommendedLevel: 100, recommendedRobot: 6 },
  { name: 'Industrial Tunnel', difficulty: 'INSANE', recommendedLevel: 106, recommendedRobot: 6 },
  { name: 'Reactor Cooling Zone', difficulty: 'INSANE', recommendedLevel: 112, recommendedRobot: 7 },
  { name: 'Moving Wall Facility', difficulty: 'INSANE', recommendedLevel: 118, recommendedRobot: 7 },
  { name: 'Multi-Level Factory', difficulty: 'INSANE', recommendedLevel: 124, recommendedRobot: 7 },
  { name: 'Gravity Platform Section', difficulty: 'NIGHTMARE', recommendedLevel: 128, recommendedRobot: 8 },
  { name: 'Energy Core Maze', difficulty: 'NIGHTMARE', recommendedLevel: 132, recommendedRobot: 8 },
  { name: 'Giant Machinery Room', difficulty: 'NIGHTMARE', recommendedLevel: 136, recommendedRobot: 8 },
  { name: 'Mech Assembly Facility', difficulty: 'NIGHTMARE', recommendedLevel: 140, recommendedRobot: 9 },
  { name: 'Reactor Bridge', difficulty: 'NIGHTMARE', recommendedLevel: 144, recommendedRobot: 9 },
  { name: 'Vertical Hangar', difficulty: 'NIGHTMARE', recommendedLevel: 148, recommendedRobot: 9 },
  { name: 'Mechanical Gauntlet', difficulty: 'NIGHTMARE', recommendedLevel: 152, recommendedRobot: 10 },
  { name: 'Collapsing Factory', difficulty: 'NIGHTMARE', recommendedLevel: 156, recommendedRobot: 10 },
  { name: 'Core Defense Facility', difficulty: 'NIGHTMARE', recommendedLevel: 160, recommendedRobot: 11 },
  { name: 'Final Reactor', difficulty: 'NIGHTMARE', recommendedLevel: 164, recommendedRobot: 11 },
  { name: 'MECH ESCAPE', difficulty: 'NIGHTMARE', recommendedLevel: 168, recommendedRobot: 12 },
];

/**
 * Wins per stage.
 *
 * The ONE place a stage reward is written. Stage 1 pays 1 and stage 2 pays 3:
 * the first clear is a TOKEN - proof the loop works and the first Win in the
 * counter - and the ladder proper starts at stage 2 and climbs from there
 * without ever stepping down again. Anything past the table continues the same
 * accelerating curve, so a thirty-first stage needs no edit here.
 */
const STAGE_REWARDS = [
  1, 3, 8, 15, 25, 40, 60, 90,
  130, 180, 250, 350, 500, 700, 1_000, 1_400, 2_000, 2_800, 4_000, 5_600,
  8_000, 12_000, 18_000, 27_000, 40_000, 60_000, 90_000, 140_000, 220_000,
  350_000,
] as const;

export const stageReward = (index: number): number => {
  const at = Math.max(1, Math.floor(index));
  const authored = STAGE_REWARDS[at - 1];
  if (authored !== undefined) return authored;
  const last = STAGE_REWARDS[STAGE_REWARDS.length - 1] as number;
  return Math.round(last * 1.6 ** (at - STAGE_REWARDS.length));
};

/**
 * The win pad: small, rectangular, and at the player's LEFT at the stage end.
 *
 * LEFT is POSITIVE X in this game. The camera looks down +Z and its right is
 * `(-cos yaw, sin yaw)`, which at yaw 0 is world -X - so the player's left
 * hand points at +X. A pad authored at a negative X sits on the wrong side of
 * the screen however "left-hand" the number reads.
 */
export const WIN_PAD = {
  width: 17,
  length: 17,
  /** Distance in from the side wall. */
  insetX: 17,
  /** How far it stands proud of the deck, so it reads as a pad. */
  height: 0.5,
} as const;

/**
 * HEADROOM above the tallest thing in a stage, before the roof.
 *
 * Has to clear `MOUNT_HEIGHT` with room for a jump, or a player standing on
 * the highest platform in a stage would bang their pilot's head on its roof.
 */
const CEILING_CLEARANCE = 62;

/** Thickness of a roof slab, so it has an underside to head-butt. */
const CEILING_THICKNESS = 7;

/** First stage begins exactly where the hangar floor ends. */
const FIRST_STAGE_Z: number = COURSE.lobbyEndZ;

const solids: CourseSolid[] = [];
const wideAreas: WideArea[] = [];
const sinking: SinkingSolid[] = [];
const pools: HazardPool[] = [];
const hazards: CourseHazard[] = [];
const decorations: Decoration[] = [];
const surfaces: SurfaceRegion[] = [];
const stages: StageDefinition[] = [];

/**
 * A lateral position, as a fraction of the corridor's half-width.
 *
 * Every obstacle offset in this file goes through here. That is what makes the
 * world's width one number to change: authoring `-6.5` would have left the
 * platforms huddled in the middle the moment the corridor got wider.
 */
const lane = (fraction: number): number => COURSE.halfWidth * fraction;

/** Push a floor slab spanning the full corridor, or a given half-width. */
const pushFloor = (
  stage: number,
  fromZ: number,
  toZ: number,
  kind: SolidKind = 'floor',
  topY: number = COURSE.floorY,
  halfWidth: number = COURSE.halfWidth,
): void => {
  if (toZ <= fromZ) return;
  solids.push({
    minX: -halfWidth,
    maxX: halfWidth,
    minY: topY - COURSE.floorThickness,
    maxY: topY,
    minZ: fromZ,
    maxZ: toZ,
    kind,
    stage,
  });
};

/** Push an arbitrary box, given its centre and size. */
const pushBox = (
  stage: number,
  kind: SolidKind,
  centreX: number,
  baseY: number,
  centreZ: number,
  width: number,
  height: number,
  length: number,
): void => {
  solids.push({
    minX: centreX - width / 2,
    maxX: centreX + width / 2,
    minY: baseY,
    maxY: baseY + height,
    minZ: centreZ - length / 2,
    maxZ: centreZ + length / 2,
    kind,
    stage,
  });
};

/**
 * A SUSPENDED platform: a thin slab with nothing under it.
 *
 * The unit this whole course is built out of. `topY` is what the player stands
 * on and the slab hangs a little below it, so the thing reads as floating over
 * the pool rather than as a pillar rising out of it.
 */
const pushIsland = (
  stage: number,
  kind: SolidKind,
  centreX: number,
  topY: number,
  centreZ: number,
  width: number,
  length: number,
  thickness = 1.6,
): void => {
  pushBox(stage, kind, centreX, topY - thickness, centreZ, width, thickness, length);
};

/**
 * Floor for a stage that is WIDER than the corridor, and the boundary to go
 * with it.
 *
 * One call, because these two facts must never be written separately: a floor
 * laid at 54 with a clamp still at 32 is a room the player cannot walk into,
 * and a clamp at 54 with a floor at 32 is a room they fall out of.
 */
const markWide = (fromZ: number, toZ: number, halfWidth: number): void => {
  wideAreas.push({ minZ: fromZ, maxZ: toZ, halfWidth });
};

const pushWideFloor = (
  stage: number,
  fromZ: number,
  toZ: number,
  halfWidth: number,
  kind: SolidKind = 'floor',
  topY: number = COURSE.floorY,
): void => {
  pushFloor(stage, fromZ, toZ, kind, topY, halfWidth);
  markWide(fromZ, toZ, halfWidth);
};

/**
 * A pool of lava, void or coolant filling the corridor between two Z.
 *
 * The counterpart to `pushIsland`: one call lays the thing that kills and the
 * platforms are placed over it. A stretch of course with islands and no pool
 * would be a drop to the pit floor and a long walk back; a pool with no
 * islands is a wall.
 */
const pushPool = (
  stage: number,
  fromZ: number,
  toZ: number,
  surface: HazardPool['surface'] = 'lava',
  halfWidth: number = COURSE.halfWidth,
): void => {
  pools.push({
    stage,
    surface,
    minX: -halfWidth,
    maxX: halfWidth,
    minZ: fromZ,
    maxZ: toZ,
    surfaceY: COURSE.floorY + POOL_Y,
    deathY: COURSE.floorY + POOL_Y - 1.4,
  });
};

/**
 * A rotating arm: a row of hazard balls stepped out along one radius.
 *
 * Each ball orbits the same centre at the same rate with the same phase, so
 * together they sweep as one rigid bar - which is what a beam, a turntable arm
 * and a laser lance all are. Built from the existing orbit rather than from a
 * new "bar" primitive, so there is still exactly one hazard shape to test
 * against and the whole thing stays a pure function of time.
 *
 * @param inner first radius to place a ball at, so a hub can be left clear
 */
const pushSpinArm = (
  stage: number,
  kind: HazardKind,
  centreX: number,
  centreZ: number,
  y: number,
  inner: number,
  outer: number,
  ballRadius: number,
  rate: number,
  phase: number,
): void => {
  // Spaced by a little under a diameter, so the arm is continuous and a mech
  // can never thread between two balls of the same bar.
  const step = ballRadius * 1.5;
  for (let r = inner; r <= outer + 0.01; r += step) {
    hazards.push({
      kind,
      stage,
      x: centreX,
      y,
      z: centreZ,
      radius: ballRadius,
      sweep: r,
      rate,
      phase,
      fromZ: 0,
      toZ: 0,
    });
  }
};

/** One thing that falls out of the dark onto a fixed spot and comes back. */
const pushFaller = (
  stage: number,
  x: number,
  z: number,
  radius: number,
  height: number,
  period: number,
  phase: number,
  baseY: number = COURSE.floorY,
): void => {
  hazards.push({
    kind: 'faller',
    stage,
    x,
    // Resting height: sitting ON the floor, so the impact lands where the
    // shadow was rather than a body-length above it.
    y: baseY + radius,
    z,
    radius,
    sweep: height,
    rate: period,
    phase,
    fromZ: 0,
    toZ: 0,
  });
};

/**
 * A BED OF EMITTERS: a row of static killers across part of the corridor.
 *
 * The course's basic punctuation, and the reason a low platform is not
 * automatically a safe one. Laid as several overlapping spheres rather than
 * one wide box because the collision model already tests spheres and a bed
 * that used a new shape would be a new thing to get wrong.
 */
const pushSpikeBed = (
  stage: number,
  centreX: number,
  z: number,
  width: number,
  y: number = COURSE.floorY,
): void => {
  const radius = 2.2;
  const count = Math.max(1, Math.round(width / (radius * 1.6)));
  const step = count > 1 ? width / (count - 1) : 0;
  for (let i = 0; i < count; i += 1) {
    const x = centreX - width / 2 + step * i;
    hazards.push({
      kind: 'spike',
      stage,
      x,
      // Sitting ON the surface, so a mech clearing the tips lives.
      y: y + radius * 0.75,
      z,
      radius,
      sweep: 0,
      rate: 0,
      phase: 0,
      fromZ: 0,
      toZ: 0,
    });
  }
};

/** A patch of ground that handles differently: polish, a conveyor, a pad. */
const pushSurface = (
  stage: number,
  fromZ: number,
  toZ: number,
  halfWidth: number,
  grip: number,
  windX = 0,
  windZ = 0,
  boost = 0,
  centreX = 0,
): void => {
  surfaces.push({
    stage,
    minX: centreX - halfWidth,
    maxX: centreX + halfWidth,
    minZ: fromZ,
    maxZ: toZ,
    grip,
    windX,
    windZ,
    boost,
  });
};

/**
 * A LAUNCH PAD: a small square of floor that throws the mech upward.
 *
 * `boost` is a velocity, so the height it reaches is `boost^2 / 2g` and the
 * distance it covers is that airtime at whatever speed the mech arrived with.
 * Authored as a MULTIPLE of the stage's own jump velocity, which is what keeps
 * a pad a shortcut rather than a teleport at every point on the ladder.
 */
const pushLaunchPad = (
  stage: number,
  x: number,
  z: number,
  size: number,
  boost: number,
): void => {
  pushBox(stage, 'rune', x, COURSE.floorY - 0.3, z, size, 0.4, size);
  surfaces.push({
    stage,
    minX: x - size / 2,
    maxX: x + size / 2,
    minZ: z - size / 2,
    maxZ: z + size / 2,
    grip: 1,
    windX: 0,
    windZ: 0,
    boost,
  });
};

/** A wall strip light at a given Z, on both sides. Pure decoration. */
const pushWallTorches = (stage: number, fromZ: number, toZ: number, spacing = 30): void => {
  for (let z = fromZ + spacing / 2; z < toZ; z += spacing) {
    for (const side of [-1, 1]) {
      decorations.push({
        kind: 'torch',
        stage,
        x: side * (COURSE.halfWidth - 1.6),
        y: COURSE.floorY + 10,
        z,
        scale: 1.4,
        rotationY: side > 0 ? -Math.PI / 2 : Math.PI / 2,
      });
    }
  }
};

/**
 * Lay a ROOF over a stretch of the world.
 *
 * Placed per stage at whatever that stage's own tallest platform is, plus
 * `CEILING_CLEARANCE`. Per stage rather than one flat slab, deliberately: a
 * corridor stage tops out at seven units and a tower at a hundred and ninety,
 * and a roof high enough for the tower would be no roof at all over the
 * corridor.
 *
 * It is never stood on and never bumped into sideways: `resolveAxis` skips any
 * solid whose underside is above the rider's head, and `surfaceYAt` only
 * offers surfaces within a step of the feet. Its ONLY role is to be what
 * `resolveCeiling` stops a climb against - and to give the strip lighting
 * something to hang from.
 */
const pushCeiling = (
  stage: number,
  fromZ: number,
  toZ: number,
  topY: number,
  halfWidth: number,
): void => {
  if (toZ <= fromZ) return;
  const base = topY + CEILING_CLEARANCE;
  solids.push({
    // Wider than the corridor, so the roof meets the walls rather than
    // stopping short of them and leaving a slot of sky down each side.
    minX: -halfWidth - 4,
    maxX: halfWidth + 4,
    minY: base,
    maxY: base + CEILING_THICKNESS,
    minZ: fromZ,
    maxZ: toZ,
    kind: 'ceiling',
    stage,
  });
};

// ---------------------------------------------------------------------------
// The hangar.
//
// LEFT (+X): the two-storey robot display deck. RIGHT (-X): the treadmill bay.
// Straight ahead: the lit course entrance, with the two scoreboards framing
// it. The middle is deliberately open - it is what the room is for.
// ---------------------------------------------------------------------------

solids.push({
  minX: -COURSE.lobbyHalfWidth,
  maxX: COURSE.lobbyHalfWidth,
  minY: COURSE.floorY - COURSE.floorThickness,
  maxY: COURSE.floorY,
  minZ: COURSE.lobbyStartZ,
  maxZ: COURSE.lobbyEndZ,
  kind: 'lobby',
  stage: -1,
});

/**
 * THE DISPLAY DECK, down the player's LEFT wall.
 *
 * That wall is at +X, not -X. The camera looks down +Z and its right is
 * `(-cos yaw, sin yaw)`, which at yaw 0 is world -X - so the player's left
 * hand points at +X.
 *
 * TWO STOREYS, five robots each, stepped back like stadium seating rather than
 * stacked as a balcony. That choice is load-bearing twice over: a balcony
 * directly over the lower row would put its underside inside the head of every
 * mech standing beneath it - `MOUNT_HEIGHT` is 7.8 and a plinth adds more -
 * and a row hidden under an overhang is a row nobody in the middle of the
 * hangar can see. Stepped back, both rows are in one shot from the spawn
 * point, which is the whole reason a shop is a PLACE in this game.
 *
 * Ten plinths, for slots 1-10. Slots 11 and 12 are bought from the mech panel
 * on the HUD rail: adding two more plinths would either crowd the row or need
 * a third storey, and the panel is the same purchase going through the same
 * server authority.
 */
export const STAND_ROW = {
  /** X of every lower-bay plinth, and the deck it stands on. */
  x: 51,
  lowerMinX: 36,
  lowerMaxX: 66,
  /** Lower deck top. A shallow step, inside the simulation's step height. */
  lowerY: 1.2,

  /** X of every upper-bay plinth, and the gantry it stands on. */
  upperX: 80,
  upperMinX: 66,
  upperMaxX: 94,
  /** Upper gantry top, reached by a stair at each end of the gallery. */
  upperY: 15,

  /**
   * Z of the first bay on each level, and the spacing along the wall.
   *
   * The two decks share their Z line, so a bay and the bay above it are one
   * column - which is what makes the gallery read as a two-storey building
   * rather than as two unrelated rows. The spacing is comfortably wider than a
   * plinth so no machine ever stands in front of its neighbour, and the row is
   * centred on the spawn point: a player who has just arrived is looking
   * straight down the middle of it.
   */
  firstZ: -146,
  spacingZ: 23,
  /** How many bays each level carries. */
  perDeck: 5,

  /*
   * THE TWO STAIRWAYS, one at each end of the gallery.
   *
   * Both climb along +X - out of the room and up to the upper deck - so a
   * player walks UP THE SCREEN toward the machines rather than across it. The
   * single flight this replaced ran along Z behind the far end of the deck,
   * which from anywhere in the hangar read as a staircase going sideways to
   * nowhere, and left half the gallery a long walk from the only way up.
   *
   * Two flights also make the structure symmetrical, which is most of why it
   * reads as a built thing: the gallery has an end, a way up at each end, and
   * five bays between them on both levels.
   */
  stairMinX: 34,
  stairMaxX: 66,
  /** Z extent of each flight. Wide enough to walk up without aiming. */
  stairWidth: 13,
  /**
   * Centre Z of the flight at the back of the hangar, and of the front one.
   *
   * Both sit OUTSIDE the bay row and INSIDE the gallery floor, which is the
   * only arrangement that works: a flight inside the row would climb through a
   * plinth, and one past the end of the floor would top out over thin air.
   * `standDeckMinZ`/`standDeckMaxZ` below are derived from these, so the deck
   * always reaches its own landings.
   */
  stairBackZ: -164.5,
  stairFrontZ: -35,

  width: 13,
  length: 13,
  height: 1,
  /** How close the player must be to claim from a bay. */
  claimRadius: 6.5,
} as const;

/**
 * Z span of the upper gallery floor, LANDINGS INCLUDED.
 *
 * Derived rather than authored, because the one thing that must never be true
 * of this deck is that a staircase tops out beside it instead of on it. The
 * floor runs from the back flight's landing to the front flight's, so both
 * stairs arrive on solid deck and the whole gallery is one continuous walkway.
 */
export const standDeckMinZ = STAND_ROW.stairBackZ - STAND_ROW.stairWidth / 2;
export const standDeckMaxZ = STAND_ROW.stairFrontZ + STAND_ROW.stairWidth / 2;

/** How many robots have a physical plinth. The rest are panel-only. */
export const DISPLAYED_ROBOTS = STAND_ROW.perDeck * 2;

/** True when this 1-based slot has a plinth on the display deck. */
export const hasStand = (slot: number): boolean =>
  Math.floor(slot) >= 1 && Math.floor(slot) <= DISPLAYED_ROBOTS;

/** Centre Z of the plinth for a 1-based robot slot. */
export const standZ = (slot: number): number => {
  const index = (Math.max(1, Math.floor(slot)) - 1) % STAND_ROW.perDeck;
  return STAND_ROW.firstZ + index * STAND_ROW.spacingZ;
};

/** Centre X of the plinth for a 1-based robot slot: which storey it is on. */
export const standX = (slot: number): number =>
  Math.max(1, Math.floor(slot)) <= STAND_ROW.perDeck ? STAND_ROW.x : STAND_ROW.upperX;

/** Deck height the plinth for a 1-based robot slot stands on. */
export const standDeckY = (slot: number): number =>
  Math.max(1, Math.floor(slot)) <= STAND_ROW.perDeck
    ? STAND_ROW.lowerY
    : STAND_ROW.upperY;

/**
 * THE TREADMILL BAY, on the player's RIGHT.
 *
 * THREE IDENTICAL BELTS, and identical is the entire point: a treadmill here
 * is somewhere to farm while chatting, not a ladder, so there is nothing to
 * choose between them, no level gate and NO MULTIPLIER. Running a belt pays
 * exactly what walking the same distance pays, through the same per-stride
 * formula - which is the specification and also the only way the two can be
 * guaranteed not to drift apart.
 *
 * The belts run along X with their consoles at the +X end, so a runner faces
 * back toward the spawn point in the middle of the hangar. Building the belt
 * along Z instead is what made an earlier game's first version read as a row
 * of beds.
 */
export const TRAINING = {
  /** Raised test-bay deck, on the player's RIGHT - which is -X. */
  minX: -90,
  maxX: -30,
  minZ: -138,
  maxZ: -30,
  /** Deck top. A shallow step, inside the simulation's step height. */
  deckY: 1.2,

  /** Tread footprint. The tread runs along X; the rigs step along Z. */
  beltLength: 26,
  beltWidth: 15,
  /** Walkable height of a tread above the deck. */
  beltHeight: 0.7,
  /** X of every rig: one column, because there is only one kind. */
  columnX: -60,
  /** Z of the first rig and the spacing between them. */
  firstZ: -118,
  spacingZ: 38,
  /** How many rigs there are. */
  count: 3,

  /**
   * Belt speed, in world units per second.
   *
   * A treadmill has no position delta to measure, so the BELT supplies the
   * distance and it flows through the identical per-stride formula. Set to the
   * base run speed, so a belt pays what running the hangar floor pays and the
   * two really are one progression rather than two that happen to look alike.
   */
  beltSpeed: MOVEMENT.moveSpeed,
} as const;

/** How many belts there are. Named for the call sites that read it. */
export const TREADMILL_COUNT = TRAINING.count;

/** Centre Z of a 1-based belt index. */
export const treadmillZ = (index: number): number =>
  TRAINING.firstZ + (Math.max(1, Math.floor(index)) - 1) * TRAINING.spacingZ;

/** Centre X of a 1-based belt index. One column, so they all share it. */
export const treadmillX = (_index: number): number => TRAINING.columnX;

/** Walkable height of every treadmill belt. */
export const TREADMILL_BELT_Y = TRAINING.deckY + TRAINING.beltHeight;

/** Nobody is on a treadmill. */
export const NO_TREADMILL = 0;

/**
 * Which treadmill a position is standing on, or 0.
 *
 * Derived from position ALONE, by both sides, every step. There is no
 * treadmill message: walking on starts it and walking off stops it, so there
 * is nothing for a client to claim and nothing to keep after stepping off.
 *
 * It checks no level and looks up no tier, because there are none: every belt
 * is the same belt and pays the same rate to everybody.
 */
export const treadmillAt = (x: number, y: number, z: number): number => {
  if (y < TREADMILL_BELT_Y - 1.6 || y > TREADMILL_BELT_Y + 4) return NO_TREADMILL;
  if (Math.abs(x - TRAINING.columnX) > TRAINING.beltLength / 2) return NO_TREADMILL;
  for (let index = 1; index <= TREADMILL_COUNT; index += 1) {
    if (Math.abs(z - treadmillZ(index)) > TRAINING.beltWidth / 2) continue;
    return index;
  }
  return NO_TREADMILL;
};

// The treadmill deck and its three belts are real solids, so the player walks
// onto them the same way they walk onto anything else.
solids.push({
  minX: TRAINING.minX,
  maxX: TRAINING.maxX,
  minY: COURSE.floorY - COURSE.floorThickness,
  maxY: TRAINING.deckY,
  minZ: TRAINING.minZ,
  maxZ: TRAINING.maxZ,
  kind: 'training',
  stage: -1,
});

for (let i = 1; i <= TREADMILL_COUNT; i += 1) {
  pushBox(
    -1,
    'training',
    treadmillX(i),
    TRAINING.deckY,
    treadmillZ(i),
    TRAINING.beltLength,
    TRAINING.beltHeight,
    TRAINING.beltWidth,
  );
}

// The two display decks. The lower one is a step; the upper one is a storey,
// reached by the stair at the back.
solids.push({
  minX: STAND_ROW.lowerMinX,
  maxX: STAND_ROW.lowerMaxX,
  minY: COURSE.floorY - COURSE.floorThickness,
  maxY: STAND_ROW.lowerY,
  minZ: STAND_ROW.firstZ - STAND_ROW.spacingZ / 2,
  maxZ: STAND_ROW.firstZ + (STAND_ROW.perDeck - 0.5) * STAND_ROW.spacingZ,
  kind: 'training',
  stage: -1,
});
solids.push({
  minX: STAND_ROW.upperMinX,
  maxX: STAND_ROW.upperMaxX,
  minY: STAND_ROW.upperY - 3.5,
  maxY: STAND_ROW.upperY,
  // Long enough to carry both landings, so each stairway arrives ON the deck.
  // Long enough to carry both landings, so each stairway arrives ON the deck.
  minZ: standDeckMinZ,
  maxZ: standDeckMaxZ,
  kind: 'training',
  stage: -1,
});

/*
 * THE TWO STAIRWAYS to the upper deck, one at each end of the gallery.
 *
 * Risers under `MOVEMENT.stepHeight`, so a mech WALKS up rather than having to
 * jump each step. One tall box would be a wall: the simulation steps over a
 * kerb and not over a storey, and that is exactly the distinction a staircase
 * exists to respect.
 *
 * Both flights climb along +X, from the open floor at the front of the deck up
 * to the gantry at the back of it, so the player walks toward the machines as
 * they rise. Built from the SAME numbers twice rather than authored separately:
 * two staircases that could drift apart are two bugs waiting to happen.
 */
for (const centreZ of [STAND_ROW.stairBackZ, STAND_ROW.stairFrontZ]) {
  const rise = STAND_ROW.upperY - COURSE.floorY;
  const steps = Math.ceil(rise / 1.05);
  const tread = (STAND_ROW.stairMaxX - STAND_ROW.stairMinX) / steps;
  for (let i = 0; i < steps; i += 1) {
    const top = COURSE.floorY + ((i + 1) / steps) * rise;
    solids.push({
      minX: STAND_ROW.stairMinX + i * tread,
      maxX: STAND_ROW.stairMinX + (i + 1) * tread,
      minY: COURSE.floorY - COURSE.floorThickness,
      maxY: top,
      minZ: centreZ - STAND_ROW.stairWidth / 2,
      maxZ: centreZ + STAND_ROW.stairWidth / 2,
      kind: 'training',
      stage: -1,
    });
  }
}

// The ten display plinths, five to a storey.
for (let slot = 1; slot <= DISPLAYED_ROBOTS; slot += 1) {
  pushBox(
    -1,
    'stand',
    standX(slot),
    standDeckY(slot),
    standZ(slot),
    STAND_ROW.width,
    STAND_ROW.height,
    STAND_ROW.length,
  );
}

/*
 * The hangar's roof.
 *
 * High enough to clear the upper display deck and the scoreboards at the
 * entrance, and low enough that the starting room reads as a room.
 */
pushCeiling(-1, COURSE.lobbyStartZ, COURSE.lobbyEndZ, 40, COURSE.lobbyHalfWidth);

// Floor beacons down the middle of the hangar, so the open ground is lit by
// something and the walk to the entrance has a line to follow.
for (let z = COURSE.lobbyStartZ + 26; z < COURSE.lobbyEndZ - 14; z += 34) {
  for (const side of [-1, 1]) {
    decorations.push({
      kind: 'brazier',
      stage: -1,
      x: side * 24,
      y: COURSE.floorY,
      z,
      scale: 1.3,
      rotationY: 0,
    });
  }
}

// ---------------------------------------------------------------------------
// The stages.
// ---------------------------------------------------------------------------

/** Solid floor at the start of every stage, to land and re-aim on. */
const START_RUNWAY = 40;

/** Solid floor leading to the finish pads. */
const FINISH_APRON = 40;

/**
 * A CHAIN OF SUSPENDED ISLANDS over a pool - the course's primary pattern.
 *
 * Four numbers decide everything about it. The gap is a fraction of a leap, so
 * crossing is a real commitment without being a coin flip. The rise means the
 * far side is also HIGHER, which is the part a faster mech cannot simply
 * outrun: jump height barely scales with the movement multiplier while travel
 * speed runs away, so elevation is what keeps a late-game player reading the
 * stage rather than skidding over it.
 *
 * @returns the Z and Y the chain ends at
 */
const pushIslandChain = (
  stage: number,
  fromZ: number,
  count: number,
  gap: number,
  rise: number,
  options: {
    readonly island?: number;
    readonly width?: number;
    readonly kind?: SolidKind;
    readonly startY?: number;
    readonly zigzag?: number;
    readonly surface?: HazardPool['surface'];
  } = {},
): { z: number; y: number } => {
  const island = options.island ?? 13;
  const width = options.width ?? lane(0.55);
  const kind = options.kind ?? 'rune';
  const zigzag = options.zigzag ?? 0;
  let y = options.startY ?? COURSE.floorY;
  let at = fromZ;

  pushPool(stage, fromZ, fromZ + count * (island + gap), options.surface ?? 'lava');

  for (let i = 0; i < count; i += 1) {
    at += gap;
    /*
     * The climb varies in SIZE but never in direction.
     *
     * A downward crossing is one gravity makes for free, so a chain that
     * stepped down every fourth island would stop asking for a jump every
     * fourth gap. The rhythm comes from a SHORT step among long ones instead -
     * still a route through a broken deck rather than a staircase.
     */
    y += rise * (i % 4 === 3 ? 0.55 : 1);
    const x = zigzag === 0 ? 0 : lane(zigzag) * (i % 2 === 0 ? 1 : -1);
    pushIsland(stage, kind, x, y, at + island / 2, width, island);
    at += island;
  }
  return { z: at, y };
};

/**
 * A way back DOWN to floor level, so a stage that climbed can finish.
 *
 * A chain that ended ninety units up would drop the player into the finish
 * apron from a height they cannot aim through, and a finish arrived at by
 * falling is a finish that cannot be missed on purpose - which is worse, not
 * better, because the pads are off to the sides and have to be walked to.
 *
 * Two shapes, chosen by how far there is to come down, and the split is the
 * point: a short drop is STAIRS the mech walks straight over, because the
 * simulation steps over a kerb and not over a storey. A long one is a flight
 * of wide catch ledges, each within a free fall of the last.
 *
 * @returns the Z the descent ends at
 */
const pushDescent = (
  stage: number,
  fromZ: number,
  fromY: number,
  toY: number,
  width: number = COURSE.halfWidth * 2,
): number => {
  const drop = fromY - toY;
  if (drop <= 0.01) return fromZ;

  // A short step down: a real flight of stairs, walked rather than fallen.
  if (drop <= 14) {
    const rise = 1.05;
    const tread = 3.8;
    const count = Math.max(1, Math.ceil(drop / rise));
    for (let i = 0; i < count; i += 1) {
      const top = fromY - ((i + 1) / count) * drop;
      pushBox(
        stage,
        'stone',
        0,
        COURSE.floorY - COURSE.floorThickness,
        fromZ + tread / 2 + i * tread,
        width,
        top - (COURSE.floorY - COURSE.floorThickness),
        tread,
      );
    }
    return fromZ + count * tread;
  }

  // A long way down: wide ledges, a free fall apart. Falling costs nothing and
  // there is no fall damage in this game, so this is a descent the player can
  // take at their own pace.
  const stepDown = 16;
  const ledge = 29;
  const count = Math.ceil(drop / stepDown);
  let y = fromY;
  let at = fromZ;
  for (let i = 0; i < count; i += 1) {
    y = i === count - 1 ? toY : y - stepDown;
    pushIsland(stage, 'stone', 0, y, at + ledge / 2, width * 0.55, ledge, 1.8);
    at += ledge;
  }
  return at;
};

/**
 * One SHUTTER: a full-height block that drops into the floor and comes back.
 *
 * The game's timed door, and it is the sinking platform seen from the side -
 * there is deliberately no door primitive. `depth` is its own height, so when
 * it is down the top is flush with the deck and the mech walks straight over
 * it.
 */
const pushShutter = (
  stage: number,
  x: number,
  z: number,
  width: number,
  height: number,
  cycle: number,
  phase: number,
): void => {
  sinking.push({
    minX: x - width / 2,
    maxX: x + width / 2,
    minY: COURSE.floorY,
    maxY: COURSE.floorY + height,
    minZ: z - 2,
    maxZ: z + 2,
    kind: 'metal',
    stage,
    cycle,
    phase,
    steady: cycle * 0.4,
    warn: cycle * 0.14,
    sunk: cycle * 0.26,
    depth: height,
  });
};

/**
 * A field of TILES that sink in an alternating pattern.
 *
 * Every tile's phase comes from `(row + column) % groups`, so the safe set
 * changes with a chequerboard rhythm the player can read a beat ahead - which
 * is what makes it a sequence to learn rather than a field to guess at.
 */
const pushPulseTiles = (
  stage: number,
  fromZ: number,
  rows: number,
  columns: number,
  tile: number,
  groups: number,
  cycle: number,
  y: number = COURSE.floorY,
): number => {
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const x = lane(-0.8 + (1.6 / (columns - 1)) * column);
      const z = fromZ + row * tile + tile / 2;
      sinking.push({
        minX: x - tile * 0.46,
        maxX: x + tile * 0.46,
        minY: y - 1.4,
        maxY: y,
        minZ: z - tile * 0.46,
        maxZ: z + tile * 0.46,
        kind: 'sinking',
        stage,
        cycle,
        phase: ((row + column) % groups) * (cycle / groups),
        steady: cycle / groups,
        warn: 0.55,
        sunk: cycle - cycle / groups - 1,
        depth: 14,
      });
    }
  }
  return fromZ + rows * tile;
};

/**
 * Stage 1 - ESCAPE.
 *
 * The stage that has to teach the whole game in ten seconds, and it teaches it
 * with nothing but floating blocks over glowing lava. Jump, land, jump again,
 * cross the pads at the end. The blocks are deliberately generous - wide, long,
 * close in height - because the lesson is the CONTROL, not the landing.
 */
const buildEscape = (stage: number, z: number, t: number, tuning: StageTuning): number => {
  const end = pushIslandChain(stage, z, 6, gapFor(t), riseFor(tuning), {
    island: 26.1,
    width: lane(0.85),
  });
  pushWallTorches(stage, z, end.z, 26);
  return pushDescent(stage, end.z, end.y, COURSE.floorY);
};

/**
 * Stage 2 - SKYFALL.
 *
 * Huge blocks falling out of the dark onto a solid floor. They move SLOWLY and
 * they hover for most of their cycle, and the gaps between the columns are
 * wide - so the whole stage is a walk the player can time rather than a
 * reflex test. It is the second thing the game teaches: watch the shadow.
 */
const buildSkyfall = (stage: number, z: number, t: number): number => {
  const length = 304.5;
  pushFloor(stage, z, z + length);
  for (let i = 0; i < 7; i += 1) {
    const at = z + 22 + i * 27;
    // Two per row and well apart, so there is always a lane straight through.
    for (const side of [-1, 1]) {
      pushFaller(stage, side * lane(0.42), at, 6.5, 34, 5.2, i * 0.9 + (side > 0 ? 0 : 2.6));
    }
  }
  pushWallTorches(stage, z, z + length, 24);
  return z + length;
};

/**
 * Stage 3 - GRID MAZE.
 *
 * Neon walls on a grid, with exactly one way through and several that look
 * like one. Flat, so nothing here is about jumping: it is about reading the
 * lit floor strips, which run along the through-route and stop at every dead
 * end.
 */
const buildGridMaze = (stage: number, z: number, t: number): number => {
  const cell = 23.2;
  const rows = 12;
  const length = rows * cell;
  pushFloor(stage, z, z + length);

  // The route weaves between five lanes; the walls are what is left over.
  const route = [0, 1, 1, 2, 2, 1, 0, -1, -1, -2, -1, 0];
  for (let row = 0; row < rows; row += 1) {
    const open = route[row] ?? 0;
    for (let column = -2; column <= 2; column += 1) {
      if (column === open) continue;
      pushBox(
        stage,
        'pillar',
        lane(column * 0.36),
        COURSE.floorY,
        z + row * cell + cell / 2,
        cell * 0.72,
        // Well above a jump, so a wall is a wall at every level.
        26,
        3,
      );
    }
    // The lit strip along the open cell, so the route is readable.
    decorations.push({
      kind: 'crystal',
      stage,
      x: lane(open * 0.36),
      y: COURSE.floorY + 7,
      z: z + row * cell + cell / 2,
      scale: 1.1,
      rotationY: 0,
    });
  }
  return z + length;
};

/**
 * Stage 4 - DRIFT DECK.
 *
 * Moving neon platforms. The platforms themselves are static geometry and the
 * MOVEMENT is in what runs between them: rows of sweepers crossing the lanes
 * the player has to stand in. Built this way on purpose - a platform that
 * really translated would need replicated state, and this course has none.
 */
const buildDriftDeck = (stage: number, z: number, t: number, tuning: StageTuning): number => {
  const gap = gapFor(t);
  const rise = riseFor(tuning);
  const end = pushIslandChain(stage, z, 7, gap, rise, {
    island: 21.8,
    width: lane(0.4),
    zigzag: 0.45,
  });
  for (let i = 0; i < 6; i += 1) {
    hazards.push({
      kind: 'sweeper',
      stage,
      x: 0,
      y: COURSE.floorY + 2.4 + i * rise,
      z: z + gap + 8 + i * (gap + 15),
      radius: 3.2,
      sweep: lane(0.8),
      rate: 1.1 + i * 0.08,
      phase: i * 1.2,
      fromZ: 0,
      toZ: 0,
    });
  }
  return pushDescent(stage, end.z, end.y, COURSE.floorY);
};

/**
 * Stage 5 - SENTINEL BAY.
 *
 * A wide hall with the hangar's SENTINEL in it: a derelict heavy mech that
 * patrols, notices, and charges. The one stage where the answer is to stay OFF
 * the floor - raised wreckage and gantry arches let a player who reads the
 * room cross without ever being reachable.
 */
const RUINS = { halfWidth: 78, length: 362.5 } as const;

/**
 * The sentinel's hall, DERIVED from the floor that is laid for it below.
 *
 * Written once by `buildSentinelBay` while this module is still evaluating,
 * which is why the Z fields are mutable and start at zero: the arena's extent
 * is whatever the build cursor happened to reach, and a hand-written pair here
 * would be free to disagree with the floor.
 */
export const RUINS_ARENA: { minZ: number; maxZ: number; readonly halfWidth: number } = {
  minZ: 0,
  maxZ: 0,
  halfWidth: RUINS.halfWidth,
};

const pushArch = (stage: number, x: number, z: number, height = 14): void => {
  const legWidth = 4;
  const span = 23.2;
  for (const side of [-1, 1]) {
    pushBox(stage, 'ruin', x + side * (span / 2), COURSE.floorY, z, legWidth, height, legWidth);
  }
  pushBox(stage, 'ruin', x, COURSE.floorY + height, z, span + legWidth, 3, legWidth);
  decorations.push({ kind: 'arch', stage, x, y: COURSE.floorY, z, scale: 1, rotationY: 0 });
};

const buildSentinelBay = (
  stage: number,
  z: number,
  t: number,
  tuning: StageTuning,
): number => {
  const half = RUINS.halfWidth;
  const length = RUINS.length;
  pushWideFloor(stage, z, z + length, half);

  // The territory is DERIVED from the floor rather than authored beside it: a
  // sentinel whose patrol range and whose floor disagree is one that walks off
  // the edge of its own stage.
  RUINS_ARENA.minZ = z;
  RUINS_ARENA.maxZ = z + length;

  const rise = riseFor(tuning);
  for (let row = 0; row < 6; row += 1) {
    const at = z + 24 + row * 38;
    for (const side of [-1, 1]) {
      pushArch(stage, side * (18 + (row % 2) * 14), at, 14 + t * 6);
      // Wreckage to climb: the HIGH ROUTE, out of the sentinel's reach and
      // reachable in two hops from the floor.
      pushIsland(stage, 'ruin', side * (half - 14), COURSE.floorY + rise, at + 8, 14, 14);
      pushIsland(
        stage,
        'ruin',
        side * (half - 14),
        COURSE.floorY + rise * 2.1 + row * 0.8,
        at + 24,
        14,
        14,
      );
      decorations.push({
        kind: 'rock',
        stage,
        x: side * (half - 28),
        y: COURSE.floorY,
        z: at + 8,
        scale: 1.5,
        rotationY: row,
      });
    }
    decorations.push({
      kind: 'brazier',
      stage,
      x: 0,
      y: COURSE.floorY,
      z: at,
      scale: 1.5,
      rotationY: 0,
    });
  }
  return z + length;
};

/**
 * Stage 6 - BEAM ARRAY.
 *
 * Rotating beams over a solid floor, each a rigid bar sweeping a whole lane.
 * There is nothing to fall into: the stage is about TIMING a walk, which is
 * the mechanic every later rotating stage is built on and the one that has to
 * be learned somewhere safe.
 */
const buildBeamArray = (stage: number, z: number, t: number): number => {
  const length = 290;
  pushFloor(stage, z, z + length);
  for (let i = 0; i < 7; i += 1) {
    const at = z + 22 + i * 25;
    pushSpinArm(
      stage,
      'spinner',
      0,
      at,
      COURSE.floorY + 3.2,
      4,
      lane(0.78),
      2.6,
      1.0 + i * 0.09 + t * 0.4,
      i * 0.85,
    );
    decorations.push({
      kind: 'chain',
      stage,
      x: 0,
      y: COURSE.floorY + 26,
      z: at,
      scale: 1.4,
      rotationY: 0,
    });
  }
  pushWallTorches(stage, z, z + length, 22);
  return z + length;
};

/**
 * Stage 7 - GATE RUN.
 *
 * Timed doors. Ranks of shutters drop into the deck and rise again, staggered
 * so a player who keeps moving at a steady pace passes through every one - and
 * a player who sprints arrives at a closed gate and waits. The first stage
 * whose answer is to go SLOWER.
 */
const buildGateRun = (stage: number, z: number, t: number): number => {
  const ranks = 9;
  const spacing = 31.9;
  const length = ranks * spacing + 20;
  pushFloor(stage, z, z + length);

  const cycle = 5.4 - t * 1.2;
  for (let rank = 0; rank < ranks; rank += 1) {
    const at = z + 18 + rank * spacing;
    /*
     * Three shutters across, and they OVERLAP.
     *
     * Each is wider than the spacing between them, so a closed rank seals the
     * corridor wall to wall. Sized flush instead - the obvious authoring -
     * leaves a two-unit slot between neighbours and another against each wall,
     * and a mech is narrow enough to run straight down one of them for the
     * whole stage without ever waiting for a gate.
     *
     * The phases are a third of a cycle apart, so a gate is open most of the
     * time and never all three at once: the rank is a rhythm to walk into, not
     * a wall to queue at.
     */
    for (let column = 0; column < 3; column += 1) {
      pushShutter(
        stage,
        lane(-0.62 + column * 0.62),
        at,
        lane(0.72),
        16,
        cycle,
        (column * cycle) / 3 + rank * 0.5,
      );
    }
  }
  pushWallTorches(stage, z, z + length, 22);
  return z + length;
};

/**
 * Stage 8 - COLLAPSE.
 *
 * Falling platforms over lava. Every row keeps at least one slab up at every
 * moment - the phases are a third of a cycle apart - so the crossing is always
 * possible and always on a clock.
 */
const buildCollapse = (stage: number, z: number, t: number, tuning: StageTuning): number => {
  const rows = 9;
  const gap = gapFor(t) * 0.75;
  const slab = 18.8;
  const rise = riseFor(tuning);
  const length = rows * (slab + gap);
  pushPool(stage, z, z + length, 'lava');

  let y = COURSE.floorY;
  for (let row = 0; row < rows; row += 1) {
    const at = z + row * (slab + gap) + gap + slab / 2;
    // Every row is a step UP, for the same reason every island in a chain is:
    // a row of slabs at one height is a row a fast player skips across without
    // ever leaving the ground, however wide the gaps between them are.
    y += rise;
    for (let column = 0; column < 3; column += 1) {
      const x = lane(-0.62 + column * 0.62);
      sinking.push({
        minX: x - lane(0.26),
        maxX: x + lane(0.26),
        minY: y - 1.6,
        maxY: y,
        minZ: at - slab / 2,
        maxZ: at + slab / 2,
        kind: 'sinking',
        stage,
        cycle: 6,
        // A third of a cycle apart, so exactly one of the three is always up.
        phase: (column * 6) / 3 + row * 0.4,
        steady: 3,
        warn: 0.9,
        sunk: 1.2,
        // Deep enough to be genuinely gone, and measured from the row's own
        // height rather than from the floor - these rows climb.
        depth: Math.max(9, rise + 4),
      });
    }
  }
  return pushDescent(stage, z + length, y, COURSE.floorY);
};

/**
 * Stage 9 - HAIRLINE.
 *
 * One narrow catwalk the length of the stage, over lava, with nothing either
 * side. No hazards at all past a handful of presses: the difficulty is the
 * WIDTH, and a mech is wide.
 */
const buildHairline = (stage: number, z: number, t: number, tuning: StageTuning): number => {
  const length = 319;
  const rise = riseFor(tuning);
  pushPool(stage, z, z + length, 'lava');
  pushIsland(stage, 'plank', 0, COURSE.floorY + rise, z + length / 2, lane(0.2), length, 1.4);

  // Three passing places, and only three. The stage is about committing.
  for (let i = 0; i < 3; i += 1) {
    pushIsland(
      stage,
      'rune',
      lane(0.34) * (i % 2 === 0 ? 1 : -1),
      COURSE.floorY + rise,
      z + length * (0.25 + i * 0.25),
      lane(0.28),
      16,
    );
  }
  for (let i = 0; i < 6; i += 1) {
    pushFaller(
      stage,
      lane(0.08) * (i % 2 === 0 ? 1 : -1),
      z + 24 + i * 32,
      3.6,
      26,
      3.2 - t * 0.6,
      i * 0.6,
      COURSE.floorY + rise,
    );
  }
  return z + length;
};

/**
 * Stage 10 - ZIGZAG.
 *
 * Platforms alternating hard left and hard right across the whole corridor, so
 * the crossing costs more travel than its Z distance suggests. The first stage
 * where AIMING matters as much as timing.
 */
const buildZigzag = (stage: number, z: number, t: number, tuning: StageTuning): number => {
  const end = pushIslandChain(stage, z, 11, gapFor(t) * 0.72, riseFor(tuning), {
    island: 15.9,
    width: lane(0.3),
    kind: 'stone',
    zigzag: 0.66,
  });
  for (let i = 0; i < 5; i += 1) {
    pushFaller(stage, lane(0.5) * (i % 2 ? 1 : -1), z + 30 + i * 36, 3.4, 24, 3, i * 0.8);
  }
  return pushDescent(stage, end.z, end.y, COURSE.floorY);
};

/**
 * Stage 11 - ASCENT.
 *
 * A vertical shaft. The ledges spiral upward with barely any Z between them,
 * so nothing here can be crossed by going fast - the only axis that helps is
 * up. The descent at the far end is free, which is the stage's reward for
 * having climbed it.
 */
const buildAscent = (stage: number, z: number, t: number, tuning: StageTuning): number => {
  const steps = 12;
  const rise = riseFor(tuning);
  const length = 232;
  pushPool(stage, z, z + length, 'void');

  let y = COURSE.floorY + rise;
  for (let i = 0; i < steps; i += 1) {
    const angle = i * 1.15;
    y += rise;
    pushIsland(
      stage,
      i % 3 === 0 ? 'rune' : 'stone',
      Math.cos(angle) * lane(0.6),
      y,
      z + 18 + (i / steps) * (length - 44) + Math.sin(angle) * 12,
      lane(0.34),
      14,
    );
  }

  // The landing shelf at the top. A shaft with no way out but another climb
  // would be a dead end.
  pushIsland(stage, 'stone', 0, y + rise, z + length - 14, lane(0.9), 26);
  return pushDescent(stage, z + length, y + rise, COURSE.floorY);
};

/**
 * Stage 12 - PRESS HALL.
 *
 * Slow crushing blocks in a narrow hall. They fall on a long cycle with a long
 * hover, so every one of them is a decision rather than a reflex - and the
 * hall is narrow enough that there is no way round, only through.
 */
const buildPressHall = (stage: number, z: number, t: number): number => {
  const length = 304.5;
  pushFloor(stage, z, z + length);

  // The hall walls, so the only route is the middle.
  for (const side of [-1, 1]) {
    pushBox(
      stage,
      'metal',
      side * lane(0.7),
      COURSE.floorY,
      z + length / 2,
      lane(0.5),
      28,
      length,
    );
  }
  for (let i = 0; i < 9; i += 1) {
    const at = z + 18 + i * 22;
    pushFaller(stage, lane(0.18) * (i % 2 === 0 ? 1 : -1), at, 5.4, 30, 4.2 - t * 0.8, i * 0.62);
  }
  pushWallTorches(stage, z, z + length, 20);
  return z + length;
};

/**
 * Stage 13 - PULSE TILES.
 *
 * Alternating safe and unsafe tiles over lava, in a chequerboard whose phase
 * runs on the diagonal. The safe set is always a connected path across, and it
 * is always visible a beat before it is needed - so the stage is a sequence to
 * learn rather than a field to guess at.
 */
const buildPulseTiles = (stage: number, z: number, t: number): number => {
  const rows = 16;
  const tile = 18.8;
  const length = rows * tile;
  pushPool(stage, z, z + length, 'lava');
  pushPulseTiles(stage, z, rows, 5, tile, 3, 5.4 - t * 1.2);
  return z + length;
};

/**
 * Stage 14 - SHIFT WALLS.
 *
 * Moving walls: ranks of sweepers that span most of the corridor and leave one
 * travelling gap, so the player has to walk WITH the wall rather than past it.
 * Each rank moves at its own rate, so the gaps drift in and out of alignment.
 */
const buildShiftWalls = (stage: number, z: number, t: number): number => {
  const ranks = 8;
  const spacing = 37.7;
  const length = ranks * spacing + 20;
  pushFloor(stage, z, z + length);

  for (let rank = 0; rank < ranks; rank += 1) {
    const at = z + 18 + rank * spacing;
    const direction = rank % 2 === 0 ? 1 : -1;
    // A wall is a ROW of sweepers sharing one phase: they move as one panel,
    // and the gap is where the row stops.
    /*
     * A wall is a ROW of sweepers sharing one phase and one rate.
     *
     * They move as one panel, so the clear lane is wherever the row stops -
     * and the row has to be SHORTER than the corridor for there to be one. The
     * spacing is a little under a diameter so the panel is continuous, and the
     * amplitude plus the panel's own half-length has to fit inside the wall or
     * the end sweeper spends half its travel inside the masonry.
     */
    for (let i = 0; i < 6; i += 1) {
      hazards.push({
        kind: 'sweeper',
        stage,
        x: lane(-0.5) + i * lane(0.2),
        y: COURSE.floorY + 3.4,
        z: at,
        radius: 3.4,
        sweep: direction * lane(0.3),
        rate: 0.8 + rank * 0.07 + t * 0.3,
        phase: rank * 0.9,
        fromZ: 0,
        toZ: 0,
      });
    }
  }
  pushWallTorches(stage, z, z + length, 24);
  return z + length;
};

/**
 * Stage 15 - TURNTABLE.
 *
 * Giant rotating platforms: two enormous discs, each drawn as a wide static
 * deck with four full-length arms sweeping over it at two heights. Standing
 * still on one is fatal and running blindly across is worse; the route is to
 * follow a gap round.
 */
const buildTurntable = (stage: number, z: number, t: number): number => {
  const half = 52;
  const length = 435;
  pushWideFloor(stage, z, z + length, half);

  for (let disc = 0; disc < 2; disc += 1) {
    const centre = z + 78 + disc * 140;
    // The deck itself: a big raised platter with a rim, so the disc reads as a
    // machine rather than as a patch of floor.
    pushIsland(stage, 'metal', 0, COURSE.floorY + 3.2, centre, half * 1.5, 110, 3.2);
    for (let arm = 0; arm < 4; arm += 1) {
      pushSpinArm(
        stage,
        'spinner',
        0,
        centre,
        COURSE.floorY + 5.4 + (arm % 2) * 3.4,
        7,
        half - 6,
        3.0,
        (0.55 + t * 0.35) * (disc === 0 ? 1 : -1),
        (arm * Math.PI) / 2,
      );
    }
    decorations.push({
      kind: 'crystal',
      stage,
      x: 0,
      y: COURSE.floorY + 16,
      z: centre,
      scale: 3,
      rotationY: 0,
    });
  }
  return z + length;
};

/**
 * Stage 16 - LAUNCH BAY.
 *
 * Jump pads. The gaps here are far past anything a leap can make, and the pads
 * are the only way across - so this is the one stage whose route is a series
 * of arcs the player does not control the height of. Aim, step on, hold the
 * line.
 */
const buildLaunchBay = (stage: number, z: number, t: number, tuning: StageTuning): number => {
  const bays = 6;
  const gap = gapFor(t) * 1.9;
  const island = 31.9;
  const length = bays * (gap + island);
  const boost = MOVEMENT.jumpVelocity * 1.7;
  pushPool(stage, z, z + length, 'void');

  /*
   * A pad on the APPROACH, before the first gap.
   *
   * Every landing in this stage is higher than a leap, including the first -
   * so without a pad on the solid run-up the stage cannot be entered at all.
   * It is the one pad that does not sit on a platform this builder made, which
   * is exactly why it is easy to forget.
   */
  surfaces.push({
    stage,
    minX: -lane(0.2),
    maxX: lane(0.2),
    minZ: z - 7,
    maxZ: z - 1,
    grip: 1,
    windX: 0,
    windZ: 0,
    boost,
  });
  pushBox(stage, 'rune', 0, COURSE.floorY, z - 4, lane(0.4), 0.3, 6);

  let at = z;
  let y = COURSE.floorY;
  for (let i = 0; i < bays; i += 1) {
    // Each landing is HIGHER, and higher than a leap - the pad is what gets
    // you there, which is the whole stage.
    y += riseFor(tuning) * 2.4;
    pushIsland(stage, 'rune', 0, y, at + gap + island / 2, lane(0.66), island);
    // The pad sits at the far end of the platform, facing the next gap.
    surfaces.push({
      stage,
      minX: -lane(0.2),
      maxX: lane(0.2),
      minZ: at + gap + island - 7,
      maxZ: at + gap + island - 1,
      grip: 1,
      windX: 0,
      windZ: 0,
      boost,
    });
    pushIsland(stage, 'metal', 0, y + 0.2, at + gap + island - 4, lane(0.4), 6, 0.6);
    at += gap + island;
  }
  return pushDescent(stage, at, y, COURSE.floorY);
};

/**
 * Stage 17 - SUSPENSION.
 *
 * Small platforms hanging from the roof on cables over nothing at all, packed
 * close in Z and scattered wide in X. Nothing moves and nothing kills except
 * the drop: the stage is pure platforming, and it is the last time that is
 * true.
 */
const buildSuspension = (stage: number, z: number, t: number, tuning: StageTuning): number => {
  const count = 14;
  const gap = gapFor(t) * 0.6;
  const pad = 15.9;
  const rise = riseFor(tuning);
  const length = count * (gap + pad);
  pushPool(stage, z, z + length, 'void');

  let at = z;
  let y = COURSE.floorY + rise;
  for (let i = 0; i < count; i += 1) {
    at += gap;
    y += i % 3 === 2 ? -rise * 0.6 : rise * 0.7;
    const x = lane(0.62) * Math.sin(i * 1.7);
    pushIsland(stage, 'rune', x, y, at + pad / 2, pad, pad, 1.2);
    decorations.push({
      kind: 'chain',
      stage,
      x,
      y: y + 2,
      z: at + pad / 2,
      scale: 1.6,
      rotationY: 0,
    });
    at += pad;
  }
  return pushDescent(stage, at, y, COURSE.floorY);
};

/**
 * Stage 18 - LASER GRID.
 *
 * Thin fast lances sweeping a corridor at ankle, waist and shoulder height.
 * They are spinners with a small ball radius and a long arm, which is exactly
 * what a laser is: something that fills a line and takes no room at all.
 */
const buildLaserGrid = (stage: number, z: number, t: number): number => {
  const length = 348;
  pushFloor(stage, z, z + length);
  for (let i = 0; i < 12; i += 1) {
    const at = z + 16 + i * 19;
    const height = COURSE.floorY + 1.6 + (i % 3) * 3.2;
    pushSpinArm(
      stage,
      'spinner',
      0,
      at,
      height,
      3,
      lane(0.9),
      1.5,
      (1.5 + i * 0.12 + t * 0.6) * (i % 2 === 0 ? 1 : -1),
      i * 0.7,
    );
  }
  pushWallTorches(stage, z, z + length, 18);
  return z + length;
};

/**
 * Stage 19 - CONVEYOR.
 *
 * Belted deck sections that push hard across the corridor, alternating
 * direction, over a lava channel down each side. The push acts in the air too,
 * so a jump taken on a belt lands where the belt was sending you - which is
 * the whole reason to walk the last few units off it before leaving.
 */
const buildConveyor = (stage: number, z: number, t: number): number => {
  const bays = 7;
  const bay = 49.3;
  const length = bays * bay;
  const width = lane(0.72);

  // A central deck with the drop either side of it.
  pushIsland(stage, 'metal', 0, COURSE.floorY, z + length / 2, width * 2, length, 2.2);
  pushPool(stage, z, z + length, 'lava');

  for (let i = 0; i < bays; i += 1) {
    const at = z + i * bay;
    const push = (34 + t * 26) * (i % 2 === 0 ? 1 : -1);
    surfaces.push({
      stage,
      minX: -width,
      maxX: width,
      minZ: at,
      maxZ: at + bay,
      grip: 1,
      windX: push,
      windZ: 0,
      boost: 0,
    });
    pushSpikeBed(stage, 0, at + bay * 0.5, width * 0.9, COURSE.floorY);
  }
  return z + length;
};

/**
 * Stage 20 - THE FORK.
 *
 * Split routes. Three lanes run the whole length and they are priced
 * differently: the middle is short and guarded by beams, the sides are long,
 * narrow and open. Every fifty units they rejoin, so a player can change their
 * mind about which trade they are making three times.
 */
const buildFork = (stage: number, z: number, t: number, tuning: StageTuning): number => {
  const legs = 4;
  const leg = 89.9;
  const length = legs * leg;
  const rise = riseFor(tuning);
  pushPool(stage, z, z + length, 'void');

  for (let i = 0; i < legs; i += 1) {
    const at = z + i * leg;
    const y = COURSE.floorY + rise * (i + 1);
    // The junction platform both routes meet on.
    pushIsland(stage, 'rune', 0, y, at + 8, lane(1.3), 16);

    // The short, guarded middle.
    pushIsland(stage, 'metal', 0, y, at + leg * 0.6, lane(0.26), leg * 0.66);
    pushSpinArm(
      stage,
      'spinner',
      0,
      at + leg * 0.6,
      y + 2.6,
      3,
      lane(0.34),
      2.2,
      2.0 + t,
      i * 1.1,
    );

    // The long ways round, one each side, lower and unguarded.
    for (const side of [-1, 1]) {
      for (let step = 0; step < 4; step += 1) {
        pushIsland(
          stage,
          'stone',
          side * lane(0.78),
          y - rise * 0.4,
          at + 20 + step * 12,
          lane(0.2),
          10,
        );
      }
    }
  }
  const top = COURSE.floorY + rise * legs;
  pushIsland(stage, 'rune', 0, top, z + length - 10, lane(1.3), 20);
  return pushDescent(stage, z + length, top, COURSE.floorY);
};

/**
 * Stage 21 - HELIX.
 *
 * A corkscrew: the platforms wind left and right around a rising line while
 * that line ADVANCES down the course, so the route spirals without ever
 * doubling back on itself. A true spiral staircase - a circle in plan view -
 * was tried first and rejected: a stage that comes back to the same Z twice at
 * two different heights cannot be described by a course that is linear in Z,
 * and neither the collision buckets nor the verifier can tell a crossing from
 * a coincidence in one.
 *
 * Each platform stands on its own column down into the lava, so the spiral
 * reads as a built structure rather than as tiles hanging in a circle.
 */
const buildHelix = (stage: number, z: number, t: number, tuning: StageTuning): number => {
  const steps = 18;
  const rise = riseFor(tuning) * 0.9;
  const length = 290;
  const pad = 20.3;
  pushPool(stage, z, z + length, 'lava');

  // The Z amplitude is kept UNDER the platform length, so consecutive turns of
  // the corkscrew overlap along the course and the route is continuous.
  const swing = 15.9;
  const advance = (length - 44) / steps;

  let y = COURSE.floorY + rise;
  let top = y;
  for (let i = 0; i < steps; i += 1) {
    const angle = (i / steps) * Math.PI * 4;
    y += rise;
    top = y;
    const x = Math.cos(angle) * lane(0.6);
    const at = z + 22 + i * advance + Math.sin(angle) * swing;
    pushBox(
      stage,
      'pillar',
      x,
      COURSE.floorY + POOL_Y,
      at,
      pad * 0.5,
      y - (COURSE.floorY + POOL_Y) - 1.4,
      pad * 0.5,
    );
    pushIsland(stage, i % 4 === 0 ? 'rune' : 'stone', x, y, at, lane(0.32), pad);
  }
  pushIsland(stage, 'stone', 0, top, z + length - 14, lane(0.9), 24);
  return pushDescent(stage, z + length, top, COURSE.floorY);
};

/**
 * Stage 22 - TUNNEL RUN.
 *
 * A low tube with emitter beds along the floor and a roof close enough that a
 * full jump bangs the pilot's head on it. The only way through is short hops
 * timed against the rollers coming the other way.
 */
const buildTunnelRun = (stage: number, z: number, t: number): number => {
  const length = 333.5;
  pushFloor(stage, z, z + length);

  // The tube: walls close in and the roof comes down. Laid explicitly rather
  // than through `pushCeiling`, because this roof is a MECHANIC and the
  // stage-wide one is a limit.
  for (const side of [-1, 1]) {
    pushBox(stage, 'metal', side * lane(0.62), COURSE.floorY, z + length / 2, lane(0.6), 30, length);
  }
  /*
   * The tube roof, and its height is the whole stage.
   *
   * `MOUNT_HEIGHT` is 7.8, so 13 leaves a mech room to stand and about five
   * units of jump - enough to clear an emitter bed and nowhere near enough to
   * leap a roller. The answer to a roller here is therefore to go AROUND it,
   * which is why the lanes are narrow and the tube is not.
   */
  solids.push({
    minX: -lane(0.62),
    maxX: lane(0.62),
    minY: COURSE.floorY + 13,
    maxY: COURSE.floorY + 17,
    minZ: z,
    maxZ: z + length,
    kind: 'ceiling',
    stage,
  });

  for (let i = 0; i < 9; i += 1) {
    pushSpikeBed(stage, lane(0.2) * (i % 2 === 0 ? 1 : -1), z + 20 + i * 24, lane(0.5));
  }
  for (let i = 0; i < 4; i += 1) {
    hazards.push({
      kind: 'roller',
      stage,
      x: lane(0.24) * (i % 2 === 0 ? 1 : -1),
      y: COURSE.floorY + 3.2,
      z: 0,
      radius: 2.8,
      sweep: 0,
      rate: 22 + t * 12,
      phase: i * 28,
      fromZ: z + length - 6,
      toZ: z + 6,
    });
  }
  return z + length;
};

/**
 * Stage 23 - DESCENT.
 *
 * Platforms stepping DOWN into a shaft, each drop further than the last, with
 * presses hammering the landings. Falling is free, so the stage is about
 * arriving on the right tile rather than about getting there at all - and
 * every landing is small.
 */
const buildDescent = (stage: number, z: number, t: number, tuning: StageTuning): number => {
  const rise = riseFor(tuning);
  const steps = 12;
  const gap = gapFor(t) * 0.7;
  const pad = 18.8;

  /*
   * THE CLIMB IN, and it is a LADDER rather than a staircase.
   *
   * The stage descends, so it has to start high - and a walkable staircase to
   * the top of it would be four times the length of the stage, because a riser
   * has to stay under `MOVEMENT.stepHeight` or the mech cannot walk up it.
   * Four ledges a `riseFor` apart is the same climb in a quarter of the space,
   * and every one of them is inside a single jump at the level this stage is
   * built for - which is the rule every step in this file is held to.
   */
  const rungs = 4;
  const top = COURSE.floorY + rise * rungs;
  let entry = z;
  for (let i = 1; i <= rungs; i += 1) {
    pushIsland(stage, 'metal', 0, COURSE.floorY + rise * i, entry + 7, lane(0.8), 14);
    entry += 14;
  }
  pushIsland(stage, 'stone', 0, top, entry + 10, lane(1.0), 20);
  entry += 20;

  const length = steps * (gap + pad);
  pushPool(stage, entry, entry + length, 'void');

  let at = entry;
  let y = top;
  // Each drop is longer than the last, so the stage gets harder to aim as it
  // goes rather than merely longer. Falling is free; landing on a small tile
  // is not.
  for (let i = 0; i < steps; i += 1) {
    at += gap;
    y -= rise * (0.5 + (i / steps) * 0.8);
    const x = lane(0.5) * Math.sin(i * 1.3);
    pushIsland(stage, i % 3 === 0 ? 'rune' : 'stone', x, y, at + pad / 2, lane(0.3), pad);
    if (i % 2 === 0) pushFaller(stage, x, at + pad / 2, 3.4, 22, 3.2, i * 0.5, y);
    at += pad;
  }
  return pushDescent(stage, at, y, COURSE.floorY);
};

/**
 * Stage 24 - UPLIFT.
 *
 * The mirror of Descent: sinking platforms used the other way up. Each one
 * spends most of its cycle DOWN at deck level and rises to meet the next
 * ledge, so the route is a lift the player has to be standing on when it goes.
 */
const buildUplift = (stage: number, z: number, t: number, tuning: StageTuning): number => {
  const lifts = 9;
  const spacing = 37.7;
  const length = lifts * spacing + 30;
  const rise = riseFor(tuning);
  pushPool(stage, z, z + length, 'lava');

  /*
   * A solid apron at deck level, because the FIRST lift has to be reachable.
   *
   * A lift delivers the player from one ledge to the next, so every lift after
   * the first has the previous ledge to be boarded from. The first has
   * nothing, and without this it is a platform hanging over lava with no way
   * onto it - the whole stage unenterable from a detail nobody would look for.
   */
  pushIsland(stage, 'metal', 0, COURSE.floorY, z + 12, lane(1.2), 26);

  let y = COURSE.floorY;
  for (let i = 0; i < lifts; i += 1) {
    const at = z + 16 + i * spacing;
    const x = lane(0.42) * (i % 2 === 0 ? 1 : -1);
    // The ledge the lift delivers you to.
    pushIsland(stage, 'stone', x, y + rise * 1.8, at + 12, lane(0.3), 12);
    // The lift itself: parked high, dropping to deck level, back up again.
    sinking.push({
      minX: x - lane(0.22),
      maxX: x + lane(0.22),
      minY: y + rise * 1.8 - 1.6,
      maxY: y + rise * 1.8,
      minZ: at - 6,
      maxZ: at + 6,
      kind: 'sinking',
      stage,
      cycle: 7 - t * 1.4,
      phase: i * 1.6,
      steady: 1.6,
      warn: 0.5,
      sunk: 2.4,
      depth: rise * 1.8,
    });
    y += rise * 1.8;
  }
  return pushDescent(stage, z + length, y + rise * 1.8, COURSE.floorY);
};

/**
 * Stage 25 - THE LEAP.
 *
 * Four enormous gaps and nothing else. Each is authored at the very edge of
 * what the stage's recommended profile can reach, so it is the one stage that
 * is genuinely a test of how far the player has levelled - and the one they
 * come back to after a rebirth to find easy.
 */
const buildLeap = (stage: number, z: number, t: number, tuning: StageTuning): number => {
  const jumps = 4;
  // 0.82 of the stage's OWN reach, not the base one: this stage is the
  // exception to `gapFor` and it says so.
  const gap = ballisticAtStage(tuning).reach * 0.82;
  const pad = 43.5;
  const length = jumps * (gap + pad) + pad;
  pushPool(stage, z, z + length, 'void');

  let at = z;
  let y = COURSE.floorY;
  pushIsland(stage, 'rune', 0, y, at + pad / 2, lane(1.1), pad);
  at += pad;
  for (let i = 0; i < jumps; i += 1) {
    at += gap;
    // Level, not climbing: this stage's whole demand is horizontal.
    pushIsland(stage, 'rune', 0, y, at + pad / 2, lane(1.1), pad);
    decorations.push({
      kind: 'crystal',
      stage,
      x: 0,
      y: y + 9,
      z: at + pad / 2,
      scale: 2.4,
      rotationY: 0,
    });
    at += pad;
  }
  return at;
};

/**
 * Stage 26 - MAZE STORM.
 *
 * The grid maze again, and this time the walls have company: beams sweeping
 * the junctions and presses in the dead ends. The route is still readable, but
 * reading it now has to happen while moving.
 */
const buildMazeStorm = (stage: number, z: number, t: number): number => {
  const cell = 26.1;
  const rows = 14;
  const length = rows * cell;
  pushFloor(stage, z, z + length);

  const route = [0, 1, 2, 2, 1, 0, -1, -2, -2, -1, 0, 1, 1, 0];
  for (let row = 0; row < rows; row += 1) {
    const open = route[row] ?? 0;
    const at = z + row * cell + cell / 2;
    for (let column = -2; column <= 2; column += 1) {
      if (column === open) continue;
      pushBox(stage, 'pillar', lane(column * 0.36), COURSE.floorY, at, cell * 0.7, 28, 3.2);
    }
    if (row % 3 === 0) {
      // The arm turns inside its own CELL, so its radius is bounded by how
      // far off the centreline that cell can be: an outer lane sits at
      // `lane(0.72)`, and a longer arm there would sweep through the wall.
      pushSpinArm(
        stage,
        'spinner',
        lane(open * 0.36),
        at,
        COURSE.floorY + 3.2,
        2.5,
        lane(0.2),
        2.0,
        (1.8 + t) * (row % 2 === 0 ? 1 : -1),
        row * 0.8,
      );
    }
    if (row % 4 === 2) {
      pushFaller(stage, lane(open * 0.36), at + cell * 0.4, 3.6, 24, 3.0, row * 0.4);
    }
  }
  return z + length;
};

/**
 * Stage 27 - METRONOME.
 *
 * A single-file sequence of timed platforms, each up for barely longer than it
 * takes to cross, all on ONE cycle offset by a fixed beat. Get on the beat and
 * the whole stage carries you; miss it once and every platform after is wrong.
 */
const buildMetronome = (stage: number, z: number, t: number, tuning: StageTuning): number => {
  const beats = 16;
  const step = 21;
  const length = beats * step + 20;
  const cycle = 4.4 - t * 0.8;
  const rise = riseFor(tuning);
  pushPool(stage, z, z + length, 'lava');

  let y = COURSE.floorY;
  for (let i = 0; i < beats; i += 1) {
    const at = z + 12 + i * step;
    y += rise * 0.5;
    const x = lane(0.34) * Math.sin(i * 0.9);
    sinking.push({
      minX: x - lane(0.24),
      maxX: x + lane(0.24),
      minY: y - 1.5,
      maxY: y,
      minZ: at - 8,
      maxZ: at + 8,
      kind: 'sinking',
      stage,
      cycle,
      // ONE beat apart, every time: the sequence is a rhythm, not a scatter.
      phase: (i * cycle) / 4,
      steady: cycle * 0.4,
      warn: 0.45,
      sunk: cycle * 0.35,
      depth: 16,
    });
  }
  return pushDescent(stage, z + length, y, COURSE.floorY);
};

/**
 * Stage 28 - STRATA.
 *
 * Three decks stacked over one another, connected by climbs at alternating
 * ends, each deck holding a different hazard. The player crosses the bottom
 * one way, climbs, crosses the middle the other way, climbs again - so the
 * stage is three stages in the footprint of one.
 */
const buildStrata = (stage: number, z: number, t: number, tuning: StageTuning): number => {
  const length = 333.5;
  const rise = riseFor(tuning);
  const deckHeight = rise * 3.4;
  pushPool(stage, z, z + length, 'void');

  for (let deck = 0; deck < 3; deck += 1) {
    const y = COURSE.floorY + deck * deckHeight;
    pushIsland(stage, deck === 1 ? 'metal' : 'stone', 0, y, z + length / 2, lane(1.1), length, 2);

    if (deck === 0) {
      for (let i = 0; i < 7; i += 1) {
        pushSpikeBed(stage, lane(0.4) * (i % 2 ? 1 : -1), z + 20 + i * 30, lane(0.7), y);
      }
    } else if (deck === 1) {
      for (let i = 0; i < 6; i += 1) {
        pushSpinArm(
          stage,
          'spinner',
          0,
          z + 24 + i * 34,
          y + 3,
          3,
          lane(0.8),
          2.4,
          1.4 + i * 0.1,
          i * 0.9,
        );
      }
    } else {
      for (let i = 0; i < 6; i += 1) {
        pushFaller(stage, lane(0.3) * (i % 2 ? 1 : -1), z + 28 + i * 32, 4.4, 24, 3.2, i * 0.7, y);
      }
    }

    // The climb to the next deck, at alternating ends: a short ladder of
    // ledges, each within a jump of the last.
    if (deck < 2) {
      const climbZ = deck % 2 === 0 ? z + length - 22 : z + 22;
      const rungs = Math.ceil(deckHeight / rise);
      for (let rung = 1; rung <= rungs; rung += 1) {
        pushIsland(
          stage,
          'rune',
          lane(0.85) * (deck % 2 === 0 ? 1 : -1),
          y + (rung / rungs) * deckHeight,
          climbZ + (deck % 2 === 0 ? -1 : 1) * rung * 9,
          lane(0.26),
          10,
        );
      }
    }
  }
  return pushDescent(stage, z + length, COURSE.floorY + 2 * deckHeight, COURSE.floorY);
};

/**
 * Stage 29 - OVERLOAD.
 *
 * Every hazard the course owns, at once, over a climbing chain: beams turning
 * through the gaps, presses on the landings, conveyor plating on half the
 * platforms and polished plating on the rest. The dress rehearsal.
 */
const buildOverload = (stage: number, z: number, t: number, tuning: StageTuning): number => {
  const gap = gapFor(t) * 0.8;
  const rise = riseFor(tuning);
  const count = 12;
  const island = 21.8;
  const end = pushIslandChain(stage, z, count, gap, rise, {
    island,
    width: lane(0.42),
    surface: 'lava',
    zigzag: 0.4,
  });

  let at = z;
  for (let i = 0; i < count; i += 1) {
    at += gap;
    const y = COURSE.floorY + rise * (i + 1);
    const x = lane(0.4) * (i % 2 === 0 ? 1 : -1);
    if (i % 3 === 0) {
      pushSpinArm(stage, 'spinner', x, at + island / 2, y + 2.6, 2.5, lane(0.36), 2.0, 2.2 + t, i);
    } else if (i % 3 === 1) {
      pushFaller(stage, x, at + island / 2, 3.8, 22, 2.8, i * 0.6, y);
    } else {
      surfaces.push({
        stage,
        minX: x - lane(0.22),
        maxX: x + lane(0.22),
        minZ: at,
        maxZ: at + island,
        grip: 0.28,
        windX: 0,
        windZ: 0,
        boost: 0,
      });
    }
    at += island;
  }
  return pushDescent(stage, end.z, end.y, COURSE.floorY);
};

/**
 * Stage 30 - FINAL GAUNTLET.
 *
 * Four movements, each one a stage the player has already beaten, run back to
 * back with no floor under any of them: shutters, a beam corridor, pulse tiles
 * and one last enormous leap onto the finish shelf.
 */
const buildFinalGauntlet = (stage: number, z: number, t: number, tuning: StageTuning): number => {
  const rise = riseFor(tuning);
  let at = z;

  // I. Shutters over lava, on a deck with the sides cut away.
  {
    const length = 217.5;
    pushPool(stage, at, at + length, 'lava');
    pushIsland(stage, 'metal', 0, COURSE.floorY + rise, at + length / 2, lane(0.8), length, 2);
    for (let rank = 0; rank < 6; rank += 1) {
      // Overlapping, and sized against THIS deck rather than the corridor:
      // the deck is `lane(0.8)` wide, so a rank has to seal that and no more.
      for (let column = 0; column < 3; column += 1) {
        pushShutter(
          stage,
          lane(-0.34 + column * 0.34),
          at + 18 + rank * 22,
          lane(0.4),
          14,
          4.2,
          (column * 4.2) / 3 + rank * 0.45,
        );
      }
    }
    at += length;
  }

  // II. A beam corridor, narrower than the last one and turning faster.
  {
    const length = 217.5;
    pushPool(stage, at, at + length, 'void');
    pushIsland(stage, 'plank', 0, COURSE.floorY + rise, at + length / 2, lane(0.26), length, 1.6);
    for (let i = 0; i < 8; i += 1) {
      pushSpinArm(
        stage,
        'spinner',
        0,
        at + 14 + i * 17,
        COURSE.floorY + rise + 2.6,
        2.5,
        lane(0.34),
        1.8,
        (2.6 + t) * (i % 2 === 0 ? 1 : -1),
        i * 0.6,
      );
    }
    at += length;
  }

  // III. Pulse tiles, climbing.
  {
    const rows = 12;
    const tile = 18.8;
    pushPool(stage, at, at + rows * tile, 'lava');
    pushPulseTiles(stage, at, rows, 5, tile, 4, 3.8, COURSE.floorY + rise * 2);
    at += rows * tile;
  }

  // IV. The last leap, onto a lit shelf.
  {
    const gap = ballisticAtStage(tuning).reach * 0.78;
    pushPool(stage, at, at + gap + 40, 'void');
    pushIsland(stage, 'rune', 0, COURSE.floorY + rise * 2, at + gap + 20, lane(1.2), 40);
    for (const side of [-1, 1]) {
      decorations.push({
        kind: 'crystal',
        stage,
        x: side * lane(0.9),
        y: COURSE.floorY + rise * 2 + 10,
        z: at + gap + 20,
        scale: 3,
        rotationY: 0,
      });
    }
    at += gap + 40;
  }

  return pushDescent(stage, at, COURSE.floorY + rise * 2, COURSE.floorY);
};

/**
 * Every stage's builder, by index.
 *
 * ONE table rather than a switch, so adding a stage is a row here and a row in
 * `STAGE_TUNING` - and so it is immediately obvious that all thirty are
 * authored and none of them is a repeat of its neighbour.
 */
type StageBuilder = (
  stage: number,
  z: number,
  t: number,
  tuning: StageTuning,
) => number;

const BUILDERS: readonly StageBuilder[] = [
  // The order is the NAME's, not the builder's. Each row is the section named
  // in STAGE_TUNING at the same index, and the mechanic under it is the one
  // that name describes - a stage called Mechanical Crusher Hall has to be the
  // crushers, whatever order the builders happened to be written in.
  buildEscape, //                      1  Mech Hangar Escape
  (s, z, t) => buildSkyfall(s, z, t), //  2  Reactor Platform
  buildCollapse, //                    3  Falling Machinery
  (s, z, t) => buildGridMaze(s, z, t), // 4  Industrial Maze
  buildHairline, //                    5  Energy Bridge
  buildSentinelBay, //                 6  Reactor Core
  buildDriftDeck, //                   7  Moving Cargo Platforms
  (s, z, t) => buildLaserGrid(s, z, t), // 8 Laser Grid Facility
  (s, z, t) => buildPressHall(s, z, t), // 9 Mechanical Crusher Hall
  buildSuspension, //                 10  Suspended Factory
  buildAscent, //                     11  Vertical Reactor Shaft
  (s, z, t) => buildPulseTiles(s, z, t), // 12 Collapsing Platforms
  (s, z, t) => buildTurntable(s, z, t), //  13 Giant Gear Facility
  (s, z, t) => buildConveyor(s, z, t), //   14 Energy Conveyor
  (s, z, t) => buildBeamArray(s, z, t), //  15 Mech Testing Chamber
  (s, z, t) => buildTunnelRun(s, z, t), //  16 Industrial Tunnel
  (s, z, t) => buildGateRun(s, z, t), //    17 Reactor Cooling Zone
  (s, z, t) => buildShiftWalls(s, z, t), // 18 Moving Wall Facility
  buildStrata, //                     19  Multi-Level Factory
  buildLaunchBay, //                  20  Gravity Platform Section
  (s, z, t) => buildMazeStorm(s, z, t), //  21 Energy Core Maze
  buildHelix, //                      22  Giant Machinery Room
  buildUplift, //                     23  Mech Assembly Facility
  buildZigzag, //                     24  Reactor Bridge
  buildDescent, //                    25  Vertical Hangar
  buildMetronome, //                  26  Mechanical Gauntlet
  buildLeap, //                       27  Collapsing Factory
  buildFork, //                       28  Core Defense Facility
  buildOverload, //                   29  Final Reactor
  buildFinalGauntlet, //              30  MECH ESCAPE
];

/** Running build cursor. Each stage begins exactly where the last one ended. */
let cursorZ: number = FIRST_STAGE_Z;

for (let stageIndex = 0; stageIndex < COURSE.stageCount; stageIndex += 1) {
  const tuning = STAGE_TUNING[
    Math.min(stageIndex, STAGE_TUNING.length - 1)
  ] as StageTuning;
  const startZ = cursorZ;
  // 0 at the first stage, 1 at the last. Every gap, rise and rate in the
  // builders is a function of it, so the whole ladder tunes from one number.
  const t = stageIndex / Math.max(1, COURSE.stageCount - 1);
  let z = startZ;

  // Where this stage's own geometry begins in the arrays, so its roof can be
  // laid at whatever height it actually turns out to reach. A stage's height
  // is no more knowable up front than its length is.
  const solidsFrom = solids.length;
  const sinkingFrom = sinking.length;

  // The run-up: solid, lit, and long enough to line a jump up on.
  pushFloor(stageIndex, z, z + START_RUNWAY);
  pushWallTorches(stageIndex, z, z + START_RUNWAY, 18);
  z += START_RUNWAY;

  const build = BUILDERS[Math.min(stageIndex, BUILDERS.length - 1)] as StageBuilder;
  z = build(stageIndex, z, t, tuning);

  /*
   * The finish apron, with the WIN pad at the player's LEFT and the RETURN pad
   * at their RIGHT.
   *
   * Left is POSITIVE X. The camera looks down +Z and its right is
   * `(-cos yaw, sin yaw)`, which at yaw 0 is world -X - so a pad authored at
   * -10 sits on the player's right, however "left-hand" the number reads.
   *
   * Two pads rather than one, because they answer two different questions.
   * The win pad banks the stage AND sends the player home; the return pad only
   * sends them home, and pays nothing - which is what a player who has already
   * banked this stage needs, and what stops "go back" and "get paid" being the
   * same button.
   */
  pushFloor(stageIndex, z, z + FINISH_APRON);
  const winPadX = COURSE.halfWidth - WIN_PAD.insetX;
  const winPadZ = z + FINISH_APRON / 2;
  const returnPadX = -winPadX;
  const returnPadZ = winPadZ;
  pushBox(
    stageIndex,
    'winPad',
    winPadX,
    COURSE.floorY,
    winPadZ,
    WIN_PAD.width,
    WIN_PAD.height,
    WIN_PAD.length,
  );
  pushBox(
    stageIndex,
    'returnPad',
    returnPadX,
    COURSE.floorY,
    returnPadZ,
    WIN_PAD.width,
    WIN_PAD.height,
    WIN_PAD.length,
  );
  // Beacons either side of the win pad, so the one thing a player is looking
  // for at the end of a stage is also the brightest thing in the room.
  for (const side of [-1, 1]) {
    decorations.push({
      kind: 'brazier',
      stage: stageIndex,
      x: winPadX + side * (WIN_PAD.width / 2 + 3),
      y: COURSE.floorY,
      z: winPadZ,
      scale: 1.2,
      rotationY: 0,
    });
  }
  z += FINISH_APRON;

  // The bridge across to the next stage's run-up.
  pushFloor(stageIndex, z, z + COURSE.stageGap);
  const endZ = z + COURSE.stageGap;
  cursorZ = endZ;

  /*
   * And the roof, measured from what the stage actually built.
   *
   * Read back out of the arrays rather than tracked by each builder, for the
   * same reason a stage's LENGTH comes from the build cursor: a figure every
   * builder had to remember to report would be a figure one of them eventually
   * forgot, and the result - a tower poking through its own ceiling - is the
   * kind of bug that only shows up at the top of a stage nobody reaches early.
   */
  // Annotated, because `COURSE` is `as const` and the inferred type of its
  // members is the literal rather than `number`.
  let stageTop: number = COURSE.floorY;
  let stageHalfWidth: number = COURSE.halfWidth;
  for (let i = solidsFrom; i < solids.length; i += 1) {
    const solid = solids[i] as CourseSolid;
    // The tube roof in stage 22 is a solid of this stage and it must NOT raise
    // the stage's own ceiling - a roof measured from a roof climbs for ever.
    if (solid.kind !== 'ceiling' && solid.maxY > stageTop) stageTop = solid.maxY;
    if (solid.maxX > stageHalfWidth) stageHalfWidth = solid.maxX;
  }
  for (let i = sinkingFrom; i < sinking.length; i += 1) {
    const platform = sinking[i] as SinkingSolid;
    if (platform.maxY > stageTop) stageTop = platform.maxY;
  }
  pushCeiling(stageIndex, startZ, endZ, stageTop, stageHalfWidth);

  stages.push({
    index: stageIndex + 1,
    name: tuning.name,
    difficulty: tuning.difficulty,
    recommendedLevel: tuning.recommendedLevel,
    recommendedSpeed: totalSpeedToReach(tuning.recommendedLevel),
    recommendedRobot: tuning.recommendedRobot,
    startZ,
    endZ,
    winPadX,
    winPadZ,
    returnPadX,
    returnPadZ,
    winReward: stageReward(stageIndex + 1),
  });
}

/** Every static solid, hangar included. */
export const COURSE_SOLIDS: readonly CourseSolid[] = solids;

/** Every platform that sinks. */
export const SINKING_SOLIDS: readonly SinkingSolid[] = sinking;

/** Every lethal pool. */
export const QUICKSAND: readonly HazardPool[] = pools;

/** Every hazard. */
export const COURSE_HAZARDS: readonly CourseHazard[] = hazards;

/** Every piece of scenery the simulation ignores. */
export const DECORATIONS: readonly Decoration[] = decorations;

/** Every stage, in order. */
export const STAGES: readonly StageDefinition[] = stages;

/**
 * The base ballistic figures, exported so the verifier checks the rule rather
 * than a number copied out of it.
 */
export const BALLISTIC_REACH = BASE_BALLISTIC.reach;
export const BALLISTIC_RISE = BASE_BALLISTIC.rise;

/** The whole roster, re-exported for the verifier's stage/robot checks. */
export const COURSE_ROBOTS: readonly RobotDefinition[] = ROBOTS;

/**
 * THE HARD END OF THE GAME. Z past which there is no more world.
 *
 * Sits past the last finish pad, so it never interferes with the final stage -
 * the player banks the last win and is returned to the hangar long before this
 * matters.
 *
 * It is a CLAMP rather than a wall, and that is what makes it absolute:
 * `clampToBounds` applies it to the RESULT of every substep, after the move
 * has already integrated, so no speed outruns it the way a collider could be
 * tunnelled.
 */
export const COURSE_END_Z: number =
  (stages[stages.length - 1]?.endZ ?? COURSE.lobbyEndZ) - 2;

/**
 * How far a sinking platform has dropped at a given time.
 *
 * The ONE definition, evaluated by the server to decide what the player is
 * standing on and by the client to draw it.
 */
export const sinkingOffsetAt = (
  platform: SinkingSolid,
  time: number,
): { drop: number; warning: boolean } => {
  const cycle = Math.max(0.1, platform.cycle);
  let t = (time + platform.phase) % cycle;
  if (t < 0) t += cycle;

  const steadyEnd = platform.steady;
  const warnEnd = steadyEnd + platform.warn;
  const sinkEnd = warnEnd + 0.45;
  const sunkEnd = sinkEnd + platform.sunk;

  if (t < steadyEnd) return { drop: 0, warning: false };
  // Still up, but flashing - the warning the player is meant to read.
  if (t < warnEnd) return { drop: 0, warning: true };
  if (t < sinkEnd) {
    const k = (t - warnEnd) / 0.45;
    return { drop: platform.depth * k * k, warning: false };
  }
  if (t < sunkEnd) return { drop: platform.depth, warning: false };

  // Rising back into place.
  const rise = Math.max(0.2, cycle - sunkEnd);
  const k = Math.min((t - sunkEnd) / rise, 1);
  return { drop: platform.depth * (1 - k), warning: false };
};

/**
 * Where a hazard is at a given time.
 *
 * The ONE definition of a hazard's position. The server evaluates it against
 * its own elapsed clock to decide a death; the client evaluates it against the
 * replicated clock to draw it. Neither can drift from the other because there
 * is nothing to drift - it is the same pure function.
 *
 * Writes into `out` so a per-substep hazard test allocates nothing.
 */
export const hazardPositionAt = (
  hazard: CourseHazard,
  time: number,
  out: { x: number; y: number; z: number },
): void => {
  out.x = hazard.x;
  out.y = hazard.y;
  out.z = hazard.z;

  switch (hazard.kind) {
    case 'spike':
      // Static. Returning the authored position unchanged is the whole
      // implementation, which is why an emitter bed costs the hazard system
      // nothing it was not already paying for.
      return;
    case 'roller': {
      const span = Math.max(1, hazard.fromZ - hazard.toZ);
      let travelled = (time * hazard.rate + hazard.phase) % span;
      if (travelled < 0) travelled += span;
      out.z = hazard.fromZ - travelled;
      return;
    }
    case 'spinner':
    case 'tornado': {
      // A circle about (x, z). Several of these at stepped radii and one phase
      // make a rigid bar, which is how every beam, arm and lance in the game is
      // drawn without a second kind of collision test.
      const angle = time * hazard.rate + hazard.phase;
      out.x = hazard.x + hazard.sweep * Math.cos(angle);
      out.z = hazard.z + hazard.sweep * Math.sin(angle);
      return;
    }
    case 'faller': {
      out.y = fallerHeightAt(hazard, time);
      return;
    }
    default:
      // Sweeper: side to side across the corridor.
      out.x = hazard.x + hazard.sweep * Math.sin(time * hazard.rate + hazard.phase);
  }
};

/**
 * Height of a faller at a given time.
 *
 * Split out because the client needs it on its own, to size the warning shadow
 * on the ground from the SAME number the kill is decided by. A shadow drawn
 * from a second estimate of the drop is a warning that lies.
 */
export const fallerHeightAt = (hazard: CourseHazard, time: number): number => {
  const period = Math.max(0.6, hazard.rate);
  let t = (time + hazard.phase) % period;
  if (t < 0) t += period;

  const hoverEnd = period * 0.52;
  const fallEnd = hoverEnd + period * 0.1;
  const restEnd = fallEnd + period * 0.14;

  if (t < hoverEnd) return hazard.y + hazard.sweep;
  if (t < fallEnd) {
    // Accelerating, so it reads as falling rather than as descending.
    const k = (t - hoverEnd) / (fallEnd - hoverEnd);
    return hazard.y + hazard.sweep * (1 - k * k);
  }
  if (t < restEnd) return hazard.y;

  // Winched back up, decelerating into the hover.
  const k = (t - restEnd) / Math.max(0.1, period - restEnd);
  return hazard.y + hazard.sweep * k * (2 - k);
};

/**
 * How far from the centreline a hazard can ever get.
 *
 * Kind-aware, because `sweep` does not mean the same thing to all of them: it
 * is a horizontal amplitude to a sweeper and an orbit radius to a spinner, but
 * a FALL HEIGHT to a faller, which never moves sideways at all.
 */
export const hazardReachX = (hazard: CourseHazard): number => {
  switch (hazard.kind) {
    case 'sweeper':
    case 'spinner':
    case 'tornado':
      return Math.abs(hazard.x) + Math.abs(hazard.sweep) + hazard.radius;
    default:
      // Rollers, fallers and emitters hold their lane.
      return Math.abs(hazard.x) + hazard.radius;
  }
};

/**
 * The Z range a hazard can ever reach, for the collision index's buckets.
 *
 * One definition, because a hazard bucketed too narrowly is simply not there:
 * it is drawn, it kills on the server, and the client's prediction never sees
 * it.
 */
export const hazardZRange = (hazard: CourseHazard): { minZ: number; maxZ: number } => {
  switch (hazard.kind) {
    case 'roller':
      return { minZ: hazard.toZ - hazard.radius, maxZ: hazard.fromZ + hazard.radius };
    case 'spinner':
    case 'tornado':
      return {
        minZ: hazard.z - Math.abs(hazard.sweep) - hazard.radius,
        maxZ: hazard.z + Math.abs(hazard.sweep) + hazard.radius,
      };
    default:
      return { minZ: hazard.z - hazard.radius, maxZ: hazard.z + hazard.radius };
  }
};

/**
 * Half-width of the playable corridor at a given Z.
 *
 * The hangar is far wider than the run it feeds into, so the clamp has to know
 * where the player is standing.
 */
export const corridorHalfWidthAt = (z: number): number => {
  if (z <= COURSE.lobbyEndZ) return COURSE.lobbyHalfWidth;
  for (const area of wideAreas) {
    if (z >= area.minZ && z <= area.maxZ) return area.halfWidth;
  }
  return COURSE.halfWidth;
};

/**
 * Every stretch wider than the corridor, the hangar included.
 *
 * The renderer walks this to build its walls, so a wall and a boundary cannot
 * end up in different places.
 */
export const WIDE_AREAS: readonly WideArea[] = [
  { minZ: COURSE.lobbyStartZ, maxZ: COURSE.lobbyEndZ, halfWidth: COURSE.lobbyHalfWidth },
  ...wideAreas,
];

/** The stage containing this Z, or null. */
export const stageAt = (z: number): StageDefinition | null => {
  for (const stage of stages) {
    if (z >= stage.startZ && z <= stage.endZ) return stage;
  }
  return null;
};

/**
 * The stage whose win pad the player is standing on, or null.
 *
 * A POSITION test rather than a message: a client says only that it thinks it
 * finished, and this is what the server checks that claim with.
 */
export const winPadAt = (x: number, y: number, z: number): StageDefinition | null => {
  if (y < COURSE.floorY - 1.5 || y > COURSE.floorY + 7) return null;
  for (const stage of stages) {
    if (Math.abs(z - stage.winPadZ) > WIN_PAD.length / 2) continue;
    if (Math.abs(x - stage.winPadX) > WIN_PAD.width / 2) continue;
    return stage;
  }
  return null;
};

/**
 * The stage whose RETURN pad the player is standing on, or null.
 *
 * Read by the client only, to send a `RequestRespawn` - which the server would
 * have honoured from anywhere anyway, so there is no authority here to get
 * wrong and nothing to validate.
 */
export const returnPadAt = (x: number, y: number, z: number): StageDefinition | null => {
  if (y < COURSE.floorY - 1.5 || y > COURSE.floorY + 7) return null;
  for (const stage of stages) {
    if (Math.abs(z - stage.returnPadZ) > WIN_PAD.length / 2) continue;
    if (Math.abs(x - stage.returnPadX) > WIN_PAD.width / 2) continue;
    return stage;
  }
  return null;
};

/**
 * Every patch of ground that handles differently.
 *
 * Read by `stepPlayer` on both sides, so a conveyor pushes exactly as hard in
 * the client's prediction as in the server's simulation.
 */
export const SURFACE_REGIONS: readonly SurfaceRegion[] = surfaces;

/**
 * The surface a position is standing on, or null for ordinary plating.
 *
 * Returns the FIRST match, so a small patch pushed before the sheet it sits on
 * wins - which is how a launch pad laid inside a conveyor bay stays a launch
 * pad.
 */
export const surfaceAt = (x: number, z: number): SurfaceRegion | null => {
  for (const region of surfaces) {
    if (x < region.minX || x > region.maxX) continue;
    if (z < region.minZ || z > region.maxZ) continue;
    return region;
  }
  return null;
};

/** The lethal pool a position is inside, or null. */
export const quicksandAt = (x: number, z: number): HazardPool | null => {
  for (const pit of pools) {
    if (x < pit.minX || x > pit.maxX) continue;
    if (z < pit.minZ || z > pit.maxZ) continue;
    return pit;
  }
  return null;
};
