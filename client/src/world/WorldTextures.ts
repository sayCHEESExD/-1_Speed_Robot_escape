import {
  CanvasTexture,
  EquirectangularReflectionMapping,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from 'three';

/**
 * Every texture in the game, drawn at runtime on a canvas.
 *
 * There is not one image file in this build's WORLD. The whole facility - the
 * deck plate, the ribbed bulkheads, the catwalk grating, the energy platforms,
 * the hazard pads and the far dark - costs a few kilobytes of code and nothing
 * at all against the 12 MB budget. The only images anywhere are the supplied
 * pilot FBX and the four HUD icons.
 *
 * EVERY SURFACE IN THIS BUILDING IS MANUFACTURED, and the textures say so:
 * panel seams, rivet lines, tread plate, hazard stripes and lit channels. Not
 * one of them is organic, and none may become so - the moment a surface reads
 * as brick or timber, the room stops being a mech facility.
 *
 * Textures are cached and shared: a caller asking twice gets the same GPU
 * upload, so the hundred-odd floor slabs of a six-stage course are one texture
 * between them.
 */
export class WorldTextures {
  private readonly cache = new Map<string, Texture>();

  /**
   * DECK PLATE: the floor of the whole facility.
   *
   * A dark chequer of large panels with a lit seam between them, which is what
   * the reference floors are: a grid you can judge distance against in a room
   * with almost no ambient light. The alternating tiles are barely different
   * from each other on purpose - the SEAM does the work, and a high-contrast
   * chequer at this scale reads as a kitchen.
   */
  grassStuds(color: string, highlight: string): Texture {
    return this.cached(`deck:${color}:${highlight}`, () => {
      const size = 256;
      const ctx = context(size);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, size, size);

      const half = size / 2;
      ctx.fillStyle = highlight;
      ctx.fillRect(0, 0, half, half);
      ctx.fillRect(half, half, half, half);

      // The lit seam, and the shadow that gives the panels a thickness.
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 6;
      ctx.strokeRect(0, 0, size, size);
      ctx.strokeRect(half, 0, half, half);
      ctx.strokeStyle = 'rgba(216,255,58,0.16)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, half);
      ctx.lineTo(size, half);
      ctx.moveTo(half, 0);
      ctx.lineTo(half, size);
      ctx.stroke();

      // Bolt heads at the panel corners: four dots that turn a flat square
      // into a plate somebody screwed down.
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      const bolts: readonly (readonly [number, number])[] = [
        [10, 10],
        [half - 10, 10],
        [10, half - 10],
        [half - 10, half - 10],
      ];
      for (const [bx, by] of bolts) {
        ctx.fillRect(bx - 2, by - 2, 5, 5);
        ctx.fillRect(bx + half - 2, by + half - 2, 5, 5);
      }
      return ctx.canvas;
    });
  }

  /**
   * RIBBED BULKHEAD: the wall of every corridor in the building.
   *
   * Tall recessed channels between raised ribs, exactly as the reference
   * corridors are built - it is the single strongest cue that a wall is a
   * manufactured panel rather than masonry, and it survives being seen at a
   * glancing angle at speed, which a brick pattern does not.
   */
  brick(color: string, dark: string, speck: string): Texture {
    return this.cached(`bulkhead:${color}:${dark}:${speck}`, () => {
      const size = 256;
      const ctx = context(size);
      ctx.fillStyle = dark;
      ctx.fillRect(0, 0, size, size);

      // Six ribs across, each a raised plate with a lit inner edge.
      const ribs = 6;
      const pitch = size / ribs;
      for (let i = 0; i < ribs; i += 1) {
        const x = i * pitch;
        ctx.fillStyle = color;
        ctx.fillRect(x + pitch * 0.14, 0, pitch * 0.58, size);
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(x + pitch * 0.14, 0, pitch * 0.07, size);
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(x + pitch * 0.66, 0, pitch * 0.06, size);
      }

      // Two horizontal splice bands, so the wall has a storey height.
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, size * 0.34, size, 5);
      ctx.fillRect(0, size * 0.72, size, 5);
      ctx.fillStyle = speck;
      ctx.fillRect(0, size * 0.34 + 5, size, 2);
      ctx.fillRect(0, size * 0.72 + 5, size, 2);
      return ctx.canvas;
    });
  }

  /**
   * CATWALK GRATING: the steel walkways and bridges.
   *
   * An open mesh with a solid kerb down each edge. Drawn as a grid of slots
   * rather than planks, because a bridge a mech walks over should look like
   * something you could drop a bolt through.
   */
  planks(color: string, dark: string, speck: string): Texture {
    return this.cached(`grate:${color}:${dark}:${speck}`, () => {
      const size = 128;
      const ctx = context(size);
      ctx.fillStyle = dark;
      ctx.fillRect(0, 0, size, size);

      ctx.fillStyle = color;
      const bar = 7;
      for (let i = 0; i < size; i += 16) {
        ctx.fillRect(0, i, size, bar);
        ctx.fillRect(i, 0, bar, size);
      }
      ctx.fillStyle = speck;
      for (let i = 0; i < size; i += 32) ctx.fillRect(i + 2, 2, 3, 3);
      return ctx.canvas;
    });
  }

  /**
   * HAZARD PAD: the diagonal-striped plate every clearance pad is made of.
   *
   * Yellow-and-black chevrons are the one piece of visual language every
   * player on earth already knows, which is exactly why the thing that pays
   * out wears them.
   */
  goldCheck(color: string, alt: string): Texture {
    return this.cached(`hazard:${color}:${alt}`, () => {
      const size = 128;
      const ctx = context(size);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, size, size);

      ctx.save();
      ctx.translate(size / 2, size / 2);
      ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = alt;
      for (let i = -size; i < size; i += 32) ctx.fillRect(i, -size, 16, size * 2);
      ctx.restore();

      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 8;
      ctx.strokeRect(0, 0, size, size);
      return ctx.canvas;
    });
  }

  /**
   * THE TROPHY PAD: flat gold, studded, and nothing else.
   *
   * The reference win area is a plain gold plate with a grid of studs on it -
   * not the hazard chevrons this used to wear. Chevrons are a WARNING, which
   * is exactly the wrong thing to say about the one surface in the game that
   * pays out: a player should read "prize" off it from the far end of a stage,
   * and stripes read "mind the gap".
   *
   * The studs are DELIBERATELY FAINT. They are what stops a big gold rectangle
   * looking like a flat fill, and at the distance this is usually seen from
   * they resolve into a texture rather than a pattern - which is what a studded
   * plate looks like in the art this is taken from.
   */
  winPlate(color: string, stud: string): Texture {
    return this.cached(`winplate:${color}:${stud}`, () => {
      const size = 256;
      const ctx = context(size);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, size, size);

      /*
       * Four studs a side, and each one is a HINT.
       *
       * A shadow under the lip and a pale highlight on top, both nearly
       * transparent: the gold has to stay gold. Drawn opaque they became a
       * polka dot, which is the failure mode of every stud texture - the dots
       * stop being surface and start being pattern.
       *
       * `stud` tints the highlight rather than replacing the plate, so the
       * palette still owns what colour a lit gold plate is.
       */
      const cells = 4;
      const pitch = size / cells;
      const radius = pitch * 0.17;
      for (let ix = 0; ix < cells; ix += 1) {
        for (let iy = 0; iy < cells; iy += 1) {
          const cx = (ix + 0.5) * pitch;
          const cy = (iy + 0.5) * pitch;

          ctx.fillStyle = 'rgba(0,0,0,0.13)';
          ctx.beginPath();
          ctx.arc(cx, cy + radius * 0.4, radius, 0, Math.PI * 2);
          ctx.fill();

          ctx.globalAlpha = 0.35;
          ctx.fillStyle = stud;
          ctx.beginPath();
          ctx.arc(cx, cy, radius, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      /*
       * NO SEAM, unlike every other plate in the facility.
       *
       * The deck, the bulkheads and the catwalks all draw a panel edge,
       * because the building is made of panels somebody bolted together. The
       * trophy plate is ONE piece of gold - a seam every six units turned it
       * into a tiled floor, which is the opposite of the single object the
       * reference puts at the end of a stage.
       */
      return ctx.canvas;
    });
  }

  /**
   * MOLTEN COOLANT: the glowing fluid under the platforms.
   *
   * Cracked crust over a bright melt. Kept as `sand` because the pool system
   * that calls it has always used that name for "whatever is at the bottom".
   */
  sand(color: string, dark: string): Texture {
    return this.cached(`melt:${color}:${dark}`, () => {
      const size = 128;
      const ctx = context(size);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, size, size);

      // A lattice of dark crust, so the surface is a skin with light under it
      // rather than a sheet of flat orange.
      ctx.strokeStyle = dark;
      ctx.lineWidth = 5;
      let seed = 7;
      const rand = (): number => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      for (let i = 0; i < 16; i += 1) {
        ctx.beginPath();
        ctx.moveTo(rand() * size, 0);
        ctx.lineTo(rand() * size, size);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, rand() * size);
        ctx.lineTo(size, rand() * size);
        ctx.stroke();
      }
      return ctx.canvas;
    });
  }

  /**
   * ENERGY PLATFORM: the projected surface the whole course is played on.
   *
   * A dark carrier plate with a bright lattice burned across it and a lit
   * border all the way round. The BORDER is the point: a mech committing to a
   * landing is aiming at the far lip of one of these, and an edge you cannot
   * see is a jump you cannot judge.
   */
  runeSlab(color: string, edge: string): Texture {
    return this.cached(`energy:${color}:${edge}`, () => {
      const size = 128;
      const ctx = context(size);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, size, size);

      ctx.strokeStyle = edge;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.55;
      for (let i = 16; i < size; i += 16) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, size);
        ctx.moveTo(0, i);
        ctx.lineTo(size, i);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      ctx.lineWidth = 10;
      ctx.strokeStyle = edge;
      ctx.strokeRect(0, 0, size, size);
      return ctx.canvas;
    });
  }

  /**
   * MACHINE HOUSING: reactor shells, tower casings, the steppers over the melt.
   *
   * Large flush panels with recessed seams and a bolt line - the surface of
   * something cast and then bolted together, which is what every big shape in
   * this building is.
   */
  stone(color: string, dark: string): Texture {
    return this.cached(`housing:${color}:${dark}`, () => {
      const size = 128;
      const ctx = context(size);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, size, size);

      ctx.strokeStyle = dark;
      ctx.lineWidth = 4;
      ctx.strokeRect(6, 6, size - 12, size - 12);
      ctx.beginPath();
      ctx.moveTo(6, size * 0.62);
      ctx.lineTo(size - 6, size * 0.62);
      ctx.stroke();

      ctx.fillStyle = dark;
      for (let i = 0; i < 6; i += 1) ctx.fillRect(14 + i * 20, size * 0.62 + 8, 4, 4);
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      ctx.fillRect(6, 6, size - 12, 3);
      return ctx.canvas;
    });
  }

  /**
   * POLISHED PLATING: the frictionless test floors and coolant decks.
   *
   * Almost featureless, with a single broad sheen across it. The absence of
   * texture IS the tell - a player who can see no grip on a surface treats it
   * as slippery before they have stepped on it.
   */
  ice(color: string, bright: string): Texture {
    return this.cached(`polish:${color}:${bright}`, () => {
      const size = 128;
      const ctx = context(size);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, size, size);

      const sheen = ctx.createLinearGradient(0, 0, size, size);
      sheen.addColorStop(0, 'rgba(255,255,255,0)');
      sheen.addColorStop(0.45, bright);
      sheen.addColorStop(0.55, bright);
      sheen.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = sheen;
      ctx.fillRect(0, 0, size, size);
      ctx.globalAlpha = 1;

      ctx.strokeStyle = 'rgba(0,0,0,0.3)';
      ctx.lineWidth = 3;
      ctx.strokeRect(0, 0, size, size);
      return ctx.canvas;
    });
  }

  /**
   * TEST-RIG TREAD: the moving belt of a calibration platform.
   *
   * Travelling chevrons on dark rubber. The material scrolls this map, so an
   * empty rig still reads as running.
   */
  belt(base: string, mark: string): Texture {
    return this.cached(`tread:${base}:${mark}`, () => {
      const size = 128;
      const ctx = context(size);
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, size, size);

      ctx.strokeStyle = mark;
      ctx.lineWidth = 9;
      ctx.lineCap = 'butt';
      for (let i = -size; i < size * 2; i += 34) {
        ctx.beginPath();
        ctx.moveTo(i, size);
        ctx.lineTo(i + size / 2, size / 2);
        ctx.lineTo(i, 0);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, 0, size, 5);
      ctx.fillRect(0, size - 5, size, 5);
      return ctx.canvas;
    });
  }

  sky(): Texture {
    const texture = this.cached(
      'sky',
      () => {
        const width = 1536;
        const height = 768;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return canvas;

        const gradient = ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, '#1a7fe0');
        gradient.addColorStop(0.22, '#2f9bf0');
        gradient.addColorStop(0.4, '#57b7f8');
        gradient.addColorStop(0.52, '#8fd6ff');
        gradient.addColorStop(0.62, '#c8edff');
        gradient.addColorStop(0.76, '#7ec8f7');
        gradient.addColorStop(1, '#3b96e2');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);

        const random = seeded(20260908);
        const layers: CloudLayer[] = [
          { count: 30, minV: 0.2, maxV: 0.44, scale: 28, squash: 0.4, alpha: 0.45, shade: 0.16 },
          { count: 26, minV: 0.34, maxV: 0.54, scale: 46, squash: 0.52, alpha: 0.78, shade: 0.38 },
          { count: 18, minV: 0.46, maxV: 0.63, scale: 68, squash: 0.6, alpha: 0.95, shade: 0.55 },
        ];

        for (const layer of layers) {
          for (let i = 0; i < layer.count; i += 1) {
            const x = random() * width;
            const y = height * (layer.minV + random() * (layer.maxV - layer.minV));
            const scale = layer.scale * (0.65 + random() * 0.8);
            // Drawn again either side of the seam when it is close to one, so
            // a cloud is never sliced in half where the texture wraps.
            drawCloud(ctx, x, y, scale, layer, random);
            if (x < scale * 3) drawCloud(ctx, x + width, y, scale, layer, random);
            else if (x > width - scale * 3) drawCloud(ctx, x - width, y, scale, layer, random);
          }
        }

        return canvas;
      },
      false,
    );

    texture.mapping = EquirectangularReflectionMapping;
    return texture;
  }

  dispose(): void {
    for (const texture of this.cache.values()) texture.dispose();
    this.cache.clear();
  }

  private cached(key: string, draw: () => HTMLCanvasElement, repeat = true): Texture {
    const existing = this.cache.get(key);
    if (existing) return existing;

    const texture = new CanvasTexture(draw());
    texture.colorSpace = SRGBColorSpace;
    if (repeat) {
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
    }
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    this.cache.set(key, texture);
    return texture;
  }
}

