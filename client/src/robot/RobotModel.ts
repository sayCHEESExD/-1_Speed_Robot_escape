import { robotForSlot, type RobotDefinition } from '@robot/shared';
import { Group, Mesh, MeshLambertMaterial } from 'three';
import { robotParts, type RobotParts } from './RobotGeometry.js';

/**
 * TWO materials for every robot in the scene.
 *
 * Colour lives in the vertices, so a scrap walker and a void colossus are the
 * same draw state - which is what lets the display deck show ten mechs without
 * ten material uploads. Lambert rather than Standard: the art direction is
 * flat and neon-lit, and a PBR shader would spend its whole cost on roughness
 * the style deliberately does not have.
 *
 * The second material is the GLOW, and it exists because a sensor strip drawn
 * as a merely bright vertex colour reads as paint. Emissive on the whole model
 * would flatten the armour into a slab of light, so the lit parts are their
 * own geometry with their own material and nothing else changes.
 */
let sharedMaterial: MeshLambertMaterial | null = null;
let sharedGlowMaterial: MeshLambertMaterial | null = null;
let sharedDisplayMaterial: MeshLambertMaterial | null = null;

const material = (): MeshLambertMaterial => {
  sharedMaterial ??= new MeshLambertMaterial({ vertexColors: true });
  return sharedMaterial;
};

/**
 * The SHOWROOM material: the same vertex colours, lit from inside.
 *
 * A display deck in a hangar this dark is a row of silhouettes without it -
 * the armour is Lambert and the only lights in the room are a dim hemisphere
 * and a sun the roof mostly blocks, so a parked mech reads as a dark shape
 * with a glowing strip on it and nothing else.
 *
 * A material rather than ten point lights, deliberately: a light per plinth
 * would raise the light count in every shader in the scene for an effect that
 * only ever applies to ten meshes standing still. One extra material costs a
 * single draw state.
 */
const displayMaterial = (): MeshLambertMaterial => {
  sharedDisplayMaterial ??= new MeshLambertMaterial({
    vertexColors: true,
    /*
     * A WHISPER of self-light, and no more.
     *
     * Emissive is added FLAT in linear space, on top of the vertex colour
     * rather than multiplied through it - so even 0.14 lifts a black frame and
     * a white one to within a shade of each other once the result is written
     * out as sRGB, and twelve machines that are meant to be distinguishable at
     * a glance come out as twelve identical pale silhouettes. It took exactly
     * that to find out. The plinth lamps do the real work.
     */
    emissive: 0xffffff,
    emissiveIntensity: 0.02,
  });
  return sharedDisplayMaterial;
};

const glowMaterial = (): MeshLambertMaterial => {
  sharedGlowMaterial ??= new MeshLambertMaterial({
    vertexColors: true,
    emissive: 0xffffff,
    emissiveIntensity: 0.95,
  });
  return sharedGlowMaterial;
};

/**
 * A built, animatable mech.
 *
 * The node tree is the animation contract: `RobotAnimator` writes to these
 * nodes and to nothing else, and the simulation writes only to `root`. That
 * separation is why an animation can never move the player.
 *
 *   root           placed by gameplay: world position and facing
 *     scaled       the robot's uniform scale
 *       body       the hip line. Carries bob, lean and roll; everything hangs
 *                  off it.
 *         cockpit shell, shoulders, hardware
 *         armL / armR   swing from the shoulder joints
 *           elbowL / elbowR   the forearms fold from the elbows
 *         legL / legR   swing from the hip joints
 *           kneeL / kneeR     the shins fold from the knees
 *         riderAnchor  THE COCKPIT FLOOR - inside the chest, not on top of
 *                      it - counter-scaled so a bigger frame does not also
 *                      produce a bigger person
 */
export class RobotModel {
  /** Attach this to the scene, or to a mount. Gameplay owns its transform. */
  readonly root = new Group();

