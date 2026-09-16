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
