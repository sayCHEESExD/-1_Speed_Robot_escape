import { GUARDIAN } from '@robot/shared';
import { Group, Mesh, MeshLambertMaterial, type BufferGeometry } from 'three';
import { BoxSet } from '../robot/BoxSet.js';

/** How fast the rendered sentinel eases toward its replicated transform. */
const FOLLOW_RATE = 12;

/** Distance past which it is placed rather than eased. */
const SNAP_DISTANCE = 30;

/**
 * Palette. Dark plate with lit optics, so it belongs to the bay it patrols.
 *
 * The glow is the important part: this thing walks a hall lit by floor beacons,
 * and a machine the same colour as the bulkhead behind it is one a player
 * discovers by being hit. A lit optic band is enough to track it across the
 * whole bay.
 */
const PLATE = 0x3f4553;
const PLATE_DARK = 0x272c36;
const FRAME = 0x171b23;
const TRIM = 0x6f7a8c;
const EYE = 0xc4a8ff;

const shortestAngle = (from: number, to: number): number => {
  let diff = to - from;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return diff;
};

/**
 * The SENTINEL: a derelict heavy mech that patrols stage five.
 *
 * Built from the same `BoxSet` the rideable mechs use, and to the same rules -
 * blocky plate, vertex colour, and NO HEAD. It is simply enormous: the scale
 * is the whole characterisation, and it is why it reads as a threat without a
 * single extra vertex of detail. A player meeting it sees their own machine
 * five times over.
 *
 * It is also the reason that stage rewards the high route: the sentinel owns
 * the FLOOR, and the wreckage stacked around the hall is out of its reach. A
 * player who climbs crosses above it; one who does not is down there with it.
 *
 * Its transform is REPLICATED, not derived: it chases, and that depends on
 * where the players are - the one hazard in the game that is state rather than
 * a pure function of time. The client eases toward whatever the server says
 * and animates a walk cycle from how far it ACTUALLY moved, so the legs can
 * never be out of step with the travel.
 */
export class Guardian {
  readonly root = new Group();

  /** The torso. Everything hangs off it, and it sits at the hip line. */
  private readonly body = new Group();
  /** The optic cowl between the shoulders - where a head would be, and is not. */
  private readonly cowl = new Group();
  private readonly arms: Group[] = [];
  private readonly legs: Group[] = [];

  private readonly geometries: BufferGeometry[] = [];
  /*
   * One material, vertex-coloured, with a touch of emissive.
   *
   * The emissive is for the optics and it costs the rest of the model almost
   * nothing: at this intensity the dark plate barely lifts while the lavender
   * reads as lit, which is the cheapest possible way to get one glowing
   * feature without a second material and a second draw call for it.
   */
  private readonly material = new MeshLambertMaterial({
    vertexColors: true,
    emissive: 0x2a2145,
    emissiveIntensity: 0.35,
  });

  private targetX = 0;
  private targetZ = 0;
  private targetYaw = 0;
  private placed = false;
  private phase = 0;
  private charging = false;

