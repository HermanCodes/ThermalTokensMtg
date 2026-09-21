/** Inline SF-Symbols-ish glyphs, stroked to match iOS weight. */

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const Search = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" {...stroke} strokeWidth={2.4}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5 21 21" />
  </svg>
);

export const Clear = () => (
  <svg viewBox="0 0 24 24" width="17" height="17">
    <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.35" />
    <path d="M8.5 8.5l7 7M15.5 8.5l-7 7" {...stroke} strokeWidth={2.2} stroke="#000" />
  </svg>
);

export const ChevronRight = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" {...stroke} strokeWidth={3}>
    <path d="M9 5l7 7-7 7" />
  </svg>
);

export const ChevronLeft = () => (
  <svg viewBox="0 0 24 24" width="19" height="19" {...stroke} strokeWidth={3}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
);

export const Bluetooth = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" {...stroke}>
    <path d="M7 7l10 10-5 4V3l5 4L7 17" />
  </svg>
);

export const Sliders = () => (
  <svg viewBox="0 0 24 24" width="19" height="19" {...stroke}>
    <path d="M4 8h10M18 8h2M4 16h4M12 16h8" />
    <circle cx="16" cy="8" r="2.2" />
    <circle cx="10" cy="16" r="2.2" />
  </svg>
);

export const Printer = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" {...stroke}>
    <path d="M7 9V4h10v5" />
    <rect x="3.5" y="9" width="17" height="7" rx="2" />
    <path d="M7 16h10v4H7z" />
  </svg>
);
