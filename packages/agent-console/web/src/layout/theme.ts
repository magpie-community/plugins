// Theme (B4). The saved setting: "auto" = follow the host (Magpie's light/dark when the page runs inside Magpie, the OS otherwise),
// "light" / "dark" = always that one, even inside Magpie. Magpie's injected colors (--magpie-bg/fg/…) only apply while the page
// shows the same light/dark as Magpie (data-host-colors); otherwise our own palette is used. Magpie's font always applies.
export type ThemeSetting = "auto" | "light" | "dark";
export type Theme = "light" | "dark";

let hostTheme: Theme | null = null;
let current: ThemeSetting = "auto";
let mq: MediaQueryList | null = null;

function osTheme(): Theme {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function normalizeThemeSetting(v: unknown): ThemeSetting {
  return v === "light" || v === "dark" ? v : "auto";
}

/** What the page shows for a setting, given the host's theme (null outside Magpie) and the OS's */
export function resolveTheme(setting: ThemeSetting, host: Theme | null, os: Theme): { theme: Theme; hostColors: boolean } {
  const theme = setting === "light" || setting === "dark" ? setting : host ?? os;
  return { theme, hostColors: host !== null && theme === host };
}

/** Startup: ?theme= is Magpie's light/dark (boot.js passes it). Shows the host theme until the saved setting arrives. */
export function initTheme(search: string): void {
  const p = new URLSearchParams(search).get("theme");
  hostTheme = p === "light" || p === "dark" ? p : null;
  applyTheme("auto");
  if (typeof window !== "undefined" && window.matchMedia) {
    mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener?.("change", () => applyTheme(current));
  }
}

/** Inside Magpie (it passed its theme): the "auto" option reads "Follow Magpie" */
export function embeddedInMagpie(): boolean {
  return hostTheme !== null;
}

export function applyTheme(setting: unknown): void {
  current = normalizeThemeSetting(setting);
  const { theme, hostColors } = resolveTheme(current, hostTheme, osTheme());
  const root = document.documentElement;
  root.dataset.theme = theme;
  if (hostColors) root.dataset.hostColors = "1";
  else delete root.dataset.hostColors;
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}
