/**
 * Scryfall search.
 *
 * Both api.scryfall.com and cards.scryfall.io send `Access-Control-Allow-Origin: *`,
 * so the whole pipeline (search + loading art into a canvas for dithering) runs
 * client-side with no backend.
 *
 * Scryfall asks for <=10 req/s, so callers should debounce.
 */

export type SearchScope = 'tokens' | 'cards';

export interface TokenCard {
  id: string;
  name: string;
  typeLine: string;
  oracleText: string;
  power?: string;
  toughness?: string;
  /** Planeswalkers carry loyalty instead of power/toughness. */
  loyalty?: string;
  manaCost?: string;
  colors: string[];
  setCode: string;
  setName: string;
  /** True for real token cards; false for ordinary cards printed as copies. */
  isToken: boolean;
  layout: string;
  /** Full card image, for the on-screen result thumbnail. */
  imageUrl?: string;
  /** Cropped art, for optionally dithering onto the label. */
  artUrl?: string;
  /** Highest-resolution full card, for printing the whole card dithered. */
  printImageUrl?: string;
}

interface RawFace {
  name?: string;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  mana_cost?: string;
  colors?: string[];
  image_uris?: Record<string, string>;
}

interface RawCard extends RawFace {
  id: string;
  set?: string;
  set_name?: string;
  layout?: string;
  card_faces?: RawFace[];
}

const API = 'https://api.scryfall.com';

/**
 * Flatten a Scryfall card into the fields the label needs.
 *
 * Layouts differ in where the data lives, and getting this wrong prints blank
 * labels:
 *   - `normal`: everything at the top level.
 *   - `transform` / `modal_dfc`: no top-level image, and null power/toughness.
 *     Each face is effectively its own card, so the front face is used.
 *   - `split` / `adventure` / `flip`: one top-level image for the whole card,
 *     but `oracle_text` is empty — the rules text only exists on the faces, so
 *     it has to be stitched back together.
 */
function normalise(raw: RawCard): TokenCard {
  const faces = raw.card_faces ?? [];
  // No top-level image means the faces are separate cards; show the front.
  const facesAreSeparate = !raw.image_uris && faces.length > 0;
  const face: RawFace = facesAreSeparate ? faces[0] : raw;
  const images = raw.image_uris ?? faces[0]?.image_uris ?? {};

  // A shared-image layout keeps its text on the faces only.
  let oracleText = face.oracle_text ?? '';
  if (!oracleText && !facesAreSeparate && faces.length > 0) {
    oracleText = faces
      .filter((f) => f.oracle_text)
      .map((f) => (f.name ? `${f.name}: ${f.oracle_text}` : f.oracle_text))
      .join('\n');
  }

  let typeLine = face.type_line ?? raw.type_line ?? '';
  if (!typeLine && faces.length > 0) {
    typeLine = faces.map((f) => f.type_line).filter(Boolean).join(' // ');
  }

  const layout = raw.layout ?? 'normal';
  return {
    id: raw.id,
    name: facesAreSeparate ? (face.name ?? raw.name ?? 'Unknown') : (raw.name ?? 'Unknown'),
    typeLine,
    oracleText,
    power: face.power ?? raw.power,
    toughness: face.toughness ?? raw.toughness,
    loyalty: face.loyalty ?? raw.loyalty,
    manaCost: face.mana_cost ?? raw.mana_cost,
    colors: face.colors ?? raw.colors ?? [],
    setCode: raw.set ?? '',
    setName: raw.set_name ?? '',
    isToken: layout === 'token' || layout === 'double_faced_token' || /^Token\b/i.test(typeLine),
    layout,
    imageUrl: images.normal ?? images.large ?? images.small,
    artUrl: images.art_crop,
    // `png` is 745x1040 with transparent corners (composited onto white when
    // dithered) — noticeably sharper than the jpg once reduced to 1bpp.
    printImageUrl: images.png ?? images.large ?? images.normal,
  };
}

/**
 * Build the query for a scope.
 *
 * The two scopes are kept disjoint: searching "goblin" for a card to copy
 * should not be buried under the 40-odd Goblin tokens, and vice versa.
 */
function buildQuery(text: string, scope: SearchScope): string {
  const t = text.trim();
  const base = scope === 'tokens' ? 'game:paper type:token' : 'game:paper -type:token';
  return t ? `${base} ${t}` : base;
}

export async function searchCards(
  text: string,
  opts: { scope?: SearchScope; signal?: AbortSignal } = {},
): Promise<TokenCard[]> {
  const scope = opts.scope ?? 'tokens';
  const url = new URL(`${API}/cards/search`);
  url.searchParams.set('q', buildQuery(text, scope));
  // Token printings differ in power/toughness and reminder text, so distinct
  // artwork is the useful axis. For real cards, reprints are noise.
  url.searchParams.set('unique', scope === 'tokens' ? 'art' : 'cards');
  url.searchParams.set('order', 'name');

  const res = await fetch(url, { signal: opts.signal, headers: { Accept: 'application/json' } });

  // Scryfall returns 404 with an error object when nothing matches.
  if (res.status === 404) return [];
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const err = await res.json();
      if (err?.details) detail = err.details;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`Scryfall search failed: ${detail}`);
  }

  const body = await res.json();
  const data: RawCard[] = body?.data ?? [];
  return data.map(normalise);
}

/** Power/toughness as a display string, or undefined for non-creatures. */
export function ptLabel(c: TokenCard): string | undefined {
  return c.power != null && c.toughness != null ? `${c.power}/${c.toughness}` : undefined;
}

/**
 * The stat to print large: power/toughness, else loyalty for planeswalkers.
 * A token copy of a planeswalker enters with its printed loyalty, so it is the
 * number that matters on the battlefield.
 */
export function statLabel(c: TokenCard): { text: string; kind: 'pt' | 'loyalty' } | undefined {
  const pt = ptLabel(c);
  if (pt) return { text: pt, kind: 'pt' };
  if (c.loyalty != null && c.loyalty !== '') return { text: c.loyalty, kind: 'loyalty' };
  return undefined;
}
