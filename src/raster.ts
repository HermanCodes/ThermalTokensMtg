/**
 * Canvas -> 1bpp raster conversion.
 *
 * The M110 wants packed rows: MSB = leftmost pixel, bit set (1) = black.
 * Rows must be a whole number of bytes, so callers pass a byte-aligned width.
 *
 * Pipeline: greyscale -> CLAHE (local contrast) -> contrast/brightness (global
 * trim) -> error diffusion. The local step comes first deliberately: card art is
 * routinely bimodal (dark illustration plus a light rules box) and no single
 * global curve serves both. Lifting the art enough to reach a target density
 * flattens the rules box to blank paper.
 */

export type Dither = 'threshold' | 'floyd-steinberg' | 'atkinson';

/** Perceptual luminance, alpha composited onto white (unprinted paper). */
function luminance(d: Uint8ClampedArray, i: number): number {
  const a = d[i + 3] / 255;
  const r = d[i] * a + 255 * (1 - a);
  const g = d[i + 1] * a + 255 * (1 - a);
  const b = d[i + 2] * a + 255 * (1 - a);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Diffusion kernels as [dx, dy, weight] with a shared divisor.
 * Atkinson pushes only 3/4 of the error, which keeps midtones from turning
 * to mud at low resolution — noticeably better on a narrow thermal label.
 */
const KERNELS: Record<
  Exclude<Dither, 'threshold'>,
  { k: [number, number, number][]; div: number }
> = {
  'floyd-steinberg': {
    k: [
      [1, 0, 7],
      [-1, 1, 3],
      [0, 1, 5],
      [1, 1, 1],
    ],
    div: 16,
  },
  atkinson: {
    k: [
      [1, 0, 1],
      [2, 0, 1],
      [-1, 1, 1],
      [0, 1, 1],
      [1, 1, 1],
      [0, 2, 1],
    ],
    div: 8,
  },
};

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// --- CLAHE ----------------------------------------------------------------

export interface ClaheOptions {
  /** Tiles per axis. More tiles = more local, but noisier on flat areas. */
  tiles?: number;
  /**
   * Contrast limit as a multiple of the average bin height. This is what makes
   * it *contrast limited*: excess histogram mass above the limit is clipped and
   * redistributed, which bounds how far any region can be stretched and stops
   * flat areas turning into amplified noise. 1 = no enhancement, 2-4 typical.
   */
  clipLimit?: number;
}

/**
 * Contrast Limited Adaptive Histogram Equalisation, in place.
 *
 * Builds an equalisation map per tile from that tile's clipped histogram, then
 * bilinearly interpolates between the four surrounding tile maps for every
 * pixel. The interpolation is what avoids visible tile seams.
 */
export function applyClahe(
  grey: Float32Array,
  w: number,
  h: number,
  opts: ClaheOptions = {},
): void {
  const tiles = Math.max(1, Math.floor(opts.tiles ?? 8));
  const clipLimit = Math.max(1, opts.clipLimit ?? 2.5);
  if (w < tiles || h < tiles) return;

  const tw = w / tiles;
  const th = h / tiles;

  // One 256-entry mapping per tile.
  const maps: Float32Array[] = [];
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const x0 = Math.floor(tx * tw);
      const x1 = Math.min(w, Math.floor((tx + 1) * tw));
      const y0 = Math.floor(ty * th);
      const y1 = Math.min(h, Math.floor((ty + 1) * th));

      const hist = new Float32Array(256);
      let count = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * w;
        for (let x = x0; x < x1; x++) {
          hist[clamp(Math.round(grey[row + x]), 0, 255)]++;
          count++;
        }
      }

      const map = new Float32Array(256);
      if (count === 0) {
        for (let i = 0; i < 256; i++) map[i] = i;
        maps.push(map);
        continue;
      }

      // Clip tall bins and redistribute the excess evenly.
      const limit = Math.max(1, (clipLimit * count) / 256);
      let excess = 0;
      for (let i = 0; i < 256; i++) {
        if (hist[i] > limit) {
          excess += hist[i] - limit;
          hist[i] = limit;
        }
      }
      const share = excess / 256;

      let cdf = 0;
      for (let i = 0; i < 256; i++) {
        cdf += hist[i] + share;
        map[i] = (255 * cdf) / count;
      }
      maps.push(map);
    }
  }

  const mapAt = (tx: number, ty: number) =>
    maps[clamp(ty, 0, tiles - 1) * tiles + clamp(tx, 0, tiles - 1)];

  // Bilinear blend between the four nearest tile centres.
  const out = new Float32Array(grey.length);
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) / th - 0.5;
    const ty0 = Math.floor(fy);
    const wy = fy - ty0;
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) / tw - 0.5;
      const tx0 = Math.floor(fx);
      const wx = fx - tx0;

      const v = clamp(Math.round(grey[y * w + x]), 0, 255);
      const m00 = mapAt(tx0, ty0)[v];
      const m10 = mapAt(tx0 + 1, ty0)[v];
      const m01 = mapAt(tx0, ty0 + 1)[v];
      const m11 = mapAt(tx0 + 1, ty0 + 1)[v];

      const top = m00 + (m10 - m00) * wx;
      const bottom = m01 + (m11 - m01) * wx;
      out[y * w + x] = top + (bottom - top) * wy;
    }
  }
  grey.set(out);
}