  /**
   * Carries the mech's bob, lean and roll. Sits at the HIP LINE.
   *
   * Placing it at the hips rather than at the feet is what lets the animator
   * lean the upper half and swing the legs from one node without the feet
   * sliding: a rotation here pivots the machine about its own waist, which is
   * where a walking mech actually pivots.
   */
  readonly body = new Group();

  /**
   * The four limbs, each hung at its own joint, each with a real SECOND joint
   * under it.
   *
   * `armL` rotates about the shoulder and `elbowL` about the elbow; `legL`
   * about the hip and `kneeL` about the knee. A one-node limb would pivot the
   * whole leg about the hip and the "knee bend" would just be more hip swing,
   * which is exactly how a procedural walk gives itself away.
   */
  readonly armL = new Group();
  readonly armR = new Group();
  readonly elbowL = new Group();
  readonly elbowR = new Group();
  readonly legL = new Group();
  readonly legR = new Group();
  readonly kneeL = new Group();
  readonly kneeR = new Group();

  /**
   * Where the rider is parented.
   *
   * A child of `body`, so the pilot inherits the walk bob, the lean and the
   * roll for free and can never drift off the seat. Counter-scaled by the
   * robot's own scale, so a bigger mech does not also produce a bigger person.
   */
  readonly riderAnchor = new Group();

  readonly definition: RobotDefinition;
  readonly parts: RobotParts;

  /** The lit parts, kept so the animator can pulse them. */
  private readonly glowMesh: Mesh | null;

  private readonly scaled = new Group();

  constructor(definition: RobotDefinition) {
    this.definition = definition;
    this.parts = robotParts(definition);

    this.root.add(this.scaled);
    this.scaled.scale.setScalar(definition.scale);
    this.scaled.add(this.body);

    /*
     * The body node sits at the HIP LINE, and the feet reach the ground from
     * there.
     *
     * `root` is the simulation's transform and its `y` is the GROUND CONTACT
     * LINE, which for a walking mech is exactly where the soles are - so the
     * only lift in the whole model is this one, and it is a fact about the
     * skeleton rather than a visual fudge. Written on `scaled`'s child rather
     * than on `root`, because `root` is gameplay's and a renderer that moved
     * it would be a second physics system.
     */
    this.body.position.y = this.parts.hipY;
    this.body.add(mesh(this.parts.body));

    const [shoulderX, shoulderY, shoulderZ] = this.parts.shoulder;
    this.armL.position.set(shoulderX, shoulderY, shoulderZ);
    this.armR.position.set(-shoulderX, shoulderY, shoulderZ);
    this.armL.add(mesh(this.parts.upperArmL));
    this.armR.add(mesh(this.parts.upperArmR));
    this.elbowL.position.y = this.parts.elbowY;
    this.elbowR.position.y = this.parts.elbowY;
    this.elbowL.add(mesh(this.parts.forearm));
    this.elbowR.add(mesh(this.parts.forearm));
    this.armL.add(this.elbowL);
    this.armR.add(this.elbowR);
    this.body.add(this.armL);
    this.body.add(this.armR);

    const [hipX, hipY, hipZ] = this.parts.hip;
    this.legL.position.set(hipX, hipY, hipZ);
    this.legR.position.set(-hipX, hipY, hipZ);
    this.legL.add(mesh(this.parts.thigh));
    this.legR.add(mesh(this.parts.thigh));
    this.kneeL.position.y = this.parts.kneeY;
    this.kneeR.position.y = this.parts.kneeY;
    this.kneeL.add(mesh(this.parts.shin));
    this.kneeR.add(mesh(this.parts.shin));
    this.legL.add(this.kneeL);
    this.legR.add(this.kneeR);
    this.body.add(this.legL);
    this.body.add(this.legR);

    if (this.parts.glow) {
      this.glowMesh = new Mesh(this.parts.glow, glowMaterial());
      this.body.add(this.glowMesh);
    } else {
      this.glowMesh = null;
    }

    /*
     * THE COCKPIT FLOOR, and the pilot stands ON it.
     *
     * `riderOffset` is authored in the roster from the mech's OWN ORIGIN - the
     * ground between the feet - because that is the space a reader can reason
     * about. `riderAnchor` is a child of `body`, which sits at the hip line,
     * so the hip height comes back off here.
     *
     * If this ever resolves ABOVE the chest rather than inside it, the pilot
     * is standing on the machine instead of driving it, which is the single
     * worst thing this game can look like. `RobotParts.cockpitY` is the same
     * number arrived at from the geometry side; they must agree.
     */
    const offset = definition.riderOffset;
    this.riderAnchor.position.set(offset.x, offset.y - this.parts.hipY, offset.z);
    this.riderAnchor.scale.setScalar(1 / definition.scale);
    this.body.add(this.riderAnchor);
  }

