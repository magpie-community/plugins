// #582 review fixes: the preview proxy's key (Host ac<key>.localhost), Magpie's gateway found by its settings.json port
// and by how it answers, the per-open nonce the ping must echo (and the keyless canary before the keyed host is looked
// up), and Apple WebKit refused only when the daemon host is before macOS 26 (Darwin < 25 from os.release(); the UA is
// frozen at 10_15_7). The real-browser attack check is scripts/preview-attack.mjs (Chromium / WebKit).
import { describe, expect, it, afterEach, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { platform as osPlatform, release as osRelease, tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "./helpers-net.js";
import { PreviewProxy, PREVIEW_PING_PATH, identify, looksLikeMagpie, magpieIndex } from "../../daemon/src/preview/proxy.js";
import { magpieConfigDirs, magpieDirFromInstall, previewDeniedPorts, savedGatewayPort } from "../../daemon/src/preview/ports.js";
import { checkPreviewUrl, deniedPort } from "../../daemon/src/preview/url.js";
import {
  PREVIEW_PING_PATH as WEB_PING,
  canReachProxy,
  confirmPreviewReachable,
  DARWIN_LOCALHOST_LOOPBACK as WEB_DARWIN_LOCALHOST_LOOPBACK,
  isAppleWebKit,
  isUnsafeLocalhostResolver,
  usePreview,
} from "../../web/src/stores/preview.js";
import { DARWIN_LOCALHOST_LOOPBACK, previewHost } from "../../daemon/src/preview/host.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.splice(0)) f(); });

async function serve(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanup.push(() => server.close());
  return { server, port: (server.address() as net.AddressInfo).port };
}
const MAGPIE_INDEX = JSON.stringify({ apis: ["/v1/chat/completions"], models: 2, name: "magpie", pid: 1, version: "0.1.2391" });
const hostOf = (proxyOrigin: string) => new URL(proxyOrigin).host;
const portOf = (proxyOrigin: string) => Number(new URL(proxyOrigin).port);

describe("preview key (#582 finding 1)", () => {
  it("each listener gets its own unguessable ac<key>.localhost name; only that Host is served", async () => {
    const up = await serve((_q, s) => { s.setHeader("content-type", "text/plain"); s.end("DEV-SECRET"); });
    const up2 = await serve((_q, s) => s.end("two"));
    const proxy = new PreviewProxy({ deniedPorts: () => [] });
    cleanup.push(() => proxy.closeAll());
    const a = await proxy.open(`localhost:${up.port}`);
    const b = await proxy.open(`localhost:${up2.port}`);
    expect(a.proxyOrigin).toMatch(/^http:\/\/ac[0-9a-f]{32}\.localhost:\d+$/);
    expect(hostOf(a.proxyOrigin).split(".")[0]).not.toBe(hostOf(b.proxyOrigin).split(".")[0]);
    const port = portOf(a.proxyOrigin);
    // what any page can send: Origin null, the bare loopback port, a guessed name, b's key on a's port
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `AC${"f".repeat(32)}.localhost:${port}`, `${hostOf(b.proxyOrigin).split(":")[0]}:${port}`]) {
      for (const method of ["GET", "POST", "OPTIONS"]) {
        const r = await request(port, "/", { host, origin: "null", "access-control-request-method": "POST" }, method);
        expect([403, 421], `${method} ${host}`).toContain(r.status);
        expect(r.headers["access-control-allow-origin"]).toBeUndefined();
        expect(r.body).not.toContain("DEV-SECRET");
      }
      expect([403, 421]).toContain((await request(port, PREVIEW_PING_PATH, { host })).status);
    }
    // the right name: served, readable by the opaque frame, the key never sent on as a Referer
    const ok = await request(port, "/", { host: hostOf(a.proxyOrigin), origin: "null" });
    expect(ok.status).toBe(200);
    expect(ok.body).toBe("DEV-SECRET");
    expect(ok.headers["access-control-allow-origin"]).toBe("null");
    expect(ok.headers["referrer-policy"]).toBe("no-referrer");
    const ping = await request(port, PREVIEW_PING_PATH, { host: hostOf(a.proxyOrigin), origin: "null" });
    expect(ping.status).toBe(200);
    expect(ping.body).toBe(a.nonce);
    expect(ping.body).not.toBe("ok");
    expect(ping.headers["access-control-allow-origin"]).toBe("null");
    expect(a.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(a.canaryOrigin).toMatch(/^http:\/\/acprobe[0-9a-f]{32}\.localhost:\d+$/);
    expect(a.canaryNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(a.canaryNonce).not.toBe(a.nonce);
    const canary = await request(port, PREVIEW_PING_PATH, { host: hostOf(a.canaryOrigin), origin: "null" });
    expect([canary.status, canary.body]).toEqual([200, a.canaryNonce]);
    // canary is ping-only
    expect((await request(port, "/", { host: hostOf(a.canaryOrigin), origin: "null" })).status).toBe(403);
    expect(WEB_PING).toBe(PREVIEW_PING_PATH);
    // the name is case-insensitive like any host name; the proxy's own origin is accepted, another is not
    expect((await request(port, "/", { host: hostOf(a.proxyOrigin).toUpperCase() })).status).toBe(200);
    expect((await request(port, "/", { host: hostOf(a.proxyOrigin), origin: a.proxyOrigin })).status).toBe(200);
    expect((await request(port, "/", { host: hostOf(a.proxyOrigin), origin: `http://127.0.0.1:${port}` })).status).toBe(403);
  });

  it("a refused WebSocket upgrade never reaches the dev server", async () => {
    let upgrades = 0;
    const up = await serve((_q, s) => s.end());
    up.server.on("upgrade", (_q, sock) => { upgrades++; sock.destroy(); });
    const proxy = new PreviewProxy({ deniedPorts: () => [] });
    cleanup.push(() => proxy.closeAll());
    const r = await proxy.open(`localhost:${up.port}`);
    const port = portOf(r.proxyOrigin);
    const reply = await new Promise<string>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => s.write(`GET /hmr HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nupgrade: websocket\r\nconnection: Upgrade\r\norigin: null\r\nsec-websocket-key: x\r\nsec-websocket-version: 13\r\n\r\n`));
      let got = "";
      s.on("data", (d) => { got += d; });
      s.on("close", () => resolve(got));
    });
    expect(reply).toContain("403");
    expect(upgrades).toBe(0);
  });
});

