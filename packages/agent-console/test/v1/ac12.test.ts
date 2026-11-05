// 1.2: preview proxy security rules, local-link detection, path chips, content width / chat font size, live Magpie theme.
import { describe, expect, it, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { request as netRequest } from "./helpers-net.js";

// Preview listeners answer only at ac<key>.localhost:<port> (#582): requests below go there unless a test sets Host itself
const proxyHosts = new Map<number, string>();
function remember<T extends { proxyOrigin: string }>(r: T): T {
  const u = new URL(r.proxyOrigin);
  proxyHosts.set(Number(u.port), u.host);
  return r;
}
const request = (port: number, path: string, headers: Record<string, string> = {}, method?: string) =>
  netRequest(port, path, { host: proxyHosts.get(port) ?? `127.0.0.1:${port}`, ...headers }, method);
import { checkPreviewUrl, deniedPort, displayHref, externalHref, withScheme } from "../../daemon/src/preview/url.js";
import { PreviewProxy, rewriteLocation, stripFrameAncestors } from "../../daemon/src/preview/proxy.js";
import { injectScriptTag, PREVIEW_SCRIPT_PATH } from "../../daemon/src/preview/inject.js";
import { previewDeniedPorts } from "../../daemon/src/preview/ports.js";
import { openExternal, openerFor } from "../../daemon/src/util/openExternal.js";
import { insideRoot, mentionSection, resolveMentions, withMentions } from "../../daemon/src/util/mentions.js";
import { buildAcpPrompt } from "../../daemon/src/providers/acp/prompt.js";
import { parseSettingsPatch, sanitizeStored, DEFAULT_SETTINGS } from "../../daemon/src/store/settings.js";
import { parseConfig } from "../../daemon/src/config.js";
import { findLocalLinks, localHref, splitLocalLinks } from "../../web/src/util/localLinks.js";
import { addMention, joinProjectPath, mentionsForSend, parseMentionDrag, relFromAbs } from "../../web/src/composer/mentions.js";
import { colValue, normalizeChatFont, normalizeContentWidth } from "../../web/src/layout/chatLayout.js";
import { parseMagpieTheme, themeFromMessage } from "../../web/src/layout/magpieBridge.js";
import { magpieTokenVars } from "../../web/src/layout/applyMagpieTokens.js";

describe("preview URL rules", () => {
  it("normalizes what people type", () => {
    expect(withScheme("5173")).toBe("http://localhost:5173/");
    expect(withScheme(":5173/x")).toBe("http://localhost:5173/x");
    expect(withScheme("localhost:5173")).toBe("http://localhost:5173");
    const ok = (s: string) => { const c = checkPreviewUrl(s); return c.ok ? c.target.href : null; };
    expect(ok("5173")).toBe("http://localhost:5173/");
    expect(ok("localhost:3000/a?b=1#c")).toBe("http://localhost:3000/a?b=1#c");
    expect(ok("http://127.0.0.1:5173/x")).toBe("http://127.0.0.1:5173/x");
    expect(ok("127.1.2.3:80")).toBe("http://127.1.2.3/");
    expect(ok("0.0.0.0:8080")).toBe("http://0.0.0.0:8080/");
    expect(ok("http://[::1]:4000/")).toBe("http://[::1]:4000/");
    expect(ok("app.localhost:3000")).toBe("http://app.localhost:3000/");
    expect(ok("https://localhost:8443")).toBe("https://localhost:8443/");
  });
  it("refuses anything that isn't a loopback http(s) URL", () => {
    const why = (s: string) => { const c = checkPreviewUrl(s); return c.ok ? "ok" : c.reason; };
    expect(why("")).toBe("empty");
    expect(why("example.com")).toBe("not_local");
    expect(why("192.168.1.10:3000")).toBe("not_local");
    expect(why("10.0.0.1:80")).toBe("not_local");
    expect(why("localhost.evil.com:80")).toBe("not_local");
    expect(why("127.0.0.1.nip.io:80")).toBe("not_local");
    expect(why("http://user:pw@localhost:3000")).toBe("userinfo");
    expect(why("file:///etc/passwd")).toBe("scheme");
    expect(why("javascript:alert(1)")).toBe("scheme");
    expect(why("ftp://localhost:21")).toBe("scheme");
    expect(why("localhost:99999")).toBe("bad_url");
    expect(why("http://localhost:3000/" + "a".repeat(2100))).toBe("too_long");
  });
  it("connects localhost to IPv4 first, then ::1; 0.0.0.0 to 127.0.0.1", () => {
    const c = checkPreviewUrl("localhost:5173");
    expect(c.ok && c.target.connect).toEqual(["127.0.0.1", "::1"]);
    const z = checkPreviewUrl("0.0.0.0:5173");
    expect(z.ok && z.target.connect).toEqual(["127.0.0.1"]);
    const v6 = checkPreviewUrl("[::1]:5173");
    expect(v6.ok && v6.target.connect).toEqual(["::1"]);
  });
  it("denies the daemon, gate and Magpie ports", () => {
    const d = previewDeniedPorts({ port: 41000, gatePort: 3499 }, { MAGPIE_ADDR: "127.0.0.1:3525" });
    for (const p of [41000, 3499, 3488, 3425, 3430, 3525]) expect(deniedPort(p, d)).toBe(true);
    expect(deniedPort(5173, d)).toBe(false);
    expect(previewDeniedPorts({ port: 1 }, { AGENT_CONSOLE_PREVIEW_DENY: "9000, 9001" })).toEqual(expect.arrayContaining([9000, 9001]));
    expect(parseConfig(["--port", "0", "--gate-port", "3555"]).gatePort).toBe(3555);
    expect(parseConfig(["--gate-port", "nope"]).gatePort).toBeUndefined();
  });
  it("maps a proxied href back to the target for the address bar", () => {
    expect(displayHref("http://127.0.0.1:4444/a?b#c", "http://127.0.0.1:4444", "http://localhost:5173")).toBe("http://localhost:5173/a?b#c");
    expect(displayHref("http://127.0.0.1:4444/", "http://127.0.0.1:4444", "http://localhost:80")).toBe("http://localhost/");
  });
});

describe("app.openExternal", () => {
  it("only takes http(s), re-serialized", () => {
    expect(externalHref("https://example.com/a b")).toBe("https://example.com/a%20b");
    expect(externalHref("javascript:alert(1)")).toBeNull();
    expect(externalHref("file:///C:/Windows/system32/calc.exe")).toBeNull();
    expect(externalHref("vscode://open?x")).toBeNull();
    expect(externalHref("not a url")).toBeNull();
    expect(externalHref("https://x.com/?q=a&b=|c")).toBeNull(); // odd characters left by URL: refused
  });
  it("uses a no-shell opener per OS", () => {
    const href = "https://example.com/?a=1&b=2";
    expect(openerFor("win32", href)).toEqual({ cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", href] });
    expect(openerFor("darwin", href)).toEqual({ cmd: "open", args: [href] });
    expect(openerFor("linux", href)).toEqual({ cmd: "xdg-open", args: [href] });
  });
  it("runs execFile with one argument and reports a missing opener", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const ok = await openExternal("https://example.com/x?y=1&z=2", {
      platform: "win32",
      exec: (cmd, args, _o, cb) => { calls.push({ cmd, args }); setTimeout(() => cb(null), 1); return { on: () => {} }; },
    });
    expect(ok.ok).toBe(true);
    expect(calls).toEqual([{ cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", "https://example.com/x?y=1&z=2"] }]);
    const missing = await openExternal("https://example.com/", {
      platform: "linux",
      exec: () => ({ on: (_e: string, fn: (e: Error) => void) => setTimeout(() => fn(new Error("ENOENT")), 1) }),
    });
    expect(missing.ok).toBe(false);
    expect((await openExternal("file:///etc/passwd", { exec: () => { throw new Error("must not run"); } })).ok).toBe(false);
  });
});

// ---- the proxy against a real upstream ----
type Up = { server: http.Server; port: number; seen: http.IncomingHttpHeaders[] };
async function upstream(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Up> {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => { seen.push(req.headers); handler(req, res); });
  server.on("upgrade", (req, socket) => {
    seen.push(req.headers);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n");
    socket.on("data", (d) => socket.write(Buffer.concat([Buffer.from("echo:"), d])));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, port: (server.address() as net.AddressInfo).port, seen };
}

describe("preview proxy", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => { for (const f of cleanup.splice(0)) f(); });

  async function setup(handler: Parameters<typeof upstream>[0], opts: Partial<ConstructorParameters<typeof PreviewProxy>[0]> = {}) {
    const up = await upstream(handler);
    const proxy = new PreviewProxy({ deniedPorts: () => [], ...opts });
    cleanup.push(() => { proxy.closeAll(); up.server.close(); });
    const r = remember(await proxy.open(`http://localhost:${up.port}/start`));
    const port = Number(new URL(r.proxyOrigin).port);
    return { up, proxy, r, port };
  }

  it("opens one random-port listener per target and refuses denied ports", async () => {
    const { proxy, r, up, port } = await setup((_q, s) => s.end("ok"));
    expect(r.proxyOrigin).toMatch(/^http:\/\/ac[0-9a-f]{32}\.localhost:\d+$/);
    expect(r.proxyHref).toBe(`${r.proxyOrigin}/start`);
    expect(r.target).toBe(`http://localhost:${up.port}`);
    const again = await proxy.open(`localhost:${up.port}/other`);
    expect(again.proxyOrigin).toBe(r.proxyOrigin);
    await expect(proxy.open(`localhost:${port}`)).rejects.toMatchObject({ code: "denied_port" }); // the proxy itself
    const p2 = new PreviewProxy({ deniedPorts: () => [up.port] });
    await expect(p2.open(`localhost:${up.port}`)).rejects.toMatchObject({ code: "denied_port" });
    await expect(p2.open("example.com:80")).rejects.toMatchObject({ code: "not_local" });
    p2.closeAll();
  });

  it("checks Host and Origin; rewrites Host/Origin/Referer upstream; strips cookies", async () => {
    const { up, port } = await setup((_q, s) => s.end("hi"));
    expect((await request(port, "/", { host: `evil.test:${port}` })).status).toBe(421);
    expect((await request(port, "/", { host: `127.0.0.1:${port + 1}` })).status).toBe(421);
    // the bare loopback address (no key) is refused, with nothing a page could read (#582)
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `ac${"0".repeat(32)}.localhost:${port}`]) {
      const no = await request(port, "/", { host, origin: "null" });
      expect([403, 421]).toContain(no.status);
      expect(no.headers["access-control-allow-origin"]).toBeUndefined();
    }
    expect((await request(port, "/", { origin: "https://evil.test" })).status).toBe(403);
    expect((await request(port, "/", { origin: "http://localhost:3430" })).status).toBe(403);
    const ok = await request(port, "/x", { origin: "null", cookie: "magpie=secret", referer: `http://${proxyHosts.get(port)}/a`, "sec-fetch-site": "cross-site" });
    expect(ok.status).toBe(200);
    expect(ok.headers["access-control-allow-origin"]).toBe("null");
    const h = up.seen.at(-1)!;
    expect(h.host).toBe(`localhost:${up.port}`);
    expect(h.origin).toBe(`http://localhost:${up.port}`);
    expect(h.referer).toBe(`http://localhost:${up.port}/a`);
    expect(h["sec-fetch-site"]).toBe("same-origin");
    expect(h.cookie).toBeUndefined();
    expect(h["accept-encoding"]).toBe("identity");
    // no Origin stays no Origin
    await request(port, "/y");
    expect(up.seen.at(-1)!.origin).toBeUndefined();
  });

  it("drops X-Frame-Options, frame-ancestors and Set-Cookie; rewrites a redirect to the target", async () => {
    const { up, port, r } = await setup((req, s) => {
      if (req.url === "/go") { s.writeHead(302, { location: `http://localhost:${up.port}/there?q=1` }); s.end(); return; }
      if (req.url === "/away") { s.writeHead(302, { location: "https://example.com/" }); s.end(); return; }
      s.writeHead(200, { "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; frame-ancestors 'none'", "set-cookie": "sid=1", "access-control-allow-origin": "*" });
      s.end("x");
    });
    const res = await request(port, "/");
    expect(res.headers["x-frame-options"]).toBeUndefined();
    expect(res.headers["content-security-policy"]).toBe("default-src 'self'");
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["access-control-allow-origin"]).toBe("null");
    expect((await request(port, "/go")).headers.location).toBe(`${r.proxyOrigin}/there?q=1`);
    expect((await request(port, "/away")).headers.location).toBe("https://example.com/");
    expect(stripFrameAncestors("frame-ancestors 'self'")).toBe("");
  });

  it("injects the bridge script into HTML (chunked, no <head>) and serves it itself", async () => {
    const { port } = await setup((req, s) => {
      s.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      if (req.url === "/nohead") { s.write("<!doctype html><body>"); s.end("hi</body>"); return; }
      s.write("<!doctype html><html><head><title>t</title></head>");
      s.end("<body>é</body></html>");
    });
    const a = await request(port, "/");
    expect(a.body).toContain(`<head><script src="${PREVIEW_SCRIPT_PATH}"></script><title>`);
    expect(a.body).toContain("é");
    expect(Number(a.headers["content-length"])).toBe(Buffer.byteLength(a.body));
    const b = await request(port, "/nohead");
    expect(b.body.startsWith(`<!doctype html><script src="${PREVIEW_SCRIPT_PATH}">`)).toBe(true);
    const js = await request(port, PREVIEW_SCRIPT_PATH);
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toContain("javascript");
    expect(js.body).toContain("ac_preview");
    expect(injectScriptTag("<p>x</p>")).toBe(`<script src="${PREVIEW_SCRIPT_PATH}"></script><p>x</p>`);
    expect(injectScriptTag("<header>x</header>")).toBe(`<script src="${PREVIEW_SCRIPT_PATH}"></script><header>x</header>`);
  });

  it("answers CORS preflight for the opaque frame", async () => {
    const { port } = await setup((_q, s) => s.end());
    const r = await request(port, "/api", { origin: "null", "access-control-request-method": "POST", "access-control-request-headers": "content-type" }, "OPTIONS");
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe("null");
    expect(r.headers["access-control-allow-headers"]).toBe("content-type");
  });

  it("shows an error page when the dev server isn't running", async () => {
    const dead = await upstream((_q, s) => s.end());
    const deadPort = dead.port;
    await new Promise((r) => dead.server.close(r));
    const proxy = new PreviewProxy({ deniedPorts: () => [] });
    cleanup.push(() => proxy.closeAll());
    const r = remember(await proxy.open(`localhost:${deadPort}`));
    const res = await request(Number(new URL(r.proxyOrigin).port), "/");
    expect(res.status).toBe(502);
    expect(res.body).toContain(`localhost:${deadPort}`);
    expect(res.body).toContain("Retry");
  });

  it("tunnels WebSocket upgrades (HMR) with the Origin rewritten, and refuses a foreign Origin", async () => {
    const { up, port } = await setup((_q, s) => s.end());
    const talk = (origin: string, host = proxyHosts.get(port)!) => new Promise<string>((resolve) => {
      const s = net.connect(port, "127.0.0.1", () => {
        s.write(`GET /hmr HTTP/1.1\r\nhost: ${host}\r\nupgrade: websocket\r\nconnection: Upgrade\r\norigin: ${origin}\r\nsec-websocket-key: x\r\nsec-websocket-version: 13\r\n\r\n`);
      });
      let got = "";
      s.on("data", (d) => {
        got += d.toString();
        if (got.includes("101") && !got.includes("echo:")) s.write("ping");
        if (got.includes("echo:ping") || got.includes("403") || got.includes("421")) { s.destroy(); resolve(got); }
      });
      s.on("close", () => resolve(got));
    });
    const ok = await talk("null");
    expect(ok).toContain("101 Switching Protocols");
    expect(ok).toContain("echo:ping");
    expect(up.seen.at(-1)!.origin).toBe(`http://localhost:${up.port}`);
    expect(up.seen.at(-1)!.host).toBe(`localhost:${up.port}`);
    expect(await talk("https://evil.test")).toContain("403");
    expect(await talk("null", `127.0.0.1:${port}`)).toContain("403"); // no key (#582)
  });

  it("closes idle listeners (fake clock), on release, and keeps at most N targets", async () => {
    let now = 1000;
    const a = await upstream((_q, s) => s.end("a"));
    const b = await upstream((_q, s) => s.end("b"));
    const proxy = new PreviewProxy({ deniedPorts: () => [], now: () => now, idleMs: 10_000, maxTargets: 1 });
    cleanup.push(() => { proxy.closeAll(); a.server.close(); b.server.close(); });
    const ra = remember(await proxy.open(`localhost:${a.port}`));
    const rb = remember(await proxy.open(`localhost:${b.port}`));
    expect(proxy.size).toBe(1); // a was closed for b
    expect(proxy.ports()).toEqual([Number(new URL(rb.proxyOrigin).port)]);
    await expect(request(Number(new URL(ra.proxyOrigin).port), "/")).rejects.toThrow();
    now += 5_000;
    proxy.sweep();
    expect(proxy.size).toBe(1);
    now += 20_000;
    proxy.sweep();
    expect(proxy.size).toBe(0);
    await proxy.open(`localhost:${b.port}`);
    expect(proxy.release(`http://localhost:${b.port}/anything`)).toBe(true);
    expect(proxy.size).toBe(0);
  });

  it("rewriteLocation leaves relative and foreign redirects alone", () => {
    const c = checkPreviewUrl("localhost:5173");
    if (!c.ok) throw new Error("x");
    expect(rewriteLocation("/login", c.target, "http://127.0.0.1:9")).toBe("/login");
    expect(rewriteLocation("http://localhost:5173/a", c.target, "http://127.0.0.1:9")).toBe("http://127.0.0.1:9/a");
    expect(rewriteLocation("http://localhost:5174/a", c.target, "http://127.0.0.1:9")).toBe("http://localhost:5174/a");
  });
});

describe("local links in chat", () => {
  const urls = (s: string) => findLocalLinks(s).map((l) => l.text);
  it("finds local addresses, with or without a scheme", () => {
    expect(urls("open http://localhost:5173/ now")).toEqual(["http://localhost:5173/"]);
    expect(urls("跑在 localhost:3000 上了")).toEqual(["localhost:3000"]);
    expect(urls("地址：127.0.0.1:8080/api?x=1，然后")).toEqual(["127.0.0.1:8080/api?x=1"]);
    expect(urls("bind 0.0.0.0:8000 and [::1]:4000")).toEqual(["0.0.0.0:8000", "[::1]:4000"]);
    expect(urls("app.localhost:3000.")).toEqual(["app.localhost:3000"]);
    expect(urls("(see localhost:3000)")).toEqual(["localhost:3000"]);
    expect(urls("Local: http://localhost:5173/,")).toEqual(["http://localhost:5173/"]);
    expect(urls("go to localhost:3000/a/(b)")).toEqual(["localhost:3000/a/(b)"]);
    expect(urls("（见 localhost:3000/a）")).toEqual(["localhost:3000/a"]);
  });
  it("leaves other text alone", () => {
    expect(urls("runs on localhost")).toEqual([]);
    expect(urls("xlocalhost:3000 foo/localhost:3000 user@localhost:22")).toEqual([]);
    expect(urls("http://192.168.1.2:3000 and 10.0.0.1:80")).toEqual([]);
    expect(urls("localhost.evil.com:80")).toEqual([]);
  });
  it("normalizes to a URL the preview opens", () => {
    expect(findLocalLinks("localhost:3000")[0]!.url).toBe("http://localhost:3000/");
    expect(splitLocalLinks("a localhost:1 b")).toEqual(["a ", expect.objectContaining({ text: "localhost:1" }), " b"]);
    expect(localHref("http://localhost:3000/x")).toBe("http://localhost:3000/x");
    expect(localHref("https://example.com")).toBeNull();
    expect(localHref("localhost:3000")).toBeNull(); // hrefs need a scheme
  });
});

describe("path chips (mentions)", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });
  it("resolves inside the project only (../, absolute, symlink escape, missing)", async () => {
    dir = mkdtempSync(join(tmpdir(), "ac12-m-"));
    const proj = join(dir, "proj");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "a b.ts"), "x");
    writeFileSync(join(dir, "secret.txt"), "s");
    try { symlinkSync(join(dir, "secret.txt"), join(proj, "link.txt")); } catch {}
    const r = await resolveMentions(proj, [
      { rel: "src/a b.ts" }, { rel: "src", isDir: true }, { rel: "src/a b.ts" },
      { rel: "../secret.txt" }, { rel: "/etc/passwd" }, { rel: "C:/x" }, { rel: "link.txt" }, { rel: "nope.ts" },
    ]);
    // the path as the project was opened, with this OS's separators (#582: not the realpath, not always "/")
    expect(r.mentions.map((m) => [m.path, m.isDir])).toEqual([[join(proj, "src", "a b.ts"), false], [join(proj, "src"), true]]);
    expect(r.warnings).toEqual(expect.arrayContaining(["../secret.txt", "/etc/passwd", "C:/x", "nope.ts"]));
    if (process.platform !== "win32") expect(r.warnings).toContain("link.txt");
  });
  it("keeps the project path as opened when it goes through a symlink (macOS /var → /private/var, a linked workspace)", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "ac12-ml-")));
    const realProj = join(dir, "real", "proj");
    mkdirSync(join(realProj, "src"), { recursive: true });
    writeFileSync(join(realProj, "src", "a.ts"), "x");
    writeFileSync(join(dir, "outside.txt"), "o");
    const alias = join(dir, "alias");
    try { symlinkSync(join(dir, "real"), alias, "junction"); } catch { return; } // no symlinks allowed here: nothing to check
    const proj = join(alias, "proj");
    // a link inside the project that points back into it through the real path is fine; one that leaves it is not
    try { symlinkSync(join(realProj, "src", "a.ts"), join(realProj, "inner.ts")); } catch {}
    try { symlinkSync(join(dir, "outside.txt"), join(realProj, "out.txt")); } catch {}
    const r = await resolveMentions(proj, [{ rel: "src/a.ts" }, { rel: "src", isDir: true }, { rel: "." , isDir: true }, { rel: "../../outside.txt" }, { rel: "out.txt" }]);
    expect(r.mentions.map((m) => m.path)).toEqual([join(proj, "src", "a.ts"), join(proj, "src"), proj]);
    expect(r.warnings).toEqual(expect.arrayContaining(["../../outside.txt"]));
    if (existsSync(join(realProj, "out.txt"))) expect(r.warnings).toContain("out.txt");
    if (existsSync(join(realProj, "inner.ts"))) {
      const r2 = await resolveMentions(proj, [{ rel: "inner.ts" }]);
      expect(r2.mentions.map((m) => m.path)).toEqual([join(proj, "inner.ts")]);
    }
    // a project opened with a trailing separator or a "." segment is the same project
    const r3 = await resolveMentions(proj + sep + "." + sep, [{ rel: "src/a.ts" }]);
    expect(r3.mentions.map((m) => m.path)).toEqual([join(proj, "src", "a.ts")]);
  });
  it("serializes for every Agent; ACP also gets resource_link blocks", async () => {
    const P = resolve(sep, "p");
    const m = [{ path: join(P, "src", "a b.ts"), isDir: false }, { path: join(P, "src"), isDir: true }];
    const slash = sep === "\\" ? "\\" : "/";
    expect(mentionSection(m)).toBe(`Referenced files (read them as needed):\n- \`${m[0]!.path}\`\n- ${m[1]!.path}${slash} (folder)`);
    expect(mentionSection([{ path: "/p/src/a b.ts", isDir: false }, { path: "/p/src", isDir: true }])).toBe("Referenced files (read them as needed):\n- `/p/src/a b.ts`\n- /p/src/ (folder)");
    expect(withMentions("fix it", m)).toBe("fix it\n\n" + mentionSection(m));
    expect(withMentions("", m)).toBe(mentionSection(m));
    expect(withMentions("x", [])).toBe("x");
    expect(mentionSection([{ path: "C:\\p\\src", isDir: true }])).toContain("C:\\p\\src\\ (folder)");
    const built = await buildAcpPrompt(withMentions("fix", m), [], { image: false, audio: false, embeddedContext: false }, m);
    expect(built.blocks[0]).toMatchObject({ type: "text" });
    expect(built.blocks.filter((b) => b.type === "resource_link").map((b) => (b as { uri: string }).uri)).toEqual([pathToFileURL(m[0]!.path).href, pathToFileURL(m[1]!.path).href]);
    if (sep === "/") expect(pathToFileURL(m[0]!.path).href).toBe("file:///p/src/a%20b.ts");
  });
  it("insideRoot handles Windows case and prefixes", () => {
    expect(insideRoot("C:\\Work\\App", "c:\\work\\app\\src", "win32")).toBe(true);
    expect(insideRoot("C:\\Work\\App", "C:\\Work\\App2\\x", "win32")).toBe(false);
    expect(insideRoot("/a/b", "/a/bc", "linux")).toBe(false);
  });
  it("composer side: drag data, dedupe, send shape, resend paths", () => {
    expect(parseMentionDrag(JSON.stringify({ projectId: "p1", rel: "src/a.ts", isDir: false }))).toEqual({ projectId: "p1", rel: "src/a.ts", isDir: false });
    expect(parseMentionDrag("{bad")).toBeNull();
    expect(parseMentionDrag(JSON.stringify({ projectId: 1, rel: "x" }))).toBeNull();
    let list = addMention([], { projectId: "p", rel: "a", isDir: false });
    list = addMention(list, { projectId: "p", rel: "a", isDir: false });
    list = addMention(list, { projectId: "p", rel: "d", isDir: true });
    expect(mentionsForSend(list)).toEqual([{ rel: "a", isDir: false }, { rel: "d", isDir: true }]);
    expect(joinProjectPath("/home/u/p", "src/a.ts")).toBe("/home/u/p/src/a.ts");
    expect(joinProjectPath("C:\\work\\p\\", "src/a.ts")).toBe("C:\\work\\p\\src\\a.ts");
    expect(relFromAbs("/home/u/p", "/home/u/p/src/a.ts")).toBe("src/a.ts");
    expect(relFromAbs("C:\\Work\\P", "c:\\work\\p\\src")).toBe("src");
    expect(relFromAbs("/home/u/p", "/home/u/p2/x")).toBeNull();
  });
});

