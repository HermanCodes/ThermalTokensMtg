/**
 * Draws a token onto a canvas at printer resolution (8 px/mm, 203 dpi).
 *
 * Deliberately *not* a dithered photo of the card. At 320 px wide and 1 bit
 * deep, card art turns to mud, whereas black-on-white text is razor sharp — so
 * the label is a purpose-built typographic layout and the art is opt-in.
 */
import type { TokenCard } from './scryfall';
import { statLabel } from './scryfall';

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
   * Print a "TOKEN" tag. Set for ordinary cards printed as token copies, so a
   * thermal proxy of a real card is never mistaken for the card itself.
   */
  tokenMarker?: boolean;
  /**
   * `tall` stacks everything with the P/T bottom-right. `wide` moves the P/T
   * into a right-hand column, which is the only way a short, wide block fits a
   * name, type line and rules text without crushing them. `auto` picks by
   * aspect ratio.
   */
  layout?: 'auto' | 'tall' | 'wide';
}

/**
 * Normalise mana and tap symbols.
 *
 * Braces are kept: `{T}: Add {G}` is the form every player reads fluently, and
 * stripping them turned ability costs like `{2}{R}` into "2R", which is worse
 * the moment real cards are in scope rather than just tokens. Multi-character
 * symbols are uppercased for consistency.
 */
function flattenSymbols(text: string): string {
  return text.replace(/\{([^}]+)\}/g, (_, s: string) => `{${s.toUpperCase()}}`);
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
/** Height of the TOKEN tag at a given print width. */
function markerH(W: number): number {
  return Math.round(W * 0.062);
}

/**
 * A solid bar with knocked-out text, bottom-left.
 *
 * Reversed out rather than set in plain type because it has to be unmistakable
 * at a glance: this label represents a token, not the card it was printed from.
 */
function drawMarker(ctx: CanvasRenderingContext2D, W: number, y: number, pad: number): void {
  const h = markerH(W);
  const size = Math.round(h * 0.72);
  ctx.font = `bold ${size}px ${SANS}`;
  const text = 'TOKEN';
  const w = Math.ceil(ctx.measureText(text).width) + Math.round(h * 0.8);
  ctx.fillStyle = '#000';
  ctx.fillRect(pad, y, w, h);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, pad + Math.round(h * 0.4), y + Math.round((h - size) / 2));
  ctx.fillStyle = '#000';
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
  const pt = statLabel(token)?.text;
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
    // 38px keeps most two-word token names on one line beside the P/T,
    // which saves ~11mm of roll versus wrapping them.
    name: Math.round(W * 0.1), // ~38px = 4.75mm at 48mm wide
    pt: Math.round(W * 0.135), // ~52px = 6.5mm
    type: Math.round(W * 0.062), // ~24px = 3.0mm
    // Rules text has to survive 203dpi at 1 bit, where anything under ~3mm
    // breaks up. Height is free on continuous roll, so spend it here.
    oracle: Math.round(W * 0.075), // ~29px = 3.6mm
    minOracle: Math.round(W * 0.057), // ~22px = 2.75mm floor
  };
}

interface WideLayout {
  /** Natural height for this content. */
  height: number;
  pad: number;
  /** Height of the name / type / P-T band above the divider. */
  bandH: number;
  ptSize: number;
  ptWidth: number;
  pt?: string;
  statKind: 'pt' | 'loyalty';
  name: { size: number; lines: string[] };
  type: { size: number; lines: string[] } | null;
  oracle: { size: number; lines: string[] } | null;
}

