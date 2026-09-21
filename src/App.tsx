import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { searchTokens, ptLabel, type TokenCard } from './scryfall';
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
  MAX_BLOCK_LINES,
  MAX_WIDTH_MM,
  DEFAULT_TEAR_FEED_PX,
  MEDIA_CONTINUOUS,
  MEDIA_LABEL_WITH_GAPS,
  MEDIA_LABEL_WITH_MARKS,
  type WriteMode,
  type Transport,
} from './printer';
import * as Icon from './ui/icons';

type Status = { kind: 'idle' | 'busy' | 'ok' | 'err'; msg: string };
type Mode = 'text' | 'card' | 'both' | 'calib';

const QUICK_PICKS = ['Treasure', 'Food', 'Clue', 'Goblin', 'Zombie', 'Soldier', 'Angel', 'Beast'];

const MODE_LABEL: Record<Mode, string> = {
  text: 'Text',
  card: 'Card',
  both: 'Card + text',
  calib: 'Calibration',
};

/* --- small presentational pieces ---------------------------------------- */

function Row({
  label,
  value,
  onClick,
  children,
}: {
  label: string;
  value?: string;
  onClick?: () => void;
  children?: React.ReactNode;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className={`row${onClick ? ' tappable' : ''}`} onClick={onClick}>
      <span className="row-label">{label}</span>
      <span className="row-trail">
        {value && <span className="row-value">{value}</span>}
        {children}
        {onClick && <Icon.ChevronRight />}
      </span>
    </Tag>
  );
}

function SliderRow({
  label,
  value,
  display,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="row slider">
      <span className="row-label">
        {label}
        <span className="row-value">{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function SwitchRow({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="row">
      <span className="row-label">{label}</span>
      <span className={`switch${disabled ? ' off' : ''}`}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span />
      </span>
    </label>
  );
}

function SelectRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | number;
  options: [string | number, string][];
  onChange: (v: string) => void;
}) {
  return (
    <label className="row">
      <span className="row-label">{label}</span>
      <span className="row-trail">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map(([v, t]) => (
            <option key={v} value={v}>
              {t}
            </option>
          ))}
        </select>
        <Icon.ChevronRight />
      </span>
    </label>
  );
}

/* --- app ----------------------------------------------------------------- */