describe("content width and chat font size", () => {
  it("settings accept the presets and 12–18 px only", () => {
    expect(DEFAULT_SETTINGS.contentWidth).toBe("default");
    expect(DEFAULT_SETTINGS.chatFontSize).toBe(13);
    for (const w of ["narrow", "default", "wide", "full"]) expect(parseSettingsPatch({ contentWidth: w }).ok).toBe(true);
    expect(parseSettingsPatch({ contentWidth: "huge" }).ok).toBe(false);
    expect(parseSettingsPatch({ chatFontSize: 12 }).ok).toBe(true);
    expect(parseSettingsPatch({ chatFontSize: 18 }).ok).toBe(true);
    expect(parseSettingsPatch({ chatFontSize: 11 }).ok).toBe(false);
    expect(parseSettingsPatch({ chatFontSize: 19 }).ok).toBe(false);
    expect(parseSettingsPatch({ chatFontSize: 13.5 }).ok).toBe(false);
    expect(parseSettingsPatch({ sidebarHidden: true }).ok).toBe(true);
    expect(sanitizeStored({ contentWidth: "x", chatFontSize: 40, theme: "dark" })).toEqual({ theme: "dark" });
  });
  it("maps to CSS values", () => {
    expect(colValue("narrow")).toBe("640px");
    expect(colValue("default")).toBe("720px");
    expect(colValue("wide")).toBe("880px");
    expect(colValue("full")).toBe("100%");
    expect(colValue("bogus")).toBe("720px");
    expect(normalizeContentWidth(undefined)).toBe("default");
    expect(normalizeChatFont(undefined)).toBe(13);
    expect(normalizeChatFont(9)).toBe(12);
    expect(normalizeChatFont(30)).toBe(18);
    expect(normalizeChatFont("16")).toBe(16);
  });
});

