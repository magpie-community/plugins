// Preview tab state per conversation (1.2): target URL, the proxy serving it, title, and a URL stack for back/forward
// when the page has no navigation bridge (the bridge, when present, drives back/forward inside the frame instead).
import { create } from "zustand";
import { checkPreviewUrl, displayOrigin } from "../../../daemon/src/preview/url.js";
import { t as tr } from "../i18n/index.js";

const t_noLocalhost = () => tr("preview.noLocalhost");

export type PreviewEntry = {
  /** normalized target URL currently shown */
  url: string;
  /** scheme://host:port of the target */
  origin: string;
  proxyOrigin: string | null;
  /** what the iframe loads (proxy origin + path); null until the proxy is up */
  proxyHref: string | null;
  title: string;
  loading: boolean;
  error: string | null;
  /** bumped to force the iframe to reload */
  nonce: number;
  /** the injected bridge has reported at least once */
  bridged: boolean;
  stack: string[];
  idx: number;
};

type Caller = (method: string, params?: unknown) => Promise<unknown>;

type PreviewStore = {
  byThread: Record<string, PreviewEntry>;
  /** Load a URL in this conversation's preview (push = a new history entry) */
  navigate(call: Caller, key: string, threadId: string | null, raw: string, opts?: { push?: boolean }): Promise<boolean>;
  /** The frame reported where it is now (bridge) */
  reported(key: string, url: string, title: string): void;
  /** The proxy for this entry was released: re-open it next time */
  detach(key: string): void;
  reload(key: string): void;
  step(key: string, delta: -1 | 1): string | null;
};

export const threadKey = (threadId: string | null | undefined) => threadId ?? "_";

const inflight = new Map<string, Promise<boolean>>();

// The proxy answers only at http://ac<key>.localhost:<port> (#582, daemon/src/preview/proxy.ts). Before showing the frame,
// check that this web view resolves that name (Chromium/WebView2 and WebKitGTK do, WebKit on macOS before 26 doesn't):
// otherwise say why instead of a blank "can't find server" frame. Checked with a per-open nonce so a hostile DNS answer
// that returns a plain 200 "ok" can't pass.
export const PREVIEW_PING_PATH = "/__agent_console__/ping";

/**
 * Apple WebKit before macOS 26 asks the system DNS for *.localhost (Magpie's Mac app on 12–15, Safari with magpie web).
 * Chromium / WebView2 / WebKitGTK resolve it to loopback themselves. Fail closed before preview.open so the key never
 * hits network DNS. Linux WebKitGTK / WPE UAs have AppleWebKit but no "Mac OS X" → treated as safe.
 */
export function isUnsafeLocalhostResolver(ua = typeof navigator !== "undefined" ? navigator.userAgent : ""): boolean {
  const appleWebKit = /AppleWebKit\//i.test(ua)
    && !/Chrome\//i.test(ua)
    && !/Chromium\//i.test(ua)
    && !/Edg(?:e|A|iOS)?\//i.test(ua)
    && !/OPR\//i.test(ua)
    && !/CriOS\//i.test(ua)
    && !/FxiOS\//i.test(ua);
  if (!appleWebKit) return false;
  const mac = ua.match(/Mac OS X (\d+)[._](\d+)/i);
  if (mac) return Number(mac[1]) < 26;
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return false;
}

