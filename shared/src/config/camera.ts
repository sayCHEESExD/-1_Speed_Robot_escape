/**
 * Third-person chase camera tuning.
 *
 * Lives in shared config so gameplay can reason about framing without
 * importing the renderer.
 */
export interface CameraConfig {
  /** Distance behind the mount at rest, in world units. */
  readonly distance: number;
  /** Height above the robot's hooves that the camera sits at. */
  readonly height: number;
  /** Height above the hooves that the camera looks at - the rider's chest. */
  readonly lookAtHeight: number;
  /** Positional smoothing factor per second (higher = snappier). */
  readonly followLerp: number;
  /** Vertical field of view in degrees at rest. */
  readonly fov: number;
  readonly near: number;
  readonly far: number;
  /**
   * Extra distance at full speed.
   *
   * Late game runs at hundreds of units a second, and a fixed camera makes the
   * next gap arrive with no warning. Pulling back is what buys the reaction
   * time the obby needs at those speeds.
   */
  readonly speedDistance: number;
  /** Extra vertical FOV in degrees at full speed, for the sense of rush. */
  readonly speedFov: number;
  /** Speed at which the two allowances above are fully applied. */
  readonly speedReference: number;
  /** How fast the dynamic distance and FOV ease, per second. */
  readonly speedEase: number;

  /**
   * Closest the player may pull the camera, as an OFFSET on `distance`.
   *
   * An offset rather than an absolute distance, because the speed pull-back is
   * an offset too: the player's zoom and the game's framing then add, and
   * zooming in at speed still gives the shot the obby needs rather than
   * fighting it.
   */
  readonly zoomMin: number;
  /** Furthest the player may push the camera, as an offset on `distance`. */
  readonly zoomMax: number;
  /** World units of zoom per wheel notch. */
  readonly zoomStep: number;
  /**
   * How fast the zoom eases toward what the wheel asked for, per second.
   *
   * A wheel arrives as discrete notches, and applying one to the distance
   * directly is a jump. Easing turns each notch into a short glide, which is
   * the difference between a zoom that feels like a control and one that feels
   * like a stutter.
   */
  readonly zoomEase: number;
}

/**
 * FRAMED FOR A NINE-UNIT MACHINE.
 *
 * The mech fills the lower half of the shot, the cockpit sits near the centre,
 * and the corridor ahead is visible to the next obstacle. Every number here
 * had to grow with the machine: the previous framing was authored for a mount
 * a third this size, and at that distance a mech is a wall of dark plate with
 * the facility hidden behind it.
 *
 * The camera sits HIGH and well back, looking slightly down. That is not a
 * neutral choice - it is the angle that makes a thing look heavy, because it
 * puts the ground plane in shot under the feet and lets the shoulder blocks
 * read against the floor rather than against the sky.
 */
export const CAMERA: CameraConfig = {
  distance: 19,
  height: 8.5,
  /** Level with the cockpit, so the pilot is the thing the shot is about. */
  lookAtHeight: 6.4,
  followLerp: 9,
  fov: 64,
  near: 0.1,
  far: 3200,
  speedDistance: 14,
  speedFov: 12,
  speedReference: 190,
  speedEase: 2.2,

  // 9 to 47 units behind the machine at rest. The near limit keeps the camera
  // OUTSIDE the mech - it is a body four units deep, not a point, and a
  // distance that reaches inside it renders the cockpit from within. The far
  // limit is roughly twice the authored framing, which is as far back as the
  // corridor still reads as a corridor.
  zoomMin: -10,
  zoomMax: 28,
  zoomStep: 2.4,
  zoomEase: 12,
};
