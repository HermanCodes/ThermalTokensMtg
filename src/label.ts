/**
 * Draws a token onto a canvas at printer resolution (8 px/mm, 203 dpi).
 *
 * Deliberately *not* a dithered photo of the card. At 320 px wide and 1 bit
 * deep, card art turns to mud, whereas black-on-white text is razor sharp — so
 * the label is a purpose-built typographic layout and the art is opt-in.
 */
import type { TokenCard } from './scryfall';
import { ptLabel } from './scryfall';

const SANS = "'Arial Narrow', 'Helvetica Neue', Helvetica, Arial, sans-serif";

export interface LabelOptions {
  widthPx: number;
  heightPx: number;
  /** Dither the art_crop into a band across the top. */
  showArt?: boolean;
  /** Show the "Creature — Goblin" line. */
  showTypeLine?: boolean;
  /** Show rules text. */
  showOracle?: boolean;
  /** Extra copies indicator, e.g. "3x" — purely cosmetic. */
  cornerNote?: string;
  /**
   * `tall` stacks everything with the P/T bottom-right. `wide` moves the P/T
   * into a right-hand column, which is the only way a short, wide block fits a
   * name, type line and rules text without crushing them. `auto` picks by
   * aspect ratio.
   */
  layout?: 'auto' | 'tall' | 'wide';
}

/** Mana/tap symbols like {T} or {1} are unreadable as braces at this size. */
function flattenSymbols(text: string): string {
  return text.replace(/\{([^}]+)\}/g, (_, s: string) => s.toUpperCase());
}

/** "Token Creature — Goblin Rogue" -> "Creature — Goblin Rogue" */
function tidyTypeLine(typeLine: string): string {
  return typeLine.replace(/^Token\s+/i, '').trim();
}

function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines.filter((l) => l.length > 0);
}

/**
 * Shrink the font until the text fits `maxLines` within `maxWidth`.
 * Returns the chosen size and the wrapped lines.
 */
function fit(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
  from: number,
  to: number,
  weight = 'bold',
): { size: number; lines: string[] } {
  for (let size = from; size >= to; size -= 1) {
    ctx.font = `${weight} ${size}px ${SANS}`;
    const lines = wrap(ctx, text, maxWidth);
    // Line count alone is not enough: `wrap` emits a single word that is wider
    // than maxWidth rather than dropping it, so a long one-word name would
    // otherwise "fit" on one line and overflow the column.
    const fitsWidth = lines.every((l) => ctx.measureText(l).width <= maxWidth);
    if (lines.length <= maxLines && fitsWidth) return { size, lines };
  }
  ctx.font = `${weight} ${to}px ${SANS}`;
  return { size: to, lines: wrap(ctx, text, maxWidth).slice(0, maxLines) };
}
/** Above this width:height ratio, the stacked layout runs out of vertical room. */
const WIDE_ASPECT = 1.7;

/**
 * Renders the label. Returns the canvas so callers can pack it to a raster.
 * Art, when enabled, must already be loaded (crossOrigin="anonymous") so its
 * pixels are readable — Scryfall's CDN sends permissive CORS headers.
 */
export function drawLabel(
  canvas: HTMLCanvasElement,
  token: TokenCard,
  opts: LabelOptions,
  art?: HTMLImageElement | null,
): HTMLCanvasElement {
  const { widthPx: W, heightPx: H } = opts;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';

  const wide =
    opts.layout === 'wide' || (opts.layout !== 'tall' && W / H > WIDE_ASPECT);

  if (wide) drawWide(ctx, token, opts, W, H);
  else drawTall(ctx, token, opts, W, H, art);

  return canvas;
}

