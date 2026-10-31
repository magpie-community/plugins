// Preview tab state per conversation (1.2): target URL, the proxy serving it, title, and a URL stack for back/forward
// when the page has no navigation bridge (the bridge, when present, drives back/forward inside the frame instead).
import { create } from "zustand";
import { checkPreviewUrl, displayOrigin } from "../../../daemon/src/preview/url.js";

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
          const r = (await call("preview.open", { url: t.href, ...(threadId ? { threadId } : {}) })) as { proxyOrigin: string; proxyHref: string; url: string };
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