const context = (size: number): CanvasRenderingContext2D => {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
};

/** Tuning for one depth of cloud. */
interface CloudLayer {
  readonly count: number;
  /** Latitude band the layer occupies, 0 = zenith, 0.5 = horizon. */
  readonly minV: number;
  readonly maxV: number;
  readonly scale: number;
  /** Vertical squash. Cumulus near the horizon are far wider than tall. */
  readonly squash: number;
  readonly alpha: number;
  /** How strongly the underside is shaded, 0..1. */
  readonly shade: number;
}

/**
 * One cumulus: a row of lobes that billow in the middle and flatten at the
 * base, drawn shaded then lit.
 */
const drawCloud = (
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  scale: number,
  layer: CloudLayer,
  random: () => number,
): void => {
  const lobes = 7 + Math.floor(random() * 5);

  // The layout is generated once and drawn twice, so the shaded pass and the
  // lit pass are the same shape rather than two different clouds.
  const shape: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < lobes; i += 1) {
    const t = lobes === 1 ? 0.5 : i / (lobes - 1);
    const bulge = Math.sin(t * Math.PI);
    shape.push({
      x: (t - 0.5) * scale * 3.2,
      y: -bulge * scale * (0.3 + random() * 0.45) + (random() - 0.5) * scale * 0.2,
      r: scale * (0.32 + bulge * 0.5 + random() * 0.2),
    });
  }
  // A flat-ish base, so the cloud sits on a line instead of floating.
  const baseLobes = 3 + Math.floor(random() * 3);
  for (let i = 0; i < baseLobes; i += 1) {
    const t = baseLobes === 1 ? 0.5 : i / (baseLobes - 1);
    shape.push({
      x: (t - 0.5) * scale * 2.6,
      y: scale * 0.12,
      r: scale * (0.35 + random() * 0.22),
    });
  }

  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, layer.squash);

  if (layer.shade > 0.01) {
    for (const lobe of shape) {
      softBlob(
        ctx,
        lobe.x,
        lobe.y + scale * 0.3,
        lobe.r,
        '150,190,225',
        layer.alpha * layer.shade,
      );
    }
  }
  for (const lobe of shape) {
    softBlob(ctx, lobe.x, lobe.y, lobe.r, '255,255,255', layer.alpha);
  }

  ctx.restore();
};

/**
 * A soft-edged blob.
 *
 * The gradient is what makes a cloud painterly: a plain filled circle gives a
 * hard rim that reads as a sticker however many you overlap.
 */
const softBlob = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  rgb: string,
  alpha: number,
): void => {
  if (radius <= 0) return;
  const gradient = ctx.createRadialGradient(x, y, radius * 0.2, x, y, radius);
  gradient.addColorStop(0, `rgba(${rgb},${alpha})`);
  gradient.addColorStop(0.6, `rgba(${rgb},${alpha * 0.82})`);
  gradient.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
};

/** Deterministic PRNG, so every client renders exactly the same sky. */
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