/** Stacked layout: name, type, rules, P/T bottom-right. Suits squarer labels. */
function drawTall(
  ctx: CanvasRenderingContext2D,
  token: TokenCard,
  opts: LabelOptions,
  W: number,
  H: number,
  art?: HTMLImageElement | null,
): void {
  const pad = Math.round(W * 0.025);
  let y = pad;
  const contentW = W - pad * 2;

  // --- optional art band ---------------------------------------------------
  if (opts.showArt && art) {
    const bandH = Math.round(H * 0.3);
    const scale = Math.max(contentW / art.width, bandH / art.height);
    const dw = art.width * scale;
    const dh = art.height * scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad, y, contentW, bandH);
    ctx.clip();
    ctx.drawImage(art, pad + (contentW - dw) / 2, y + (bandH - dh) / 2, dw, dh);
    ctx.restore();
    y += bandH + Math.round(pad * 0.8);
  }

  // --- P/T block (reserved first: it anchors the bottom-right) -------------
  const pt = ptLabel(token);
  let ptWidth = 0;
  let ptSize = 0;
  if (pt) {
    ptSize = Math.round(H * 0.26);
    ctx.font = `bold ${ptSize}px ${SANS}`;
    ptWidth = ctx.measureText(pt).width;
  }

  // --- name ----------------------------------------------------------------
  const nameMax = Math.round(H * 0.2);
  const name = fit(ctx, token.name, contentW, 2, nameMax, Math.round(nameMax * 0.55));
  ctx.font = `bold ${name.size}px ${SANS}`;
  for (const line of name.lines) {
    ctx.fillText(line, pad, y);
    y += Math.round(name.size * 1.02);
  }

  // --- type line -----------------------------------------------------------
  if (opts.showTypeLine !== false && token.typeLine) {
    const tSize = Math.max(11, Math.round(H * 0.075));
    ctx.font = `${tSize}px ${SANS}`;
    const tLines = wrap(ctx, tidyTypeLine(token.typeLine), contentW).slice(0, 1);
    y += Math.round(tSize * 0.15);
    for (const line of tLines) {
      ctx.fillText(line, pad, y);
      y += Math.round(tSize * 1.15);
    }
  }

  // --- divider -------------------------------------------------------------
  y += Math.round(pad * 0.5);
  ctx.fillRect(pad, y, contentW, Math.max(1, Math.round(H * 0.008)));
  y += Math.round(pad * 0.9);

  // --- oracle text (keeps clear of the P/T corner) -------------------------
  const oracle = flattenSymbols(token.oracleText).trim();
  if (opts.showOracle !== false && oracle) {
    const bottomLimit = pt ? H - pad - ptSize * 0.82 : H - pad;
    const avail = Math.max(0, bottomLimit - y);
    const oSize = Math.max(10, Math.round(H * 0.072));
    ctx.font = `${oSize}px ${SANS}`;
    const lineH = Math.round(oSize * 1.16);
    const maxLines = Math.max(1, Math.floor(avail / lineH));
    const o = fit(ctx, oracle, contentW, maxLines, oSize, 10, 'normal');
    ctx.font = `${o.size}px ${SANS}`;
    const oLineH = Math.round(o.size * 1.16);
    for (const line of o.lines) {
      ctx.fillText(line, pad, y);
      y += oLineH;
    }
  }

  // --- P/T, bottom-right ---------------------------------------------------
  if (pt) {
    ctx.font = `bold ${ptSize}px ${SANS}`;
    ctx.fillText(pt, W - pad - ptWidth, H - pad - ptSize * 1.02);
  }

  if (opts.cornerNote) {
    const nSize = Math.max(10, Math.round(H * 0.07));
    ctx.font = `bold ${nSize}px ${SANS}`;
    ctx.fillText(opts.cornerNote, pad, H - pad - nSize);
  }
}

/**
 * Type sizes for the wide layout, derived from the print WIDTH rather than the
 * height.
 *
 * Width is fixed by the print head, so these are stable absolute sizes chosen
 * to read across a table at 203 dpi. Deriving them from the block height
 * instead made the layout circular — the height depends on how much text there
 * is, and the text size depended on the height.
 */
function wideSizes(W: number) {
  return {
    pad: Math.round(W * 0.02),
    name: Math.round(W * 0.115), // ~44px at 48mm
    type: Math.round(W * 0.052), // ~20px
    oracle: Math.round(W * 0.047), // ~18px
    minOracle: Math.round(W * 0.031), // ~12px floor
  };
}

interface WideLayout {
  /** Natural height for this content. */
  height: number;
  pad: number;
  contentW: number;
  ptCol: number;
  ptSize: number;
  pt?: string;
  name: { size: number; lines: string[] };
  type: { size: number; lines: string[] } | null;
  oracle: { size: number; lines: string[] } | null;
}

/**
 * Work out the wide layout for a token at a given width.
 *
 * Measuring and drawing share this so they cannot drift: `naturalWideHeight`
 * returns `height` and `drawWide` renders exactly what was measured.
 */
function layoutWide(token: TokenCard, W: number, opts: LabelOptions): WideLayout {
  const S = wideSizes(W);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, W);
  canvas.height = 8;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  const pt = ptLabel(token);
  let ptSize = 0;
  let ptCol = 0;
  if (pt) {
    // Size the column to the text it holds: "1/1" needs far less room than
    // "10/10", and every pixel saved goes to the rules text.
    ptSize = Math.round(W * 0.14);
    ctx.font = `bold ${ptSize}px ${SANS}`;
    ptCol = Math.min(Math.round(W * 0.3), Math.round(ctx.measureText(pt).width + S.pad * 2.5));
    while (ptSize > 12 && ctx.measureText(pt).width > ptCol - S.pad * 1.5) {
      ptSize -= 1;
      ctx.font = `bold ${ptSize}px ${SANS}`;
    }
  }

  const contentW = W - S.pad * 2 - ptCol;
  const name = fit(ctx, token.name, contentW, 2, S.name, 12);

  let type: { size: number; lines: string[] } | null = null;
  if (opts.showTypeLine !== false && token.typeLine) {
    type = fit(ctx, tidyTypeLine(token.typeLine), contentW, 1, S.type, 9, 'normal');
  }

  const oracleText = flattenSymbols(token.oracleText).trim();
  let oracle: { size: number; lines: string[] } | null = null;
  if (opts.showOracle !== false && oracleText) {
    // No height budget to satisfy any more: use the preferred size and let the
    // block grow. Only drop size if a single word will not fit the column.
    let chosen = { size: S.minOracle, lines: [] as string[] };
    for (let size = S.oracle; size >= S.minOracle; size -= 1) {
      ctx.font = `${size}px ${SANS}`;
      const lines = wrap(ctx, oracleText, contentW);
      if (lines.every((l) => ctx.measureText(l).width <= contentW)) {
        chosen = { size, lines };
        break;
      }
    }
    if (chosen.lines.length === 0) {
      ctx.font = `${S.minOracle}px ${SANS}`;
      chosen = { size: S.minOracle, lines: wrap(ctx, oracleText, contentW) };
    }
    oracle = chosen;
  }

  // Sum the natural height of the text column.
  let textH = S.pad;
  textH += name.lines.length * Math.round(name.size * 1.04);
  if (type) textH += type.lines.length * Math.round(type.size * 1.15);
  if (oracle) {
    textH += Math.round(S.pad * 0.5) + 1 + Math.round(S.pad * 0.6);
    textH += oracle.lines.length * Math.round(oracle.size * 1.2);
  }
  textH += S.pad;

  // The P/T column sets a floor so a one-line token is not absurdly short.
  const ptFloor = pt ? Math.round(ptSize * 1.35) + S.pad : 0;

  return {
    height: Math.max(textH, ptFloor),
    pad: S.pad,
    contentW,
    ptCol,
    ptSize,
    pt,
    name,
    type,
    oracle,
  };
}

