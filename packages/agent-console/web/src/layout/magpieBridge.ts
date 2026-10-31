// Live theme from Magpie (1.2 fix). The plugin page (page/boot.js) navigates its frame to the daemon page, so Magpie's
// bridge.js is gone from the frame; but Magpie's window keeps posting {magpie:1, event:"theme", data:{dark, lang, tokens}}
// to the frame's window, and answers a {magpie:1, method:"hello"} call with the current theme. This page speaks that small
// part of the bridge protocol itself: at load (the theme may have changed during the redirect, or after a self-heal) and on
// every switch, so the page follows Magpie's light/dark and neutral colours without a reload.
// Only messages from window.parent with magpie:1 are read, and only the theme fields (and the language) are used; no commands are taken.
import { applyMagpieTokens } from "./applyMagpieTokens.js";
import { setHostTheme } from "./theme.js";

export type MagpieTheme = { dark: boolean; tokens: Record<string, unknown>; lang?: string };

/** A theme payload from Magpie (event data, or a hello answer) → {dark, tokens}, or null if it isn't one */
export function parseMagpieTheme(d: unknown): MagpieTheme | null {
  if (!d || typeof d !== "object") return null;
  const o = d as { dark?: unknown; tokens?: unknown; lang?: unknown };
  if (typeof o.dark !== "boolean") return null;
  const tokens = o.tokens && typeof o.tokens === "object" && !Array.isArray(o.tokens) ? (o.tokens as Record<string, unknown>) : {};
  const out: MagpieTheme = { dark: o.dark, tokens };
  if (typeof o.lang === "string" && o.lang.length <= 32) out.lang = o.lang;
  return out;
}

/** Which theme a bridge message carries, given the id of our own hello call */
export function themeFromMessage(m: unknown, helloId: number): MagpieTheme | null {
  if (!m || typeof m !== "object") return null;
  const msg = m as { magpie?: unknown; event?: unknown; data?: unknown; id?: unknown; result?: unknown };
  if (msg.magpie !== 1) return null;
  if (msg.event === "theme") return parseMagpieTheme(msg.data);
  if (msg.id === helloId && msg.result) return parseMagpieTheme(msg.result);
  return null;
}

let started = false;

export function startMagpieThemeBridge(onTheme?: (t: MagpieTheme) => void): void {
  if (started || typeof window === "undefined") return;
  const parentWin = window.parent;
  if (!parentWin || parentWin === window) return;
  started = true;
  // a large id of our own, far from what bridge.js used before the navigation
  const helloId = 1_000_000 + Math.floor(Math.random() * 1_000_000);
  window.addEventListener("message", (e) => {
    if (e.source !== parentWin) return;
    const t = themeFromMessage(e.data, helloId);
    if (!t) return;
    applyMagpieTokens(t.tokens);
    setHostTheme(t.dark ? "dark" : "light");
    onTheme?.(t);
  });
  try {
    parentWin.postMessage({ magpie: 1, id: helloId, method: "hello" }, "*");
  } catch {}
}