describe("live Magpie theme (bridge messages after the redirect)", () => {
  it("reads theme events and our hello answer only", () => {
    expect(themeFromMessage({ magpie: 1, event: "theme", data: { dark: true, lang: "zh", tokens: { bg: "#111" } } }, 5)).toEqual({ dark: true, lang: "zh", tokens: { bg: "#111" } });
    expect(themeFromMessage({ magpie: 1, id: 5, result: { dark: false, tokens: {} } }, 5)).toEqual({ dark: false, tokens: {} });
    expect(themeFromMessage({ magpie: 1, id: 6, result: { dark: false } }, 5)).toBeNull();
    expect(themeFromMessage({ event: "theme", data: { dark: true } }, 5)).toBeNull();
    expect(themeFromMessage({ magpie: 1, event: "theme", data: { dark: "yes" } }, 5)).toBeNull();
    expect(parseMagpieTheme({ dark: true, tokens: [1] })).toEqual({ dark: true, tokens: {} });
  });
  it("keeps neutral tokens, drops the accent and odd values", () => {
    expect(magpieTokenVars({ bg: "#111", "fg-2": "#eee", accent: "#f00", "accent-soft": "#f00", bad: "red;}", "x y": "1", font: "Inter, sans-serif" })).toEqual({
      "--magpie-bg": "#111", "--magpie-fg-2": "#eee", "--magpie-font": "Inter, sans-serif",
    });
  });
});

