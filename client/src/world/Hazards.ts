import { COURSE, COURSE_HAZARDS, hazardPositionAt, type CourseHazard } from '@robot/shared';
import {
  BoxGeometry,
  CircleGeometry,
  ConeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  SphereGeometry,
  type BufferGeometry,
  type Material,
} from 'three';
import { PALETTE } from '../config/worldVisuals.js';

/** How high the warning patch floats above the floor, to beat z-fighting. */
const WARN_LIFT = 0.06;

/**
 * Everything in the world that moves and kills.
 *
 * Every position here is a PURE FUNCTION of the server's clock: the server
 * evaluates `hazardPositionAt` against its own elapsed time to decide a death,
 * and this evaluates the identical function against the replicated value to
 * draw the thing. The two cannot disagree, because there is nothing to
 * disagree about - no hazard state is on the wire at all.
 *
 * Six kinds share one update loop and five shapes. A ball sweeps or rolls, a
 * bar segment orbits, masonry falls, a funnel drifts and a SPIKE simply sits
 * there - and which one a hazard is affects only what geometry it was given at
 * construction. The motion, and therefore the kill, is the same code for all
 * of them, which is exactly why a static spike bed cost this file a shape and
 * a case and nothing else.
 */
export class Hazards {
  readonly root = new Group();

  private readonly meshes: Mesh[] = [];
  /** The ground patch under each faller, or null for hazards that do not fall. */
  private readonly warnings: (Mesh | null)[] = [];

  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: Material[] = [];

  /** Scratch for a hazard position, so a frame allocates nothing. */
  private readonly at = { x: 0, y: 0, z: 0 };

  constructor() {
    // 16x12 segments: chunky enough to read as a toy ball, cheap enough that a
    // dozen of them cost nothing.
    const ball = this.keep(new SphereGeometry(1, 16, 12));
    const bar = this.keep(new BoxGeometry(1, 1, 1));
    const patch = this.keep(new CircleGeometry(1, 18));
    // A spike: four-sided, so it reads as forged iron rather than as a
    // smooth cone. Pointed UP, which is the direction it is always seen from
    // in a game played on a robot.
    const spike = this.keep(new ConeGeometry(1, 2.4, 4));

    /*
     * ONE lavender for every moving killer - balls and bars alike.
     *
     * In this game a colour is a promise, and lavender promises "this will end
     * your run". Stage 6 was first built with log-brown arms turning over a
     * log-brown floor, which is invisible until it has already hit; giving the
     * bars the same colour the rolling balls have had since stage 2 is worth
     * more than making a log look like a log.
     */
    const hazardMaterial = this.keepMaterial(
      new MeshLambertMaterial({ color: PALETTE.hazard }),
    );
    const rockMaterial = this.keepMaterial(new MeshLambertMaterial({ color: PALETTE.rock }));
    /*
     * Spikes are NOT lavender, and that is the one deliberate exception to the
     * colour promise above.
     *
     * Lavender means "this is moving and it will end your run", and the value
     * of that promise is that a player can track it. A spike bed never moves:
     * it is a property of the floor, read once and then routed around, and
     * painting a static field in the colour reserved for things that chase
     * would make every moving hazard in the game harder to pick out. What it
     * gets instead is a BRIGHT TIP on a dark shaft, which is the half that has
     * to be visible from directly above.
     */
    const spikeMaterial = this.keepMaterial(
      new MeshLambertMaterial({ color: PALETTE.spike }),
    );
    const spikeTipMaterial = this.keepMaterial(
      new MeshLambertMaterial({ color: PALETTE.spikeTip }),
    );
    const funnelMaterial = this.keepMaterial(
      new MeshLambertMaterial({ color: PALETTE.tornado, transparent: true, opacity: 0.8 }),
    );
    // Unlit and translucent: the warning is a marker on the ground, and a
    // marker that dimmed with the sun would be least visible in the shade of
    // the thing about to land on it.
    const warnMaterial = this.keepMaterial(
      new MeshBasicMaterial({
        color: PALETTE.impactWarn,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
      }),
    );

    for (const hazard of COURSE_HAZARDS) {
      let mesh: Mesh;
      switch (hazard.kind) {
        case 'spinner':
          // A cube, not a ball. Several of these at stepped radii are ONE
          // rigid bar, and a row of spheres would read as beads on a string.
          mesh = new Mesh(bar, hazardMaterial);
          mesh.scale.set(hazard.radius * 2.1, hazard.radius * 1.9, hazard.radius * 2.1);
          break;
        case 'faller':
          mesh = new Mesh(bar, rockMaterial);
          mesh.scale.set(hazard.radius * 1.8, hazard.radius * 1.8, hazard.radius * 1.8);
          break;
        case 'tornado':
          mesh = new Mesh(bar, funnelMaterial);
          // Tall and narrow: a funnel reaching from the ground to well over
          // the player's head, so it is visible across the whole arena.
          mesh.scale.set(hazard.radius * 1.7, hazard.radius * 4, hazard.radius * 1.7);
          break;
        case 'spike': {
          mesh = new Mesh(spike, spikeMaterial);
          mesh.scale.set(hazard.radius * 0.75, hazard.radius * 1.15, hazard.radius * 0.75);
          // The bright tip, parented to the shaft so it never has to be moved
          // separately - and a spike never moves at all, so this is the last
          // time either of them is touched.
          const tip = new Mesh(spike, spikeTipMaterial);
          tip.position.y = 0.62;
          tip.scale.setScalar(0.42);
          mesh.add(tip);
          break;
        }
        default:
          mesh = new Mesh(ball, hazardMaterial);
          mesh.scale.setScalar(hazard.radius);
      }

      mesh.position.set(hazard.x, hazard.y, hazard.z);
      mesh.castShadow = true;
      this.root.add(mesh);
      this.meshes.push(mesh);

      this.warnings.push(hazard.kind === 'faller' ? this.addWarning(patch, warnMaterial, hazard) : null);
    }
  }

