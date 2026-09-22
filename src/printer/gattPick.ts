/**
 * Choosing the printer's write characteristic, shared by both transports.
 *
 * Not every unit exposes the documented 0xff00/0xff02 pair — some report a
 * different service entirely, and printing then works only because a fallback
 * happened to pick the right characteristic. That makes the choice dependent on
 * the order the device lists things in, so the pair that actually printed is
 * remembered and tried first next time.
 */
import { SERVICE_UUID_STR, WRITE_CHAR_UUID_STR, KNOWN_SERVICE_UUIDS } from './protocol';

export type MatchPath = 'documented' | 'remembered' | 'known-service' | 'brute-force';

export interface GattPair {
  service: string;
  characteristic: string;
}

/** A discovered characteristic, with whatever handle the transport needs. */
export interface GattEntryOf<T> extends GattPair {
  writable: boolean;
  props: string;
  ref: T;
}

const REMEMBERED_KEY = 'tokenprinter.gatt';

/** The pair that last printed successfully, if any. */
export function loadRemembered(): GattPair | null {
  try {
    const raw = localStorage.getItem(REMEMBERED_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { service?: unknown; characteristic?: unknown };
    return typeof v.service === 'string' && typeof v.characteristic === 'string'
      ? { service: v.service, characteristic: v.characteristic }
      : null;
  } catch {
    return null;
  }
}

/**
 * Record a working pair.
 *
 * Call this only after a print has actually succeeded: remembering a guess that
 * turned out to be wrong would make the wrong choice permanent.
 */
export function saveRemembered(pair: GattPair): void {
  try {
    localStorage.setItem(REMEMBERED_KEY, JSON.stringify(pair));
  } catch {
    // Private browsing or blocked storage — not worth failing a print over.
  }
}

export function forgetRemembered(): void {
  try {
    localStorage.removeItem(REMEMBERED_KEY);
  } catch {
    /* ignore */
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Pick a characteristic to write to, in descending order of confidence.
 * Returns the whole entry so the caller keeps its native handle.
 */
export function pickWritable<T>(
  entries: GattEntryOf<T>[],
): { chosen?: GattEntryOf<T>; matchPath?: MatchPath } {
  const documented = entries.find(
    (e) => same(e.service, SERVICE_UUID_STR) && same(e.characteristic, WRITE_CHAR_UUID_STR),
  );
  if (documented) return { chosen: documented, matchPath: 'documented' };

  const saved = loadRemembered();
  const remembered = saved
    ? entries.find(
        (e) => same(e.service, saved.service) && same(e.characteristic, saved.characteristic),
      )
    : undefined;
  if (remembered) return { chosen: remembered, matchPath: 'remembered' };

  const known = entries.find(
    (e) => KNOWN_SERVICE_UUIDS.some((u) => same(u, e.service)) && e.writable,
  );
  if (known) return { chosen: known, matchPath: 'known-service' };

  const brute = entries.find((e) => e.writable);
  if (brute) return { chosen: brute, matchPath: 'brute-force' };

  return {};
}

/** Human-readable properties list, for the diagnostics dump. */
export function propsOf(p: Record<string, unknown>): string {
  return Object.entries(p)
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .join(',');
}
