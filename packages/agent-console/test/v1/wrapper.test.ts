// 1.3 item 5: the gate's wrapper page (lib/wrapper.mjs) that keeps the plugin frame on the stable gate port
import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { freePort, request } from "./helpers-net.js";

const root = resolve(__dirname, "..", "..");
const gateUrl = pathToFileURL(join(root, "lib", "gate.mjs")).href;
const wrapperUrl = pathToFileURL(join(root, "lib", "wrapper.mjs")).href;

type Msg = { source: unknown; data: unknown };

/** Runs the wrapper's script against a tiny fake DOM with a controllable clock */
async function runWrapper(
  hash: string,
  search = "",
  opts: { visible?: boolean; sessionStorage?: Record<string, string>; framed?: boolean; ua?: string } = {},
) {
  const { wrapperHtml, WRAP_TIMING } = await import(/* @vite-ignore */ wrapperUrl);
  const html: string = wrapperHtml("n0nce", WRAP_TIMING);
  const script = html.split('<script nonce="n0nce">')[1]!.split("</script>")[0]!;
  let now = 1_800_000_000_000;
  const intervals: (() => void)[] = [];
  const childWin = { posted: [] as unknown[], postMessage(d: unknown) { this.posted.push(d); } };
  const parentWin = { posted: [] as unknown[], postMessage(d: unknown) { this.posted.push(d); } };
  const el = (id: string) => ({ id, hidden: id !== "f", textContent: "", src: "", disabled: false, onclick: null as null | (() => void),
    classList: { set: new Set<string>(), add(c: string) { this.set.add(c); }, remove(c: string) { this.set.delete(c); } },
    on: {} as Record<string, () => void>, addEventListener(t: string, fn: () => void) { this.on[t] = fn; } });
  const els: Record<string, ReturnType<typeof el>> = { f: el("f"), m: el("m"), s: el("s"), r: el("r") };
  (els.f as unknown as { contentWindow: unknown }).contentWindow = childWin;
  let onMessage: (e: Msg) => void = () => {};
  const winOn: Record<string, (() => void)[]> = {};
  const docOn: Record<string, (() => void)[]> = {};
  const loc = {
    hash, search, replaced: null as string | null, reloaded: 0,
    replace(u: string) { this.replaced = u; },
    reload() { this.reloaded++; },
  };
  const store = new Map<string, string>(Object.entries(opts.sessionStorage ?? {}));
  const sessionStorage = {
    getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
    setItem(k: string, v: string) { store.set(k, String(v)); },
    removeItem(k: string) { store.delete(k); },
    clear() { store.clear(); },
  };
  const win: Record<string, unknown> = {
    parent: parentWin,
    addEventListener: (t: string, fn: (e: Msg) => void) => {
      if (t === "message") onMessage = fn;
      else (winOn[t] ??= []).push(fn as unknown as () => void);
    },
  };
  // Magpie hosts the wrapper in an iframe (parent !== window). Top-level /app uses framed: false.
  if (opts.framed === false) win.parent = win;
  const doc = {
    getElementById: (id: string) => els[id], documentElement: { className: "" },
    visibilityState: opts.visible === false ? "hidden" : "visible",
    addEventListener: (t: string, fn: () => void) => { (docOn[t] ??= []).push(fn); },
  };
  const DateFake = { now: () => now };
  type TO = { at: number; fn: () => void };
  const timeouts: TO[] = [];
  const setTimeoutFake = (f: () => void, ms = 0) => { timeouts.push({ at: now + ms, fn: f }); return timeouts.length; };
  const flushTimeouts = () => {
    let ran = true;
    while (ran) {
      ran = false;
      for (let i = timeouts.length - 1; i >= 0; i--) {
        if (timeouts[i]!.at <= now) {
          const t = timeouts.splice(i, 1)[0]!;
          t.fn();
          ran = true;
        }
      }
    }
  };
  const fn = new Function("window", "document", "location", "setInterval", "setTimeout", "Date", "URL", "URLSearchParams", "sessionStorage", "navigator", script);
  fn(win, doc, loc, (f: () => void) => { intervals.push(f); return 1; }, setTimeoutFake, DateFake, URL, URLSearchParams, sessionStorage, { userAgent: opts.ua ?? "X11; Linux x86_64" });
  const tick = (ms: number, step = 1000) => { for (let t = 0; t < ms; t += step) { now += step; intervals.forEach((f) => f()); flushTimeouts(); } };
  return {
    els, loc, childWin, parentWin, tick, doc, store, flushTimeouts,
    fromChild: (data: unknown) => onMessage({ source: childWin, data }),
    fromParent: (data: unknown) => onMessage({ source: parentWin, data }),
    fromOther: (data: unknown) => onMessage({ source: {}, data }),
    jump: (ms: number) => { now += ms; flushTimeouts(); },
    hide: () => { doc.visibilityState = "hidden"; (docOn.visibilitychange ?? []).forEach((f) => f()); },
    show: () => { doc.visibilityState = "visible"; (docOn.visibilitychange ?? []).forEach((f) => f()); },
    focus: () => { (winOn.focus ?? []).forEach((f) => f()); },
    now: () => now,
  };
}