export default function App() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TokenCard[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<TokenCard | null>(null);
  const [art, setArt] = useState<HTMLImageElement | null>(null);

  const [screen, setScreen] = useState<'search' | 'detail'>('search');
  const [sheet, setSheet] = useState(false);

  const [labelMm, setLabelMm] = useState({ w: MAX_WIDTH_MM, h: 30 });
  const [mode, setMode] = useState<Mode>('both');
  const [textBlockMm, setTextBlockMm] = useState(26);
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

  useEffect(() => {
    const t = transportRef.current;
    if (t instanceof WebBluetoothTransport) t.writeMode = writeMode;
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
        setResults(await searchTokens(query, ac.signal));
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
  }, [query]);

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
    [selected, mode, art, cardFit, geometry, showArt, dither, threshold, brightness, contrast, clahe, sweepBright, sweepContrast, cellH, calibLayout, calibContent, textBlockMm, autoTextBlock],
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
      try {
        // Web Bluetooth in the browser, CoreBluetooth in the iOS shell.
        const t = await pickTransport();
        transportRef.current = t;
        if (t instanceof WebBluetoothTransport) t.writeMode = writeMode;

        const name = await t.connect({ allDevices });
        t.onDisconnect(() => {
          setPrinterName(null);
          setStatus({ kind: 'err', msg: 'Printer disconnected' });
        });
        setPrinterName(name);

        if (t instanceof WebBluetoothTransport) {
          setDiag([
            `match: ${t.matchPath ?? 'none'}`,
            ...t.gatt.map(
              (g) => `${g.chosen ? '>> ' : '   '}${g.service} / ${g.characteristic} [${g.props}]`,
            ),
          ]);
          if (t.isUncertain()) {
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
        const t = transportRef.current;
        if (t instanceof WebBluetoothTransport) {
          setDiag(t.gatt.map((g) => `   ${g.service} / ${g.characteristic} [${g.props}]`));
        }
        setStatus({ kind: 'err', msg: (e as Error).message });
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
        media,
        maxBlockLines,
        tearFeedPx: Math.round(tearMm * 8),
      });
      setStatus({ kind: 'ok', msg: 'Test pattern sent' });
    } catch (e) {
      setStatus({ kind: 'err', msg: (e as Error).message });
    }
  }, [geometry, density, chunkSize, media, maxBlockLines, tearMm]);

  const print = useCallback(async () => {
    if (!selected) return;
    const t = transportRef.current;
    if (!t.isConnected()) {
      setStatus({ kind: 'err', msg: 'Connect a printer first' });
      return;
    }
    setStatus({ kind: 'busy', msg: 'Printing…' });
    try {
      for (let i = 0; i < copies; i++) {
        const out = renderRaster();
        if (!out) throw new Error('Nothing to print yet — the card image is still loading');
        await printRaster(t, out.raster, out.height, geometry.widthBytes, {
          density,
          chunkSize,
          media,
          maxBlockLines,
          tearFeedPx: Math.round(tearMm * 8),
          onProgress: (f) => setProgress((i + f) / copies),
        });
      }
      setStatus({
        kind: 'ok',
        msg: copies > 1 ? `Printed ${copies} × ${selected.name}` : `Printed ${selected.name}`,
      });
    } catch (e) {
      setStatus({ kind: 'err', msg: (e as Error).message });
    } finally {
      setProgress(0);
    }
  }, [selected, copies, geometry, renderRaster, density, chunkSize, media, maxBlockLines, tearMm]);

  const busy = status.kind === 'busy';
  const open = (c: TokenCard) => {
    setSelected(c);
    setScreen('detail');
    setStatus({ kind: 'idle', msg: '' });
  };

  return (
    <div className="ios">
      {/* ================= search ================= */}
      <section className={`screen${screen === 'detail' ? ' pushed' : ''}`}>
        <div className="scroll">
          <h1 className="largetitle">Tokens</h1>

          <div className="searchwrap">
            <div className="searchbar">
              <Icon.Search />
              <input
                value={query}
                placeholder="Goblin, Treasure, Angel…"
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button className="clear" onClick={() => setQuery('')} aria-label="Clear">
                  <Icon.Clear />
                </button>
              )}
            </div>
          </div>

          <div className="chips">
            {QUICK_PICKS.map((p) => (
              <button
                key={p}
                className={query === p ? 'chip on' : 'chip'}
                onClick={() => setQuery(p)}
              >
                {p}
              </button>
            ))}
          </div>

          <div className="group">
            {printerName ? (
              <div className="row">
                <span className="row-label">
                  <span className="dot on" /> {printerName}
                </span>
                <button className="textbtn" onClick={() => connect(false)}>
                  Reconnect
                </button>
              </div>
            ) : (
              <button className="row tappable" onClick={() => connect(false)} disabled={!supported}>
                <span className="row-label accent">
                  <Icon.Bluetooth /> Connect printer
                </span>
                <Icon.ChevronRight />
              </button>
            )}
          </div>

          {!supported && (
            <p className="footnote warn">
              This browser can’t reach Bluetooth devices. On iPhone use the app build, or open
              this page in Bluefy.
            </p>
          )}

          {results.length > 0 && (
            <>
              <h2 className="grouphead">
                {results.length} {results.length === 1 ? 'token' : 'tokens'}
              </h2>
              <div className="group list">
                {results.map((c) => (
                  <button key={c.id} className="row tappable card" onClick={() => open(c)}>
                    {c.imageUrl ? (
                      <img src={c.imageUrl} alt="" loading="lazy" />
                    ) : (
                      <div className="thumb-none" />
                    )}
                    <span className="card-text">
                      <span className="card-name">{c.name}</span>
                      <span className="card-type">{c.typeLine}</span>
                      <span className="card-set">{c.setName}</span>
                    </span>
                    <span className="row-trail">
                      {ptLabel(c) && <span className="badge">{ptLabel(c)}</span>}
                      <Icon.ChevronRight />
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}

          {!searching && query && results.length === 0 && (
            <p className="footnote">No tokens match “{query}”.</p>
          )}

          <div className="tailspace" />
        </div>
      </section>

      {/* ================= detail ================= */}
      <section className={`screen detail${screen === 'detail' ? ' open' : ''}`}>
        <div className="navbar">
          <button className="navback" onClick={() => setScreen('search')}>
            <Icon.ChevronLeft />
            <span>Tokens</span>
          </button>
          <span className="navtitle">{selected?.name ?? ''}</span>
          <button className="navbtn" onClick={() => setSheet(true)} aria-label="Options">
            <Icon.Sliders />
          </button>
        </div>

        <div className="scroll">
          <div className="paper">
            {selected ? <canvas ref={previewRef} /> : <p className="empty">No token selected</p>}
          </div>

          {mode === 'calib' ? (
            <div className="banner">
              <span>Calibration strip</span>
              <button className="textbtn" onClick={() => setMode('both')}>
                Done
              </button>
            </div>
          ) : (
            <div className="segmented">
              {(['text', 'card', 'both'] as const).map((m) => (
                <button
                  key={m}
                  className={mode === m ? 'on' : ''}
                  disabled={m !== 'text' && !selected?.printImageUrl}
                  onClick={() => setMode(m)}
                >
                  {MODE_LABEL[m]}
                </button>
              ))}
            </div>
          )}

          <div className="group">
            <div className="row">
              <span className="row-label">Copies</span>
              <span className="stepper">
                <button onClick={() => setCopies((c) => Math.max(1, c - 1))} disabled={copies <= 1}>
                  −
                </button>
                <span>{copies}</span>
                <button
                  onClick={() => setCopies((c) => Math.min(20, c + 1))}
                  disabled={copies >= 20}
                >
                  +
                </button>
              </span>
            </div>
            <Row
              label="Paper used"
              value={printSize ? `${printSize.w.toFixed(0)} × ${printSize.h.toFixed(0)} mm` : '—'}
            />
            <Row label="Print options" onClick={() => setSheet(true)} />
          </div>

          {status.msg && <p className={`footnote ${status.kind}`}>{status.msg}</p>}
          <div className="tailspace" />
        </div>

        <div className="bottombar">
          <button className="primary" onClick={print} disabled={!selected || busy}>
            {busy && progress > 0
              ? `Printing ${Math.round(progress * 100)}%`
              : copies > 1
                ? `Print ${copies} labels`
                : 'Print label'}
          </button>
        </div>
      </section>

      {/* ================= settings sheet ================= */}
      <div className={`backdrop${sheet ? ' open' : ''}`} onClick={() => setSheet(false)} />
      <div className={`sheet${sheet ? ' open' : ''}`}>
        <div className="grabber" />
        <div className="sheethead">
          <span>Print options</span>
          <button className="textbtn strong" onClick={() => setSheet(false)}>
            Done
          </button>
        </div>

        <div className="scroll">
          <h2 className="grouphead">Look</h2>
          <div className="group">
            <SliderRow
              label="Ink"
              display={`${targetInk}%`}
              value={targetInk}
              min={15}
              max={60}
              onChange={setTargetInk}
            />
            <SliderRow
              label="Contrast"
              display={contrast > 0 ? `+${contrast}` : `${contrast}`}
              value={contrast}
              min={-50}
              max={80}
              onChange={setContrast}
            />
            <SwitchRow
              label="Adjust each card automatically"
              checked={autoToneOn}
              onChange={setAutoToneOn}
            />
            {!autoToneOn && (
              <SliderRow
                label="Brightness"
                display={brightness > 0 ? `+${brightness}` : `${brightness}`}
                value={brightness}
                min={-60}
                max={80}
                onChange={setBrightness}
              />
            )}
            {mode === 'text' && (
              <SwitchRow
                label="Include a strip of art"
                checked={showArt}
                disabled={!selected?.artUrl}
                onChange={setShowArt}
              />
            )}
            {mode === 'both' && (
              <SwitchRow
                label="Fit text to content"
                checked={autoTextBlock}
                onChange={setAutoTextBlock}
              />
            )}
            {mode === 'both' && !autoTextBlock && (
              <SliderRow
                label="Text height"
                display={`${textBlockMm} mm`}
                value={textBlockMm}
                min={14}
                max={45}
                onChange={setTextBlockMm}
              />
            )}
            {mode === 'card' && (
              <SelectRow
                label="Card shape"
                value={cardFit}
                options={[
                  ['aspect', 'Keep proportions'],
                  ['label', 'Fit height'],
                ]}
                onChange={(v) => setCardFit(v as CardFit)}
              />
            )}
          </div>
          {solved?.clamped && (
            <p className="footnote warn">
              This card can’t reach {targetInk}% ink without washing out. Try lowering Ink.
            </p>
          )}

          <h2 className="grouphead">Paper</h2>
          <div className="group">
            <SliderRow
              label="Width"
              display={`${Math.min(labelMm.w, MAX_WIDTH_MM)} mm`}
              value={Math.min(labelMm.w, MAX_WIDTH_MM)}
              min={20}
              max={MAX_WIDTH_MM}
              onChange={(v) => setLabelMm((s) => ({ ...s, w: v }))}
            />
            {mode !== 'both' && (
              <SliderRow
                label="Height"
                display={`${labelMm.h} mm`}
                value={labelMm.h}
                min={16}
                max={90}
                onChange={(v) => setLabelMm((s) => ({ ...s, h: v }))}
              />
            )}
            <SliderRow
              label="Tear-off gap"
              display={`${tearMm} mm`}
              value={tearMm}
              min={0}
              max={25}
              onChange={setTearMm}
            />
            <SliderRow
              label="Darkness"
              display={`${density}`}
              value={density}
              min={1}
              max={15}
              onChange={setDensity}
            />
            <SelectRow
              label="Paper type"
              value={media}
              options={[
                [MEDIA_CONTINUOUS, 'Continuous roll'],
                [MEDIA_LABEL_WITH_GAPS, 'Die-cut labels'],
                [MEDIA_LABEL_WITH_MARKS, 'Black-mark labels'],
              ]}
              onChange={(v) => setMedia(Number(v))}
            />
          </div>
          <p className="footnote">
            The print head is {MAX_WIDTH_MM} mm wide, so wider paper keeps a blank margin.
          </p>

          <h2 className="grouphead">Advanced</h2>
          <div className="group">
            <Row label="Send test pattern" onClick={testPrint} />
            <Row
              label="Calibration strip"
              onClick={() => {
                if (!selected?.printImageUrl) return;
                setMode('calib');
                setSheet(false);
              }}
            />
            <Row label={showDiag ? 'Hide diagnostics' : 'Show diagnostics'} onClick={() => setShowDiag((v) => !v)} />
          </div>

          {showDiag && (
            <>
              <div className="group">
                <SelectRow
                  label="Dither"
                  value={dither}
                  options={[
                    ['atkinson', 'Atkinson'],
                    ['floyd-steinberg', 'Floyd–Steinberg'],
                    ['threshold', 'Threshold'],
                  ]}
                  onChange={(v) => setDither(v as Dither)}
                />
                <SliderRow
                  label="Threshold"
                  display={`${threshold}`}
                  value={threshold}
                  min={40}
                  max={220}
                  onChange={setThreshold}
                />
                <SwitchRow label="Local contrast (CLAHE)" checked={claheOn} onChange={setClaheOn} />
                {claheOn && (
                  <>
                    <SliderRow
                      label="Clip limit"
                      display={clipLimit.toFixed(1)}
                      value={clipLimit}
                      min={1}
                      max={6}
                      step={0.5}
                      onChange={setClipLimit}
                    />
                    <SliderRow
                      label="Tiles"
                      display={`${tiles}×${tiles}`}
                      value={tiles}
                      min={2}
                      max={16}
                      step={2}
                      onChange={setTiles}
                    />
                  </>
                )}
              </div>
              <div className="group">
                <SelectRow
                  label="Write mode"
                  value={writeMode}
                  options={[
                    ['with-response', 'With response'],
                    ['without-response', 'Without response'],
                  ]}
                  onChange={(v) => setWriteMode(v as WriteMode)}
                />
                <SelectRow
                  label="Chunk size"
                  value={chunkSize}
                  options={[
                    [20, '20 B'],
                    [60, '60 B'],
                    [128, '128 B'],
                    [180, '180 B'],
                  ]}
                  onChange={(v) => setChunkSize(Number(v))}
                />
                <SelectRow
                  label="Lines per block"
                  value={maxBlockLines}
                  options={[
                    [65535, 'No split'],
                    [1024, '1024'],
                    [512, '512'],
                    [256, '256'],
                  ]}
                  onChange={(v) => setMaxBlockLines(Number(v))}
                />
                <Row label="Show all devices" onClick={() => connect(true)} />
              </div>
              {mode === 'calib' && (
                <div className="group">
                  <label className="row slider">
                    <span className="row-label">Brightness values</span>
                    <input
                      type="text"
                      value={sweepBright}
                      onChange={(e) => setSweepBright(e.target.value)}
                    />
                  </label>
                  <label className="row slider">
                    <span className="row-label">Contrast values</span>
                    <input
                      type="text"
                      value={sweepContrast}
                      onChange={(e) => setSweepContrast(e.target.value)}
                    />
                  </label>
                  <SelectRow
                    label="Layout"
                    value={calibLayout}
                    options={[
                      ['stack', 'Stacked'],
                      ['grid', 'Grid'],
                    ]}
                    onChange={(v) => setCalibLayout(v as CalibLayout)}
                  />
                  <SelectRow
                    label="Sample"
                    value={calibContent}
                    options={[
                      ['art', 'Art band'],
                      ['card', 'Whole card'],
                    ]}
                    onChange={(v) => setCalibContent(v as CalibContent)}
                  />
                  {calibContent === 'art' && (
                    <SliderRow
                      label="Sample height"
                      display={`${(cellH / 8).toFixed(0)} mm`}
                      value={cellH}
                      min={80}
                      max={360}
                      step={10}
                      onChange={setCellH}
                    />
                  )}
                </div>
              )}
              <p className="footnote mono">
                {geometry.widthPx} dots · {geometry.widthBytes} bytes/line
                {tone ? ` · card mean ${tone.mean.toFixed(0)}` : ''}
                {solved
                  ? ` · B${solved.brightness > 0 ? '+' : ''}${solved.brightness} · ink ${(solved.predictedInk * 100).toFixed(0)}%`
                  : ''}
              </p>
              {diag.length > 0 && <pre>{diag.join('\n')}</pre>}
            </>
          )}

          <div className="tailspace" />
        </div>
      </div>
    </div>
  );
}
