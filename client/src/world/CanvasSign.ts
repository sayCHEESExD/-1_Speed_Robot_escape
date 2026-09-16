import { maxTextureEdge } from '../config/device.js';
import {
  CanvasTexture,
  FrontSide,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
} from 'three';

/** One line of text on a sign. */
export interface SignLine {
  readonly text: string;
  /** Relative share of the panel's height this line takes. */
  readonly size: number;
  readonly fill: string;
  /** Outline colour. The chunky dark rim every label in the reference has. */
  readonly stroke: string;
  /** Outline width, as a fraction of the font size. */
  readonly strokeWidth?: number;
}

/**
 * A floating text panel, drawn on a canvas.
 *
 * All of this game's world text - the stage gates, the "+N Speed" over each
 * treadmill, the price over each robot stand, the TRAINING title - is one of
 * these. Canvas rather than a font file because the style is a heavy stroked
 * display face a browser can draw directly, and because a font file would be
 * the single largest asset in a build that otherwise has almost none.
 *
 * Unlit on purpose: a sign that dims when it faces away from the sun is a sign
 * the player cannot read.
 */
export class CanvasSign {
  readonly mesh: Mesh;

  private readonly texture: CanvasTexture;
  private readonly material: MeshBasicMaterial;
  private readonly geometry: PlaneGeometry;

  /**
   * @param width  panel width in world units
   * @param height panel height in world units
   * @param lines  what to draw, top to bottom
   */
  constructor(width: number, height: number, lines: readonly SignLine[]) {
    /*
     * SIXTY-FOUR PIXELS A UNIT, UP TO A CEILING - AND THE CEILING IS THE POINT.
     *
     * Without one this line was the most expensive in the client. A sign is
     * sized from its WORLD size, so the stage gates - 46 units across - each
     * became a 2944 x 704 canvas: eight megapixels and thirty-three megabytes
     * of GPU memory for two words, thirty times over. The scene's textures came
     * to 369 MB, which is more than a phone will give one tab, and the symptom
     * was a browser that hung rather than a game that ran slowly.
     *
     * The comment this replaces said the cost was "texture memory only". That
     * is exactly the cost that mattered.
     *
     * Scaling the whole sign down rather than clamping one edge keeps the
     * canvas the same SHAPE as the panel, so the layout below is untouched and
     * nothing is squashed. Small labels are unaffected: they never reach the
     * ceiling, so they still get all 64.
     */
    const edge = maxTextureEdge();
    const pixelsPerUnit = Math.min(64, edge / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(width * pixelsPerUnit));
    canvas.height = Math.max(2, Math.round(height * pixelsPerUnit));

    const ctx = canvas.getContext('2d');
    if (ctx) drawLines(ctx, canvas.width, canvas.height, lines);

    this.texture = new CanvasTexture(canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 8;
    // No mipmaps: a sign is nearly always seen at a shallow angle from a
    // distance, and the blurred chain is what makes small labels mush.
    this.texture.generateMipmaps = false;
    this.texture.minFilter = LinearFilter;

    this.geometry = new PlaneGeometry(width, height);
    this.material = new MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      // Single-sided. A double-sided panel is legible from the front and
      // MIRRORED from behind, which is worse than not being there at all.
      side: FrontSide,
      depthWrite: false,
    });

    this.mesh = new Mesh(this.geometry, this.material);
  }

  dispose(): void {
    this.texture.dispose();
    this.material.dispose();
    this.geometry.dispose();
    this.mesh.removeFromParent();
  }
}

/*
 * THE FACILITY'S TYPEFACE, and every sign in the world is set in it.
 *
 * Bahnschrift is the DIN-derived face Windows ships and DIN Alternate is
 * Apple's; between them almost every player gets the squared, engineered
 * letterform that industrial signage is actually set in, with no font file to
 * download and no 12 MB budget spent on one. The fallbacks step down through
 * the narrow grotesques.
 *
 * NOT Arial Black. A poster face on a gate, a scoreboard and a bay header is
 * the single loudest way a world says "toy", and this one is a mech facility.
 */
const FONT = '"Bahnschrift", "DIN Alternate", "Roboto Condensed", "Segoe UI Semibold", system-ui, sans-serif';

/**
 * Draw the lines, sized to FIT.
 *
 * The bug this exists to prevent: sizing a line from its height band alone and
 * then drawing it centred. Nothing measured the result against the panel's
 * WIDTH, so any long string - "TRAINING", "60.0K Wins Required", "+3 Speed" on
 * a narrow label - simply ran off both ends of the canvas and was clipped by
 * the texture edge. The stroke made it worse: `strokeText` paints half a line
 * width OUTSIDE the glyphs, so even text that technically fitted lost the
 * outline on its first and last characters.
 *
 * So: reserve padding for the stroke, measure, and shrink until it fits. The
 * panels themselves are also authored wide enough that the shrink rarely has
 * to do anything - the fix is not "make the text small", it is "never let the
 * text exceed the space it was given".
 */
const drawLines = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  lines: readonly SignLine[],
): void => {
  ctx.clearRect(0, 0, width, height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  // Lines share the panel by their own heights, so a big title and a small
  // subtitle divide it proportionally rather than by a fixed grid.
  const total = lines.reduce((sum, line) => sum + line.size, 0) || 1;
  let cursor = 0;

  for (const line of lines) {
    const band = (line.size / total) * height;
    const strokeRatio = line.strokeWidth ?? 0.1;
    const centreY = cursor + band / 2;
    cursor += band;
    if (!line.text) continue;

    let fontSize = band * 0.8;

    /*
     * TRACKED OUT, the way stencilled signage is.
     *
     * Letter-spacing is what separates a technical sign from a headline, and
     * it has to be set BEFORE measuring or the shrink pass fits the wrong
     * string. Chromium supports the property directly; where it is not
     * supported the assignment is simply ignored and the text is merely tight.
     */
    const track = (size: number): void => {
      ctx.font = `700 ${size}px ${FONT}`;
      ctx.letterSpacing = `${size * 0.07}px`;
    };

    // Converge on a size whose glyphs AND outline sit inside the panel. Four
    // passes is plenty: each one scales by the exact overflow ratio.
    for (let pass = 0; pass < 4; pass += 1) {
      track(fontSize);
      const drawn = ctx.measureText(line.text).width + fontSize * strokeRatio;
      const room = width * 0.94;
      if (drawn <= room) break;
      fontSize *= room / drawn;
    }

    track(fontSize);
    ctx.lineWidth = fontSize * strokeRatio;
    ctx.strokeStyle = line.stroke;
    ctx.strokeText(line.text, width / 2, centreY);
    /*
     * The fill is drawn with a BLOOM of its own colour.
     *
     * Every sign in this facility is a lit panel, and a lit panel spills a
     * little light onto its own bezel. It is two lines of canvas and it is
     * most of what stops these reading as printed cardboard.
     */
    ctx.save();
    ctx.shadowColor = line.fill;
    ctx.shadowBlur = fontSize * 0.34;
    ctx.fillStyle = line.fill;
    ctx.fillText(line.text, width / 2, centreY);
    ctx.restore();
    ctx.letterSpacing = '0px';
  }
};