describe("1.2 QA fixes", () => {
  it("Claude Write says Create for a new file, Overwrite for an existing one", async () => {
    const { targetExists, callInfo } = await import("../../daemon/src/agents/kinds.js");
    const dir = mkdtempSync(join(tmpdir(), "ac12-k-"));
    writeFileSync(join(dir, "old.txt"), "x");
    expect(targetExists({ file_path: join(dir, "old.txt") })).toBe(true);
    expect(targetExists({ file_path: "old.txt" }, dir)).toBe(true);
    expect(targetExists({ file_path: join(dir, "new.txt") })).toBe(false);
    expect(targetExists({})).toBe(false);
    const create = callInfo("Write", { file_path: join(dir, "new.txt"), _exists: targetExists({ file_path: join(dir, "new.txt") }) }, dir);
    expect(create.title).toMatch(/新建|Create/);
    rmSync(dir, { recursive: true, force: true });
  });
  it("the theme bridge carries Magpie's language, and the UI language can switch at runtime", async () => {
    expect(parseMagpieTheme({ dark: false, lang: "en", tokens: {} })).toEqual({ dark: false, lang: "en", tokens: {} });
    expect(parseMagpieTheme({ dark: false, lang: "x".repeat(40) })).toEqual({ dark: false, tokens: {} });
    const i18n = await import("../../web/src/i18n/index.js");
    i18n.initLocale("?lang=zh");
    expect(i18n.t("sidebar.newProject")).toBe("新建项目");
    expect(i18n.setLocale("en")).toBe(true);
    expect(i18n.t("sidebar.newProject")).toBe("New project");
    expect(i18n.setLocale("en-US")).toBe(false);
    expect(i18n.setLocale("zh-TW")).toBe(true);
    expect(i18n.tf("timeline.cat.read", { n: 1 })).toBe("读取 1");
  });
  it("every new 1.2 key exists in both languages", async () => {
    const { messages } = await import("../../web/src/i18n/messages.js");
    const keys = (o: Record<string, unknown>, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === "object" && v ? keys(v as Record<string, unknown>, p + k + ".") : [p + k]));
    const zh = new Set(keys(messages.zh as unknown as Record<string, unknown>));
    const en = new Set(keys(messages.en as unknown as Record<string, unknown>));
    for (const k of ["preview.tab", "preview.empty", "preview.limits", "preview.noLocalhost", "links.openPreviewTitle", "links.externalFailed", "mention.add", "mention.drop", "sidebar.collapse", "sidebar.expand", "settings.contentWidth", "settings.chatFont", "timeline.cat.read"]) {
      expect(zh.has(k), "zh " + k).toBe(true);
      expect(en.has(k), "en " + k).toBe(true);
    }
    expect([...zh].filter((k) => !en.has(k) && !k.startsWith("composer.agentMode."))).toEqual([]);
    expect([...en].filter((k) => !zh.has(k))).toEqual([]);
  });
});
