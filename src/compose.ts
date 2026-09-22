/**
 * Raster compositing.
 *
 * Different regions of one print need different treatment: a card image wants
 * tone adjustment and error diffusion, while text wants a hard threshold and no
 * tone shift at all. So each region is rendered and packed separately, then
 * bit-blitted into a single raster. Dithering the assembled image in one pass
 * would apply one setting to everything and wreck the text.
 */
import {
  imageDataToRaster,
  type Dither,
  type RasterOptions,
  type ClaheOptions,
} from './raster';
import { drawLabel, naturalWideHeight } from './label';
import type { TokenCard } from './scryfall';

/**
 * OR a byte-aligned source raster into a destination raster.
 * Byte alignment keeps this a plain byte copy — x positions are chosen as whole
 * numbers of bytes precisely so no bit shifting is needed.
 */
export function blit(
  dst: Uint8Array,
  dstWidthBytes: number,
  dstHeight: number,
  src: Uint8Array,
  srcWidthBytes: number,
  srcHeight: number,
  xBytes: number,
  y: number,
): void {
  for (let r = 0; r < srcHeight; r++) {
    const dy = y + r;
    if (dy < 0 || dy >= dstHeight) continue;
    const di = dy * dstWidthBytes + xBytes;
    const si = r * srcWidthBytes;
    for (let b = 0; b < srcWidthBytes; b++) {
      if (xBytes + b >= dstWidthBytes) break;
      dst[di + b] |= src[si + b];
    }
  }
}

/** Draw a solid horizontal rule across the full width. */
export function rule(
  dst: Uint8Array,
  widthBytes: number,
  height: number,
  y: number,
  thickness = 2,
): void {
  for (let t = 0; t < thickness; t++) {
    const yy = y + t;
    if (yy < 0 || yy >= height) continue;
    dst.fill(0xff, yy * widthBytes, (yy + 1) * widthBytes);
  }
}

/** Pack a canvas region to 1bpp using the given options. */
function pack(
  canvas: HTMLCanvasElement,
  widthBytes: number,
  opts: RasterOptions,
): Uint8Array {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return imageDataToRaster(
    ctx.getImageData(0, 0, canvas.width, canvas.height),
    widthBytes,
    opts,
  );
}

export interface CombinedOptions {
  widthBytes: number;
  /**
   * Height of the text block in px (8 px per mm), or 'auto' to size it to the
   * token's own text. On continuous roll height is free, and a fixed block
   * either crushes long rules text or wastes paper on short.
   */
  textHeightPx: number | 'auto';
  /** Card height in px; defaults to keeping the card's aspect ratio. */
  cardHeightPx?: number;
  dither?: Dither;
  brightness?: number;
  contrast?: number;
  /** Local contrast for the card half; the text half is never tone-adjusted. */
  clahe?: ClaheOptions | null;
  /** Threshold for the text block — it is never dithered. */
  threshold?: number;
  /** Rule thickness between the card and the text. 0 to omit. */
  dividerPx?: number;
  /** Print a TOKEN tag on the text block. */
  tokenMarker?: boolean;
}

/**
 * Dithered card on top, typographic text block underneath.
 *
 * Gives you the card to recognise at a glance and the crisp P/T and rules text
 * to actually read — which a dithered card alone can't provide at 203 dpi.
 */
export function buildCombinedLabel(
  img: HTMLImageElement,
  token: TokenCard,
  opts: CombinedOptions,
): { raster: Uint8Array; height: number } {
  const {
    widthBytes,
    textHeightPx,
    dither = 'atkinson',
    brightness = 0,
    contrast = 0,
    clahe,
    threshold = 128,
    dividerPx = 2,
    tokenMarker = false,
  } = opts;

  const W = widthBytes * 8;
  const textH =
    textHeightPx === 'auto'
      ? naturalWideHeight(token, W, { tokenMarker })
      : textHeightPx;
  const cardH = opts.cardHeightPx ?? Math.round((W * img.height) / img.width);
  const gap = Math.max(0, dividerPx) + (dividerPx > 0 ? 6 : 0);
  const height = cardH + gap + textH;
  const out = new Uint8Array(widthBytes * height);

  const scratch = document.createElement('canvas');

  // --- card: tone-adjusted and dithered ---------------------------------
  scratch.width = W;
  scratch.height = cardH;
  const cctx = scratch.getContext('2d', { willReadFrequently: true })!;
  cctx.fillStyle = '#fff';
  cctx.fillRect(0, 0, W, cardH);
  cctx.drawImage(img, 0, 0, W, cardH);
  blit(
    out,
    widthBytes,
    height,
    pack(scratch, widthBytes, { dither, brightness, contrast, clahe }),
    widthBytes,
    cardH,
    0,
    0,
  );

  // --- divider ------------------------------------------------------------
  if (dividerPx > 0) {
    rule(out, widthBytes, height, cardH + 3, dividerPx);
  }

  // --- text: hard threshold, no tone shift, no diffusion ------------------
  scratch.width = W;
  scratch.height = textH;
  // Force the wide layout. The height above was measured with it, and letting
  // drawLabel re-decide by aspect ratio would pick the stacked layout once the
  // auto-sized block turns squarish — crushing the rules text to fit above a
  // bottom-corner P/T, and disagreeing with the height we just reserved.
  drawLabel(scratch, token, {
    widthPx: W,
    heightPx: textH,
    showArt: false,
    layout: 'wide',
    tokenMarker,
  });
  blit(
    out,
    widthBytes,
    height,
    pack(scratch, widthBytes, { dither: 'threshold', threshold }),
    widthBytes,
    textH,
    0,
    cardH + gap,
  );

  return { raster: out, height };
}
