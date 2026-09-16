import {
  BackSide,
  BoxGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  Group,
  ShaderMaterial,
  SphereGeometry,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PALETTE } from '../config/worldVisuals.js';

/**
 * The sky: a gradient dome and a field of BLOCKY clouds.
 *
 * The clouds are real geometry rather than a painted texture, because the
 * reference art's clouds are unmistakably built out of bricks - soft painted
 * cumulus is the single fastest way to make this world stop looking like the
 * game it is copying. Each cloud is a cluster of boxes; the whole sky is TWO
 * merged meshes (a lit top and a shaded underside) and one dome, so the entire
 * atmosphere costs three draw calls.
 *
 * Nothing here casts or receives shadows and nothing is lit: a cloud that
 * darkened as the sun moved would be a cloud nobody asked for.
 */

/** How far out the dome sits. Inside the camera's far plane. */
const DOME_RADIUS = 1600;

/** Cloud field extent, in world units, and how high it floats. */
const FIELD = {
  halfWidth: 900,
  fromZ: -400,
  toZ: 2400,
  minY: 120,
  maxY: 240,
  clusters: 90,
} as const;

/** Deterministic PRNG, so every client sees exactly the same sky. */
const seeded = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export class Sky {
  readonly root = new Group();

  private readonly disposables: (BufferGeometry | ShaderMaterial | MeshBasicMaterial)[] = [];

  constructor() {
    this.root.add(this.buildDome());
    this.buildClouds();
    // Drawn behind everything, and never occluding the world.
    this.root.renderOrder = -1;
  }

  /**
   * A vertical gradient painted on the inside of a sphere.
   *
   * A two-stop shader rather than a texture: it is a dozen lines, it never
   * bands, and it costs no upload at all.
   */
  private buildDome(): Mesh {
    const geometry = new SphereGeometry(DOME_RADIUS, 24, 16);
    const material = new ShaderMaterial({
      side: BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new Color(0x2a86e0) },
        midColor: { value: new Color(PALETTE.sky) },
        bottomColor: { value: new Color(PALETTE.fog) },
      },
      vertexShader: `
        varying float vHeight;
        void main() {
          vHeight = normalize(position).y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 midColor;
        uniform vec3 bottomColor;
        varying float vHeight;
        void main() {
          // Two bands: deep blue overhead easing to the bright haze the fog
          // colour is matched to, so the horizon and the fog meet invisibly.
          float h = clamp(vHeight, -1.0, 1.0);
          vec3 sky = mix(midColor, topColor, clamp(h * 1.6, 0.0, 1.0));
          vec3 low = mix(bottomColor, midColor, clamp((h + 0.25) * 3.0, 0.0, 1.0));
          gl_FragColor = vec4(h > 0.0 ? sky : low, 1.0);
        }
      `,
    });

    this.disposables.push(geometry, material);
    const dome = new Mesh(geometry, material);
    dome.frustumCulled = false;
    return dome;
  }

  /**
   * The cloud field.
   *
   * Every cluster is five to nine boxes stepped around a centre, which is what
   * gives the chunky stacked silhouette the reference art has. Two merged
   * meshes rather than one so the undersides can be a shade darker without a
   * second material per cloud.
   */
  private buildClouds(): void {
    const random = seeded(0x9a1ce);
    const tops: BufferGeometry[] = [];
    const bases: BufferGeometry[] = [];

    for (let i = 0; i < FIELD.clusters; i += 1) {
      const cx = (random() * 2 - 1) * FIELD.halfWidth;
      const cy = FIELD.minY + random() * (FIELD.maxY - FIELD.minY);
      const cz = FIELD.fromZ + random() * (FIELD.toZ - FIELD.fromZ);
      const scale = 8 + random() * 16;
      const blocks = 5 + Math.floor(random() * 5);

      for (let b = 0; b < blocks; b += 1) {
        const t = blocks === 1 ? 0.5 : b / (blocks - 1);
        // A billow: widest and tallest in the middle of the cluster.
        const bulge = Math.sin(t * Math.PI);
        const w = scale * (1.1 + bulge * 1.5 + random() * 0.4);
        const h = scale * (0.5 + bulge * 0.55);
        const d = scale * (1.0 + bulge * 1.2 + random() * 0.4);

        const x = cx + (t - 0.5) * scale * 4.2;
        const y = cy + bulge * scale * 0.35 + (random() - 0.5) * scale * 0.2;
        const z = cz + (random() - 0.5) * scale * 1.2;

        const top = new BoxGeometry(w, h, d);
        top.translate(x, y, z);
        tops.push(top);

        // A flat slab under it, a touch wider, reading as the shaded base.
        const base = new BoxGeometry(w * 1.04, h * 0.32, d * 1.04);
        base.translate(x, y - h * 0.62, z);
        bases.push(base);
      }
    }

    this.addLayer(tops, PALETTE.cloud);
    this.addLayer(bases, PALETTE.cloudShade);
  }

  private addLayer(parts: BufferGeometry[], color: number): void {
    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (!merged) return;

    // Unlit and unfogged: a cloud two hundred units up must not fade into the
    // haze the ground uses, and must not dim as the sun's target moves.
    const material = new MeshBasicMaterial({ color, fog: false });
    this.disposables.push(merged, material);

    const mesh = new Mesh(merged, material);
    mesh.frustumCulled = false;
    this.root.add(mesh);
  }

  dispose(): void {
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.root.removeFromParent();
  }
}
