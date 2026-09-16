import {
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  TextureLoader,
  type Texture,
} from 'three';

/**
 * One of the supplied PNGs, hung in the world as a flat panel.
 *
 * The counterpart to `CanvasSign`: that draws text the game composes, this
 * shows artwork the game was GIVEN. The two exist side by side because the
 * rules for each are different - a canvas sign is measured and shrunk to fit
 * its panel, and a supplied image is used exactly as it is.
 *
 * WHICH MEANS THE ASPECT RATIO IS DRIVEN, NEVER SET. The caller gives a
 * height; the width comes from the image once it has loaded. Setting both is
 * how a piece of supplied art gets squashed, and it is the same rule the HUD
 * icons follow in CSS.
 *
 * The texture is CACHED by URL. Thirty win pads all hang the same trophy, and
 * thirty decodes of one file would be thirty copies of it on the GPU.
 */
export class ImageBillboard {
  readonly mesh: Mesh;

  private readonly material: MeshBasicMaterial;
  private readonly geometry: PlaneGeometry;

  /**
   * @param url    served from the repo-level `assets/` folder
   * @param height world units tall. The width follows from the image.
   */
  constructor(url: string, height: number) {
    this.geometry = new PlaneGeometry(height, height);
    this.material = new MeshBasicMaterial({
      map: loadSharedImage(url),
      transparent: true,
      // Cut out the fully transparent border rather than blending it: a
      // billboard hanging in front of a lit platform shows its own soft edge
      // as a grey rectangle otherwise.
      alphaTest: 0.5,
      // Both faces, unlike a world sign. A sign carries text and would read
      // MIRRORED from behind, which is worse than not being there; a trophy is
      // near enough symmetrical that being visible from the far side of the
      // pad is worth more than the purity.
      side: DoubleSide,
      // Unlit on purpose. This is artwork, not a surface: shading it would put
      // the hall's own darkness over a UI element the player has to read.
      fog: false,
    });

    this.mesh = new Mesh(this.geometry, this.material);
    this.applyAspect();
  }

  /**
   * Take the real aspect ratio once the image has decoded.
   *
   * The plane is square until then, which is the right placeholder: it is the
   * wrong shape for a frame or two rather than invisible, and a trophy that
   * popped into existence late would be the one thing on a win pad that was
   * not there when the player arrived.
   *
   * The callback comes from the LOADER rather than from a texture event: a
   * shared texture is loaded exactly once, so a second billboard asking for
   * the same file gets one that has already decoded and must read the size
   * straight off it.
   */
  private applyAspect(): void {
    const texture = this.material.map;
    if (!texture) return;

    const image = texture.image as { width?: number; height?: number } | null;
    const w = image?.width ?? 0;
    const h = image?.height ?? 0;
    if (w > 0 && h > 0) {
      // HEIGHT drives, width follows. See the class comment.
      this.mesh.scale.set(w / h, 1, 1);
      return;
    }

    // Still loading. Ask to be told, and re-read then.
    onImageDecoded(texture, () => this.applyAspect());
  }

  dispose(): void {
    // The TEXTURE is deliberately not disposed: it is shared by every
    // billboard showing the same file, and releasing it here would blank the
    // other twenty-nine.
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}

const loader = new TextureLoader();
const CACHE = new Map<string, Texture>();

/**
 * Everyone still waiting on a texture that has not decoded yet.
 *
 * Kept beside the cache rather than on the texture, because the whole point of
 * sharing one decode between thirty billboards is that twenty-nine of them
 * never start a load of their own - so they have no load callback to hang off
 * and need somewhere to be told from.
 */
const WAITING = new Map<Texture, (() => void)[]>();

/**
 * One decode per URL, however many billboards ask for it.
 *
 * Exported because the win effect hangs the SAME trophy on a pool of sprites:
 * a second loader for `trophy.png` would be a second copy of it on the GPU for
 * a picture already sitting there on thirty win pads.
 */
export const loadSharedImage = (url: string): Texture => {
  const cached = CACHE.get(url);
  if (cached) return cached;
  const texture = loader.load(url, (loaded) => {
    const waiting = WAITING.get(loaded);
    WAITING.delete(loaded);
    for (const notify of waiting ?? []) notify();
  });
  CACHE.set(url, texture);
  return texture;
};

/**
 * Call `notify` when this texture's image is available.
 *
 * Exported as `onImageDecoded` for the same reason `loadSharedImage` is:
 * anything that sizes geometry from supplied art has to wait for the file,
 * because the aspect ratio is DRIVEN by the image and never set.
 */
export const onImageDecoded = (texture: Texture, notify: () => void): void => {
  const waiting = WAITING.get(texture);
  if (waiting) waiting.push(notify);
  else WAITING.set(texture, [notify]);
};

/** Release every cached image. For a full teardown only. */
export const disposeBillboardTextures = (): void => {
  for (const texture of CACHE.values()) texture.dispose();
  CACHE.clear();
  WAITING.clear();
};
