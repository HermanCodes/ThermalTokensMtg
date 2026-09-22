/**
 * Phone interface: a navigation stack with a modal settings sheet, styled to
 * match iOS. Used on touch devices and inside the native shell.
 */
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

export default function PhoneApp({
  api,
  onUseDesktopLayout,
}: {
  api: PrinterApi;
  onUseDesktopLayout?: () => void;
}) {
  const {
    query, setQuery, results, searching, scope, setScope,
    selected, mode, setMode, labelMm, setLabelMm,
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
    screen, setScreen, sheet, setSheet, open,
  } = api;

  return (
    <div className="ios">
      {/* ================= search ================= */}
      <section className={`screen${screen === 'detail' ? ' pushed' : ''}`}>
        <div className="scroll">
          <h1 className="largetitle">Tokens</h1>

          <div className="segmented scope">
            <button
              className={scope === 'tokens' ? 'on' : ''}
              onClick={() => setScope('tokens')}
            >
              Tokens
            </button>
            <button className={scope === 'cards' ? 'on' : ''} onClick={() => setScope('cards')}>
              All cards
            </button>
          </div>

          <div className="searchwrap">
            <div className="searchbar">
              <Icon.Search />
              <input
                value={query}
                placeholder={scope === 'tokens' ? 'Goblin, Treasure, Angel…' : 'Llanowar Elves, Teferi…'}
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
                <button className="textbtn" onClick={() => connect()}>
                  Reconnect
                </button>
              </div>
            ) : (
              <button
                className="row tappable"
                onClick={() => connect()}
                disabled={!supported || busy}
              >
                <span className="row-label accent">
                  <Icon.Bluetooth />
                  {busy ? 'Looking for your printer…' : 'Connect printer'}
                </span>
                <Icon.ChevronRight />
              </button>
            )}
          </div>

          {status.msg && screen === 'search' && (
            <p className={`footnote ${status.kind}`}>{status.msg}</p>
          )}

          {!supported && (
            <p className="footnote warn">
              This browser can’t reach Bluetooth devices. On iPhone use Bluefy, or the app
              build.
            </p>
          )}

          {status.kind === 'err' && screen === 'search' && (
            <div className="group">
              <button className="row tappable" onClick={() => connect()} disabled={busy}>
                <span className="row-label accent">Try again</span>
                <Icon.ChevronRight />
              </button>
            </div>
          )}

          {status.kind === 'err' && diag.length > 0 && screen === 'search' && (
            <details className="diagbox">
              <summary>Connection details</summary>
              <pre>{diag.join('\n')}</pre>
            </details>
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
                      {statLabel(c) && (
                        <span className={`badge${statLabel(c)!.kind === 'loyalty' ? ' loyalty' : ''}`}>
                          {statLabel(c)!.text}
                        </span>
                      )}
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

          {status.msg && screen === 'detail' && (
            <p className={`footnote ${status.kind}`}>{status.msg}</p>
          )}
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
            {selected && !selected.isToken && (
              <SwitchRow
                label="Mark as TOKEN"
                checked={markTokens}
                onChange={setMarkTokens}
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
                {writeMode === 'without-response' && (
                  <p className="footnote warn">
                    Without response, chunks are capped at 20 bytes — anything larger is
                    dropped by the link with no error. Reliable but slower; use With
                    response unless you are testing.
                  </p>
                )}
                <SelectRow
                  label="Write mode"
                  value={writeMode}
                  options={[
                    ['with-response', 'With response'],
                    ['without-response', 'Without response'],
                  ]}
                  onChange={(v) => setWriteMode(v as WriteMode)}
                />
                <SliderRow
                  label="Pacing"
                  display={`${chunkDelay} ms`}
                  value={chunkDelay}
                  min={0}
                  max={30}
                  onChange={setChunkDelay}
                />
                <p className="footnote">
                  Pacing is the printer's flow control: a Bluetooth write is acknowledged by
                  the radio, not the printer, so sending flat out overruns its buffer and it
                  feeds blank paper. Lower it to print faster, but check the result.
                </p>
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

          {onUseDesktopLayout && (
            <>
              <h2 className="grouphead">Interface</h2>
              <div className="group">
                <Row label="Use desktop layout" onClick={onUseDesktopLayout} />
              </div>
              <p className="footnote">
                The layout follows the window by default. Choosing one here remembers it.
              </p>
            </>
          )}

          <div className="tailspace" />
        </div>
      </div>
    </div>
  );
}
