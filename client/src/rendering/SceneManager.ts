import { AmbientLight, Color, DirectionalLight, Fog, HemisphereLight, Scene } from 'three';
import { PALETTE, WORLD_FOG } from '../config/worldVisuals.js';

/**
 * Bounce colour off the ground.
 *
 * Cold stone with a hint of the lava below it, not the previous game's bright
 * green meadow: the hemisphere light fills every downward-facing surface with
 * this, so a stale value tints the underside of the entire hall.
 */
const GROUND_BOUNCE = 0x3b4760;

/**
 * The scene root and the base lighting rig.
 *
 * Soft and simple on purpose. The art direction is flat toy-brick, so the
 * lighting exists to separate one face of a box from another and to lay a
 * shadow under each mount - not to model anything. A hemisphere fill, a low
 * ambient and a single key light is the whole rig.
 *
 * It is a NIGHT HANGAR, so the key is dim and the fill is cold, and what
 * carries the room instead is emission: the lava, the floor beacons, the wall
 * strips, the hard-light platforms and every mech's own neon are all lit
 * materials.
 *
 * The rig was inherited from a game set outdoors and it had to come DOWN by
 * more than half. The tell was the mech roster: armour is baked into vertex
 * colours, and under an outdoor key a black frame and a white one both came
 * out the same pale grey - twelve machines that are meant to be
 * distinguishable at a glance rendered as twelve identical silhouettes. What
 * is left is just enough to separate one face of a box from another, which is
 * all a flat toy-brick style ever needed.
 */
export class SceneManager {
  readonly scene = new Scene();

  /** The sun. Exposed so its shadow camera can follow the player. */
  readonly sun: DirectionalLight;

  constructor() {
    this.scene.fog = new Fog(PALETTE.fog, WORLD_FOG.near, WORLD_FOG.far);
    this.setBackground();

    /*
     * THE FILL, and there is a real amount of it.
     *
     * A facility is LIT. The first version of this rig was a dim key over
     * near-black materials, which is a room with the lights off: the neon read
     * perfectly and everything it was bolted to - floors, walls, stairs,
     * platforms, machinery, the mech itself - was a silhouette. Neon is an
     * ACCENT in this game, not the only source of visibility.
     *
     * Three lights do it, and three is the whole rig because every extra one
     * is paid for by every fragment in the world: a cool overhead hemisphere
     * for the ceiling bounce, a flat ambient so nothing is ever pure black,
     * and a key that gives every box a lit face and a shaded one. The
     * hemisphere's GROUND colour matters as much as its sky: it is what lifts
     * the undersides of platforms a player has to read from below.
     */
    const hemi = new HemisphereLight(0x5f7fb8, GROUND_BOUNCE, 1.55);
    hemi.position.set(0, 60, 0);
    this.scene.add(hemi);

    this.scene.add(new AmbientLight(0xc8d8ff, 0.95));

    this.sun = new DirectionalLight(0xe6f0ff, 1.9);
    this.sun.position.set(48, 95, -34);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 320;
    this.sun.shadow.camera.left = -90;
    this.sun.shadow.camera.right = 90;
    this.sun.shadow.camera.top = 90;
    this.sun.shadow.camera.bottom = -90;
    this.sun.shadow.bias = -0.0009;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
  }

  /**
   * Keep the shadow frustum over the player.
   *
   * The course is fifteen hundred units long and the shadow map is one texture.
   * A frustum big enough to cover the whole run would put a handful of texels
   * under each mount; moving a small frustum with the player keeps the shadows
   * crisp everywhere and costs one vector copy a frame.
   */
  followShadow(x: number, y: number, z: number): void {
    this.sun.target.position.set(x, y, z);
    this.sun.position.set(x + 48, y + 95, z - 34);
    this.sun.target.updateMatrixWorld();
  }

  /**
   * The flat colour behind everything.
   *
   * A fallback only: the blocky sky dome covers the whole view, so this is
   * what shows for the one frame before it is added and behind anything the
   * dome's triangles miss at an extreme aspect ratio. Matched to the fog, so
   * even then the seam is invisible.
   */
  setBackground(color: number = PALETTE.fog): void {
    this.scene.background = new Color(color);
  }
}
