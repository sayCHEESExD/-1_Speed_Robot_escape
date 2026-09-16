import {
  CanvasTexture,
  LinearFilter,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
} from 'three';
import { visibleName } from '@robot/shared';

/**
 * World units tall the text is drawn at.
 *
 * Sized against a NINE-UNIT MACHINE, not against a person: a plate tuned for
 * a human-scale character is a banner over a mech. A tenth of the mech's own
 * height is legible across the hangar and still reads as a label rather than
 * as signage.
 */
const HEIGHT = 1.25;

/** Canvas pixels per world unit. Enough to stay crisp at close range. */
const PIXELS_PER_UNIT = 44;

/** Widest a plate may get before the name is shrunk to fit it. */
const MAX_WIDTH = 11;

/**
 * THE NAME OVER A PLAYER'S HEAD.
 *
 * It is the portal's display name and nothing else - never the account id,
 * never the login handle, never the derived board handle. `visibleName` is the
 * one place that decides what an unnamed player is called, so a guest reads
 * the same here as on every board.
 *
 * A SPRITE, so it faces the camera from every angle without anything per-frame
 * pointing it: a plate that had to be turned toward the viewer would be one
 * more transform per player per frame, and it would still be wrong for one
 * frame after a sharp turn.
 *
 * The canvas is redrawn ONLY when the name changes, which for almost every
 * player is once, when they join. A remote that re-drew its plate on every
 * patch would upload a texture sixty times a second for a string that had not
 * moved.
 */
export class NamePlate {
  readonly sprite: Sprite;

  private readonly canvas: HTMLCanvasElement;
  private readonly texture: CanvasTexture;
  private readonly material: SpriteMaterial;

  /** What is currently painted, so an unchanged name costs one compare. */
  private painted = '\u0000';

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(MAX_WIDTH * PIXELS_PER_UNIT);
    this.canvas.height = Math.round(HEIGHT * PIXELS_PER_UNIT);

    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = LinearFilter;

    this.material = new SpriteMaterial({
      map: this.texture,
      transparent: true,
      // Unlit and unfogged: this is interface drawn in the world, and a name
      // that dimmed in a dark hall would be a name nobody could read.
      fog: false,
      depthWrite: false,
    });

    this.sprite = new Sprite(this.material);
    this.sprite.scale.set(MAX_WIDTH, HEIGHT, 1);
    this.sprite.visible = false;
  }

  /**
   * Show this player's name, and put the plate over their machine.
   *
   * @param displayName the replicated portal name; empty for a guest
   * @param height      the mech's own height, so the plate clears the shoulders
   *                    of a siege walker and does not float over a scout
   */
  set(displayName: string, height: number): void {
    const name = visibleName(displayName);
    if (name !== this.painted) {
      this.paint(name);
      this.painted = name;
    }
    this.sprite.position.set(0, height + 1.4, 0);
    this.sprite.visible = true;
  }

  private paint(name: string): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);

    /*
     * Set in the facility's own type, and sized to FIT.
     *
     * A display name is whatever the player chose, so the one thing that can
     * never happen is a name running off its own plate - it shrinks instead,
     * the same rule every sign in this world follows.
     */
    let size = height * 0.62;
    for (let pass = 0; pass < 4; pass += 1) {
      ctx.font = `700 ${size}px "Bahnschrift", "DIN Alternate", "Segoe UI Semibold", system-ui, sans-serif`;
      const drawn = ctx.measureText(name).width;
      const room = width * 0.92;
      if (drawn <= room) break;
      size *= room / drawn;
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    // A dark halo rather than an outline: the plate hangs over a lit hangar and
    // a dark pit alike, and this reads on both without looking like a sticker.
    ctx.lineWidth = size * 0.16;
    ctx.strokeStyle = 'rgba(2, 6, 12, 0.85)';
    ctx.strokeText(name, width / 2, height / 2);

    ctx.fillStyle = '#ffffff';
    ctx.fillText(name, width / 2, height / 2);

    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
    this.sprite.removeFromParent();
  }
}
