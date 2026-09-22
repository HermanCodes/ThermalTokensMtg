/**
 * Everything the app does, with no opinion about how it looks.
 *
 * The phone and desktop interfaces are two views over this one hook, so the
 * search, rendering, tone solving and Bluetooth behaviour cannot drift between
 * them — only the layout differs.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { searchCards, type TokenCard, type SearchScope } from './scryfall';
import { drawLabel, drawCard, loadArt, type CardFit } from './label';
import {
  canvasToRaster,
  rasterToCanvas,
  analyseImageTone,
  autoTone,
  type Dither,
  type ToneStats,
  type AutoToneResult,
} from './raster';
import { buildCombinedLabel } from './compose';
import {
  buildCalibrationStrip,
  parseValues,
  type CalibLayout,
  type CalibContent,
} from './calibration';
import {
  WebBluetoothTransport,
  pickTransport,
  transportAvailable,
  printRaster,
  printTestPattern,
  mmToPx,
  alignWidth,
  PRINTER_WIDTH_PX,
  DEFAULT_DENSITY,
  CHUNK_SIZE,
  CHUNK_DELAY_MS,
  CONNECT_SETTLE_MS,
  MAX_BLOCK_LINES,
  MAX_WIDTH_MM,
  DEFAULT_TEAR_FEED_PX,
  MEDIA_CONTINUOUS,
  type WriteMode,
  type Transport,
} from './printer';

export type Status = { kind: 'idle' | 'busy' | 'ok' | 'err'; msg: string };
export type Mode = 'text' | 'card' | 'both' | 'calib';

export const QUICK_PICKS = ['Treasure', 'Food', 'Clue', 'Goblin', 'Zombie', 'Soldier', 'Angel', 'Beast'];

export const MODE_LABEL: Record<Mode, string> = {
  text: 'Text',
  card: 'Card',
  both: 'Card + text',
  calib: 'Calibration',
};

/**
 * Describe whatever a rejected promise handed us.
 *
 * Chrome rejects with a DOMException, but other Web Bluetooth implementations
 * do not: Bluefy on iOS can reject with a non-Error, and reading `.name` /
 * `.message` off that yields "undefined: undefined" — which says nothing about
 * what went wrong. This keeps the raw shape so the diagnostics box is useful.
 */
function describeThrown(e: unknown): { name: string; message: string; raw: string } {
  if (e instanceof Error) {
    return { name: e.name, message: e.message, raw: `${e.name}: ${e.message}` };
  }
  if (typeof e === 'string') return { name: 'string', message: e, raw: `string: ${e}` };
  if (e === undefined) {
    return { name: 'undefined', message: 'rejected with undefined', raw: 'rejected with undefined' };
  }
  if (e === null) {
    return { name: 'null', message: 'rejected with null', raw: 'rejected with null' };
  }
  if (typeof e === 'object') {
    const o = e as Record<string, unknown>;
    const name =
      typeof o.name === 'string'
        ? o.name
        : (o.constructor as { name?: string } | undefined)?.name ?? 'object';
    const message = typeof o.message === 'string' ? o.message : '';
    let json: string;
    try {
      json = JSON.stringify(e);
    } catch {
      json = '(not serialisable)';
    }
    return {
      name,
      message,
      raw: `${name}${message ? `: ${message}` : ''} keys=[${Object.keys(o).join(',')}] ${json}`,
    };
  }
  return { name: typeof e, message: String(e), raw: `${typeof e}: ${String(e)}` };
}

/** Map a thrown value to actionable text. */
function friendlyBleError(e: unknown): string {
  const { name, message } = describeThrown(e);
  switch (name) {
    case 'NotFoundError':
      return 'No printer found. Switch it on, and close any other app connected to it.';
    case 'SecurityError':
      return 'Blocked. Bluetooth needs an HTTPS page — plain http:// will not work.';
    case 'NotSupportedError':
      return 'This browser cannot reach Bluetooth devices.';
    case 'NetworkError':
      return 'Could not connect. Power the printer off and on, then try again.';
    case 'InvalidStateError':
      return 'Bluetooth is off, or the printer is already connected elsewhere.';
    case 'NotAllowedError':
      return 'Permission refused. Allow Bluetooth for this site and try again.';
    // Bluefy rejects with a bare value when it dislikes the request, most often
    // because no device matched its scan.
    case 'undefined':
    case 'null':
      return 'No printer found, or this browser rejected the request. Try “Search all Bluetooth devices”.';
    default:
      return message ? `${name}: ${message}` : `Failed: ${name}`;
  }
}