const TOKEN = "a".repeat(64);
const BACK = "http://127.0.0.1:5000/_magpie/plugin/abc123/page/index.html?x=1";
const hash = (o: Record<string, string>) => "#" + new URLSearchParams(o).toString();

describe("gate /app", () => {
  it("serves the wrapper with a fresh nonce CSP; Host and Origin checks still apply; no secrets in it", async () => {
    const { createGate } = await import(/* @vite-ignore */ gateUrl);
    const port = await freePort();
    const key = "c".repeat(64);
    const gate = createGate({ port, key, token: TOKEN, ensureDaemon: async () => ({ port: 4999 }) });
    await gate.listen();
    try {
      const a = await request(port, "/app");
      const b = await request(port, "/app?theme=dark");
      expect(a.status).toBe(200);
      expect(a.headers["content-type"]).toContain("text/html");
      const csp = String(a.headers["content-security-policy"]);
      expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-src http://127.0.0.1:*");
      // only loopback pages and Magpie's own window (wails://localhost, http://wails.localhost) may frame /app
      expect(csp).toContain("frame-ancestors 'self' http://127.0.0.1:* http://localhost:* http://[::1]:* http://wails.localhost:* wails:");
      expect(csp).not.toMatch(/frame-ancestors[^;]*\s(\*|https:|http:)(\s|;|$)/); // never "any site"
      expect(csp).not.toBe(String(b.headers["content-security-policy"]));
      expect(a.headers["cache-control"]).toBe("no-store");
      expect(a.body).not.toContain(TOKEN);
      expect(a.body).not.toContain(key);
      expect((await request(port, "/app", { host: `evil.example:${port}` })).status).toBe(421);
      expect((await request(port, "/app", { origin: "null" })).status).toBe(403);
      // ac_try is forwarded to the wrapper only in its exact shape
      const ok = await request(port, `/open?k=${key}&ac_try=1800000000000.2`);
      expect(new URL(String(ok.headers.location)).searchParams.get("ac_try")).toBe("1800000000000.2");
      const bad = await request(port, `/open?k=${key}&ac_try=${encodeURIComponent("1.2<script>")}`);
      expect(new URL(String(bad.headers.location)).searchParams.has("ac_try")).toBe(false);
    } finally {
      await gate.close();
    }
  });
});

