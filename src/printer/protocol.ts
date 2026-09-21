/**
 * Phomemo M110 wire protocol.
 *
 * The printer speaks an ESC/POS-ish dialect. A job is:
 *
 *   speed   : 1b 4e 0d <speed>     (0x01 slow .. 0x05 fast)
 *   density : 1b 4e 04 <density>   (0x01 light .. 0x0f dark)
 *   media   : 1f 11 <media>        (0x0a label-with-gaps, 0x0b continuous)
 *   raster  : 1d 76 30 00 <widthBytes LE16> <lines LE16> <1bpp bitmap>
 *   footer  : 1f f0 05 00 1f f0 03 00
 *
 * Print head is 384 dots wide => 48 bytes per line, 1bpp,
 * MSB = leftmost pixel, bit set (1) = black.
 *
 * Command bytes are the community-documented sequences (phomemo-tools,
 * phomymo, pyphomemo) — reverse-engineered from the vendor Android app.
 */

export const SERVICE_UUID = 0xff00;
export const WRITE_CHAR_UUID = 0xff02;
export const NOTIFY_CHAR_UUID = 0xff03;

/**
 * Expand a 16-bit Bluetooth UUID to its canonical 128-bit string.
 *
 * Chrome accepts bare 16-bit numbers and canonicalises them itself, but other
 * Web Bluetooth implementations (Bluefy on iOS, for one) only accept the full
 * string form and fail obscurely on a number. Always pass the string.
 */
export const uuid16 = (n: number): string =>
  `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;

export const SERVICE_UUID_STR = uuid16(SERVICE_UUID);
export const WRITE_CHAR_UUID_STR = uuid16(WRITE_CHAR_UUID);
export const NOTIFY_CHAR_UUID_STR = uuid16(NOTIFY_CHAR_UUID);

/** Service UUIDs advertised across Phomemo models — used to spot a printer. */
export const KNOWN_SERVICE_UUIDS = [
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000ae30-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
];

export const PRINTER_WIDTH_PX = 384;
export const BYTES_PER_LINE = PRINTER_WIDTH_PX / 8; // 48
export const PX_PER_MM = 8; // 203 dpi
/**
 * Widest printable strip, in mm. A hard mechanical limit: the head is 384 dots
 * across, so wider stock simply leaves an unprinted margin.
 */
export const MAX_WIDTH_MM = PRINTER_WIDTH_PX / PX_PER_MM; // 48

export const MEDIA_LABEL_WITH_GAPS = 0x0a;
export const MEDIA_CONTINUOUS = 0x0b;
export const MEDIA_LABEL_WITH_MARKS = 0x26;

export const DEFAULT_SPEED = 0x05;
export const DEFAULT_DENSITY = 0x0f;
export const DEFAULT_MEDIA = MEDIA_LABEL_WITH_GAPS;

/** Send payload in 128-byte GATT chunks with a small delay between them. */
export const CHUNK_SIZE = 128;
export const CHUNK_DELAY_MS = 20;

/**
 * Raster lines per GS v 0 block.
 *
 * Default is effectively "do not split": the printer FEEDS after finishing each
 * block, so a split image prints as separate sections with gaps between them.
 * Continuous output therefore requires a single block, and the printer streams
 * it as it arrives rather than buffering the whole thing.
 *
 * The ceiling is the printer's buffer, not the 16-bit height field — a block
 * that is too large is dropped silently. Drop to SAFE_BLOCK_LINES for very long
 * images (a tall calibration strip), accepting the gaps.
 */
export const MAX_BLOCK_LINES = 0xffff;
/** Conservative split size for images too long to send as one block. */
export const SAFE_BLOCK_LINES = 256;
/**
 * Blank lines appended after the image so the tear bar sits clear of the print.
 * The head stops well short of the tear edge, so without this the tear runs
 * through the bottom of the label. 10mm at 8 px/mm.
 */
export const DEFAULT_TEAR_FEED_PX = 80;

/** Pause between blocks so the printer can drain its buffer. */
export const BLOCK_DELAY_MS = 120;

const u16le = (v: number) => [v & 0xff, (v >> 8) & 0xff];

export const cmdSpeed = (speed = DEFAULT_SPEED) =>
  new Uint8Array([0x1b, 0x4e, 0x0d, speed]);

export const cmdDensity = (density = DEFAULT_DENSITY) =>
  new Uint8Array([0x1b, 0x4e, 0x04, density]);

export const cmdMedia = (media = DEFAULT_MEDIA) =>
  new Uint8Array([0x1f, 0x11, media]);

/** Single GS v 0 raster header carrying the full 16-bit height. */
export const rasterHeader = (height: number, widthBytes = BYTES_PER_LINE) =>
  new Uint8Array([0x1d, 0x76, 0x30, 0x00, ...u16le(widthBytes), ...u16le(height)]);

/** Finish-printing sequence: releases the label once the gap sensor finds the edge. */
export const footer = () =>
  new Uint8Array([0x1f, 0xf0, 0x05, 0x00, 0x1f, 0xf0, 0x03, 0x00]);

export function mmToPx(mm: number): number {
  return Math.round(mm * PX_PER_MM);
}

/** Round a pixel width up to a whole number of bytes. */
export function alignWidth(px: number): number {
  return Math.ceil(px / 8) * 8;
}

/** Concatenate the whole job — handy for hex-dump inspection and tests. */
export function buildPrintPayload(
  bitmap: Uint8Array,
  height: number,
  opts: { widthBytes?: number; speed?: number; density?: number; media?: number } = {},
): Uint8Array {
  const widthBytes = opts.widthBytes ?? BYTES_PER_LINE;
  if (bitmap.length !== widthBytes * height) {
    throw new Error(
      `bitmap size ${bitmap.length} != widthBytes*height (${widthBytes}*${height}=${widthBytes * height})`,
    );
  }
  const parts = [
    cmdSpeed(opts.speed),
    cmdDensity(opts.density),
    cmdMedia(opts.media),
    rasterHeader(height, widthBytes),
    bitmap,
    footer(),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function* chunk(payload: Uint8Array, size = CHUNK_SIZE) {
  for (let i = 0; i < payload.length; i += size) {
    yield payload.subarray(i, i + size);
  }
}
