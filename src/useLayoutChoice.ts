import { useCallback, useEffect, useState } from 'react';

export type Layout = 'phone' | 'desktop';

const KEY = 'tokenprinter.layout';

/**
 * Enough room for three columns, and a mouse to drive them.
 *
 * Deliberately not user-agent sniffing: the question is not "what device is
 * this" but "is there room for the desktop layout and a precise pointer to use
 * it". A narrow desktop window gets the phone layout, which is correct, and a
 * tablet with a keyboard gets the desktop one.
 */
const DESKTOP_QUERY = '(min-width: 900px) and (pointer: fine)';

function inNativeShell(): boolean {
  return typeof (window as unknown as { Capacitor?: unknown }).Capacitor !== 'undefined';
}

function detect(): Layout {
  // The iOS app is always the phone interface, whatever the window reports.
  if (inNativeShell()) return 'phone';
  if (typeof window === 'undefined' || !window.matchMedia) return 'phone';

  // A zero viewport means the window has not been measured — before first
  // layout, or inside an embedder that reports nothing. Width queries are
  // useless here, so fall back to the pointer and the physical screen, which
  // are still meaningful. Re-evaluation below corrects this as soon as a real
  // size arrives.
  if (window.innerWidth === 0) {
    const fine = window.matchMedia('(pointer: fine)').matches;
    return fine && window.screen?.width >= 900 ? 'desktop' : 'phone';
  }

  return window.matchMedia(DESKTOP_QUERY).matches ? 'desktop' : 'phone';
}

function loadOverride(): Layout | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'phone' || v === 'desktop' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Pick an interface, following the window as it changes.
 *
 * Auto-detection is never quite right for everyone, so the choice can be
 * overridden and the override is remembered. Clearing it returns to following
 * the window.
 */
export function useLayoutChoice(): {
  layout: Layout;
  auto: Layout;
  overridden: boolean;
  setOverride: (l: Layout | null) => void;
} {
  const [auto, setAuto] = useState<Layout>(detect);
  const [override, setOverrideState] = useState<Layout | null>(loadOverride);

  useEffect(() => {
    if (inNativeShell() || !window.matchMedia) return;
    const mq = window.matchMedia(DESKTOP_QUERY);
    const reevaluate = () => setAuto(detect());
    // The media query is the precise signal, but resize is belt and braces: if
    // the query read wrong at mount it will not fire a change event to correct
    // itself.
    if (mq.addEventListener) mq.addEventListener('change', reevaluate);
    else mq.addListener(reevaluate);
    window.addEventListener('resize', reevaluate);
    // And once more after first paint, for the case where mount beat layout.
    const raf = requestAnimationFrame(reevaluate);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', reevaluate);
      else mq.removeListener(reevaluate);
      window.removeEventListener('resize', reevaluate);
      cancelAnimationFrame(raf);
    };
  }, []);

  const setOverride = useCallback((l: Layout | null) => {
    setOverrideState(l);
    try {
      if (l) localStorage.setItem(KEY, l);
      else localStorage.removeItem(KEY);
    } catch {
      /* blocked storage is not worth failing over */
    }
  }, []);

  // The native shell cannot be overridden into the desktop layout.
  const layout = inNativeShell() ? 'phone' : (override ?? auto);
  return { layout, auto, overridden: override !== null, setOverride };
}