  /** Height from the ground line to the shoulder blocks, for labels. */
  get height(): number {
    return this.parts.height * this.definition.scale;
  }

  /**
   * Brighten the neon, 0..1.
   *
   * The one visual the ANIMATOR drives that is not a transform, and it earns
   * the exception: a mech seen head-on has no attitude to read, and the strip
   * brightening as it pushes into a run is what says the machine is working.
   * Silently does nothing on a frame with no lit parts.
   */
  setGlow(amount: number): void {
    if (!this.glowMesh) return;
    const clamped = amount < 0 ? 0 : amount > 1 ? 1 : amount;
    // Written on the MESH's own material instance only if one exists - the
    // shared material is never mutated, or every mech in the room would flare
    // whenever anybody started running.
    const target = this.glowMesh.material as MeshLambertMaterial;
    if (target === sharedGlowMaterial) {
      this.glowMesh.material = target.clone();
    }
    (this.glowMesh.material as MeshLambertMaterial).emissiveIntensity =
      0.7 + clamped * 1.2;
  }

  /**
   * Light this mech as a SHOWROOM model rather than a played one.
   *
   * Presentation only, and it touches nothing the animator writes: it swaps
   * the material on the armour meshes and leaves every transform, the glow
   * mesh and the rider anchor exactly as they were. The plinths call it; the
   * player's own mount never does.
   */
  setDisplayLit(on: boolean): void {
    const target = on ? displayMaterial() : material();
    this.body.traverse((node) => {
      const mesh = node as Mesh;
      if (!mesh.isMesh) return;
      // The glow mesh has its own material and its own meaning - relighting it
      // here would undo `setGlow` on the frame the deck was built.
      if (mesh === this.glowMesh) return;
      mesh.material = target;
    });
  }

  /** Reset every animated node to its rest pose. */
  resetPose(): void {
    this.body.position.set(0, this.parts.hipY, 0);
    this.body.rotation.set(0, 0, 0);
    this.body.scale.setScalar(1);
    for (const limb of [
      this.armL,
      this.armR,
      this.elbowL,
      this.elbowR,
      this.legL,
      this.legR,
      this.kneeL,
      this.kneeR,
    ]) {
      limb.rotation.set(0, 0, 0);
    }
    this.setGlow(0);
  }

  /**
   * Meshes are cheap and geometry is shared, so disposal only unhooks the
   * scene graph. The cached per-robot geometry outlives every instance and is
   * released by `disposeRobotGeometry`.
   */
  dispose(): void {
    // The cloned glow material is this instance's own, so it is this
    // instance's to release.
    const glow = this.glowMesh?.material as MeshLambertMaterial | undefined;
    if (glow && glow !== sharedGlowMaterial) glow.dispose();
    this.root.removeFromParent();
  }
}

/** A fresh mech for a replicated slot. Never throws on an unknown slot. */
export const robotModelForSlot = (slot: number): RobotModel =>
  new RobotModel(robotForSlot(slot));

const mesh = (geometry: RobotParts['body']): Mesh => {
  const node = new Mesh(geometry, material());
  node.castShadow = true;
  node.receiveShadow = true;
  return node;
};
