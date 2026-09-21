/**
 * Scryfall search, scoped to tokens.
 *
 * Both api.scryfall.com and cards.scryfall.io send `Access-Control-Allow-Origin: *`,
 * so the whole pipeline (search + loading art into a canvas for dithering) runs
 * client-side with no backend.
 *
 * Scryfall asks for <=10 req/s, so callers should debounce.
 */

export interface TokenCard {
  id: string;
  name: string;
  typeLine: string;
  oracleText: string;
  power?: string;
  toughness?: string;
  colors: string[];
  setCode: string;
  setName: string;
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
  colors?: string[];
  image_uris?: Record<string, string>;
}

interface RawCard extends RawFace {
  id: string;
  set?: string;
  set_name?: string;
  card_faces?: RawFace[];
}

const API = 'https://api.scryfall.com';

/**
 * Double-faced tokens (layout `double_faced_token`) carry no top-level
 * `image_uris` — the art lives on each entry of `card_faces`. Fall back to the
 * front face so those tokens still render.
 */
function normalise(raw: RawCard): TokenCard {
  const face: RawFace = raw.image_uris ? raw : (raw.card_faces?.[0] ?? raw);
  const images = raw.image_uris ?? face.image_uris ?? {};
  return {
    id: raw.id,
    name: raw.name ?? face.name ?? 'Unknown',
    typeLine: face.type_line ?? raw.type_line ?? '',
    oracleText: face.oracle_text ?? raw.oracle_text ?? '',
    power: face.power ?? raw.power,
    toughness: face.toughness ?? raw.toughness,
    colors: face.colors ?? raw.colors ?? [],
    setCode: raw.set ?? '',
    setName: raw.set_name ?? '',
    imageUrl: images.normal ?? images.large ?? images.small,
    artUrl: images.art_crop,
    // `png` is 745x1040 with transparent corners (composited onto white when
    // dithered) — noticeably sharper than the jpg once reduced to 1bpp.
    printImageUrl: images.png ?? images.large ?? images.normal,
  };
}

/** Restrict to real paper tokens; `unique=art` collapses identical reprints. */
function buildQuery(text: string): string {
  const t = text.trim();
  const base = 'game:paper type:token';
  return t ? `${base} ${t}` : base;
}

export async function searchTokens(
  text: string,
  signal?: AbortSignal,
): Promise<TokenCard[]> {
  const url = new URL(`${API}/cards/search`);
  url.searchParams.set('q', buildQuery(text));
  url.searchParams.set('unique', 'art');
  url.searchParams.set('order', 'name');

  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });

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

/** Power/toughness as a display string, or undefined for non-creature tokens. */
export function ptLabel(c: TokenCard): string | undefined {
  return c.power != null && c.toughness != null ? `${c.power}/${c.toughness}` : undefined;
}