describe("Magpie's gateway is never previewed (#582 finding 2)", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

  it("reads the gateway port from Magpie's settings.json (XDG, ~/.config, portable, plugin-work)", () => {
    dir = mkdtempSync(join(tmpdir(), "ac582-"));
    const home = join(dir, "home");
    const xdg = join(dir, "xdg");
    const portable = join(dir, "Magpie", "data");
    for (const [d, port] of [[join(home, ".config", "magpie"), 3561], [join(xdg, "magpie"), 3562], [portable, 3563]] as const) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "settings.json"), JSON.stringify({ theme: "dark", port }));
    }
    const self = join(portable, "plugins", "node_modules", "@magpie-community", "page-agent-console", "daemon", "dist", "main.js");
    const dirs = magpieConfigDirs({ HOME: home, XDG_CONFIG_HOME: xdg }, { self, cwd: join(portable, "plugin-work"), platform: "linux" });
    expect(dirs).toEqual([portable, join(xdg, "magpie"), join(home, ".config", "magpie")]);
    const denied = previewDeniedPorts({ port: 41000 }, {}, { configDirs: dirs });
    for (const p of [3561, 3562, 3563, 3425, 3430, 3488, 41000]) expect(deniedPort(p, denied), String(p)).toBe(true);
    expect(deniedPort(5173, denied)).toBe(false);
    // Windows: the home folder is USERPROFILE; paths with backslashes
    expect(magpieConfigDirs({ USERPROFILE: "C:\\Users\\me" }, { self: "", cwd: "", platform: "win32" })).toEqual(process.platform === "win32" ? ["C:\\Users\\me\\.config\\magpie"] : []);
    expect(magpieDirFromInstall("C:\\Magpie\\data\\plugins\\node_modules\\@magpie-community\\page-agent-console\\daemon\\dist\\main.js")).toBe("C:\\Magpie\\data");
    expect(magpieDirFromInstall("/opt/x/main.js")).toBeNull();
  });

  it("settings.json without a port (or a bad one) means the default; unreadable means nothing", () => {
    const read = (body: string) => () => body;
    expect(savedGatewayPort("x", read("{}"))).toBe(3425);
    expect(savedGatewayPort("x", read('{"port":0}'))).toBe(3425);
    expect(savedGatewayPort("x", read('{"port":80}'))).toBe(3425);
    expect(savedGatewayPort("x", read('{"port":3561}'))).toBe(3561);
    expect(savedGatewayPort("x", read("garbled"))).toBeNull();
    expect(savedGatewayPort("x", () => { throw new Error("ENOENT"); })).toBeNull();
    // read again on every open: a port changed in Settings while the daemon runs is denied at once
    let body = '{"port":3561}';
    const opts = { configDirs: ["/m"], read: () => body };
    expect(previewDeniedPorts({ port: 1 }, {}, opts)).toContain(3561);
    body = '{"port":3999}';
    expect(previewDeniedPorts({ port: 1 }, {}, opts)).toContain(3999);
  });

  it("refuses a target that answers GET / like the gateway, on any port (open and later)", async () => {
    const gw = await serve((req, s) => {
      if (req.url === "/") { s.writeHead(200, { "content-type": "application/json" }); s.end(MAGPIE_INDEX); return; }
      s.writeHead(200, { "content-type": "application/json" }); s.end('{"data":[],"object":"list"}');
    });
    const proxy = new PreviewProxy({ deniedPorts: () => [] });
    cleanup.push(() => proxy.closeAll());
    await expect(proxy.open(`localhost:${gw.port}/v1/models`)).rejects.toMatchObject({ code: "denied_port" });
    expect(proxy.size).toBe(0);

    // a dev server that is later replaced by the gateway on the same port: refused once it is asked again
    let magpie = false;
    let now = 1_000_000;
    const dev = await serve((req, s) => {
      if (magpie && req.url === "/") { s.writeHead(200, { "content-type": "application/json" }); s.end(MAGPIE_INDEX); return; }
      s.writeHead(200, { "content-type": magpie ? "application/json" : "text/plain" }); s.end(magpie ? '{"data":[]}' : "dev");
    });
    const p2 = new PreviewProxy({ deniedPorts: () => [], now: () => now });
    cleanup.push(() => p2.closeAll());
    const r = await p2.open(`localhost:${dev.port}`);
    const port = portOf(r.proxyOrigin);
    expect((await request(port, "/v1/models", { host: hostOf(r.proxyOrigin) })).body).toBe("dev");
    magpie = true;
    now += 61_000;
    const refused = await request(port, "/v1/models", { host: hostOf(r.proxyOrigin), origin: "null" });
    expect(refused.status).toBe(403);
    expect(refused.body).not.toContain("data");
    expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
    // and stays refused
    magpie = false;
    expect((await request(port, "/", { host: hostOf(r.proxyOrigin) })).status).toBe(403);
  });

  it("refuses any reply that carries X-Magpie-* headers", async () => {
    const gw = await serve((req, s) => {
      if (req.url === "/") { s.end("hello"); return; } // index not recognisable
      s.writeHead(200, { "content-type": "application/json", "x-magpie-provider": "deepseek" }); s.end('{"secret":1}');
    });
    const proxy = new PreviewProxy({ deniedPorts: () => [] });
    cleanup.push(() => proxy.closeAll());
    const r = await proxy.open(`localhost:${gw.port}`);
    const port = portOf(r.proxyOrigin);
    const res = await request(port, "/v1/chat/completions", { host: hostOf(r.proxyOrigin) });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain("secret");
    expect((await request(port, "/", { host: hostOf(r.proxyOrigin) })).status).toBe(403);
  });

  it("fails closed when the target doesn't answer the identity check in time", async () => {
    const hang = net.createServer((s) => { s.on("error", () => {}); /* accepts, never answers */ });
    await new Promise<void>((r) => hang.listen(0, "127.0.0.1", () => r()));
    cleanup.push(() => hang.close());
    const hp = (hang.address() as net.AddressInfo).port;
    const proxy = new PreviewProxy({ deniedPorts: () => [], identityTimeoutMs: 300 });
    cleanup.push(() => proxy.closeAll());
    const r = await proxy.open(`localhost:${hp}`);
    const res = await request(portOf(r.proxyOrigin), "/", { host: hostOf(r.proxyOrigin) });
    expect(res.status).toBe(502); // the "not responding" page; nothing was forwarded
  });

  it("recognises the gateway's index and headers only", async () => {
    expect(magpieIndex(MAGPIE_INDEX)).toBe(true);
    expect(magpieIndex('{"name":"magpie"}')).toBe(false);
    expect(magpieIndex('{"name":"my-app","apis":[]}')).toBe(false);
    expect(magpieIndex("<html>")).toBe(false);
    expect(looksLikeMagpie({ "X-Magpie-Provider": "x" } as never)).toBe(true);
    expect(looksLikeMagpie({ "content-type": "text/html" })).toBe(false);
    const c = checkPreviewUrl("localhost:1");
    if (!c.ok) throw new Error("x");
    expect(await identify(c.target, ["127.0.0.1"], 500)).toBe("none");
  });
});


