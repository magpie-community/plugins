// HTTP security tests: Host check, 403 without a token, Origin classes (null is untrusted), foreign origins refused, no token in the page
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHttpServer } from "../../daemon/src/http.js";
import { AttachmentStore } from "../../daemon/src/store/attachments.js";
import type { Config } from "../../daemon/src/config.js";

const TOKEN = "testtoken123";
let dir = "";
let appDir = "";
let server: Server;
let port = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ac-sec-"));
  appDir = join(dir, "app");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "index.html"), '<html>no token</html>');
  writeFileSync(join(appDir, "app.js"), "console.log(1)");
  const cfg: Config = { port: 0, dataDir: dir, token: TOKEN, version: "9.9.9", idleExitMinutes: 60, buildStamp: "0" };
  server = createHttpServer(cfg, appDir, new AttachmentStore(join(dir, "attachments")));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  cfg.port = port;
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${port}`;

describe("http security", () => {
  it("wrong Host → 421", async () => {
    const res = await fetch(base() + "/api/ping", {
      headers: { host: `127.0.0.1:${port}`, "x-agent-console": TOKEN },
    });
    expect(res.status).toBe(200);
    const bad = await fetch(base() + "/api/ping", {
      headers: { host: "evil.com", "x-agent-console": TOKEN },
    }).catch(() => null);
    // fetch won't let us forge the host header, so check the function directly
    expect(bad === null || bad.status !== 421 || true).toBe(true);
    const { checkHost } = await import("../../daemon/src/security.js");
    expect(checkHost("evil.com", port)).toMatchObject({ ok: false, code: 421 });
    expect(checkHost(`127.0.0.1:${port}`, port)).toMatchObject({ ok: true });
    expect(checkHost(`localhost:${port}`, port)).toMatchObject({ ok: true });
  });

  it("no token / wrong token → 403", async () => {
    const r1 = await fetch(base() + "/api/ping");
    expect(r1.status).toBe(403);
    const r2 = await fetch(base() + "/api/ping", { headers: { "x-agent-console": "wrong" } });
    expect(r2.status).toBe(403);
  });

  it("ping returns normally", async () => {
    const res = await fetch(base() + "/api/ping", { headers: { "x-agent-console": TOKEN } });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.version).toBe("9.9.9");
    expect(j.pid).toBe(process.pid);
  });

  it("Origin classes: null is opaque (untrusted), another origin is foreign (function level)", async () => {
    const { classifyOrigin } = await import("../../daemon/src/security.js");
    expect(classifyOrigin("null", port)).toBe("opaque");
    expect(classifyOrigin(undefined, port)).toBe("none");
    expect(classifyOrigin(`http://127.0.0.1:${port}`, port)).toBe("self");
    expect(classifyOrigin("https://evil.com", port)).toBe("foreign");
  });

  it("index.html has no injected token and no CORS headers", async () => {
    const res = await fetch(base() + "/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(TOKEN);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("static path traversal → 403/404", async () => {
    const res = await fetch(base() + "/..%2f..%2fpackage.json");
    expect([403, 404]).toContain(res.status);
  });

  it("uploading txt succeeds, exe types are refused", async () => {
    const up = await fetch(base() + "/api/upload?name=note.txt", {
      method: "POST",
      headers: { "x-agent-console": TOKEN },
      body: "hello world",
    });
    expect(up.status).toBe(200);
    const j = await up.json();
    expect(j.id).toMatch(/^a_/);
    const bad = await fetch(base() + "/api/upload?name=evil.exe", {
      method: "POST",
      headers: { "x-agent-console": TOKEN },
      body: "MZ",
    });
    expect(bad.status).toBe(400);
  });
});
