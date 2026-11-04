// Small line icons (stroke=currentColor, 1.6px); no third-party icon pack, keeps the bundle small.
const PATHS: Record<string, string> = {
  plus: "M12 5v14M5 12h14",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  arrowLeft: "M19 12H5m6-6-6 6 6 6",
  arrowRight: "M5 12h14m-6-6 6 6-6 6",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-9 9h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z",
  panelLeft: "M4 5h16v14H4zM9.5 5v14",
  widen: "M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm10 17-4.5-4.5",
  caret: "M9 6l6 6-6 6",
  dots: "M5 12h.01M12 12h.01M19 12h.01",
  pin: "M9 4h6l1 7 3 3v2H5v-2l3-3 1-7Zm3 12v4",
  send: "M4 12 20 4l-4 8 4 8-16-8Zm0 0h8",
  stop: "M7 7h10v10H7z",
  attach: "M8 12l6-6a3.5 3.5 0 0 1 5 5l-7 7a5 5 0 0 1-7-7l6-6",
  menu: "M4 6h16M4 12h16M4 18h16",
  changes: "M7 4v13m0 0a3 3 0 1 0 .01 0M7 17a3 3 0 1 1-.01 0M17 7v13m0-13a3 3 0 1 0 .01 0M17 7a3 3 0 1 1-.01 0",
  files: "M4 4h6l2 3h8v13H4V4Z",
  term: "M4 5h16v14H4zM7 9l3 3-3 3m5 0h5",
  x: "M6 6l12 12M18 6 6 18",
  refresh: "M20 11a8 8 0 1 0-2.3 6.3M20 5v6h-6",
  copy: "M8 8h11v12H8zM5 16V4h11",
  check: "M5 13l4 4L19 7",
  gauge: "M5.6 18.4a9 9 0 1 1 12.8 0M12 13l3.5-3.5M12 13h.01",
  arrowUp: "M12 19V5m-6 6 6-6 6 6",
  stopFill: "M8 8h8v8H8z",
  shield: "M12 3l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V6l8-3z",
  shieldCheck: "M12 3l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V6l8-3zM8.5 12.2l2.4 2.4 4.6-4.8",
  zap: "M13 2L4 14h7l-1 8 9-12h-7l1-8z",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
};

const FILLED = new Set(["stopFill"]);
const BOLD = new Set(["arrowUp"]);

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  const d = PATHS[name];
  if (!d) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={FILLED.has(name) ? "currentColor" : "none"} stroke="currentColor"
      strokeWidth={BOLD.has(name) ? "2.2" : "1.6"} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
