import { NoToneMapping, PCFShadowMap, SRGBColorSpace, WebGLRenderer } from 'three';
import { clientConfig } from '../config/clientConfig.js';
import { isMobileGpu } from '../config/device.js';

/**
 * Most render pixels per CSS pixel on a phone.
 *
 * A phone reports a device pixel ratio of 2 or 3, so an uncapped canvas is
 * four to nine times the fragments for a difference nobody can see at arm's
 * length. Every one of those fragments is paid for by a scene of 400-odd draw
 * calls.
 */
const MOBILE_PIXEL_RATIO = 1.5;

/**
 * Owns the WebGLRenderer and the canvas sizing contract.
 *
 * Resize handling is centralised here: the renderer measures its container and
 * notifies subscribers (the camera) so nothing else has to listen to `resize`.
 */
export class RendererManager {
  readonly renderer: WebGLRenderer;

  private readonly container: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private readonly listeners = new Set<(width: number, height: number) => void>();

  /** rAF handle for a deferred re-measure; 0 when none is pending. */
  private pendingSizeRetry = 0;

  /** Extra cap on pixel ratio from the portal's graphics setting. */
  private qualityPixelRatio = Number.POSITIVE_INFINITY;

  /** True on a phone or tablet. A CEILING on quality, never a default. */
  private mobile = false;

  constructor(container: HTMLElement) {
    this.container = container;

    /*
     * A PHONE IS NOT GIVEN A DESKTOP RENDERER.
     *
     * Both of these are fixed when the context is created and cannot be moved
     * afterwards, so the decision has to be made HERE rather than left to the
     * portal's quality setting - which most players never touch, and which a
     * standalone build never receives at all. Until now a phone got MSAA and
     * a high-performance context by default and simply wore the cost.
     *
     * Multisampling is the expensive one: it multiplies the work of every
     * fragment on a tile-based mobile GPU, which is the architecture in every
     * phone. The pixel-ratio cap below does far more for the same look.
     */
    const mobile = isMobileGpu();
    this.renderer = new WebGLRenderer({
      antialias: !mobile,
      powerPreference: mobile ? 'default' : 'high-performance',
      alpha: false,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    // The art direction is flat, saturated and toy-like. Filmic tone mapping
    // desaturates exactly the bright greens and blues the style depends on,
    // so colours are passed through untouched.
    this.renderer.toneMapping = NoToneMapping;
    /*
     * SHADOWS ARE A DESKTOP EFFECT HERE.
     *
     * Every shadow-casting light renders the scene again into a depth map, and
     * this scene is 455 draw calls. A phone pays that twice per frame for a
     * soft edge under a mech it is mostly looking down at. The portal's quality
     * setting can still turn them back on for a tablet that wants them.
     */
    this.renderer.shadowMap.enabled = !mobile;
    // PCFSoftShadowMap is deprecated as of three r185.
    this.renderer.shadowMap.type = PCFShadowMap;
    /*
     * And the render resolution. A phone reports a device pixel ratio of 3, so
     * an uncapped canvas is nine times the fragments of a CSS-pixel one for a
     * difference nobody can see at arm's length on a five-inch screen.
     */
    this.mobile = mobile;

    container.appendChild(this.renderer.domElement);

    this.resizeObserver = new ResizeObserver(() => this.applySize());
    this.resizeObserver.observe(container);

    // Orientation changes on mobile do not always fire a container resize.
    window.addEventListener('orientationchange', this.onOrientationChange);

    this.applySize();
  }

  /** Subscribe to size changes. Fires immediately with the current size. */
  onResize(listener: (width: number, height: number) => void): () => void {
    this.listeners.add(listener);
    listener(this.width, this.height);
    return () => this.listeners.delete(listener);
  }

  /**
   * Apply a graphics quality level from the portal settings.
   *
   * Only the two knobs that can change after the context exists are moved:
   * render resolution and shadows. Antialiasing is fixed at construction by
   * WebGL itself, so a quality drop lowers the pixel ratio instead - which is
   * where the frame time actually goes on a weak GPU anyway.
   *
   * An unknown level leaves the renderer exactly as it is rather than guessing
   * at a default and silently downgrading somebody's machine.
   */
  setQuality(level: string): void {
    let pixelRatio: number;
    let shadows: boolean;
    switch (level) {
      case 'Low':
        pixelRatio = 1;
        shadows = false;
        break;
      case 'Medium':
        pixelRatio = 1.25;
        shadows = true;
        break;
      case 'High':
      case 'Ultra':
        pixelRatio = Number.POSITIVE_INFINITY;
        shadows = true;
        break;
      default:
        return;
    }

    /*
     * THE PHONE'S BUDGET IS A CEILING, NOT A DEFAULT, and that distinction is
     * the whole reason this was still wrong after the constructor set it.
     *
     * The portal reports "High" for everybody unless they have gone and
     * changed it - which almost nobody does - and this method then wrote that
     * straight over the mobile settings a moment after they were applied. A
     * phone was back on full resolution and shadows before the first frame,
     * and the constructor's work was invisible.
     *
     * Taking the LOWER of the two means the setting still works in the
     * direction that matters: a player who picks Low on a tablet gets Low.
     */
    this.qualityPixelRatio = this.mobile
      ? Math.min(pixelRatio, MOBILE_PIXEL_RATIO)
      : pixelRatio;
    const wanted = shadows && !this.mobile;
    if (this.renderer.shadowMap.enabled !== wanted) {
      this.renderer.shadowMap.enabled = wanted;
      // Materials cache the shadow configuration they were compiled against.
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.applySize();
  }

  get width(): number {
    return this.container.clientWidth || window.innerWidth;
  }

  get height(): number {
    return this.container.clientHeight || window.innerHeight;
  }

  dispose(): void {
    if (this.pendingSizeRetry !== 0) cancelAnimationFrame(this.pendingSizeRetry);
    this.resizeObserver.disconnect();
    window.removeEventListener('orientationchange', this.onOrientationChange);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private readonly onOrientationChange = (): void => {
    // Safari reports stale dimensions during the rotation animation.
    window.setTimeout(() => this.applySize(), 250);
  };

  private applySize(): void {
    const width = this.width;
    const height = this.height;

    if (width === 0 || height === 0) {
      // A page opened in a background tab can measure 0 before it is laid out,
      // and ResizeObserver callbacks are not delivered while rendering is
      // suspended - so retry rather than staying stuck at the canvas default.
      if (this.pendingSizeRetry === 0) {
        this.pendingSizeRetry = requestAnimationFrame(() => {
          this.pendingSizeRetry = 0;
          this.applySize();
        });
      }
      return;
    }

    const pixelRatio = Math.min(
      window.devicePixelRatio || 1,
      clientConfig.maxPixelRatio,
      this.qualityPixelRatio,
    );
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);

    for (const listener of this.listeners) listener(width, height);
  }
}
