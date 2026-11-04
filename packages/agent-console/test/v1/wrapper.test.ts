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
async function runWrapper(hash: string, search = "", opts: { visible?: boolean } = {}) {
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
  const loc = { hash, search, replaced: null as string | null, replace(u: string) { this.replaced = u; } };
  const win: Record<string, unknown> = {
    parent: parentWin,
    addEventListener: (t: string, fn: (e: Msg) => void) => { if (t === "message") onMessage = fn; },
  };
  const doc = { getElementById: (id: string) => els[id], documentElement: { className: "" }, visibilityState: opts.visible === false ? "hidden" : "visible" };
  const DateFake = { now: () => now };
  const fn = new Function("window", "document", "location", "setInterval", "Date", "URL", "URLSearchParams", script);
  fn(win, doc, loc, (f: () => void) => { intervals.push(f); return 1; }, DateFake, URL, URLSearchParams);
  const tick = (ms: number, step = 1000) => { for (let t = 0; t < ms; t += step) { now += step; intervals.forEach((f) => f()); } };
  return {
    els, loc, childWin, parentWin, tick, doc,
    fromChild: (data: unknown) => onMessage({ source: childWin, data }),
    fromParent: (data: unknown) => onMessage({ source: parentWin, data }),
    fromOther: (data: unknown) => onMessage({ source: {}, data }),
    jump: (ms: number) => { now += ms; },
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
    const w2 = await runWrapper(hash({ t: TOKEN, p: "99999", b: BACK }));
    expect(w2.els.f!.src).toBe("");
    const w3 = await runWrapper(hash({ t: TOKEN, p: "4321", b: "https://evil.example/_magpie/plugin/a/index.html" }));
    w3.fromChild({ ac_console: "lost", at: 5 });
    expect(w3.loc.replaced).toBeNull();
    expect(w3.els.m!.hidden).toBe(false);
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