/**
 * Work out the wide layout for a token at a given width.
 *
 * The P/T sits beside the name in a top band rather than in a full-height
 * column, which hands the rules text the entire width instead of ~70% of it.
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

  // --- P/T or loyalty, sized to the band ----------------------------------
  const stat = statLabel(token);
  const pt = stat?.text;
  let ptSize = 0;
  let ptWidth = 0;
  if (pt) {
    ptSize = S.pt;
    ctx.font = `bold ${ptSize}px ${SANS}`;
    // Never let it swallow more than a third of the width.
    const cap = Math.round(W * 0.34);
    while (ptSize > 14 && ctx.measureText(pt).width > cap) {
      ptSize -= 1;
      ctx.font = `bold ${ptSize}px ${SANS}`;
    }
    ptWidth = Math.ceil(ctx.measureText(pt).width);
  }

  // Name and type line share the band, to the left of the P/T.
  const bandW = W - S.pad * 2 - (pt ? ptWidth + Math.round(S.pad * 1.2) : 0);
  const name = fit(ctx, token.name, bandW, 2, S.name, 14);

  let type: { size: number; lines: string[] } | null = null;
  if (opts.showTypeLine !== false && token.typeLine) {
    type = fit(ctx, tidyTypeLine(token.typeLine), bandW, 1, S.type, 11, 'normal');
  }

  let textBandH = name.lines.length * Math.round(name.size * 1.04);
  if (type) textBandH += Math.round(type.size * 1.2);
  const bandH = Math.max(textBandH, pt ? Math.round(ptSize * 1.1) : 0);

  // --- rules text, full width --------------------------------------------
  const oracleText = flattenSymbols(token.oracleText).trim();
  let oracle: { size: number; lines: string[] } | null = null;
  if (opts.showOracle !== false && oracleText) {
    const full = W - S.pad * 2;
    let chosen = { size: S.minOracle, lines: [] as string[] };
    for (let size = S.oracle; size >= S.minOracle; size -= 1) {
      ctx.font = `${size}px ${SANS}`;
      const lines = wrap(ctx, oracleText, full);
      if (lines.every((l) => ctx.measureText(l).width <= full)) {
        chosen = { size, lines };
        break;
      }
    }
    if (chosen.lines.length === 0) {
      ctx.font = `${S.minOracle}px ${SANS}`;
      chosen = { size: S.minOracle, lines: wrap(ctx, oracleText, full) };
    }
    oracle = chosen;
  }

  let height = S.pad + bandH;
  if (oracle) {
    height += Math.round(S.pad * 0.7) + 2 + Math.round(S.pad * 0.7);
    height += oracle.lines.length * Math.round(oracle.size * 1.22);
  }
  if (opts.tokenMarker) height += Math.round(S.pad * 0.5) + markerH(W);
  height += S.pad;

  return {
    height,
    pad: S.pad,
    bandH,
    ptSize,
    ptWidth,
    pt,
    statKind: stat?.kind ?? 'pt',
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
 * Name and P/T in a top band, rules text full width beneath.
 *
 * Keeping the P/T out of the rules-text column is what makes the small print
 * legible: at 203dpi and 1 bit, narrower columns force a smaller size, and
 * anything under ~3mm falls apart.
 */
function drawWide(
  ctx: CanvasRenderingContext2D,
  token: TokenCard,
  opts: LabelOptions,
  W: number,
  H: number,
): void {
  const L = layoutWide(token, W, opts);
  const { pad } = L;
  let y = pad;

  // --- name ---------------------------------------------------------------
  ctx.font = `bold ${L.name.size}px ${SANS}`;
  for (const line of L.name.lines) {
    ctx.fillText(line, pad, y);
    y += Math.round(L.name.size * 1.04);
  }

  if (L.type) {
    ctx.font = `${L.type.size}px ${SANS}`;
    for (const line of L.type.lines) {
      ctx.fillText(line, pad, y);
      y += Math.round(L.type.size * 1.2);
    }
  }

  // --- P/T or loyalty, top-right of the band ------------------------------
  if (L.pt) {
    ctx.font = `bold ${L.ptSize}px ${SANS}`;
    const x = W - pad - L.ptWidth;
    if (L.statKind === 'loyalty') {
      // Box it so a bare number reads as loyalty rather than a power value.
      const padX = Math.round(L.ptSize * 0.18);
      ctx.fillRect(
        x - padX,
        pad - Math.round(padX * 0.5),
        L.ptWidth + padX * 2,
        Math.round(L.ptSize * 1.15),
      );
      ctx.fillStyle = '#fff';
      ctx.fillText(L.pt, x, pad);
      ctx.fillStyle = '#000';
    } else {
      ctx.fillText(L.pt, x, pad);
    }
  }

  // --- rules text, spanning the full width -------------------------------
  if (L.oracle) {
    let ry = pad + L.bandH + Math.round(pad * 0.7);
    ctx.fillRect(pad, ry, W - pad * 2, 2);
    ry += 2 + Math.round(pad * 0.7);

    ctx.font = `${L.oracle.size}px ${SANS}`;
    const lineH = Math.round(L.oracle.size * 1.22);
    for (const line of L.oracle.lines) {
      // Clip rather than overflow if the caller forced a shorter block.
      if (ry + lineH > H) break;
      ctx.fillText(line, pad, ry);
      ry += lineH;
    }
  }

  if (opts.tokenMarker) {
    drawMarker(ctx, W, H - pad - markerH(W), pad);
  }

  if (opts.cornerNote) {
    const nSize = Math.round(W * 0.04);
    ctx.font = `bold ${nSize}px ${SANS}`;
    const w = ctx.measureText(opts.cornerNote).width;
    ctx.fillText(opts.cornerNote, W - pad - w, H - pad - nSize);
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
