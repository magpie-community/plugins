// #582 review fixes: the preview proxy's key (Host ac<key>.localhost), Magpie's gateway found by its settings.json port
// and by how it answers, and the ping the page checks before showing the frame. The real-browser attack check is
// scripts/preview-attack.mjs (Chromium / WebKit).
import { describe, expect, it, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "./helpers-net.js";
import { PreviewProxy, PREVIEW_PING_PATH, identify, looksLikeMagpie, magpieIndex } from "../../daemon/src/preview/proxy.js";
import { magpieConfigDirs, magpieDirFromInstall, previewDeniedPorts, savedGatewayPort } from "../../daemon/src/preview/ports.js";
import { checkPreviewUrl, deniedPort } from "../../daemon/src/preview/url.js";
import { PREVIEW_PING_PATH as WEB_PING } from "../../web/src/stores/preview.js";

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
    expect([ping.status, ping.body, ping.headers["access-control-allow-origin"]]).toEqual([200, "ok", "null"]);
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