// --- packing --------------------------------------------------------------

export interface RasterOptions {
  dither?: Dither;
  /**
   * 0-255 cut point. Only strongly affects `threshold` mode — error diffusion
   * preserves average tone, so this barely moves a dithered image.
   */
  threshold?: number;
  /** Local contrast normalisation, applied before the global trim. */
  clahe?: ClaheOptions | null;
  /** -100..100. Global trim on top of CLAHE; shifts overall density. */
  brightness?: number;
  /** -100..100. Global expansion or compression around mid grey. */
  contrast?: number;
  invert?: boolean;
}

/**
 * Pack an ImageData into the printer's 1bpp row format.
 *
 * @param widthBytes bytes per output row (pads/crops to this width)
 */
export function imageDataToRaster(
  img: ImageData,
  widthBytes: number,
  opts: RasterOptions = {},
): Uint8Array {
  const { width: w, height: h, data } = img;
  const dither = opts.dither ?? 'atkinson';
  const threshold = opts.threshold ?? 128;
  const outWidth = widthBytes * 8;
  const out = new Uint8Array(widthBytes * h);

  // Work on a float greyscale buffer so error diffusion can go out of range.
  const grey = new Float32Array(w * h);
  for (let i = 0, p = 0; p < grey.length; p++, i += 4) {
    grey[p] = luminance(data, i);
  }

  if (opts.clahe) applyClahe(grey, w, h, opts.clahe);

  const bright = (opts.brightness ?? 0) * 2.55;
  const contrast = (100 + (opts.contrast ?? 0)) / 100;
  if (bright !== 0 || contrast !== 1) {
    for (let p = 0; p < grey.length; p++) {
      grey[p] = clamp((grey[p] - 128) * contrast + 128 + bright, 0, 255);
    }
  }

  const kernel = dither === 'threshold' ? null : KERNELS[dither];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const old = grey[p];
      const isBlack = old < threshold;
      const next = isBlack ? 0 : 255;

      if (kernel) {
        const err = old - next;
        for (const [dx, dy, wt] of kernel.k) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= w || ny >= h) continue;
          grey[ny * w + nx] += (err * wt) / kernel.div;
        }
      }

      const black = opts.invert ? !isBlack : isBlack;
      if (black && x < outWidth) {
        out[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }

  return out;
}

export function canvasToRaster(
  canvas: HTMLCanvasElement,
  widthBytes: number,
  opts: RasterOptions = {},
): { raster: Uint8Array; height: number } {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d context');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { raster: imageDataToRaster(img, widthBytes, opts), height: canvas.height };
}

