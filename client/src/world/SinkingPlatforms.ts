import { SINKING_SOLIDS, sinkingOffsetAt } from '@robot/shared';
import { Color, Group, Mesh, MeshLambertMaterial, type Texture } from 'three';
import { PALETTE } from '../config/worldVisuals.js';
import { texturedBox } from './texturedBox.js';

/** How fast a warning platform shakes, in radians per second. */
const SHAKE_RATE = 34;

/** How far it shakes, in world units. */
const SHAKE_AMOUNT = 0.16;

/**
 * The platforms of stage 3 that drop into the quicksand.
 *
 * Their height is a PURE FUNCTION of the replicated clock, evaluated by the
 * exact same `sinkingOffsetAt` the server collides against - so the platform
 * the player can see is the platform they can stand on, with nothing
 * replicated per platform and nothing to drift.
 *
 * The warning is the whole mechanic: a platform shakes visibly and flushes
 * toward a warning colour for a beat before it goes, so crossing this stage is
 * a decision rather than a coin flip. One material is swapped for another
 * rather than tinted per-mesh, so a field of platforms is still two draw
 * states.
 */
export class SinkingPlatforms {
  readonly root = new Group();

  private readonly meshes: Mesh[] = [];
  private readonly baseY: number[] = [];
  private readonly baseX: number[] = [];

  private readonly steady: MeshLambertMaterial;
  private readonly warning: MeshLambertMaterial;

  constructor(plankTexture: Texture) {
    this.steady = new MeshLambertMaterial({ map: plankTexture });
    this.warning = new MeshLambertMaterial({
      map: plankTexture,
      // Tinted rather than replaced, so a warning platform is obviously the
      // same platform - just about to leave.
      color: new Color(PALETTE.sinkingWarn),
      emissive: new Color(PALETTE.sinkingWarn),
      emissiveIntensity: 0.35,
    });

    for (const platform of SINKING_SOLIDS) {
      const width = platform.maxX - platform.minX;
      const height = platform.maxY - platform.minY;
      const depth = platform.maxZ - platform.minZ;

      const geometry = texturedBox(width, height, depth, 4);
      const mesh = new Mesh(geometry, this.steady);
      const x = (platform.minX + platform.maxX) / 2;
      const y = (platform.minY + platform.maxY) / 2;
      mesh.position.set(x, y, (platform.minZ + platform.maxZ) / 2);
      mesh.castShadow = true;
      mesh.receiveShadow = true;

      this.root.add(mesh);
      this.meshes.push(mesh);
      this.baseY.push(y);
      this.baseX.push(x);
    }
  }

  /** @param elapsed the server's clock, replicated. */
  update(elapsed: number): void {
    for (let i = 0; i < this.meshes.length; i += 1) {
      const platform = SINKING_SOLIDS[i];
      const mesh = this.meshes[i];
      const baseY = this.baseY[i];
      const baseX = this.baseX[i];
      if (!platform || !mesh || baseY === undefined || baseX === undefined) continue;

      const { drop, warning } = sinkingOffsetAt(platform, elapsed);
      mesh.position.y = baseY - drop;
      // The shake is a sideways judder, which reads far better than a vertical
      // one against a platform that is about to move vertically.
      mesh.position.x = warning
        ? baseX + Math.sin(elapsed * SHAKE_RATE + i) * SHAKE_AMOUNT
        : baseX;

      const material = warning ? this.warning : this.steady;
      if (mesh.material !== material) mesh.material = material;
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) mesh.geometry.dispose();
    this.meshes.length = 0;
    this.steady.dispose();
    this.warning.dispose();
    this.root.removeFromParent();
  }
}
