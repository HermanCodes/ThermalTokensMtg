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
 * Bring the printer back to a command boundary.
 *
 * Only useful when the printer is NOT part-way through a raster. A half-sent
 * `GS v 0` leaves the firmware counting bytes, and everything sent next — this
 * command included — is swallowed as image data. `printRaster` therefore pads
 * a failed raster out to its promised length before giving up, and this is for
 * the cases that leaves behind: an aborted job, or a printer that was talking
 * to another app. If prints are still garbled after this, only a power cycle
 * will do.
 */
export async function resetPrinter(transport: Transport): Promise<void> {
  if (!transport.isConnected()) throw new Error('Printer not connected');
  await transport.write(P.cmdInit());
  await sleep(P.RESET_SETTLE_MS);
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

    let delivered = 0;
    try {
      for (const c of P.chunk(payload, chunkSize)) {
        await transport.write(c);
        delivered += c.length;
        // Skip the timer entirely at zero: setTimeout is clamped to a few ms, so
        // even `sleep(0)` would cost a second across a few hundred chunks.
        if (delay > 0) await sleep(delay);
      }
    } catch (e) {
      // The header already promised the printer a fixed number of bytes. Stop
      // here and it spends the rest of the session consuming whatever arrives
      // next as image data — which is why a failed print used to be followed by
      // a garbled one, and the one after that. Pay the debt in blank rows so
      // the parser lands back on a command boundary.
      await settleRaster(transport, payload.length - delivered, chunkSize, delay);
      throw e;
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
 * Finish a raster the printer is still waiting on, with blank rows.
 *
 * Best effort by design: the write that failed has probably taken the link with
 * it, so every error here is swallowed. Getting the parser realigned is a bonus
 * on top of reporting the original failure, never a reason to mask it.
 */
async function settleRaster(
  transport: Transport,
  owed: number,
  chunkSize: number,
  delay: number,
): Promise<void> {
  if (owed <= 0) return;
  try {
    const blank = new Uint8Array(Math.min(chunkSize, owed));
    let left = owed;
    while (left > 0) {
      const n = Math.min(blank.length, left);
      await transport.write(blank.subarray(0, n));
      left -= n;
      if (delay > 0) await sleep(delay);
    }
    await transport.write(P.footer());
  } catch {
    // Link is gone. Nothing more to be done from this side.
  }
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

/** How a cut was chosen. A 'seam' is the renderer's own division; the rest are size. */
export type CutReason = 'seam' | 'blank row' | 'forced';

/** Where a long label was divided, so the caller can describe what happened. */
export interface SectionPlan {
  /** First raster line of each section, and how many lines it covers. */
  sections: { from: number; lines: number }[];
  /** Bytes actually sent per section — the final one includes the tear feed. */
  bytesPerSection: number[];
  /** How each cut was chosen, for diagnostics. */
  cutReasons: CutReason[];
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
  /**
   * Blank lines the tear-off gap will append to the FINAL section.
   *
   * They are part of that section's raster, so they spend the same budget the
   * image does. Leaving them out of the sum is how a label comfortably under
   * the limit on paper still went over it on the wire.
   */
  tearLines?: number;
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
 * Content first, size second. A card-and-text label has one place it wants to
 * be divided — the rule between the picture and the words — and the renderer
 * says where that is. So the seams are applied first and neighbouring pieces
 * merged back together only while they still fit, rather than measuring out
 * byte-sized chunks and hoping a seam happens to fall inside the search window.
 * Only a piece that is still too big on its own gets cut by size, and then a
 * blank row is preferred to a raw position so the cut misses the glyphs.
 */
export function planSections(
  height: number,
  widthBytes: number,
  opts: PlanOptions | number = {},
): SectionPlan {
  // Older call sites passed maxBytes positionally.
  const o: PlanOptions = typeof opts === 'number' ? { maxBytes: opts } : opts;
  const maxBytes = o.maxBytes ?? P.MAX_JOB_BYTES;
  const tearLines = Math.max(0, Math.round(o.tearLines ?? 0));

  const jobLines = Math.max(1, Math.floor(maxBytes / widthBytes));
  // The last section carries the tear feed inside its own raster, so its share
  // of the image is smaller by exactly that much.
  const lastLines = Math.max(1, jobLines - tearLines);

  const finish = (bounds: number[], reasons: CutReason[]): SectionPlan => {
    const sections: { from: number; lines: number }[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      sections.push({ from: bounds[i], lines: bounds[i + 1] - bounds[i] });
    }
    return {
      sections,
      bytesPerSection: sections.map(
        (s, i) => (s.lines + (i === sections.length - 1 ? tearLines : 0)) * widthBytes,
      ),
      cutReasons: reasons,
    };
  };

  if (height <= lastLines) return finish([0, height], []);

  // Never leave a scrap that would just be torn off and lost.
  const minLines = Math.max(8, Math.round(jobLines * 0.15));
  // How far back from the ideal cut it is worth looking for a clean one.
  const window = Math.round(jobLines * 0.35);

  /** Capacity of a piece, which shrinks for the one carrying the tear feed. */
  const capOf = (to: number) => (to === height ? lastLines : jobLines);

  // --- 1. cut at every seam the renderer vouched for ----------------------
  const seams = [...new Set(o.seams ?? [])]
    .filter((y) => Number.isFinite(y) && y > 0 && y < height)
    .map((y) => Math.round(y))
    .sort((a, b) => a - b);

  // --- 2. merge neighbours back while they still fit ----------------------
  // Two seams should not mean three jobs when two will do: every extra job is
  // another inter-job feed, another wait, and another chance to desynchronise.
  // `acc` is the furthest boundary the section running from the last committed
  // bound can still swallow.
  const bounds: number[] = [0];
  let acc = 0;
  for (const next of [...seams, height]) {
    if (acc === 0) {
      acc = next; // first piece; nothing yet to merge it into
      continue;
    }
    if (next - bounds[bounds.length - 1] <= capOf(next)) {
      acc = next; // absorb: the running section still fits
    } else {
      bounds.push(acc);
      acc = next;
    }
  }
  bounds.push(acc);

  // --- 3. divide anything still over budget, by blank row then by force ---
  const finalBounds: number[] = [0];
  const reasons: CutReason[] = [];
  for (let i = 1; i < bounds.length; i++) {
    const from = finalBounds[finalBounds.length - 1];
    const to = bounds[i];
    for (const c of subdivide(from, to)) {
      finalBounds.push(c.at);
      reasons.push(c.reason);
    }
    finalBounds.push(to);
    if (to !== height) reasons.push('seam');
  }

  /** Split [from, to) by size alone, returning the interior cuts. */
  function subdivide(from: number, to: number): { at: number; reason: CutReason }[] {
    const cuts: { at: number; reason: CutReason }[] = [];
    let pos = from;
    // Guard against a pathological input spinning here: every cut advances by
    // at least minLines, so the count is bounded by the line count.
    for (let guard = 0; guard < 4096; guard++) {
      const cap = capOf(to);
      if (to - pos <= cap) break;

      // This section can run to pos + jobLines, and never past the piece itself.
      const hi = Math.min(pos + jobLines, to - 1);
      // Does one more cut finish the piece? If so the remainder has to fit too,
      // which raises the floor; if not, only the ceiling matters.
      const oneMoreDoes = to - hi <= cap;
      const lo = Math.min(hi, Math.max(pos + minLines, oneMoreDoes ? to - cap : 0));
      // Filling the first job to the brim would leave the last one a scrap of a
      // few lines plus the tear gap. When a single cut will do, halve instead.
      const target = oneMoreDoes
        ? Math.min(hi, Math.max(lo, Math.round((pos + to) / 2)))
        : hi;

      let at = target;
      let reason: CutReason = 'forced';
      if (o.raster && o.widthBytes) {
        const floor = Math.max(lo, target - window);
        for (let y = target; y >= floor; y--) {
          if (isBlankRow(o.raster, o.widthBytes, y)) {
            at = y;
            reason = 'blank row';
            break;
          }
        }
      }
      if (at <= pos || at >= to) break; // nothing sensible left to do
      cuts.push({ at, reason });
      pos = at;
    }
    return cuts;
  }

  return finish(finalBounds, reasons);
}

/** What a print actually did, for the status line and the diagnostics panel. */
export interface PrintReport {
  sections: number;
  cutReasons: CutReason[];
  bytesPerSection: number[];
  /** Every wait taken, between sections and between copies. */
  waitsMs: number[];
  copies: number;
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
 * garbled too. The same applies between copies, which are whole labels rather
 * than sections but arrive down the same pipe.
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
    /** Whole labels to print, each with its own tear-off gap. */
    copies?: number;
  } = {},
): Promise<PrintReport> {
  const maxJobBytes = opts.maxJobBytes ?? P.MAX_JOB_BYTES;
  const tearLines = Math.max(0, Math.round(opts.tearFeedPx ?? P.DEFAULT_TEAR_FEED_PX));

  const plan = planSections(height, widthBytes, {
    maxBytes: maxJobBytes,
    seams: opts.seams,
    raster,
    widthBytes,
    tearLines,
  });

  // The planner is the only thing standing between a long label and a job the
  // printer silently drops, so check its work rather than trust it. A section
  // over budget here is a bug, and a bug that shows up as blank paper an hour
  // later is worth ten lines of guard.
  const over = plan.bytesPerSection.findIndex((b) => b > maxJobBytes);
  if (over >= 0) {
    throw new Error(
      `Cannot split this label safely: section ${over + 1} would be ` +
        `${plan.bytesPerSection[over]} bytes against a ${maxJobBytes} limit. ` +
        'Shorten the label, or raise Max job size in Diagnostics.',
    );
  }

  const total = plan.sections.length;
  const copies = Math.max(1, Math.round(opts.copies ?? 1));
  const linesPerSecond = Math.max(20, opts.linesPerSecond ?? P.PRINT_LINES_PER_SEC);
  const waitsMs: number[] = [];
  const steps = total * copies;

  /** Wait for paper already committed to actually come out of the printer. */
  const waitFor = async (lines: number) => {
    const printMs = (lines / linesPerSecond) * 1000;
    const ms = Math.max(P.MIN_SECTION_GAP_MS, Math.round(printMs + P.SECTION_SETTLE_MS));
    waitsMs.push(ms);
    await sleep(ms);
  };

  for (let copy = 0; copy < copies; copy++) {
    for (let i = 0; i < total; i++) {
      const { from, lines } = plan.sections[i];
      const slice = raster.subarray(from * widthBytes, (from + lines) * widthBytes);
      const lastSection = i === total - 1;
      // Only the final section of each label carries the tear-off allowance;
      // adding it between sections would push a blank gap into the middle.
      const tear = lastSection ? tearLines : 0;

      await printRaster(transport, slice, lines, widthBytes, {
        ...opts,
        tearFeedPx: tear,
        onProgress: (f) => opts.onProgress?.((copy * total + i + f) / steps),
      });

      const lastOfAll = lastSection && copy === copies - 1;
      if (!lastOfAll) await waitFor(lines + tear);
    }
  }

  return {
    sections: total,
    cutReasons: plan.cutReasons,
    bytesPerSection: plan.bytesPerSection,
    waitsMs,
    copies,
  };
}