describe("wrapper page", () => {
  it("frames the daemon on 127.0.0.1:<p> with the token in the fragment and w=1; shows it on the first alive", async () => {
    const w = await runWrapper(hash({ t: TOKEN, p: "4321", b: BACK }), "?theme=dark&lang=en&ac_try=1.1");
    expect(w.els.f!.src).toBe(`http://127.0.0.1:4321/?theme=dark&lang=en#t=${TOKEN}&w=1`);
    expect(w.doc.documentElement.className).toBe("dark");
    expect(w.els.f!.classList.set.has("on")).toBe(false);
    w.fromOther({ ac_console: "alive" }); // not from the child: ignored
    expect(w.els.f!.classList.set.has("on")).toBe(false);
    w.fromChild({ ac_console: "alive" });
    expect(w.els.f!.classList.set.has("on")).toBe(true);
    expect(w.els.m!.hidden).toBe(true);
  });

  it("refuses a bad token or port, and never follows a non-Magpie back URL", async () => {
    const w1 = await runWrapper(hash({ t: "x", p: "4321", b: BACK }));
    expect(w1.els.f!.src).toBe("");
    expect(w1.els.r!.hidden).toBe(false);
    expect(w1.els.r!.textContent).toBe("重新连接");
    w1.els.r!.onclick!();
    // valid #b= was stored before the early return, so Reconnect walks back through Magpie
    expect(w1.loc.replaced).toBe(BACK);
    expect(w1.loc.reloaded).toBe(0);

    const w2 = await runWrapper(hash({ t: TOKEN, p: "99999", b: BACK }), "?lang=en");
    expect(w2.els.f!.src).toBe("");
    expect(w2.els.r!.textContent).toBe("Reconnect");
    expect(w2.els.s!.textContent).toContain("Click Reconnect");

    const w3 = await runWrapper(hash({ t: TOKEN, p: "4321", b: "https://evil.example/_magpie/plugin/a/index.html" }), "", { framed: false });
    expect(w3.store.has("ac_wrap_back")).toBe(false);
    w3.fromChild({ ac_console: "lost", at: 5 });
    expect(w3.loc.replaced).toBeNull();
    expect(w3.els.m!.hidden).toBe(false);
    expect(w3.els.r!.hidden).toBe(false);
    w3.els.r!.onclick!();
    expect(w3.loc.reloaded).toBe(1);
  });

  it("a reload onto a dead daemon (no alive within 12 s) goes back through the Magpie page", async () => {
    const w = await runWrapper(hash({ t: TOKEN, p: "4321", b: BACK }));
    w.tick(11000);
    expect(w.loc.replaced).toBeNull();
    w.tick(2000);
    const u = new URL(w.loc.replaced!);
    expect(u.origin + u.pathname).toBe("http://127.0.0.1:5000/_magpie/plugin/abc123/page/index.html");
    expect(u.searchParams.get("x")).toBe("1");
    expect(u.searchParams.has("ac_lost")).toBe(false);
    expect(u.searchParams.get("ac_try")).toMatch(/^\d+\.1$/);
    expect(w.loc.replaced).not.toContain(TOKEN);
  });

  it("once the child frame has loaded (e.g. the browser's error page), it gets 6 s", async () => {
    const w = await runWrapper(hash({ t: TOKEN, p: "4321", b: BACK }));
    w.tick(1000);
    w.els.f!.on.load!();
    w.tick(5000);
    expect(w.loc.replaced).toBeNull();
    w.tick(2000);
    expect(w.loc.replaced).not.toBeNull();
  });

  it("'lost' from the child goes back with ac_lost; 15 s of silence too", async () => {
    const w = await runWrapper(hash({ t: TOKEN, p: "4321", b: BACK }));
    w.fromChild({ ac_console: "alive" });
    w.fromChild({ ac_console: "lost", at: 1234567890123 });
    expect(new URL(w.loc.replaced!).searchParams.get("ac_lost")).toBe("1234567890123");

    const s = await runWrapper(hash({ t: TOKEN, p: "4321", b: BACK }));
    s.fromChild({ ac_console: "alive" });
    for (let i = 0; i < 10; i++) { s.tick(2000); s.fromChild({ ac_console: "alive" }); }
    expect(s.loc.replaced).toBeNull();
    s.tick(17000);
    expect(s.loc.replaced).not.toBeNull();
  });

  it("time this page was suspended (sleep) or hidden does not count as silence", async () => {
    const w = await runWrapper(hash({ t: TOKEN, p: "4321", b: BACK }));
    w.fromChild({ ac_console: "alive" });
    w.jump(3_600_000); // an hour asleep: the next tick sees a big gap
    w.tick(1000);
    w.tick(10000);
    expect(w.loc.replaced).toBeNull();
    const h = await runWrapper(hash({ t: TOKEN, p: "4321", b: BACK }), "", { visible: false });
    h.tick(60000);
    expect(h.loc.replaced).toBeNull();
  });

  it("at most 3 automatic tries in 2 minutes, then a button", async () => {
    const start = 1_800_000_000_000 - 30_000;
    const w = await runWrapper(hash({ t: TOKEN, p: "4321", b: BACK }), `?ac_try=${start}.3`);
    w.fromChild({ ac_console: "lost", at: 1 });
    expect(w.loc.replaced).toBeNull();
    expect(w.els.r!.hidden).toBe(false);
    w.els.r!.onclick!();
    expect(new URL(w.loc.replaced!).searchParams.has("ac_try")).toBe(false);
    // an old counter (more than 2 minutes ago) starts over
    const old = await runWrapper(hash({ t: TOKEN, p: "4321", b: BACK }), `?ac_try=${start - 200_000}.3`);
    old.fromChild({ ac_console: "lost", at: 1 });
    expect(new URL(old.loc.replaced!).searchParams.get("ac_try")).toBe(`${old.now()}.1`);
  });

  it("remembers a safe #b= in sessionStorage and reuses it when the hash has none", async () => {
    const first = await runWrapper(hash({ t: TOKEN, p: "4321", b: BACK }));
    expect(first.store.get("ac_wrap_back")).toBe(BACK);

    const w = await runWrapper(hash({ t: TOKEN, p: "4321" }), "", { sessionStorage: { ac_wrap_back: BACK } });
    w.fromChild({ ac_console: "lost", at: 99 });
    const u = new URL(w.loc.replaced!);
    expect(u.origin + u.pathname).toBe("http://127.0.0.1:5000/_magpie/plugin/abc123/page/index.html");
    expect(u.searchParams.get("ac_lost")).toBe("99");
    expect(u.searchParams.has("ac_try")).toBe(false); // go(false): not an automatic try
    expect(w.loc.replaced).not.toContain(TOKEN);
  });

  it("ignores an unsafe sessionStorage back and still offers Reconnect via reload", async () => {
    const evil = "https://evil.example/_magpie/plugin/a/index.html";
    const w = await runWrapper(hash({ t: TOKEN, p: "4321" }), "?lang=en", { sessionStorage: { ac_wrap_back: evil }, framed: false });
    w.fromChild({ ac_console: "lost", at: 1 });
    expect(w.loc.replaced).toBeNull();
    expect(w.els.r!.hidden).toBe(false);
    expect(w.els.r!.textContent).toBe("Reconnect");
    expect(w.els.s!.textContent).toMatch(/Click Reconnect/);
    expect(w.els.s!.textContent).toMatch(/Plugins page/);
    expect(w.els.s!.textContent).not.toMatch(/top-bar/);
    w.els.r!.onclick!();
    expect(w.loc.reloaded).toBe(1);
  });

  it("with no back at all (top-level), Reconnect reloads and the copy points at Magpie Plugins", async () => {
    const w = await runWrapper(hash({ t: TOKEN, p: "4321" }), "", { framed: false });
    w.fromChild({ ac_console: "lost", at: 1 });
    expect(w.loc.replaced).toBeNull();
    expect(w.els.r!.hidden).toBe(false);
    expect(w.els.r!.textContent).toBe("重新连接");
    expect(w.els.s!.textContent).toContain("重新连接");
    expect(w.els.s!.textContent).toContain("Agent 控制台");
    expect(w.els.s!.textContent).toContain("插件");
    expect(w.els.s!.textContent).not.toContain("顶栏");
    expect(w.parentWin.posted).toEqual([]);
    w.els.r!.onclick!();
    expect(w.loc.reloaded).toBe(1);
  });

  it("with no back in a Magpie iframe, auto-notifies the parent with method error and Reconnect does too", async () => {
    const w = await runWrapper(hash({ t: TOKEN, p: "4321" }));
    w.fromChild({ ac_console: "lost", at: 1 });
    expect(w.loc.replaced).toBeNull();
    expect(w.els.r!.hidden).toBe(false);
    expect(w.parentWin.posted).toEqual([
      { magpie: 1, method: "error", params: { message: "本地服务已断开" } },
    ]);
    w.parentWin.posted.length = 0;
    w.els.r!.onclick!();
    expect(w.parentWin.posted).toEqual([
      { magpie: 1, method: "error", params: { message: "本地服务已断开" } },
    ]);
    expect(w.loc.reloaded).toBe(0);
    w.tick(300);
    expect(w.loc.reloaded).toBe(1);
  });

  // 1.3.5 / 1.3.6 followed http://wails.localhost/… on Windows: WebView2 can't load it from this frame (on 127.0.0.1, an
  // out-of-process iframe Wails' request filter doesn't see), which left its gray error page. Now it is never a target.
  it("Windows wails.localhost #b= is not taken: on loss it asks Magpie for Try again and never navigates", async () => {
    const WAILS = "http://wails.localhost/_magpie/plugin/abc123/index.html";
    const w = await runWrapper(hash({ t: TOKEN, p: "4321", b: WAILS }), "", { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/146.0" });
    expect(w.store.has("ac_wrap_back")).toBe(false);
    w.fromChild({ ac_console: "lost", at: 42 });
    expect(w.loc.replaced).toBeNull();
    expect(w.parentWin.posted).toEqual([{ magpie: 1, method: "error", params: { message: "本地服务已断开" } }]);
    // the 12 s boot timeout / 15 s silence path is the same
    const w2 = await runWrapper(hash({ t: TOKEN, p: "4321", b: WAILS }), "?lang=en", { ua: "Windows NT 10.0" });
    w2.tick(20_000);
    expect(w2.loc.replaced).toBeNull();
    expect(w2.parentWin.posted).toEqual([{ magpie: 1, method: "error", params: { message: "Local service disconnected" } }]);
  });

  it("Windows wails.localhost: Reconnect, also after max auto tries, asks Magpie and never replaces to it", async () => {
    const WAILS = "http://wails.localhost/_magpie/plugin/tok/page/index.html";
    const start = 1_800_000_000_000 - 30_000;
    const w = await runWrapper(hash({ t: TOKEN, p: "4321", b: WAILS }), `?ac_try=${start}.3`, { ua: "Windows NT 10.0" });
    w.fromChild({ ac_console: "lost", at: 1 });
    expect(w.loc.replaced).toBeNull();
    w.parentWin.posted.length = 0;
    w.els.r!.onclick!();
    expect(w.loc.replaced).toBeNull();
    expect(w.parentWin.posted).toEqual([{ magpie: 1, method: "error", params: { message: "本地服务已断开" } }]);
  });

  it("a stale http://wails.localhost back in sessionStorage (left by 1.3.5 / 1.3.6) is dropped and never followed", async () => {
    const STALE = "http://wails.localhost/_magpie/plugin/oldtok/page/index.html";
    for (const ua of ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Macintosh", "X11; Linux x86_64"]) {
      const w = await runWrapper(hash({ t: TOKEN, p: "4321" }), "", { ua, sessionStorage: { ac_wrap_back: STALE } });
      w.fromChild({ ac_console: "lost", at: 7 });
      expect(w.loc.replaced, ua).toBeNull();
      expect(w.store.has("ac_wrap_back"), ua).toBe(false);
      expect(w.parentWin.posted, ua).toEqual([{ magpie: 1, method: "error", params: { message: "本地服务已断开" } }]);
      w.parentWin.posted.length = 0;
      w.els.r!.onclick!();
      expect(w.loc.replaced, ua).toBeNull();
      expect(w.parentWin.posted, ua).toEqual([{ magpie: 1, method: "error", params: { message: "本地服务已断开" } }]);
    }
    // invalid link + stale stored back: same, Magpie's card right away
    const bad = await runWrapper(hash({ t: "nope", p: "1" }), "", { ua: "Windows NT 10.0", sessionStorage: { ac_wrap_back: STALE } });
    expect(bad.loc.replaced).toBeNull();
    expect(bad.store.has("ac_wrap_back")).toBe(false);
    expect(bad.parentWin.posted).toEqual([{ magpie: 1, method: "error", params: { message: "链接已失效" } }]);
    // a stale wails back never shadows a fresh loopback #b= (magpie web)
    const web = await runWrapper(hash({ t: TOKEN, p: "4321", b: BACK }), "", { ua: "Windows NT 10.0", sessionStorage: { ac_wrap_back: STALE } });
    expect(web.store.get("ac_wrap_back")).toBe(BACK);
    web.fromChild({ ac_console: "lost", at: 7 });
    expect(new URL(web.loc.replaced!).origin).toBe("http://127.0.0.1:5000");
  });

  it.each([
    ["http://wails.localhost/_magpie/plugin/a/index.html", "Windows NT 10.0"],
    ["http://wails.localhost/_magpie/plugin/a/page/index.html", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"],
    ["wails://localhost/_magpie/plugin/a/page/index.html", "Macintosh"],
    ["https://wails.localhost/_magpie/plugin/a/page/index.html", "Windows NT 10.0"],
    ["http://wails.localhost:8080/_magpie/plugin/a/index.html", "Windows NT 10.0"],
    ["http://wails.localhost/_magpie/plugin/a/index.html", "Macintosh"],
    ["http://wails.localhost/_magpie/plugin/a/index.html", "X11; Linux"],
    ["http://evil-wails.localhost/_magpie/plugin/a/index.html", "Windows NT 10.0"],
    ["http://wails.localhost.evil.com/_magpie/plugin/a/index.html", "Windows NT 10.0"],
  ])("rejects unsafe Wails back %s (%s), from hash and storage", async (back, ua) => {
    const w = await runWrapper(hash({ t: TOKEN, p: "4321", b: back }), "", {
      ua, framed: false, sessionStorage: { ac_wrap_back: back },
    });
    w.fromChild({ ac_console: "lost", at: 42 });
    expect(w.loc.replaced).toBeNull();
    w.els.r!.onclick!();
    expect(w.loc.replaced).toBeNull();
    expect(w.loc.reloaded).toBe(1);
  });

  it("an invalid link with only a stored back still Reconnects through Magpie", async () => {
    const w = await runWrapper(hash({ t: "nope", p: "1" }), "", { sessionStorage: { ac_wrap_back: BACK } });
    expect(w.els.f!.src).toBe("");
    expect(w.els.r!.hidden).toBe(false);
    w.els.r!.onclick!();
    expect(w.loc.replaced).toBe(BACK);
    expect(w.loc.reloaded).toBe(0);
  });

  it("coming back visible after a long hidden spell: a child that answers is left alone", async () => {
    const w = await runWrapper(hash({ t: TOKEN, p: "4321", b: BACK }));
    w.fromChild({ ac_console: "alive" });
    w.hide();
    w.tick(600_000, 60_000); // ten minutes hidden, heartbeats throttled away
    w.show();
    w.tick(2000);
    w.fromChild({ ac_console: "alive" }); // next heartbeat after unthrottling
    w.tick(10_000, 2000);
    w.fromChild({ ac_console: "alive" });
    w.tick(2000);
    expect(w.loc.replaced).toBeNull();
    expect(w.loc.reloaded).toBe(0);
    // focus while it's fresh does nothing either
    w.focus();
    w.tick(5000);
    w.fromChild({ ac_console: "alive" });
    w.tick(5000);
    expect(w.loc.replaced).toBeNull();
  });

  it("coming back visible with a silent child recovers within the probe window, not after silentMs", async () => {
    const w = await runWrapper(hash({ t: TOKEN, p: "4321", b: BACK }));
    w.fromChild({ ac_console: "alive" });
    const heard = w.now();
    w.hide();
    w.tick(600_000, 60_000);
    w.show();
    w.tick(3000);
    expect(w.loc.replaced).toBeNull(); // still giving it its heartbeat
    w.tick(1000);
    const u = new URL(w.loc.replaced!);
    expect(u.searchParams.get("ac_lost")).toBe(String(heard));
    expect(u.searchParams.get("ac_try")).toMatch(/^\d+\.1$/);
    expect(w.loc.replaced).not.toContain(TOKEN);
  });

  it("window focus after sleep (timers suspended) also checks at once", async () => {
    const w = await runWrapper(hash({ t: TOKEN, p: "4321", b: BACK }));
    w.fromChild({ ac_console: "alive" });
    w.jump(3_600_000); // asleep: no ticks, no heartbeats
    w.focus();
    w.tick(1000); // the big gap bumps lastAlive; the probe still runs from the real heardAt
    w.tick(3000);
    expect(w.loc.replaced).not.toBeNull();
  });

  it("never alive: loaded hidden and shown after bootMs recovers within the probe window", async () => {
    const w = await runWrapper(hash({ t: TOKEN, p: "4321", b: BACK }), "", { visible: false });
    w.tick(60_000);
    expect(w.loc.replaced).toBeNull();
    w.show();
    w.tick(4000);
    const u = new URL(w.loc.replaced!);
    expect(u.searchParams.has("ac_lost")).toBe(false);
    expect(u.searchParams.get("ac_try")).toMatch(/^\d+\.1$/);
    // shown before bootMs: no early probe, the normal 12 s boot window applies
    const e = await runWrapper(hash({ t: TOKEN, p: "4321", b: BACK }), "", { visible: false });
    e.tick(3000);
    e.show();
    e.tick(5000);
    expect(e.loc.replaced).toBeNull();
    e.fromChild({ ac_console: "alive" });
    e.tick(5000);
    expect(e.loc.replaced).toBeNull();
  });

  it("a probe is dropped if the page hides again before it ends", async () => {
    const w = await runWrapper(hash({ t: TOKEN, p: "4321", b: BACK }));
    w.fromChild({ ac_console: "alive" });
    w.hide();
    w.tick(120_000, 60_000);
    w.show();
    w.tick(2000);
    w.hide();
    w.tick(60_000);
    expect(w.loc.replaced).toBeNull();
  });

  it("auto tries used up: coming back counts as clicking Reconnect (once)", async () => {
    const start = 1_800_000_000_000 - 30_000;
    const w = await runWrapper(hash({ t: TOKEN, p: "4321", b: BACK }), `?ac_try=${start}.3`);
    w.fromChild({ ac_console: "lost", at: 1 });
    expect(w.loc.replaced).toBeNull();
    expect(w.els.r!.hidden).toBe(false);
    w.hide();
    w.show();
    const u = new URL(w.loc.replaced!);
    expect(u.origin + u.pathname).toBe("http://127.0.0.1:5000/_magpie/plugin/abc123/page/index.html");
    expect(u.searchParams.has("ac_try")).toBe(false); // go(false), like the button
    expect(w.els.r!.disabled).toBe(true);
    w.loc.replaced = null;
    w.focus();
    w.els.r!.onclick!();
    expect(w.loc.replaced).toBeNull(); // already on its way: not twice
  });

  it("no back at all (top-level): coming back to the end state reloads like the button", async () => {
    const w = await runWrapper(hash({ t: TOKEN, p: "4321" }), "", { framed: false });
    w.fromChild({ ac_console: "lost", at: 1 });
    expect(w.loc.reloaded).toBe(0);
    w.focus();
    expect(w.loc.reloaded).toBe(1);
    expect(w.loc.replaced).toBeNull();
    w.show();
    expect(w.loc.reloaded).toBe(1);
  });

  it("no back in Magpie iframe: coming back re-asks the parent (then reload fallback)", async () => {
    const w = await runWrapper(hash({ t: TOKEN, p: "4321" }));
    w.fromChild({ ac_console: "lost", at: 1 });
    w.parentWin.posted.length = 0;
    w.focus();
    expect(w.parentWin.posted).toEqual([
      { magpie: 1, method: "error", params: { message: "本地服务已断开" } },
    ]);
    expect(w.loc.reloaded).toBe(0);
    w.tick(300);
    expect(w.loc.reloaded).toBe(1);
  });

  it("invalid link: coming back runs Reconnect through the stored back; unsafe stored back is never followed", async () => {
    const w = await runWrapper(hash({ t: "nope", p: "1" }), "", { sessionStorage: { ac_wrap_back: BACK } });
    w.show();
    expect(w.loc.replaced).toBe(BACK);
    const evil = await runWrapper(hash({ t: "nope", p: "1", b: "https://evil.example/_magpie/plugin/a/index.html" }), "",
      { sessionStorage: { ac_wrap_back: "http://evil.example/_magpie/plugin/a/index.html" }, framed: false });
    evil.focus();
    expect(evil.loc.replaced).toBeNull();
    expect(evil.loc.reloaded).toBe(1);
  });

  it("hidden page: focus/visibility events while hidden do nothing", async () => {
    const w = await runWrapper(hash({ t: TOKEN, p: "4321", b: BACK }), "", { visible: false });
    w.tick(60_000);
    w.focus();
    w.tick(10_000);
    expect(w.loc.replaced).toBeNull();
  });

  it("relays only the Magpie theme protocol", async () => {
    const w = await runWrapper(hash({ t: TOKEN, p: "4321", b: BACK }));
    w.fromChild({ magpie: 1, id: 7, method: "hello", extra: "x" });
    w.fromChild({ magpie: 1, id: 8, method: "openExternal", params: { url: "https://evil" } });
    expect(w.parentWin.posted).toEqual([{ magpie: 1, id: 7, method: "hello" }]);
    w.fromParent({ magpie: 1, event: "theme", data: { dark: true }, other: 1 });
    w.fromParent({ magpie: 1, id: 7, result: { dark: false } });
    w.fromParent({ magpie: 1, method: "something" });
    w.fromParent({ ac_console: "lost" }); // only the child can report
    expect(w.childWin.posted).toEqual([{ magpie: 1, event: "theme", data: { dark: true } }, { magpie: 1, id: 7, result: { dark: false } }]);
    expect(w.loc.replaced).toBeNull();
  });
});

describe("daemon page side", () => {
  it("isWrapped needs w=1 and a parent; heartbeat only while connected", async () => {
    const m = await import("../../web/src/api/backToMagpie.js");
    const posted: unknown[] = [];
    const g = globalThis as unknown as { window?: unknown };
    const prev = g.window;
    const parent = { postMessage: (d: unknown) => posted.push(d) };
    g.window = { parent };
    try {
      expect(m.isWrapped("#t=x&w=1")).toBe(true);
      expect(m.isWrapped("#t=x")).toBe(false);
      let state = "connecting";
      const stop = m.startWrapperHeartbeat({ getState: () => state }, 5);
      await new Promise((r) => setTimeout(r, 20));
      expect(posted).toEqual([]);
      state = "open";
      await new Promise((r) => setTimeout(r, 30));
      stop();
      expect(posted.length).toBeGreaterThan(0);
      expect(posted[0]).toEqual({ ac_console: "alive" });
      m.reportLostToWrapper();
      expect((posted.at(-1) as { ac_console: string }).ac_console).toBe("lost");
    } finally {
      g.window = prev;
    }
  });
});
