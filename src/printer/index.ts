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
  /** How each cut was chosen, for diagnostics. */
  cutReasons: ('seam' | 'blank row' | 'forced')[];
}

export interface PlanOptions {
  maxBytes?: number;
  /**
   * Positions the renderer says are safe to cut at — the divider between a card
   * and its text, or the gaps between calibration samples.
   */
  seams?: number[];
  /**
   * The image itself. With no seam available, an all-white row is found near
   * the target so a cut never lands through a glyph or a run of art.
   */
  raster?: Uint8Array;
  widthBytes?: number;
}

/** True when this raster row has no ink at all. */
function isBlankRow(raster: Uint8Array, widthBytes: number, y: number): boolean {
  const from = y * widthBytes;
  for (let i = from; i < from + widthBytes; i++) if (raster[i] !== 0) return false;
  return true;
}

/**
 * Work out how to divide a raster into printable jobs.
 *
 * Cuts are chosen, not merely measured out. Splitting on byte count alone lands
 * halfway through a line of rules text, so a seam the renderer vouched for is
 * preferred, then a blank row near the target, and only failing both is the raw
 * position used.
 */
export function planSections(
  height: number,
  widthBytes: number,
  opts: PlanOptions | number = {},
): SectionPlan {
  // Older call sites passed maxBytes positionally.
  const o: PlanOptions = typeof opts === 'number' ? { maxBytes: opts } : opts;
  const maxBytes = o.maxBytes ?? P.MAX_JOB_BYTES;
  const linesPerJob = Math.max(1, Math.floor(maxBytes / widthBytes));

  if (height <= linesPerJob) {
    return {
      sections: [{ from: 0, lines: height }],
      bytesPerSection: [height * widthBytes],
      cutReasons: [],
    };
  }

  // Never leave a scrap that would just be torn off and lost.
  const minLines = Math.max(8, Math.round(linesPerJob * 0.15));
  // How far back from the ideal cut it is worth looking for a clean one.
  const window = Math.round(linesPerJob * 0.35);
  const seams = (o.seams ?? []).filter((y) => y > 0 && y < height).sort((a, b) => a - b);

  const cuts: number[] = [];
  const reasons: ('seam' | 'blank row' | 'forced')[] = [];
  let pos = 0;

  while (height - pos > linesPerJob) {
    const target = pos + linesPerJob;
    const lowest = pos + minLines;

    // 1. A seam the renderer offered, as late as possible without overshooting.
    const seam = [...seams].reverse().find((y) => y > lowest && y <= target);
    if (seam !== undefined) {
      cuts.push(seam);
      reasons.push('seam');
      pos = seam;
      continue;
    }

    // 2. Failing that, a row with no ink in it.
    let blank: number | undefined;
    if (o.raster && o.widthBytes) {
      for (let y = target; y >= Math.max(lowest, target - window); y--) {
        if (isBlankRow(o.raster, o.widthBytes, y)) {
          blank = y;
          break;
        }
      }
    }
    if (blank !== undefined) {
      cuts.push(blank);
      reasons.push('blank row');
      pos = blank;
      continue;
    }

    // 3. Nothing clean within reach — cut where the size demands.
    cuts.push(target);
    reasons.push('forced');
    pos = target;
  }

  const bounds = [0, ...cuts, height];
  const sections: { from: number; lines: number }[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    sections.push({ from: bounds[i], lines: bounds[i + 1] - bounds[i] });
  }

  return {
    sections,
    bytesPerSection: sections.map((s) => s.lines * widthBytes),
    cutReasons: reasons,
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
 * be accepted, and only the last carries the tear-off feed.
 *
 * Each section must FINISH PRINTING before the next is sent. Bluetooth writes
 * are acknowledged by the radio long before the paper moves, so sending
 * straight on hands a second job to a printer still working through the first:
 * it drops the data and is left in a state where the next attempt comes out
 * garbled too.
 */
export async function printSectioned(
  transport: Transport,
  raster: Uint8Array,
  height: number,
  widthBytes = P.BYTES_PER_LINE,
  opts: PrintOptions & {
    maxJobBytes?: number;
    seams?: number[];
    /** Override the estimated print speed used to wait between sections. */
    linesPerSecond?: number;
  } = {},
): Promise<{ sections: number; cutReasons: string[] }> {
  const plan = planSections(height, widthBytes, {
    maxBytes: opts.maxJobBytes ?? P.MAX_JOB_BYTES,
    seams: opts.seams,
    raster,
    widthBytes,
  });
  const total = plan.sections.length;
  const linesPerSecond = Math.max(20, opts.linesPerSecond ?? P.PRINT_LINES_PER_SEC);

  for (let i = 0; i < total; i++) {
    const { from, lines } = plan.sections[i];
    const slice = raster.subarray(from * widthBytes, (from + lines) * widthBytes);
    const last = i === total - 1;
    const tear = last ? (opts.tearFeedPx ?? P.DEFAULT_TEAR_FEED_PX) : 0;

    await printRaster(transport, slice, lines, widthBytes, {
      ...opts,
      // Only the final section carries the tear-off allowance; adding it
      // between sections would push a blank gap into the middle of the label.
      tearFeedPx: tear,
      onProgress: (f) => opts.onProgress?.((i + f) / total),
    });

    if (!last) {
      // Wait for the paper to actually move. The head is by far the slow part,
      // and nothing in the Bluetooth layer reports when it has finished.
      const printMs = ((lines + tear) / linesPerSecond) * 1000;
      await sleep(Math.round(printMs + P.SECTION_SETTLE_MS));
    }
  }

  return { sections: total, cutReasons: plan.cutReasons };
}