  constructor() {
    this.root.add(this.body);
    // The hip line. The legs reach the floor from here, so this is the number
    // that decides how tall the thing is.
    this.body.position.y = 17;

    /*
     * Torso, waist and shoulders.
     *
     * Five nodes of articulation total - the torso, the cowl, two arms and two
     * legs - which is all a blocky machine this size needs and exactly the
     * skeleton the rideable frames use, one segment shorter.
     */
    const torso = new BoxSet();
    torso.add([9, 3, 7], [0, -1.5, 0], FRAME); // waist
    torso.add([14, 11, 9], [0, 6.5, 0], PLATE); // chest
    torso.add([9, 5.5, 2.6], [0, 7.5, 5.4], TRIM); // chest plate
    torso.addMirrored([2, 5, 8], [7, 6.5, 0], PLATE_DARK); // side intakes
    torso.add([11, 8, 3.4], [0, 7, -5.8], PLATE_DARK); // backpack
    // Shoulder blocks, and they are the silhouette: a sentinel is mostly
    // shoulders seen head-on, which is how it reads as heavy at any distance.
    torso.addMirrored([7, 7, 8], [10, 10, 0], PLATE);
    torso.addMirrored([7.6, 1.6, 8.6], [10, 13.6, 0], PLATE_DARK);
    torso.addMirrored([5, 4, 5], [7, -2.4, 0], PLATE_DARK); // hip blocks
    this.body.add(this.mesh(torso));

    /*
     * The cowl, and the OPTIC BAND across the front of it.
     *
     * No head, exactly as the rideable roster has none - this is a low armour
     * collar between the shoulders with a single lit strip on it. That strip
     * is the one LIT thing on the machine, in the lavender everything lethal
     * in this world glows, which is what makes it readable across a hundred
     * units of hall lit only by beacons. A dark machine in a dark room with no
     * light on it is one the player meets rather than sees coming, and a
     * chaser the player cannot see coming is a coin flip rather than a threat.
     */
    const cowl = new BoxSet();
    cowl.add([7, 3, 5.5], [0, 0, 0], FRAME);
    cowl.add([5.4, 1.1, 0.7], [0, 0.5, 2.9], EYE);
    cowl.addMirrored([0.7, 4.5, 0.7], [2.6, 3.4, -0.6], TRIM); // antennae
    this.cowl.position.set(0, 13.5, 0);
    this.cowl.add(this.mesh(cowl));
    this.body.add(this.cowl);

    // Arms: upper, elbow and forearm merged into one swinging limb. A sentinel
    // never grabs anything, so the elbow it does not bend is a node saved.
    const arm = new BoxSet();
    arm.add([3.6, 7, 3.6], [0, -3.5, 0], PLATE);
    arm.add([4, 1.4, 4], [0, -7.4, 0], FRAME);
    arm.add([4.2, 7.5, 4.2], [0, -11.8, 0], PLATE);
    arm.add([4.6, 3, 4.6], [0, -17, 0], PLATE_DARK); // fist
    const armGeometry = arm.build() as BufferGeometry;
    this.geometries.push(armGeometry);

    for (const x of [10, -10] as const) {
      const shoulder = new Group();
      shoulder.position.set(x, 10, 0);
      const mesh = new Mesh(armGeometry, this.material);
      mesh.castShadow = true;
      shoulder.add(mesh);
      this.body.add(shoulder);
      this.arms.push(shoulder);
    }

    // Legs: thigh, knee and shin merged the same way, with a long foot so the
    // thing reads as something that could stand up under its own weight.
    const leg = new BoxSet();
    leg.add([5.4, 8.5, 5.4], [0, -4.2, 0], PLATE);
    leg.add([5.8, 1.6, 5.8], [0, -9, 0], FRAME);
    leg.add([5.8, 7.5, 6], [0, -13.5, 0], PLATE);
    leg.add([6.4, 2.4, 9], [0, -18, 1.4], PLATE_DARK); // foot
    const legGeometry = leg.build() as BufferGeometry;
    this.geometries.push(legGeometry);

    for (const x of [4.2, -4.2] as const) {
      const hip = new Group();
      hip.position.set(x, -2, 0);
      const mesh = new Mesh(legGeometry, this.material);
      mesh.castShadow = true;
      hip.add(mesh);
      this.body.add(hip);
      this.legs.push(hip);
    }

    this.root.position.set(0, GUARDIAN.shoulderY, (GUARDIAN.minZ + GUARDIAN.maxZ) / 2);
  }

  /** Copy the replicated transform in. Called on every patch. */
  apply(x: number, z: number, rotationY: number, charging: boolean): void {
    this.targetX = x;
    this.targetZ = z;
    this.targetYaw = rotationY;
    this.charging = charging;
  }

  update(delta: number): void {
    const dt = Math.max(0, delta);
    const position = this.root.position;

    const previousX = position.x;
    const previousZ = position.z;
    const gap = Math.hypot(this.targetX - previousX, this.targetZ - previousZ);

    if (!this.placed || gap > SNAP_DISTANCE) {
      position.x = this.targetX;
      position.z = this.targetZ;
      this.root.rotation.y = this.targetYaw;
      this.placed = true;
    } else {
      const alpha = 1 - Math.exp(-FOLLOW_RATE * dt);
      position.x += (this.targetX - position.x) * alpha;
      position.z += (this.targetZ - position.z) * alpha;
      this.root.rotation.y += shortestAngle(this.root.rotation.y, this.targetYaw) * alpha;
    }

    // The gait is driven by distance ACTUALLY covered, so the legs can never
    // be out of step with the travel however the interpolation lands.
    const travelled = Math.hypot(position.x - previousX, position.z - previousZ);
    this.phase = (this.phase + travelled / 9) % (Math.PI * 2);

    const swing = Math.sin(this.phase);
    const amplitude = this.charging ? 0.5 : 0.28;
    // A BIPED: the two legs are half a cycle apart and the arms counter-swing.
    for (let i = 0; i < this.legs.length; i += 1) {
      const hip = this.legs[i];
      if (hip) hip.rotation.x = swing * amplitude * (i === 0 ? 1 : -1);
    }
    for (let i = 0; i < this.arms.length; i += 1) {
      const shoulder = this.arms[i];
      if (shoulder) shoulder.rotation.x = swing * amplitude * 0.7 * (i === 0 ? -1 : 1);
    }

    /*
     * The bob runs at DOUBLE the phase, exactly as the player's does.
     *
     * A biped's hips rise and fall on every footfall and there are two of
     * those per stride; bobbing once per cycle is what makes a walk read as a
     * limp, and a limping boss reads as a bug rather than as damage.
     */
    this.body.position.y = 17 - Math.abs(Math.sin(this.phase)) * (this.charging ? 0.9 : 0.5);
    this.body.rotation.z = swing * (this.charging ? 0.05 : 0.03);
    // Leaning in is the whole tell that it has noticed you.
    this.body.rotation.x = this.charging ? 0.12 : 0.02;
    this.cowl.rotation.x = Math.cos(this.phase * 2) * 0.06;
  }

  private mesh(set: BoxSet): Mesh {
    const geometry = set.build() as BufferGeometry;
    this.geometries.push(geometry);
    const mesh = new Mesh(geometry, this.material);
    mesh.castShadow = true;
    return mesh;
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    this.geometries.length = 0;
    this.material.dispose();
    this.root.removeFromParent();
  }
}
