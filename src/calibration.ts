/**
 * Builds a calibration strip: the same image repeated at a range of
 * brightness/contrast settings, each cell dithered independently and labelled,
 * so the best combination can be picked by eye off real paper.
 *
 * Every cell is packed separately and then bit-blitted into the final raster.
 * Dithering the assembled strip in one pass would apply a single tone setting
 * to everything and defeat the whole exercise.
 */
import { imageDataToRaster, type Dither, type ClaheOptions } from './raster';
import { blit } from './compose';

const SANS = "'Arial Narrow', 'Helvetica Neue', Helvetica, Arial, sans-serif";

/**
 * `stack` gives one full-width cell per setting, straight down the roll — far
 * easier to compare than side-by-side cells, at the cost of paper.
 * `grid` packs contrast across the width to keep the strip short.
 */
export type CalibLayout = 'stack' | 'grid';

/** `art` is the card's art + type line band; `card` is the whole card. */
export type CalibContent = 'art' | 'card';

export interface CalibrationOptions {
  /** Output width in bytes (8 px per byte). */
  widthBytes: number;
  brightnessValues: number[];
  contrastValues: number[];
  layout?: CalibLayout;
  content?: CalibContent;
  /** Height of each image cell in px, for `art` content (8 px per mm). */
  cellH?: number;
  dither?: Dither;
  clahe?: ClaheOptions | null;
}

const LABEL_H = 18;
const HEADER_H = 22;
/** Art + type line: the widest tonal range on a card. */
const ART_TOP = 0.08;
const ART_BOTTOM = 0.52;

/** Render text to a crisp 1bpp raster — thresholded, never dithered. */
function textRaster(
  text: string,
  widthBytes: number,
  height: number,
  opts: { size?: number; bold?: boolean } = {},
): Uint8Array {
  const w = widthBytes * 8;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, height);
  ctx.fillStyle = '#000';
  ctx.font = `${opts.bold ? 'bold ' : ''}${opts.size ?? height - 5}px ${SANS}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 2, height / 2);
  return imageDataToRaster(ctx.getImageData(0, 0, w, height), widthBytes, {
    dither: 'threshold',
    threshold: 128,
  });
}

const fmt = (n: number) => (n > 0 ? `+${n}` : `${n}`);

export function buildCalibrationStrip(
  img: HTMLImageElement,
  opts: CalibrationOptions,
): { raster: Uint8Array; height: number; seams: number[] } {
  const {
    widthBytes,
    brightnessValues: brights,
    contrastValues: contrasts,
    layout = 'stack',
    content = 'art',
    cellH: cellHOpt = 200,
    dither = 'atkinson',
    clahe,
  } = opts;

  if (!brights.length || !contrasts.length) {
    throw new Error('Calibration needs at least one brightness and one contrast value');
  }

  const cols = layout === 'stack' ? 1 : contrasts.length;
  // Byte-align the columns so blitting needs no bit shifting.
  const cellWBytes = Math.max(1, Math.floor(widthBytes / cols));
  const cellW = cellWBytes * 8;

  // Source crop: whole card, or just the art band.
  const srcTop = content === 'card' ? 0 : ART_TOP;
  const srcFrac = content === 'card' ? 1 : ART_BOTTOM - ART_TOP;
  const sy = Math.round(img.height * srcTop);
  const sh = Math.max(1, Math.round(img.height * srcFrac));

  // A whole card must keep its proportions; an art band uses the chosen height.
  const cellH =
    content === 'card' ? Math.round((cellW * sh) / img.width) : cellHOpt;

  // One labelled cell per setting in stack layout; one row per brightness in grid.
  const cells: { b: number; c: number }[] = [];
  for (const b of brights) {
    for (const c of contrasts) cells.push({ b, c });
  }
  const rows = layout === 'stack' ? cells.length : brights.length;
  const height = HEADER_H + rows * (LABEL_H + cellH) + 8;
  const out = new Uint8Array(widthBytes * height);

  const headerText =
    layout === 'stack'
      ? `CALIBRATION  ${brights.length}x${contrasts.length} settings`
      : `CALIBRATION  ${contrasts.map((c) => `C${fmt(c)}`).join('  /  ')}`;
  blit(
    out,
    widthBytes,
    height,
    textRaster(headerText, widthBytes, HEADER_H, { size: 14, bold: true }),
    widthBytes,
    HEADER_H,
    0,
    0,
  );

  // One scratch canvas reused for every cell.
  const scratch = document.createElement('canvas');
  scratch.width = cellW;
  scratch.height = cellH;
  const sctx = scratch.getContext('2d', { willReadFrequently: true })!;

  const drawCell = (b: number, c: number, xBytes: number, y: number) => {
    sctx.fillStyle = '#fff';
    sctx.fillRect(0, 0, cellW, cellH);
    // Fill the cell, cropping rather than squashing.
    const scale = Math.max(cellW / img.width, cellH / sh);
    const dw = img.width * scale;
    const dh = sh * scale;
    sctx.save();
    sctx.beginPath();
    sctx.rect(0, 0, cellW, cellH);
    sctx.clip();
    sctx.drawImage(img, 0, sy, img.width, sh, (cellW - dw) / 2, (cellH - dh) / 2, dw, dh);
    sctx.restore();

    const cell = imageDataToRaster(sctx.getImageData(0, 0, cellW, cellH), cellWBytes, {
      dither,
      clahe,
      brightness: b,
      contrast: c,
    });
    blit(out, widthBytes, height, cell, cellWBytes, cellH, xBytes, y);
  };

  // Sample boundaries: a strip too long for one job is cut between samples.
  const seams: number[] = [];

  let y = HEADER_H;
  if (layout === 'stack') {
    for (const { b, c } of cells) {
      const label = `B${fmt(b)}   C${fmt(c)}`;
      blit(
        out,
        widthBytes,
        height,
        textRaster(label, widthBytes, LABEL_H, { size: 14, bold: true }),
        widthBytes,
        LABEL_H,
        0,
        y,
      );
      y += LABEL_H;
      drawCell(b, c, 0, y);
      y += cellH;
      // Full-width rule so adjacent cells read as separate samples.
      const ruleY = y - 1;
      for (let bb = 0; bb < widthBytes; bb++) out[ruleY * widthBytes + bb] = 0xff;
      seams.push(y);
    }
  } else {
    for (const b of brights) {
      blit(
        out,
        widthBytes,
        height,
        textRaster(`B${fmt(b)}`, widthBytes, LABEL_H, { size: 14, bold: true }),
        widthBytes,
        LABEL_H,
        0,
        y,
      );
      y += LABEL_H;
      contrasts.forEach((c, i) => drawCell(b, c, i * cellWBytes, y));
      y += cellH;
      seams.push(y);
    }
  }

  return { raster: out, height, seams };
}

/** Parse a comma-separated list of numbers, ignoring blanks and junk. */
export function parseValues(text: string): number[] {
  return text
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}
