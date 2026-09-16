/**
 * DECODED PORTRAITS, by URL, shared by everything that draws one.
 *
 * Two boards and one nameplate per visible player all want the same handful of
 * faces, and a cache per drawing surface would fetch each of them several
 * times over and hold several copies. This is the one cache.
 *
 * `crossOrigin` is not optional, and it is the reason this is a module rather
 * than three calls to `new Image()`. Every surface here draws into a canvas
 * that becomes a WebGL TEXTURE, and drawing an image fetched WITHOUT CORS
 * taints the canvas - the upload then throws and the whole board, or the whole
 * nameplate, goes blank. A portrait whose host refuses CORS simply never
 * decodes and the name is drawn on its own.
 *
 * The caller is handed null until the image is ready and is told ONCE, through
 * its own callback, when it becomes ready - so a face that arrives late is
 * picked up on the next redraw rather than by polling for it every frame.
 */
const CACHE = new Map<string, HTMLImageElement>();

/**
 * The decoded image for this URL, or null while it is still on its way.
 *
 * @param url     the portrait, already checked to be on the portal's CDN
 * @param onReady called once when a fresh image finishes decoding; the caller
 *                uses it to invalidate whatever it drew without the face
 */
export const portraitFor = (
  url: string,
  onReady: () => void,
): HTMLImageElement | null => {
  const cached = CACHE.get(url);
  if (cached) return cached.complete && cached.naturalWidth > 0 ? cached : null;

  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.referrerPolicy = 'no-referrer';
  image.decoding = 'async';
  image.addEventListener('load', onReady);
  image.src = url;
  CACHE.set(url, image);
  return null;
};

/**
 * Draw a portrait as a CIRCLE, the way the portal shows one.
 *
 * Shared so a face is the same shape over a mech as it is on a board, and so
 * the clip is saved and restored in exactly one place - a stray `clip()` left
 * on a context silently blanks everything drawn after it.
 */
export const drawPortrait = (
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  centreY: number,
  size: number,
): void => {
  const radius = size / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + radius, centreY, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(image, x, centreY - radius, size, size);
  ctx.restore();

  /*
   * A hairline ring, in the HUD's own language.
   *
   * The portal renders its thumbnails on a pale backdrop, so an unringed
   * circle floats as a bright blob - over a dark hangar it reads as a hole in
   * the plate rather than as somebody's face. The ring gives it an edge and
   * ties it to every other bordered thing in this interface.
   */
  ctx.beginPath();
  ctx.arc(x + radius, centreY, radius - 0.5, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(1, size * 0.045);
  ctx.strokeStyle = 'rgba(3, 8, 14, 0.85)';
  ctx.stroke();
};