describe("preview ping nonce + canary (#582 WebKit DNS)", () => {
  it("rotates nonces on every open; ping never answers a generic ok", async () => {
    const up = await serve((_q, s) => s.end("dev"));
    const proxy = new PreviewProxy({ deniedPorts: () => [] });
    cleanup.push(() => proxy.closeAll());
    const a = await proxy.open(`localhost:${up.port}`);
    const b = await proxy.open(`localhost:${up.port}/again`);
    expect(a.proxyOrigin).toBe(b.proxyOrigin);
    expect(b.nonce).not.toBe(a.nonce);
    expect(b.canaryNonce).not.toBe(a.canaryNonce);
    expect(b.canaryOrigin).not.toBe(a.canaryOrigin);
    const port = portOf(a.proxyOrigin);
    // old nonce is gone; retired canary Host is unknown → 421 (not a bare loopback address)
    expect((await request(port, PREVIEW_PING_PATH, { host: hostOf(a.proxyOrigin) })).body).toBe(b.nonce);
    expect([403, 421]).toContain((await request(port, PREVIEW_PING_PATH, { host: hostOf(a.canaryOrigin) })).status);
    expect((await request(port, PREVIEW_PING_PATH, { host: hostOf(b.canaryOrigin) })).body).toBe(b.canaryNonce);
  });

  it("a non-proxy server that answers 200 ok fails canReachProxy; navigate releases the listener", async () => {
    const up = await serve((_q, s) => s.end("DEV-SECRET"));
    const proxy = new PreviewProxy({ deniedPorts: () => [] });
    cleanup.push(() => proxy.closeAll());
    const opened = await proxy.open(`localhost:${up.port}/`);
    expect(proxy.size).toBe(1);

    // Real proxy ping body (Host header, connect to 127.0.0.1) — must be the nonce, never "ok"
    const port = portOf(opened.proxyOrigin);
    expect((await request(port, PREVIEW_PING_PATH, { host: hostOf(opened.proxyOrigin) })).body).toBe(opened.nonce);
    expect((await request(port, PREVIEW_PING_PATH, { host: hostOf(opened.canaryOrigin) })).body).toBe(opened.canaryNonce);

    // Attacker DNS: answers with plain 200 "ok" (what canReachProxy used to accept). Fetch via 127.0.0.1
    // so the test does not depend on this machine's *.localhost resolver.
    const fake = await serve((_q, s) => {
      s.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "null" });
      s.end("ok");
    });
    const good = await serve((_q, s) => {
      s.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "null" });
      s.end(opened.nonce);
    });
    expect(await canReachProxy(`http://127.0.0.1:${fake.port}`, opened.nonce)).toBe(false);
    expect(await canReachProxy(`http://127.0.0.1:${good.port}`, "ok")).toBe(false);
    expect(await canReachProxy(`http://127.0.0.1:${good.port}`, opened.nonce)).toBe(true);
    expect(await confirmPreviewReachable({
      proxyOrigin: `http://127.0.0.1:${fake.port}`,
      proxyHref: `http://127.0.0.1:${fake.port}/`,
      url: opened.url,
      nonce: opened.nonce,
      canaryOrigin: `http://127.0.0.1:${fake.port}`,
      canaryNonce: opened.canaryNonce,
    })).toBe(false);

    // Panel path: preview.open returns real listener, but fetch is hijacked to the fake server → must release
    const released: string[] = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const u = new URL(url);
      // rewrite any *.localhost lookup → fake server (simulates hostile DNS answering the lookup)
      return prevFetch(`http://127.0.0.1:${fake.port}${u.pathname}${u.search}`, {
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    }) as typeof fetch;
    cleanup.push(() => { globalThis.fetch = prevFetch; });

    usePreview.setState({ byThread: {} });
    const call = async (m: string, p?: unknown) => {
      if (m === "preview.open") {
        return {
          proxyOrigin: opened.proxyOrigin,
          proxyHref: opened.proxyHref,
          url: opened.url,
          nonce: opened.nonce,
          canaryOrigin: opened.canaryOrigin,
          canaryNonce: opened.canaryNonce,
        };
      }
      if (m === "preview.release") {
        const url = String((p as { url?: string } | undefined)?.url ?? "");
        released.push(url);
        proxy.release(url);
        return { ok: true };
      }
      return {};
    };
    const ok = await usePreview.getState().navigate(call, "t1", null, `http://localhost:${up.port}/`, { push: true });
    expect(ok).toBe(false);
    expect(released).toEqual([`http://localhost:${up.port}`]);
    expect(proxy.size).toBe(0);
    const entry = usePreview.getState().byThread["t1"];
    expect(entry?.proxyHref).toBeNull();
    expect(entry?.error).toBeTruthy();
    // real ping would have worked; the failure was the fake answer
    expect(entry?.error?.length ?? 0).toBeGreaterThan(10);
  });

});