/** Render a packed raster back to a canvas — exact preview of what prints. */
export function rasterToCanvas(
  raster: Uint8Array,
  widthBytes: number,
  height: number,
  target: HTMLCanvasElement,
): void {
  const w = widthBytes * 8;
  target.width = w;
  target.height = height;
  const ctx = target.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(w, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < w; x++) {
      const bit = (raster[y * widthBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      const v = bit ? 0 : 255;
      const i = (y * w + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// --- automatic tone -------------------------------------------------------

export interface ToneStats {
  /** Mean luminance 0-255 after CLAHE, if CLAHE was requested. */
  mean: number;
  /** Standard deviation of luminance. */
  std: number;
  /** 256-bin luminance histogram. */
  histogram: number[];
  /** Total pixels sampled. */
  count: number;
}

/**
 * Measure an image's tone at reduced resolution, running the same CLAHE the
 * renderer will.
 *
 * Measuring the post-CLAHE image is the point: solving brightness against the
 * raw histogram would fight the local step instead of trimming it.
 */
export function analyseImageTone(
  img: HTMLImageElement,
  opts: { sampleWidth?: number; clahe?: ClaheOptions | null } = {},
): ToneStats {
  const w = Math.max(1, opts.sampleWidth ?? 128);
  const h = Math.max(1, Math.round((w * img.height) / img.width));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  // White ground so transparent card corners count as paper, matching print.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  const d = ctx.getImageData(0, 0, w, h).data;
  const grey = new Float32Array(w * h);
  for (let i = 0, p = 0; p < grey.length; p++, i += 4) {
    grey[p] = luminance(d, i);
  }
  if (opts.clahe) applyClahe(grey, w, h, opts.clahe);

  const histogram = new Array<number>(256).fill(0);
  const count = w * h;
  let sum = 0;
  let sumSq = 0;
  for (let p = 0; p < grey.length; p++) {
    const v = clamp(Math.round(grey[p]), 0, 255);
    histogram[v]++;
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / count;
  return {
    mean,
    std: Math.sqrt(Math.max(0, sumSq / count - mean * mean)),
    histogram,
    count,
  };
}

/** Luminance at a given percentile of the histogram. */
export function percentile(stats: ToneStats, p: number): number {
  const target = (stats.count * p) / 100;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += stats.histogram[v];
    if (acc >= target) return v;
  }
  return 255;
}

export interface AutoToneOptions {
  /** Desired ink coverage, 0..1. Around 0.3 reads well on thermal paper. */
  targetInk?: number;
  /** Contrast held while solving — it governs legibility, not coverage. */
  contrast?: number;
}

export interface AutoToneResult {
  brightness: number;
  /** Predicted ink coverage 0..1. */
  predictedInk: number;
  /** Fraction of pixels flattened to pure black or white. */
  predictedClip: number;
  /** True when the solve hit its brightness limit and fell short of target. */
  clamped: boolean;
}

/**
 * Solve the brightness that lands an image on a target ink coverage.
 *
 * Error diffusion reproduces average tone, so coverage is essentially
 * `(255 - mean) / 255`. That inverts exactly: pick the mean giving the coverage
 * you want, then solve the brightness that gets there at the caller's contrast.
 *
 * Only a modest trim is needed now, because CLAHE has already normalised local
 * contrast — the brightness limits below exist to catch pathological images
 * rather than to do the heavy lifting.
 */
export function autoTone(
  stats: ToneStats,
  opts: AutoToneOptions = {},
): AutoToneResult {
  const targetInk = clamp(opts.targetInk ?? 0.3, 0.02, 0.95);
  const contrast = opts.contrast ?? 18;
  const cf = (100 + contrast) / 100;
  const targetMean = 255 * (1 - targetInk);

  // Mean after contrast alone, straight from the histogram.
  let sum = 0;
  for (let v = 0; v < 256; v++) {
    const n = stats.histogram[v];
    if (n !== 0) sum += clamp((v - 128) * cf + 128, 0, 255) * n;
  }
  const meanAfterContrast = sum / stats.count;

  const wanted = (targetMean - meanAfterContrast) / 2.55;
  const brightness = clamp(wanted, -45, 45);

  // Evaluate what that actually produces, including clipping.
  let finalSum = 0;
  let clipped = 0;
  const b = brightness * 2.55;
  for (let v = 0; v < 256; v++) {
    const n = stats.histogram[v];
    if (n === 0) continue;
    const x = clamp((v - 128) * cf + 128, 0, 255) + b;
    if (x <= 0 || x >= 255) clipped += n;
    finalSum += clamp(x, 0, 255) * n;
  }
  const finalMean = finalSum / stats.count;

  return {
    brightness: Math.round(brightness),
    predictedInk: clamp((255 - finalMean) / 255, 0, 1),
    predictedClip: clipped / stats.count,
    clamped: Math.abs(wanted) > 45.5,
  };
}