/**
 * Natural height in px for a token's wide text block at this width.
 * Lets callers size the block to its content instead of guessing — on
 * continuous roll, height is free and a fixed block either crushes long rules
 * text or wastes paper on short.
 */
export function naturalWideHeight(
  token: TokenCard,
  widthPx: number,
  opts: Partial<LabelOptions> = {},
): number {
  return layoutWide(token, widthPx, {
    widthPx,
    heightPx: 0,
    ...opts,
  } as LabelOptions).height;
}

/**
 * Two-column layout: text on the left, P/T in its own right-hand column.
 *
 * Taking the P/T out of the vertical flow is what makes a short, wide block
 * work — it frees the full height for the name and rules text, and the P/T ends
 * up larger than it was when squeezed into a corner.
 */
function drawWide(
  ctx: CanvasRenderingContext2D,
  token: TokenCard,
  opts: LabelOptions,
  W: number,
  H: number,
): void {
  const L = layoutWide(token, W, opts);
  const { pad, contentW } = L;
  let y = pad;

  ctx.font = `bold ${L.name.size}px ${SANS}`;
  for (const line of L.name.lines) {
    ctx.fillText(line, pad, y);
    y += Math.round(L.name.size * 1.04);
  }

  if (L.type) {
    ctx.font = `${L.type.size}px ${SANS}`;
    for (const line of L.type.lines) {
      ctx.fillText(line, pad, y);
      y += Math.round(L.type.size * 1.15);
    }
  }

  if (L.oracle) {
    y += Math.round(pad * 0.5);
    ctx.fillRect(pad, y, contentW, 1);
    y += Math.round(pad * 0.6) + 1;
    ctx.font = `${L.oracle.size}px ${SANS}`;
    const lineH = Math.round(L.oracle.size * 1.2);
    for (const line of L.oracle.lines) {
      // Clip rather than overflow if the caller forced a shorter block.
      if (y + lineH > H) break;
      ctx.fillText(line, pad, y);
      y += lineH;
    }
  }

  // --- P/T: vertically centred in its own column, with a separating rule ---
  if (L.pt) {
    const colX = W - L.ptCol;
    ctx.fillRect(colX - Math.round(pad * 0.6), pad, 1, H - pad * 2);
    ctx.font = `bold ${L.ptSize}px ${SANS}`;
    const w = ctx.measureText(L.pt).width;
    ctx.fillText(L.pt, colX + (L.ptCol - w) / 2, Math.round((H - L.ptSize * 1.15) / 2));
  }

  if (opts.cornerNote) {
    const nSize = Math.round(W * 0.04);
    ctx.font = `bold ${nSize}px ${SANS}`;
    ctx.fillText(opts.cornerNote, pad, H - pad - nSize);
  }
}


/** Load an image with CORS enabled so its pixels can be read back. */
export function loadArt(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load art: ${url}`));
    img.src = url;
  });
}


export type CardFit = 'aspect' | 'label';

/**
 * Draw the whole card image to be dithered, Cauldron-style.
 *
 * `aspect` keeps the card's proportions and lets the height follow the width —
 * the right choice on continuous roll, where height is free. `label` letterboxes
 * the card inside a fixed WxH for die-cut stock.
 */
export function drawCard(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  opts: { widthPx: number; heightPx: number; fit: CardFit },
): HTMLCanvasElement {
  const W = opts.widthPx;
  // Raster height must stay a whole number of lines.
  const H =
    opts.fit === 'aspect' ? Math.round((W * img.height) / img.width) : opts.heightPx;

  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  // White ground: the png has transparent corners, and unprinted paper is white.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  if (opts.fit === 'aspect') {
    ctx.drawImage(img, 0, 0, W, H);
  } else {
    const scale = Math.min(W / img.width, H / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }

  return canvas;
}
