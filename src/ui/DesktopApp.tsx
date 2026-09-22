/**
 * Desktop interface.
 *
 * A desktop browser has room to show everything at once, so there is no
 * navigation stack and no settings sheet: results, preview and settings sit
 * side by side. The phone's push transitions and modal sheet are worse with a
 * mouse, not better.
 */
import { useEffect, useRef } from 'react';
import { statLabel } from '../scryfall';
import type { CardFit } from '../label';
import type { Dither } from '../raster';
import {
  MAX_WIDTH_MM,
  MEDIA_CONTINUOUS,
  MEDIA_LABEL_WITH_GAPS,
  MEDIA_LABEL_WITH_MARKS,
  type WriteMode,
} from '../printer';
import type { CalibLayout, CalibContent } from '../calibration';
import { MODE_LABEL, QUICK_PICKS, type PrinterApi } from '../usePrinter';
import { Row, SliderRow, SwitchRow, SelectRow } from './controls';
import * as Icon from './icons';

export default function DesktopApp({
  api,
  onUsePhoneLayout,
}: {
  api: PrinterApi;
  onUsePhoneLayout: () => void;
}) {
  const {
    query, setQuery, results, searching, scope, setScope,
    selected, setSelected, mode, setMode, labelMm, setLabelMm,
    textBlockMm, setTextBlockMm, autoTextBlock, setAutoTextBlock,
    cardMm, setCardMm, cardFit, setCardFit,
    showArt, setShowArt, markTokens, setMarkTokens,
    dither, setDither, threshold, setThreshold,
    brightness, setBrightness, contrast, setContrast,
    autoToneOn, setAutoToneOn, targetInk, setTargetInk,
    claheOn, setClaheOn, clipLimit, setClipLimit, tiles, setTiles,
    tone, solved, printSize, previewRef, geometry,
    sweepBright, setSweepBright, sweepContrast, setSweepContrast,
    cellH, setCellH, calibLayout, setCalibLayout, calibContent, setCalibContent,
    printerName, status, progress, busy, copies, setCopies,
    density, setDensity, media, setMedia, tearMm, setTearMm,
    writeMode, setWriteMode, chunkSize, setChunkSize,
    chunkDelay, setChunkDelay, maxBlockLines, setMaxBlockLines,
    supported, diag, showDiag, setShowDiag,
    connect, print, testPrint,
  } = api;

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // A mouse and keyboard are available, so use them.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl/Cmd+Enter prints from anywhere.
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (selected && !busy) print();
        return;
      }
      // Ctrl/Cmd+K focuses search, as most web apps do.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      // Arrow keys move through results unless a text field has focus.
      const typing =
        document.activeElement instanceof HTMLInputElement &&
        document.activeElement.type === 'text';
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && results.length > 0) {
        if (typing && document.activeElement !== searchRef.current) return;
        e.preventDefault();
        const i = selected ? results.findIndex((c) => c.id === selected.id) : -1;
        const next = e.key === 'ArrowDown' ? Math.min(results.length - 1, i + 1) : Math.max(0, i - 1);
        setSelected(results[next]);
        listRef.current
          ?.querySelectorAll('.drow')[next]
          ?.scrollIntoView({ block: 'nearest' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [results, selected, setSelected, print, busy]);

  return (
    <div className="desk">
      <header className="topbar">
        <h1>Token Printer</h1>
        <div className="spacer" />
        <span className="conn">
          <span className={`dot ${printerName ? 'on' : ''}`} />
          {printerName ?? 'Not connected'}
        </span>
        <button className="btn" onClick={() => connect()} disabled={!supported || busy}>
          <Icon.Bluetooth />
          {printerName ? 'Reconnect' : 'Connect printer'}
        </button>
        <button className="btn ghost" onClick={onUsePhoneLayout} title="Switch to the phone layout">
          Phone view
        </button>
      </header>

      {status.kind === 'err' && (
        <div className="banner err">
          <span>{status.msg}</span>
          <button className="btn" onClick={() => connect()} disabled={busy}>
            Try again
          </button>
        </div>
      )}

      {!supported && (
        <p className="banner err">
          This browser can’t reach Bluetooth devices. Chrome and Edge work as-is; Brave needs{' '}
          <code>brave://flags/#brave-web-bluetooth-api</code> enabled.
        </p>
      )}

      <div className="cols">
        {/* ---------------- results ---------------- */}
        <section className="pane results-pane">
          <div className="segmented scope">
            <button className={scope === 'tokens' ? 'on' : ''} onClick={() => setScope('tokens')}>
              Tokens
            </button>
            <button className={scope === 'cards' ? 'on' : ''} onClick={() => setScope('cards')}>
              All cards
            </button>
          </div>

          <div className="searchbar">
            <Icon.Search />
            <input
              ref={searchRef}
              type="text"
              value={query}
              placeholder={
                scope === 'tokens' ? 'Goblin, Treasure, Angel…' : 'Llanowar Elves, Teferi…'
              }
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && results.length > 0) setSelected(results[0]);
              }}
            />
            {query && (
              <button className="clear" onClick={() => setQuery('')} aria-label="Clear">
                <Icon.Clear />
              </button>
            )}
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

          <p className="hint">
            {searching
              ? 'Searching…'
              : `${results.length} result${results.length === 1 ? '' : 's'}`}
            <span className="keys">↑↓ select · ⏎ first · ⌘⏎ print</span>
          </p>

          <div className="dlist" ref={listRef}>
            {results.map((c) => (
              <button
                key={c.id}
                className={`drow${selected?.id === c.id ? ' sel' : ''}`}
                onClick={() => setSelected(c)}
              >
                {c.imageUrl ? <img src={c.imageUrl} alt="" loading="lazy" /> : <span className="thumb-none" />}
                <span className="drow-text">
                  <span className="drow-name">{c.name}</span>
                  <span className="drow-type">{c.typeLine}</span>
                  <span className="drow-set">{c.setName}</span>
                </span>
                {statLabel(c) && (
                  <span className={`badge${statLabel(c)!.kind === 'loyalty' ? ' loyalty' : ''}`}>
                    {statLabel(c)!.text}
                  </span>
                )}
              </button>
            ))}
            {!searching && query && results.length === 0 && (
              <p className="hint pad">No matches for “{query}”.</p>
            )}
          </div>
        </section>

        {/* ---------------- preview ---------------- */}
        <section className="pane preview-pane">
          {mode === 'calib' ? (
            <div className="banner tint">
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

          <div className="paper-wrap">
            {selected ? (
              <div className="paper">
                <canvas ref={previewRef} />
              </div>
            ) : (
              <p className="empty">Search for a token or card, then pick one.</p>
            )}
          </div>

          <div className="printbar">
            <span className="size">
              {printSize ? `${printSize.w.toFixed(0)} × ${printSize.h.toFixed(0)} mm` : '—'}
            </span>
            <div className="spacer" />
            <span className="stepper">
              <button onClick={() => setCopies((c) => Math.max(1, c - 1))} disabled={copies <= 1}>
                −
              </button>
              <span>{copies}</span>
              <button onClick={() => setCopies((c) => Math.min(20, c + 1))} disabled={copies >= 20}>
                +
              </button>
            </span>
            <button className="primary" onClick={print} disabled={!selected || busy}>
              {busy && progress > 0
                ? `Printing ${Math.round(progress * 100)}%`
                : copies > 1
                  ? `Print ${copies}`
                  : 'Print'}
            </button>
          </div>

          <p className={`status ${status.kind}`}>
            {status.kind === 'err' ? ' ' : status.msg || ' '}
          </p>
        </section>

        {/* ---------------- settings ---------------- */}
        <aside className="pane settings-pane">
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
            {selected && !selected.isToken && (
              <SwitchRow label="Mark as TOKEN" checked={markTokens} onChange={setMarkTokens} />
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
            {mode === 'both' && (
              <SliderRow
                label="Card height"
                display={cardMm > 0 ? `${cardMm} mm` : 'full'}
                value={cardMm}
                min={0}
                max={70}
                step={5}
                onChange={setCardMm}
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
            <p className="hint tint">
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

          <h2 className="grouphead">Advanced</h2>
          <div className="group">
            <Row label="Send test pattern" onClick={testPrint} />
            <Row
              label="Calibration strip"
              onClick={() => {
                if (selected?.printImageUrl) setMode('calib');
              }}
            />
            <Row
              label={showDiag ? 'Hide diagnostics' : 'Show diagnostics'}
              onClick={() => setShowDiag(!showDiag)}
            />
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
                <SliderRow
                  label="Pacing"
                  display={`${chunkDelay} ms`}
                  value={chunkDelay}
                  min={0}
                  max={30}
                  onChange={setChunkDelay}
                />
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
                <Row label="Only Phomemo devices" onClick={() => connect(true)} />
              </div>
              <p className="hint mono">
                {geometry.widthPx} dots · {geometry.widthBytes} bytes/line
                {tone ? ` · card mean ${tone.mean.toFixed(0)}` : ''}
                {solved
                  ? ` · B${solved.brightness > 0 ? '+' : ''}${solved.brightness} · ink ${(solved.predictedInk * 100).toFixed(0)}%`
                  : ''}
              </p>
              {diag.length > 0 && <pre>{diag.join('\n')}</pre>}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
