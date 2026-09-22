import * as P from './protocol';
import { sleep, type Transport } from './transport';

export * from './protocol';
export type { Transport, ConnectOptions } from './transport';
export { WebBluetoothTransport } from './webBluetooth';
export { pickTransport, transportAvailable } from './pickTransport';
export type { GattEntry, MatchPath, WriteMode } from './webBluetooth';

export interface PrintOptions {
  speed?: number;
  density?: number;
  media?: number;
  /**
   * GATT write size. 128 matches the reference implementations, but a chunk
   * larger than the negotiated ATT MTU minus 3 can fail on a
   * write-without-response characteristic — drop to 20 if nothing prints.
   */
  chunkSize?: number;
  /** Delay between chunks; too fast overruns the printer's buffer. */
  chunkDelayMs?: number;
  /**
   * True when the transport is writing without acknowledgement, so chunks must
   * be clamped to the guaranteed-safe MTU payload and paced by a delay.
   */
  unacknowledged?: boolean;
  /**
   * Raster lines per GS v 0 block. Long images must be split — a single
   * oversized block is silently dropped by the printer.
   */
  maxBlockLines?: number;
  /**
   * Blank lines to append after the image, so the tear bar clears the print.
   * Sent as part of the same raster rather than as a feed command, which keeps
   * it inside one continuous block.
   */
  tearFeedPx?: number;
  /** Progress 0..1, for a UI bar. */
  onProgress?: (fraction: number) => void;
}

/**
 * Send one raster to the printer.
 *
 * The setup commands go as discrete writes (that is what the known-good BLE
 * flow does), then the bitmap streams as one or more GS v 0 blocks, then the
 * footer releases the label.
 *
 * Long images MUST be split into several blocks: a single block big enough for,
 * say, a 170mm calibration strip (~53 KB) overflows the printer's buffer and the
 * whole job is silently dropped. Each block carries its own header, so the
 * printer digests one bufferful at a time.
 */
export async function printRaster(
  transport: Transport,
  rasterIn: Uint8Array,
  heightIn: number,
  widthBytes = P.BYTES_PER_LINE,
  opts: PrintOptions = {},
): Promise<void> {
  let raster = rasterIn;
  let height = heightIn;
  if (raster.length !== widthBytes * height) {
    throw new Error(
      `raster size ${raster.length} != widthBytes*height (${widthBytes}*${height}=${widthBytes * height})`,
    );
  }
  if (!transport.isConnected()) throw new Error('Printer not connected');

  // Append blank lines for the tear-off allowance. Zero-filled bytes print
  // nothing, so this costs paper but no ink.
  const tear = Math.max(0, Math.round(opts.tearFeedPx ?? P.DEFAULT_TEAR_FEED_PX));
  if (tear > 0) {
    const padded = new Uint8Array(widthBytes * (height + tear));
    padded.set(raster, 0);
    raster = padded;
    height = height + tear;
  }

  /**
   * A write-without-response cannot exceed the ATT MTU minus 3 and nothing
   * acknowledges it, so an oversized one is dropped with no error at all: the
   * job "completes" in milliseconds and the printer waits forever for data.
   * 20 bytes is the payload of the 23-byte default MTU, which every link
   * supports, so clamp to it rather than fail silently.
   */
  const requested = opts.chunkSize ?? P.CHUNK_SIZE;
  const chunkSize = opts.unacknowledged ? Math.min(requested, P.SAFE_NO_RESPONSE_CHUNK) : requested;
  const delay = opts.chunkDelayMs ?? P.CHUNK_DELAY_MS;
  const maxLines = Math.max(1, opts.maxBlockLines ?? P.MAX_BLOCK_LINES);

  // Three discrete writes, not one coalesced buffer. The reference
  // implementations send these separately and the printer expects it that way;
  // batching them was enough to leave it feeding blank paper.
  await transport.write(P.cmdSpeed(opts.speed));
  await transport.write(P.cmdDensity(opts.density));
  await transport.write(P.cmdMedia(opts.media));

  const blocks = Math.ceil(height / maxLines);
  let blockIndex = 0;
  for (let line = 0; line < height; line += maxLines) {
    const lines = Math.min(maxLines, height - line);
    const head = P.rasterHeader(lines, widthBytes);
    const from = line * widthBytes;
    const to = (line + lines) * widthBytes;

    const payload = new Uint8Array(head.length + (to - from));
    payload.set(head, 0);
    payload.set(raster.subarray(from, to), head.length);

    for (const c of P.chunk(payload, chunkSize)) {
      await transport.write(c);
      // Skip the timer entirely at zero: setTimeout is clamped to a few ms, so
      // even `sleep(0)` would cost a second across a few hundred chunks.
      if (delay > 0) await sleep(delay);
    }
    opts.onProgress?.(Math.min(1, (line + lines) / height));

    // Let the printer drain before the next header arrives — but there is no
    // next header after the last block.
    blockIndex++;
    if (blockIndex < blocks) await sleep(P.BLOCK_DELAY_MS);
  }

  await transport.write(P.footer());
  opts.onProgress?.(1);
}

/**
 * Smallest useful print: thick horizontal stripes across the label.
 *
 * Deliberately tiny and geometric — it exercises the full command path with a
 * fraction of the data, so a failure points at the transport rather than at the
 * renderer, and the result is obvious at a glance.
 */
export async function printTestPattern(
  transport: Transport,
  widthBytes = P.BYTES_PER_LINE,
  opts: PrintOptions = {},
): Promise<void> {
  const height = 80;
  const raster = new Uint8Array(widthBytes * height);
  for (let y = 0; y < height; y++) {
    // 10 solid rows, 10 blank, repeating.
    const on = Math.floor(y / 10) % 2 === 0;
    if (on) raster.fill(0xff, y * widthBytes, (y + 1) * widthBytes);
  }
  await printRaster(transport, raster, height, widthBytes, opts);
}