// #582 third review: Apple froze the UA at "Mac OS X 10_15_7", so the macOS version comes from the daemon
// (os.platform() + os.release(), Darwin 25 = macOS 26) via preview.open, never from the UA.
describe("Apple WebKit + daemon Darwin version (#582 frozen UA)", () => {
  // Literal UAs Apple WebKit sends on every macOS, 26+ included (a plain WKWebView on macOS 27.2, and Safari)
  const WKWEBVIEW_FROZEN = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  const SAFARI_FROZEN = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
  const IPAD_SAFARI = "Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
  const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const EDGE_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
  const WEBKITGTK = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

  const macos26 = previewHost("darwin", "25.0.0");
  const macos27 = previewHost("darwin", "26.2.0");
  const macos15 = previewHost("darwin", "24.6.0");
  const macos12 = previewHost("darwin", "21.6.0");
  const linux = previewHost("linux", "6.8.0-45-generic");
  const win = previewHost("win32", "10.0.26100");

  it("the daemon reads the Darwin major from os.release()", () => {
    expect(macos26).toEqual({ platform: "darwin", darwinMajor: 25 });
    expect(macos27).toEqual({ platform: "darwin", darwinMajor: 26 });
    expect(macos15).toEqual({ platform: "darwin", darwinMajor: 24 });
    expect(linux).toEqual({ platform: "linux", darwinMajor: null });
    expect(win).toEqual({ platform: "win32", darwinMajor: null });
    expect(previewHost("darwin", "")).toEqual({ platform: "darwin", darwinMajor: null });
    expect(previewHost("darwin", "garbage")).toEqual({ platform: "darwin", darwinMajor: null });
    expect(DARWIN_LOCALHOST_LOOPBACK).toBe(WEB_DARWIN_LOCALHOST_LOOPBACK);
    // default arguments = this host
    const here = previewHost();
    expect(here.platform).toBe(osPlatform());
    if (here.platform === "darwin") expect(here.darwinMajor).toBe(Number(osRelease().split(".")[0]));
    else expect(here.darwinMajor).toBeNull();
  });

  it("the frozen 10_15_7 UA on a macOS 26+ host is safe; on Darwin 24 or an unknown host it is refused", () => {
    for (const ua of [WKWEBVIEW_FROZEN, SAFARI_FROZEN, IPAD_SAFARI]) {
      expect(isAppleWebKit(ua)).toBe(true);
      expect(isUnsafeLocalhostResolver(macos26, ua)).toBe(false);
      expect(isUnsafeLocalhostResolver(macos27, ua)).toBe(false);
      expect(isUnsafeLocalhostResolver(macos15, ua)).toBe(true);
      expect(isUnsafeLocalhostResolver(macos12, ua)).toBe(true);
      // missing / unparseable daemon info fails closed
      expect(isUnsafeLocalhostResolver(undefined, ua)).toBe(true);
      expect(isUnsafeLocalhostResolver(null, ua)).toBe(true);
      expect(isUnsafeLocalhostResolver({ platform: "darwin", darwinMajor: null }, ua)).toBe(true);
      expect(isUnsafeLocalhostResolver({ platform: "", darwinMajor: null }, ua)).toBe(true);
      // non-darwin daemon hosts are left to the canary + nonce probe
      expect(isUnsafeLocalhostResolver(linux, ua)).toBe(false);
      expect(isUnsafeLocalhostResolver(win, ua)).toBe(false);
    }
  });

  it("Chromium / Edge / WebKitGTK are never refused, whatever the host", () => {
    for (const ua of [CHROME_MAC, EDGE_WIN, WEBKITGTK]) {
      expect(isAppleWebKit(ua)).toBe(false);
      for (const h of [macos12, macos15, macos26, linux, win, null]) expect(isUnsafeLocalhostResolver(h, ua)).toBe(false);
    }
  });

  // Panel path against a real listener. fetch is routed to 127.0.0.1:<port> with the name's Host header, so the test
  // doesn't depend on this machine's *.localhost resolver.
  async function panel(ua: string, host: unknown) {
    const up = await serve((_q, s) => s.end("DEV"));
    const proxy = new PreviewProxy({ deniedPorts: () => [] });
    cleanup.push(() => proxy.closeAll());
    vi.stubGlobal("navigator", { userAgent: ua });
    cleanup.push(() => vi.unstubAllGlobals());
    const pinged: string[] = [];
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const u = new URL(String(input));
      pinged.push(u.hostname);
      const r = await request(Number(u.port), u.pathname + u.search, { host: u.host });
      return new Response(r.body, { status: r.status });
    }) as typeof fetch;
    cleanup.push(() => { globalThis.fetch = prevFetch; });
    const calls: string[] = [];
    const released: string[] = [];
    const call = async (m: string, p?: unknown) => {
      calls.push(m);
      if (m === "preview.open") {
        const opened = await proxy.open(String((p as { url: string }).url));
        return host === undefined ? opened : { ...opened, host };
      }
      if (m === "preview.release") {
        const url = String((p as { url?: string } | undefined)?.url ?? "");
        released.push(url);
        proxy.release(url);
        return { ok: true };
      }
      return {};
    };
    usePreview.setState({ byThread: {} });
    const ok = await usePreview.getState().navigate(call, "mac", null, `http://localhost:${up.port}/`, { push: true });
    return { ok, calls, released, pinged, proxy, up, entry: usePreview.getState().byThread["mac"] };
  }

  it("Magpie's Mac app (frozen WKWebView UA) on a macOS 26 host (Darwin 25.x) opens the preview", async () => {
    const r = await panel(WKWEBVIEW_FROZEN, previewHost("darwin", "25.0.0"));
    expect(r.ok).toBe(true);
    expect(r.calls).toEqual(["preview.open"]);
    expect(r.released).toEqual([]);
    expect(r.proxy.size).toBe(1);
    expect(r.entry?.error).toBeNull();
    expect(r.entry?.proxyHref).toMatch(/^http:\/\/ac[0-9a-f]+\.localhost:\d+\/$/);
    // canary first, then the keyed name
    expect(r.pinged).toHaveLength(2);
    expect(r.pinged[0]).toMatch(/^acprobe[0-9a-f]+\.localhost$/);
    expect(r.pinged[1]).toBe(new URL(r.entry!.proxyHref!).hostname);
  });

  it("Safari (frozen UA) with magpie web on a macOS 27 host opens the preview", async () => {
    const r = await panel(SAFARI_FROZEN, previewHost("darwin", "26.2.0"));
    expect(r.ok).toBe(true);
    expect(r.entry?.proxyHref).toBeTruthy();
    expect(r.released).toEqual([]);
  });

  it("Apple WebKit on a Darwin 24.x host (macOS 15) is refused: no *.localhost lookup, listener released", async () => {
    const r = await panel(WKWEBVIEW_FROZEN, previewHost("darwin", "24.6.0"));
    expect(r.ok).toBe(false);
    expect(r.pinged).toEqual([]);
    expect(r.released).toEqual([`http://localhost:${r.up.port}`]);
    expect(r.proxy.size).toBe(0);
    expect(r.entry?.proxyHref).toBeNull();
    expect(r.entry?.error).toBeTruthy();
  });

  it("Apple WebKit with no host info from the daemon fails closed the same way", async () => {
    const r = await panel(SAFARI_FROZEN, undefined);
    expect(r.ok).toBe(false);
    expect(r.pinged).toEqual([]);
    expect(r.proxy.size).toBe(0);
  });

  it("a non-darwin daemon host is unaffected (frozen Safari UA and Chromium both open)", async () => {
    const a = await panel(SAFARI_FROZEN, previewHost("linux", "6.8.0"));
    expect(a.ok).toBe(true);
    expect(a.released).toEqual([]);
    const b = await panel(EDGE_WIN, previewHost("win32", "10.0.26100"));
    expect(b.ok).toBe(true);
    expect(b.released).toEqual([]);
  });
});