  /** @param elapsed the server's clock, in seconds. */
  update(elapsed: number): void {
    for (let i = 0; i < this.meshes.length; i += 1) {
      const hazard = COURSE_HAZARDS[i];
      const mesh = this.meshes[i];
      if (!hazard || !mesh) continue;

      // A spike bed is authored where it stands and never moves, so every
      // frame spent re-deriving its position would be a frame spent copying
      // three numbers onto themselves.
      if (hazard.kind === 'spike') continue;

      hazardPositionAt(hazard, elapsed, this.at);
      mesh.position.set(this.at.x, this.at.y, this.at.z);

      switch (hazard.kind) {
        case 'spinner':
          // Turned to face along its own orbit, so the segments of one arm line
          // up into a bar instead of each sitting at its own angle.
          mesh.rotation.y = -Math.atan2(
            this.at.z - hazard.z,
            this.at.x - hazard.x,
          );
          break;
        case 'tornado':
          // Spinning on its own axis as well as travelling, which is the only
          // thing that separates a funnel from a tall grey box.
          mesh.rotation.y = elapsed * 4;
          break;
        case 'faller': {
          const warning = this.warnings[i];
          if (warning) {
            // The patch tightens and darkens as the rock comes down, so a
            // glance says how long is left rather than merely that something
            // is overhead. Both come from the SAME height the kill does.
            const fallen = 1 - (this.at.y - hazard.y) / Math.max(1, hazard.sweep);
            warning.scale.setScalar(hazard.radius * (1.9 - fallen * 0.6));
            const material = warning.material as MeshBasicMaterial;
            material.opacity = 0.2 + fallen * 0.42;
          }
          mesh.rotation.y = hazard.phase;
          break;
        }
        case 'roller':
          // Rolling the RIGHT way: the spin comes from the same travel the
          // position does, so a ball never slides while appearing to roll
          // backwards.
          mesh.rotation.x = -this.at.z / hazard.radius;
          break;
        default:
          mesh.rotation.z = -this.at.x / hazard.radius;
      }
    }
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.root.removeFromParent();
  }

  private addWarning(
    geometry: BufferGeometry,
    material: Material,
    hazard: CourseHazard,
  ): Mesh {
    const mesh = new Mesh(geometry, material.clone());
    this.materials.push(mesh.material as Material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(hazard.x, COURSE.floorY + WARN_LIFT, hazard.z);
    mesh.scale.setScalar(hazard.radius * 1.9);
    this.root.add(mesh);
    return mesh;
  }

  private keep<T extends BufferGeometry>(geometry: T): T {
    this.geometries.push(geometry);
    return geometry;
  }

  private keepMaterial<T extends Material>(material: T): T {
    this.materials.push(material);
    return material;
  }
}
