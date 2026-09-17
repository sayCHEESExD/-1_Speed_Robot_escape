import type { Vec3 } from '../types/math.js';

/**
 * World-space constants shared by the renderer and the authoritative server.
 *
 * Units are "world units" (1 unit ~= 1 Roblox stud in feel). The supplied
 * player.fbx is authored at 320 units tall, so it is scaled down on load.
 */

/** Multiplier applied to the loaded FBX so the character is PLAYER_HEIGHT tall. */
export const FBX_TO_WORLD_SCALE = 0.01;

/** Rider height in world units (320 * FBX_TO_WORLD_SCALE). */
export const PLAYER_HEIGHT = 3.2;

/**
 * How much larger than life the pilot's head is drawn.
 *
 * The rider is three units of person on a nine-unit machine, framed by a
 * camera that has to keep the MECH on screen - so the only part of them that
 * is ever clear of the armour is a head under half a unit across. At playing
 * distance that reads as a fitting on the robot rather than as a person riding
 * it, which is the thing this game is about.
 *
 * A NUDGE, not a caricature: the body still has to look like it belongs to
 * somebody in a cockpit. Applied to the neck bone by `PlayerRig`, so it costs
 * nothing per frame and covers the bundled rider and a Bloxity avatar alike.
 */
export const RIDER_HEAD_SCALE = 1.22;

/**
 * THE ONE PLACE THE PILOT'S NECK SCALE IS DECIDED.
 *
 * Two things want to write that bone and neither may simply overwrite the
 * other: this game enlarges the head so a rider reads at chase-camera
 * distance, and the PORTAL lets a player choose their own head proportion.
 * Writing one on top of the other is how the fix silently stopped working -
 * the proportions pass runs after the rig is bound and reset the bone to the
 * portal's figure, which for almost everybody is exactly 1.
 *
 * They MULTIPLY. A player who made their head big still has a big head, a
 * player who made it small still has a small one, and every one of them is
 * readable from behind.
 */
export const riderNeckScale = (portalHeadScale = 1): number => {
  const chosen =
    Number.isFinite(portalHeadScale) && portalHeadScale > 0 ? portalHeadScale : 1;
  return RIDER_HEAD_SCALE * chosen;
};

/**
 * How far the robot model is lifted off the simulation's contact line.
 *
 * ZERO, and deliberately: a mech STANDS on its feet. The geometry builder puts
 * the model's origin on the ground between them, so the simulation's `y` - the
 * height a platform's top is compared against - is already exactly where the
 * soles are. The constant is kept rather than deleted because it is the one
 * place that fact is written down, and a future hovering mount would set it
 * here rather than lifting the model in the renderer.
 */
export const ROBOT_RIDE_HEIGHT = 0;

/**
 * Height of the MOUNTED pair, ground line to top of rider.
 *
 * The simulation moves the ROBOT, not the person: `motion.y` is the ground
 * contact line and this is the whole silhouette's height, which is what a
 * ceiling test has to clear.
 *
 * ONE figure for the whole roster, sized to the TALLEST. A heavy frame stands
 * about 8.7 units to the top of its shoulder blocks with the pilot's head
 * another notch above that, so 9 covers it. A per-robot height would mean a
 * ceiling a player could pass under on one mech and not on another, which is a
 * course that changes shape when you go shopping.
 */
export const MOUNT_HEIGHT = 9;

/**
 * Horizontal half-width of the mounted pair.
 *
 * A mech is three metres across the shoulder blocks and half that at the feet,
 * and the collision body is a cylinder because it turns: modelling the
 * shoulder line would mean a rotating box, and a rotating box against an
 * axis-aligned course is a solver, not a radius. Sized between the two, so a
 * mech neither catches on every doorway nor stands on air.
 */
export const MOUNT_RADIUS = 2.1;

/** The course runs along +Z. Players travel *along* it, never across it. */
export const COURSE_FORWARD_AXIS = 'z' as const;

/**
 * Spawn transform: the middle of the starting arena.
 *
 * Deliberately clear of both feature areas - the two-storey robot display deck
 * down the player's LEFT and the treadmill bay on their RIGHT - so the game
 * opens on the open ground the hangar exists to provide, with both features in
 * shot and the lit course entrance straight ahead.
 */
export const SPAWN_POSITION: Readonly<Vec3> = { x: 0, y: 0, z: -92 };

/** Spawn yaw in radians (facing +Z, down the course). */
export const SPAWN_ROTATION_Y = 0;

/**
 * Y below which the rider has fallen out of the world.
 *
 * Sits well ABOVE the pit floor, so a fall is a short drop into a pit the
 * player can see the bottom of rather than a long one into nothing. The world
 * having a visible bottom is what stops a miss reading as a bug.
 */
export const DEATH_PLANE_Y = -16;

/**
 * Seconds a dead mech LIES WHERE IT FELL before it is placed at the spawn.
 *
 * THE DEATH HAPPENS WHERE THE DEATH HAPPENED. The server used to place a
 * player on the very tick it decided they had died, which meant the fall-over
 * animation - which is half a second long - played out in the hangar: the
 * machine blinked out of the pit it had just dropped into and keeled over at
 * the spawn point, in front of everybody, for no visible reason.
 *
 * So a death now has two halves. First the mech is FROZEN at the point it
 * died, its input ignored and its fall-over playing for everyone who can see
 * it; then, and only then, it is placed. This is the length of the first half,
 * and it is shared because both sides have to agree on it: the client's
 * `DEATH.duration` is this number, so the animation and the hold cannot drift
 * apart and leave the mech either cut off mid-topple or lying there after it
 * has finished.
 */
export const DEATH_HOLD_SECONDS = 0.55;

/**
 * Extra seconds the SERVER waits beyond the animation before placing.
 *
 * The client predicts its own death so it can start toppling on the frame the
 * player can see it happen, and the server confirms it a moment later from its
 * own simulation. The two clocks therefore start a hair apart, and a hold that
 * was exactly the length of the animation could place the mech a few frames
 * before it finished falling over - which is the bug this whole flow exists to
 * remove, just smaller.
 *
 * A tenth of a second is longer than that gap can plausibly be on a local
 * server and adds nothing anybody notices to a death.
 */
export const DEATH_PLACE_MARGIN = 0.1;