/**
 * Both transports expose the same diagnostics surface, so the UI reads it
 * structurally rather than switching on which class is in use.
 */
interface Diagnosable {
  gatt: { service: string; characteristic: string; props: string; chosen: boolean }[];
  matchPath?: string;
  notifyState: string;
  notifications: string[];
  writeMode: 'with-response' | 'without-response';
  isUncertain(): boolean;
  confirmWorking(): void;
}

function asDiagnosable(t: unknown): Diagnosable | null {
  const d = t as Partial<Diagnosable> | null;
  return d && Array.isArray(d.gatt) && typeof d.confirmWorking === 'function'
    ? (d as Diagnosable)
    : null;
}

/* --- the hook ------------------------------------------------------------ */

export function usePrinter() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TokenCard[]>([]);
  const [searching, setSearching] = useState(false);
  const [scope, setScope] = useState<SearchScope>('tokens');
  const [markTokens, setMarkTokens] = useState(true);
  const [selected, setSelected] = useState<TokenCard | null>(null);
  const [art, setArt] = useState<HTMLImageElement | null>(null);

  const [screen, setScreen] = useState<'search' | 'detail'>('search');
  const [sheet, setSheet] = useState(false);

  const [labelMm, setLabelMm] = useState({ w: MAX_WIDTH_MM, h: 30 });
  const [mode, setMode] = useState<Mode>('both');
  const [textBlockMm, setTextBlockMm] = useState(26);
  const [cardMm, setCardMm] = useState(0); // 0 = keep true card proportions
  const [autoTextBlock, setAutoTextBlock] = useState(true);
  const [sweepBright, setSweepBright] = useState('12, 20, 28, 36, 44, 52');
  const [sweepContrast, setSweepContrast] = useState('18');
  const [cellH, setCellH] = useState(200);
  const [calibLayout, setCalibLayout] = useState<CalibLayout>('stack');
  const [calibContent, setCalibContent] = useState<CalibContent>('art');
  const [cardFit, setCardFit] = useState<CardFit>('aspect');
  const [showArt, setShowArt] = useState(false);
  const [dither, setDither] = useState<Dither>('atkinson');
  const [threshold, setThreshold] = useState(128);
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(0);
  const [autoToneOn, setAutoToneOn] = useState(true);
  const [targetInk, setTargetInk] = useState(40);
  const [tone, setTone] = useState<ToneStats | null>(null);
  const [solved, setSolved] = useState<AutoToneResult | null>(null);
  const [claheOn, setClaheOn] = useState(true);
  const [clipLimit, setClipLimit] = useState(2.5);
  const [tiles, setTiles] = useState(8);
  const [density, setDensity] = useState(DEFAULT_DENSITY);
  const [copies, setCopies] = useState(1);
  const [media, setMedia] = useState(MEDIA_CONTINUOUS);

  const [printerName, setPrinterName] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle', msg: '' });
  const [progress, setProgress] = useState(0);
  const [writeMode, setWriteMode] = useState<WriteMode>('with-response');
  const [chunkSize, setChunkSize] = useState(CHUNK_SIZE);
  const [chunkDelay, setChunkDelay] = useState(CHUNK_DELAY_MS);
  const [maxBlockLines, setMaxBlockLines] = useState(MAX_BLOCK_LINES);
  const [tearMm, setTearMm] = useState(DEFAULT_TEAR_FEED_PX / 8);
  const [diag, setDiag] = useState<string[]>([]);
  const [showDiag, setShowDiag] = useState(false);
  const [printSize, setPrintSize] = useState<{ w: number; h: number } | null>(null);

  const renderCanvas = useRef<HTMLCanvasElement>(document.createElement('canvas'));
  const previewRef = useRef<HTMLCanvasElement>(null);
  const transportRef = useRef<Transport>(new WebBluetoothTransport());

  const supported = transportAvailable();

  const clahe = useMemo(
    () => (claheOn ? { tiles, clipLimit } : null),
    [claheOn, tiles, clipLimit],
  );

  /**
   * Resolve the platform transport up front.
   *
   * `requestDevice()` must be reached inside the user gesture that asked for
   * it. Awaiting a dynamic import first can spend that transient activation,
   * leaving the call silently ignored — so the choice happens on mount, not in
   * the tap handler.
   */
  useEffect(() => {
    let live = true;
    pickTransport().then((t) => {
      if (!live) return;
      transportRef.current = t;
      const d = asDiagnosable(t);
      if (d) d.writeMode = writeMode;
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const d = asDiagnosable(transportRef.current);
    if (d) d.writeMode = writeMode;
  }, [writeMode]);

  /** Per-mode defaults. Contrast stays a user control even with auto on. */
  useEffect(() => {
    if (mode === 'calib') return; // calibration sweeps these itself
    const usesImage = mode === 'card' || mode === 'both';
    setBrightness(usesImage ? 36 : 0);
    setContrast(usesImage ? 18 : 0);
  }, [mode]);

  /** Measure the card's tone whenever the image or mode changes. */
  useEffect(() => {
    if (!art || !(mode === 'card' || mode === 'both')) {
      setTone(null);
      return;
    }
    setTone(analyseImageTone(art, { clahe }));
  }, [art, mode, clahe]);

  /**
   * Solve brightness to hit the target ink coverage at the chosen contrast.
   * Contrast is an input here, not an output — it controls legibility, which is
   * not something a coverage target can reason about.
   */
  useEffect(() => {
    if (!autoToneOn || !tone) {
      setSolved(null);
      return;
    }
    const r = autoTone(tone, { targetInk: targetInk / 100, contrast });
    setSolved(r);
    setBrightness(r.brightness);
  }, [autoToneOn, tone, targetInk, contrast]);

  const geometry = useMemo(() => {
    // The head is the ceiling — asking for more just clips.
    const wMm = Math.min(labelMm.w, MAX_WIDTH_MM);
    const widthPx = Math.min(alignWidth(mmToPx(wMm)), PRINTER_WIDTH_PX);
    return { widthPx, heightPx: mmToPx(labelMm.h), widthBytes: widthPx / 8 };
  }, [labelMm]);

  // --- search (debounced; Scryfall asks for <=10 req/s) ---------------------
  useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        setResults(await searchCards(query, { scope, signal: ac.signal }));
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setStatus({ kind: 'err', msg: (e as Error).message });
        }
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [query, scope]);

  // --- load art for the selected token --------------------------------------
  useEffect(() => {
    let live = true;
    setArt(null);
    const url =
      mode === 'card' || mode === 'both' || mode === 'calib'
        ? selected?.printImageUrl
        : showArt
          ? selected?.artUrl
          : undefined;
    if (!url) return;
    loadArt(url)
      .then((img) => live && setArt(img))
      .catch((e) => {
        if (live) setStatus({ kind: 'err', msg: (e as Error).message });
      });
    return () => {
      live = false;
    };
  }, [selected, showArt, mode]);

  /**
   * Render the current selection to a packed raster. Used by both the preview
   * and the print path so what you see is always what gets sent.
   */
  const renderRaster = useCallback(
    (note?: string) => {
      if (!selected) return null;
      if (mode === 'calib') {
        if (!art) return null;
        return buildCalibrationStrip(art, {
          widthBytes: geometry.widthBytes,
          brightnessValues: parseValues(sweepBright),
          contrastValues: parseValues(sweepContrast),
          layout: calibLayout,
          content: calibContent,
          cellH,
          dither,
          clahe,
        });
      }
      if (mode === 'both') {
        if (!art) return null;
        return buildCombinedLabel(art, selected, {
          widthBytes: geometry.widthBytes,
          tokenMarker: markTokens && !selected.isToken,
          cardHeightPx: cardMm > 0 ? Math.round(cardMm * 8) : undefined,
          textHeightPx: autoTextBlock ? 'auto' : Math.round(textBlockMm * 8),
          dither,
          brightness,
          contrast,
          clahe,
          threshold,
        });
      }
      if (mode === 'card') {
        if (!art) return null;
        drawCard(renderCanvas.current, art, {
          widthPx: geometry.widthPx,
          heightPx: geometry.heightPx,
          fit: cardFit,
        });
      } else {
        drawLabel(
          renderCanvas.current,
          selected,
          {
            widthPx: geometry.widthPx,
            heightPx: geometry.heightPx,
            showArt,
            cornerNote: note,
            tokenMarker: markTokens && !selected.isToken,
          },
          art,
        );
      }
      return canvasToRaster(renderCanvas.current, geometry.widthBytes, {
        dither,
        threshold,
        brightness,
        contrast,
        clahe,
      });
    },
    [selected, mode, art, cardFit, geometry, showArt, dither, threshold, brightness, contrast, clahe, sweepBright, sweepContrast, cellH, calibLayout, calibContent, textBlockMm, autoTextBlock, cardMm, markTokens],
  );

  // Preview shows the packed 1bpp raster, not the greyscale canvas.
  useEffect(() => {
    if (!previewRef.current) return;
    const out = renderRaster(copies > 1 ? `${copies}x` : undefined);
    if (!out) {
      setPrintSize(null);
      return;
    }
    rasterToCanvas(out.raster, geometry.widthBytes, out.height, previewRef.current);
    setPrintSize({ w: geometry.widthPx / 8, h: out.height / 8 });
  }, [renderRaster, copies, geometry.widthBytes, geometry.widthPx, screen]);

  const connect = useCallback(
    async (allDevices = false) => {
      setStatus({ kind: 'busy', msg: 'Looking for your printer…' });
      // Already chosen on mount — no await before requestDevice.
      const t = transportRef.current;
      const d = asDiagnosable(t);
      if (d) d.writeMode = writeMode;
      try {
        const name = await t.connect({ allDevices });
        t.onDisconnect(() => {
          setPrinterName(null);
          setStatus({ kind: 'err', msg: 'Printer disconnected' });
        });
        setPrinterName(name);

        // Give the firmware a moment: printing the instant GATT resolves can
        // be accepted and then dropped.
        await new Promise((r) => setTimeout(r, CONNECT_SETTLE_MS));

        if (d) {
          setDiag([
            `transport: ${t.name}`,
            `match: ${d.matchPath ?? 'none'}`,
            `notify: ${d.notifyState}`,
            ...d.gatt.map(
              (g) => `${g.chosen ? '>> ' : '   '}${g.service} / ${g.characteristic} [${g.props}]`,
            ),
          ]);
          if (d.isUncertain()) {
            setShowDiag(true);
            setStatus({
              kind: 'err',
              msg: 'Connected, but this may be the wrong service — see Diagnostics.',
            });
            return;
          }
        }
        setStatus({ kind: 'ok', msg: `Connected to ${name}` });
      } catch (e) {
        const d = describeThrown(e);
        const nav = typeof navigator !== 'undefined' ? navigator.bluetooth : undefined;
        setDiag([
          `thrown: ${d.raw}`,
          `ua: ${typeof navigator !== 'undefined' ? navigator.userAgent : '?'}`,
          `secure context: ${typeof window !== 'undefined' && window.isSecureContext}`,
          `origin: ${typeof location !== 'undefined' ? location.origin : '?'}`,
          `navigator.bluetooth: ${nav ? 'present' : 'MISSING'}`,
          `requestDevice: ${nav && typeof nav.requestDevice === 'function' ? 'function' : 'MISSING'}`,
          `getAvailability: ${nav && typeof nav.getAvailability === 'function' ? 'function' : 'absent'}`,
          `transport: ${t.name}`,
          ...(asDiagnosable(t)?.gatt.map(
            (g) => `   ${g.service} / ${g.characteristic} [${g.props}]`,
          ) ?? []),
        ]);
        // A cancelled chooser is not a failure worth shouting about.
        const cancelled = d.name === 'NotFoundError' && /cancel/i.test(d.message);
        setStatus(
          cancelled ? { kind: 'idle', msg: '' } : { kind: 'err', msg: friendlyBleError(e) },
        );
      }
    },
    [writeMode],
  );

  const testPrint = useCallback(async () => {
    const t = transportRef.current;
    if (!t.isConnected()) {
      setStatus({ kind: 'err', msg: 'Connect a printer first' });
      return;
    }
    setStatus({ kind: 'busy', msg: 'Sending test pattern…' });
    try {
      await printTestPattern(t, geometry.widthBytes, {
        density,
        chunkSize,
        chunkDelayMs: chunkDelay,
        media,
        maxBlockLines,
        tearFeedPx: Math.round(tearMm * 8),
        unacknowledged: writeMode === 'without-response',
      });
      setStatus({ kind: 'ok', msg: 'Test pattern sent' });
    } catch (e) {
      setStatus({ kind: 'err', msg: (e as Error).message });
    }
  }, [geometry, density, chunkSize, chunkDelay, media, maxBlockLines, tearMm, writeMode]);

  const print = useCallback(async () => {
    if (!selected) return;
    const t = transportRef.current;
    if (!t.isConnected()) {
      setStatus({ kind: 'err', msg: 'Connect a printer first' });
      return;
    }
    setStatus({ kind: 'busy', msg: 'Printing…' });
    const started = performance.now();
    try {
      // Render once; every copy sends the same raster.
      const out = renderRaster();
      if (!out) throw new Error('Nothing to print yet — the card image is still loading');
      for (let i = 0; i < copies; i++) {
        await printRaster(t, out.raster, out.height, geometry.widthBytes, {
          density,
          chunkSize,
          chunkDelayMs: chunkDelay,
          media,
          maxBlockLines,
          tearFeedPx: Math.round(tearMm * 8),
          unacknowledged: writeMode === 'without-response',
          onProgress: (f) => setProgress((i + f) / copies),
        });
      }
      // Only now is the chosen characteristic proven, so it is safe to reuse.
      asDiagnosable(t)?.confirmWorking();
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      setStatus({
        kind: 'ok',
        msg:
          copies > 1
            ? `Printed ${copies} × ${selected.name} in ${secs}s`
            : `Printed ${selected.name} in ${secs}s`,
      });
    } catch (e) {
      setStatus({ kind: 'err', msg: (e as Error).message });
    } finally {
      setProgress(0);
    }
  }, [selected, copies, geometry, renderRaster, density, chunkSize, chunkDelay, media, maxBlockLines, tearMm, writeMode]);

  const busy = status.kind === 'busy';
  const open = (c: TokenCard) => {
    setSelected(c);
    setScreen('detail');
    setStatus({ kind: 'idle', msg: '' });
  };


  return {
    // search
    query, setQuery, results, searching, scope, setScope,
    selected, setSelected, art,
    // layout + rendering
    mode, setMode, labelMm, setLabelMm, textBlockMm, setTextBlockMm,
    autoTextBlock, setAutoTextBlock, cardMm, setCardMm, cardFit, setCardFit,
    showArt, setShowArt, markTokens, setMarkTokens,
    dither, setDither, threshold, setThreshold,
    brightness, setBrightness, contrast, setContrast,
    autoToneOn, setAutoToneOn, targetInk, setTargetInk,
    claheOn, setClaheOn, clipLimit, setClipLimit, tiles, setTiles,
    tone, solved, printSize, previewRef, geometry,
    // calibration
    sweepBright, setSweepBright, sweepContrast, setSweepContrast,
    cellH, setCellH, calibLayout, setCalibLayout, calibContent, setCalibContent,
    // printer
    printerName, status, progress, busy, copies, setCopies,
    density, setDensity, media, setMedia, tearMm, setTearMm,
    writeMode, setWriteMode, chunkSize, setChunkSize,
    chunkDelay, setChunkDelay, maxBlockLines, setMaxBlockLines,
    supported, diag, showDiag, setShowDiag,
    connect, print, testPrint,
    // navigation (the phone view uses these; desktop shows everything at once)
    screen, setScreen, sheet, setSheet, open,
  };
}

export type PrinterApi = ReturnType<typeof usePrinter>;