/** GET origin+/__agent_console__/ping must return exactly expectedNonce (from preview.open over the authenticated WS). */
export async function canReachProxy(origin: string, expectedNonce: string, timeoutMs = 5000): Promise<boolean> {
  if (!expectedNonce) return false;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(origin + PREVIEW_PING_PATH, {
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: ac.signal,
    });
    if (!r.ok) return false;
    const text = await r.text();
    return text === expectedNonce;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

type PreviewOpenResult = {
  proxyOrigin: string;
  proxyHref: string;
  url: string;
  nonce: string;
  canaryOrigin: string;
  canaryNonce: string;
};

/**
 * Prove loopback resolution (keyless canary) then that the keyed host is our listener (nonce echo).
 * On any failure the caller must preview.release so a leaked key dies with the listener.
 */
export async function confirmPreviewReachable(r: PreviewOpenResult, timeoutMs = 5000): Promise<boolean> {
  // Canary first: the keyed name is never looked up if *.localhost goes to hostile DNS
  if (!(await canReachProxy(r.canaryOrigin, r.canaryNonce, timeoutMs))) return false;
  return canReachProxy(r.proxyOrigin, r.nonce, timeoutMs);
}

export const usePreview = create<PreviewStore>((set, get) => ({
  byThread: {},
  navigate: async (call, key, threadId, raw, opts) => {
    const c = checkPreviewUrl(raw);
    if (!c.ok) return false;
    const t = c.target;
    const prev = get().byThread[key];
    const sameProxy = prev && prev.origin === t.origin && prev.proxyOrigin;
    let stack = prev?.stack ?? [];
    let idx = prev?.idx ?? -1;
    if (opts?.push !== false) {
      if (stack[idx] !== t.href) {
        stack = [...stack.slice(0, idx + 1), t.href].slice(-50);
        idx = stack.length - 1;
      }
    } else if (!stack.length) {
      stack = [t.href];
      idx = 0;
    }
    if (sameProxy) {
      set((s) => ({ byThread: { ...s.byThread, [key]: { ...prev!, url: t.href, proxyHref: prev!.proxyOrigin + t.path, error: null, nonce: prev!.nonce + 1, stack, idx } } }));
      // remember it on the conversation
      if (threadId) void call("threads.update", { id: threadId, previewUrl: t.href }).catch(() => {});
      return true;
    }
    set((s) => ({
      byThread: {
        ...s.byThread,
        [key]: {
          url: t.href, origin: t.origin, proxyOrigin: null, proxyHref: null, title: prev?.origin === t.origin ? prev.title : "",
          loading: true, error: null, nonce: (prev?.nonce ?? 0) + 1, bridged: false, stack, idx,
        },
      },
    }));
    const flightKey = `${key}\n${t.href}`;
    let p = inflight.get(flightKey);
    if (!p) {
      p = (async () => {
        try {
          // Fail closed before preview.open on engines that send *.localhost to network DNS (#582)
          if (isUnsafeLocalhostResolver()) throw new Error(t_noLocalhost());
          const r = (await call("preview.open", { url: t.href, ...(threadId ? { threadId } : {}) })) as PreviewOpenResult;
          if (!(await confirmPreviewReachable(r))) {
            void call("preview.release", { url: t.origin }).catch(() => {});
            throw new Error(t_noLocalhost());
          }
          set((s) => {
            const cur = s.byThread[key];
            if (!cur || cur.url !== t.href) return s;
            return { byThread: { ...s.byThread, [key]: { ...cur, proxyOrigin: r.proxyOrigin, proxyHref: r.proxyHref, loading: false, error: null } } };
          });
          return true;
        } catch (e) {
          const msg = String((e as Error)?.message ?? e);
          set((s) => {
            const cur = s.byThread[key];
            if (!cur || cur.url !== t.href) return s;
            return { byThread: { ...s.byThread, [key]: { ...cur, loading: false, error: msg } } };
          });
          return false;
        } finally {
          inflight.delete(flightKey);
        }
      })();
      inflight.set(flightKey, p);
    }
    return p;
  },
  reported: (key, url, title) => {
    set((s) => {
      const cur = s.byThread[key];
      if (!cur) return s;
      let { stack, idx } = cur;
      if (stack[idx] !== url) {
        // in-page navigation: keep our fallback stack in step
        if (stack[idx - 1] === url) idx -= 1;
        else if (stack[idx + 1] === url) idx += 1;
        else { stack = [...stack.slice(0, idx + 1), url].slice(-50); idx = stack.length - 1; }
      }
      return { byThread: { ...s.byThread, [key]: { ...cur, url, title, bridged: true, stack, idx } } };
    });
  },
  detach: (key) => {
    set((s) => {
      const cur = s.byThread[key];
      if (!cur) return s;
      return { byThread: { ...s.byThread, [key]: { ...cur, proxyOrigin: null, proxyHref: null, bridged: false } } };
    });
  },
  reload: (key) => {
    set((s) => {
      const cur = s.byThread[key];
      if (!cur) return s;
      return { byThread: { ...s.byThread, [key]: { ...cur, nonce: cur.nonce + 1, error: null } } };
    });
  },
  step: (key, delta) => {
    const cur = get().byThread[key];
    if (!cur) return null;
    const idx = cur.idx + delta;
    if (idx < 0 || idx >= cur.stack.length) return null;
    set((s) => ({ byThread: { ...s.byThread, [key]: { ...cur, idx } } }));
    return cur.stack[idx]!;
  },
}));

/** Address-bar text for a target URL (default ports hidden, like a browser) */
export function addressText(url: string): string {
  const c = checkPreviewUrl(url);
  if (!c.ok) return url;
  return displayOrigin(c.target.origin) + c.target.path;
}
