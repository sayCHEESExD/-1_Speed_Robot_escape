import { NoToneMapping, PCFShadowMap, SRGBColorSpace, WebGLRenderer } from 'three';
import { clientConfig } from '../config/clientConfig.js';

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

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    // The art direction is flat, saturated and toy-like. Filmic tone mapping
    // desaturates exactly the bright greens and blues the style depends on,
    // so colours are passed through untouched.
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap is deprecated as of three r185.
    this.renderer.shadowMap.type = PCFShadowMap;

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

    this.qualityPixelRatio = pixelRatio;
    if (this.renderer.shadowMap.enabled !== shadows) {
      this.renderer.shadowMap.enabled = shadows;
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
