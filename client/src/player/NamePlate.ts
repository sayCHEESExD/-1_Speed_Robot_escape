import {
  CanvasTexture,
  LinearFilter,
  SRGBColorSpace,
  Sprite,
  SpriteMaterial,
} from 'three';
import { visibleName } from '@robot/shared';
import { drawPortrait, portraitFor } from '../bloxity/Portraits.js';

/**
 * World units tall the whole plate is - the portrait AND the name under it.
 *
 * Sized against a NINE-UNIT MACHINE, not against a person: a plate tuned for
 * a human-scale character is a banner over a mech.
 */
const HEIGHT = 2.8;

/** Canvas pixels per world unit. Enough to stay crisp at close range. */
const PIXELS_PER_UNIT = 44;

/** Widest a plate may get before the name is shrunk to fit it. */
const MAX_WIDTH = 11;

/** Share of the plate's height the portrait takes; the name has the rest. */
const FACE_SHARE = 0.56;

/**
 * How far the plate floats above the top of the machine.
 *
 * Above the MECH's own height, which is its shoulders - and a rider sits in
 * the chest below them wearing whatever the portal has put on their head.
 * Wings, tall hats and antennae all stand well over a bare skull, so the
 * clearance is generous on purpose: a name tangled in somebody's accessories
 * is worse than a name slightly too high.
 */
const CLEARANCE = 3.4;

/**
 * THE NAME AND FACE OVER A PLAYER'S HEAD.
 *
 * The portal's portrait over the portal's display name - the same pairing the
 * scoreboards use, so the player you are running beside and the player at the
 * top of the board are recognisably the same person. Never the account id,
 * never the login handle, never the derived board handle; `visibleName` is the
 * one place that decides what an unnamed player is called.
 *
 * A SPRITE, so it faces the camera from every angle without anything per-frame
 * pointing it: a plate that had to be turned toward the viewer would be one
 * more transform per player per frame, and it would still be wrong for one
 * frame after a sharp turn.
 *
 * The canvas is redrawn ONLY when the name or the portrait changes, which for
 * almost every player is once, when they join. A remote that re-drew its plate
 * on every patch would upload a texture sixty times a second for a string that
 * had not moved.
 */
export class NamePlate {
  readonly sprite: Sprite;

  private readonly canvas: HTMLCanvasElement;
  private readonly texture: CanvasTexture;
  private readonly material: SpriteMaterial;

  /** What is currently painted, so an unchanged plate costs one compare. */
  private painted = '\u0000';
  /** The name and portrait last asked for, so a late face can be redrawn. */
  private name = '';
  private face = '';

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
   * Show this player, and put the plate over their machine.
   *
   * @param displayName the replicated portal name; empty for a guest
   * @param avatarUrl   their replicated portrait on the portal's CDN, or empty
   * @param height      the mech's own height, so the plate clears the shoulders
   *                    of a siege walker and does not float over a scout
   */
  set(displayName: string, avatarUrl: string, height: number): void {
    this.name = visibleName(displayName);
    this.face = avatarUrl;
    this.repaint();
    this.sprite.position.set(0, height + CLEARANCE, 0);
    this.sprite.visible = true;
  }

  /**
   * Draw, but only if what would be drawn has actually changed.
   *
   * The signature carries whether the PORTRAIT WAS READY as well as which one
   * it is, so the plate drawn before a face decoded is replaced the moment it
   * lands - and is not redrawn again afterwards.
   */
  private repaint(): void {
    const image = this.face
      ? portraitFor(this.face, () => {
          // Straight back through the same path: the signature now differs,
          // so this draws exactly once more and then settles.
          if (this.sprite.visible) this.repaint();
        })
      : null;

    const signature = `${this.name}\u0000${image ? this.face : ''}`;
    if (signature === this.painted) return;
    this.painted = signature;
    this.paint(image);
  }

  private paint(image: HTMLImageElement | null): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    const { width, height } = this.canvas;
    ctx.clearRect(0, 0, width, height);

    /*
     * THE FACE ON TOP, THE NAME UNDER IT.
     *
     * Stacked rather than side by side, because this plate is read at a
     * glance from across a hangar and from any angle: a row that grew sideways
     * with the length of the name would hang off one shoulder of the machine
     * and swing as the camera moved. Stacked, the whole thing stays centred
     * over the mech whatever anybody is called.
     *
     * A player with no portrait is drawn as the name alone, vertically
     * centred - never as a blank circle, which would read as a missing player
     * rather than as a player the portal has no picture of.
     */
    const faceSize = image ? height * FACE_SHARE : 0;
    const textBand = height - faceSize;
    let size = textBand * 0.74;

    if (image) {
      drawPortrait(ctx, image, (width - faceSize) / 2, faceSize / 2, faceSize);
    }

    /*
     * Set in the facility's own type, and sized to FIT.
     *
     * A display name is whatever the player chose, so the one thing that can
     * never happen is a name running off its own plate - it shrinks instead,
     * the same rule every sign in this world follows.
     */
    for (let pass = 0; pass < 4; pass += 1) {
      ctx.font = `700 ${size}px "Bahnschrift", "DIN Alternate", "Segoe UI Semibold", system-ui, sans-serif`;
      const drawn = ctx.measureText(this.name).width;
      const room = width * 0.92;
      if (drawn <= room) break;
      size *= room / drawn;
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    // A dark halo rather than an outline: the plate hangs over a lit hangar and
    // a dark pit alike, and this reads on both without looking like a sticker.
    const baseline = faceSize + textBand / 2;
    ctx.lineWidth = size * 0.16;
    ctx.strokeStyle = 'rgba(2, 6, 12, 0.85)';
    ctx.strokeText(this.name, width / 2, baseline);

    ctx.fillStyle = '#ffffff';
    ctx.fillText(this.name, width / 2, baseline);

    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
    this.sprite.removeFromParent();
  }
}
