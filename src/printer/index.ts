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
 * This sends ONE job. The printer will not accept a raster beyond about 44 KB,
 * and splitting into multiple GS v 0 blocks within a job makes it feed between
 * them, which shows up as gaps through the label. Use `printSectioned` for
 * anything long: it breaks the image into separate jobs instead.
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

  // No automatic pacing. The evidence says an oversized raster is rejected up
  // front — the whole image is discarded and only the feed runs — rather than
  // overflowing part-way through, and `printSectioned` keeps every job inside
  // the size that already prints unpaced. Pacing by job size was measured at
  // 7.6s for a 113mm label that prints in about two, so it cost speed on
  // working labels to guard against a failure mode that is not happening.
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


/** Where a long label was divided, so the caller can describe what happened. */
export interface SectionPlan {
  /** First raster line of each section, and how many lines it covers. */
  sections: { from: number; lines: number }[];
  bytesPerSection: number[];
}

/**
 * Work out how to divide a raster into printable jobs.
 *
 * Splits on whole lines at the largest size the printer accepts. A single
 * section is returned unchanged, so short labels are unaffected.
 */
export function planSections(
  height: number,
  widthBytes: number,
  maxBytes = P.MAX_JOB_BYTES,
): SectionPlan {
  const linesPerJob = Math.max(1, Math.floor(maxBytes / widthBytes));
  if (height <= linesPerJob) {
    return { sections: [{ from: 0, lines: height }], bytesPerSection: [height * widthBytes] };
  }
  // Spread the lines evenly rather than leaving a sliver at the end: a 2mm
  // final section would be torn off and lost.
  const count = Math.ceil(height / linesPerJob);
  const even = Math.ceil(height / count);
  const sections: { from: number; lines: number }[] = [];
  for (let from = 0; from < height; from += even) {
    sections.push({ from, lines: Math.min(even, height - from) });
  }
  return {
    sections,
    bytesPerSection: sections.map((s) => s.lines * widthBytes),
  };
}

/**
 * Print a raster of any length, dividing it into separate jobs if need be.
 *
 * The printer rejects a raster beyond roughly 44 KB outright — the image is
 * discarded and only the feed runs, so a long label appears to "print" as blank
 * paper. Splitting inside a single job is not the answer either, because the
 * printer feeds between GS v 0 blocks and the gaps land in the middle of the
 * label. Separate jobs are the one approach that works: each is small enough to
 * be accepted, and only the last carries the tear-off feed, so the sections
 * come out as one continuous strip with a minimal seam.
 */
export async function printSectioned(
  transport: Transport,
  raster: Uint8Array,
  height: number,
  widthBytes = P.BYTES_PER_LINE,
  opts: PrintOptions & { maxJobBytes?: number } = {},
): Promise<{ sections: number }> {
  const plan = planSections(height, widthBytes, opts.maxJobBytes ?? P.MAX_JOB_BYTES);
  const total = plan.sections.length;

  for (let i = 0; i < total; i++) {
    const { from, lines } = plan.sections[i];
    const slice = raster.subarray(from * widthBytes, (from + lines) * widthBytes);
    const last = i === total - 1;
    await printRaster(transport, slice, lines, widthBytes, {
      ...opts,
      // Only the final section needs the tear-off allowance; adding it between
      // sections would push a blank gap into the middle of the label.
      tearFeedPx: last ? opts.tearFeedPx : 0,
      onProgress: (f) => opts.onProgress?.((i + f) / total),
    });
    // Let the printer finish the section before the next job's setup arrives.
    if (!last) await sleep(P.BLOCK_DELAY_MS);
  }

  return { sections: total };
}
