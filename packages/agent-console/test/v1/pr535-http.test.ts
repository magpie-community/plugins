// PR #535 review reproduction: the daemon's HTTP + WS Host / Origin / token policy.
// Uses node:http and the ws client so the Host and Origin headers can be set explicitly (fetch doesn't allow it).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createHttpServer } from "../../daemon/src/http.js";
import { AttachmentStore } from "../../daemon/src/store/attachments.js";
import { Gateway } from "../../daemon/src/ws/gateway.js";
import type { Config } from "../../daemon/src/config.js";
import { request as rawRequest } from "./helpers-net.js";

const token = "pr535-token-0123456789abcdef";
const EVIL = "https://evil.example";
let server: http.Server;
let gateway: Gateway;
let port: number;
let dir: string;

const request = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  rawRequest(port, path, headers, method);

// When the WS upgrade is refused the ws client fires unexpected-response, which gives us the status code
function upgradeStatus(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("open", () => {
      resolve(101);
      ws.terminate();
    });
    ws.on("error", () => resolve(-1));
  });
}

// Optionally send hello after connecting; returns the first message or the close code
function wsSession(hello: string | null): Promise<{ message?: any; closeCode?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: "null" } });
    ws.on("open", () => {
      if (hello !== null) ws.send(JSON.stringify({ t: "hello", token: hello, v: 1 }));
    });
    ws.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.t === "hello.ok") {
        resolve({ message });
        ws.close();
      }
    });
    ws.on("close", (code) => resolve({ closeCode: code }));
    ws.on("error", () => {});
  });
}

describe("PR535 HTTP and WS policy", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "pr535-http-"));
    const app = join(dir, "app");
    mkdirSync(app);
    writeFileSync(join(app, "index.html"), "<!doctype html><title>safe page</title>");
    writeFileSync(join(app, "app.js"), "console.log(1)");
    const cfg: Config = {
      port: 0,
      dataDir: dir,
      token,
      version: "test",
      idleExitMinutes: 60,
      buildStamp: "test",
    };
    gateway = new Gateway(cfg);
    server = createHttpServer(cfg, app, new AttachmentStore(join(dir, "attachments")), {
      onUpgrade: (req, socket, head) => gateway.handleUpgrade(req, socket, head),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    // Same as the daemon's main.ts: write back the actual port after listen
    cfg.port = port;
  });

  afterAll(async () => {
    gateway.closeAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("Origin: null GET / → 403, no token, no ACAO", async () => {
    const res = await request("/", { origin: "null" });
    expect(res.status).toBe(403);
    expect(res.body).not.toContain(token);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    const js = await request("/app.js", { origin: "null" });
    expect(js.status).toBe(403);
    expect(js.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("GET / without Origin → 200, no token, no ACAO, hardened headers", async () => {
    const res = await request("/");
    expect(res.status).toBe(200);
    expect(res.body).not.toContain(token);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("foreign Origin → 403 on /, on /api/ping even with the token, on OPTIONS /api/upload", async () => {
    expect((await request("/", { origin: EVIL })).status).toBe(403);
    const ping = await request("/api/ping", { origin: EVIL, "x-agent-console": token });
    expect(ping.status).toBe(403);
    expect(ping.headers["access-control-allow-origin"]).toBeUndefined();
    const pre = await request("/api/upload", { origin: EVIL, "access-control-request-method": "POST" }, "OPTIONS");
    expect(pre.status).toBe(403);
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("bad Host → 421 on /, /api/ping (with token) and OPTIONS /api/upload", async () => {
    for (const host of [`evil.example:${port}`, `127.0.0.1:${port + 1}`]) {
      expect((await request("/", { host })).status).toBe(421);
      expect((await request("/api/ping", { host, "x-agent-console": token })).status).toBe(421);
      expect((await request("/api/upload", { host, origin: "null" }, "OPTIONS")).status).toBe(421);
    }
  });

  it("/api/ping: valid token + Origin null → 200 with ACAO null; no token → 403 without ACAO", async () => {
    const ok = await request("/api/ping", { origin: "null", "x-agent-console": token });
    expect(ok.status).toBe(200);
    expect(ok.headers["access-control-allow-origin"]).toBe("null");
    expect(ok.headers["access-control-allow-credentials"]).toBeUndefined();
    const bad = await request("/api/ping", { origin: "null" });
    expect(bad.status).toBe(403);
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
    const wrong = await request("/api/ping", { origin: "null", "x-agent-console": "wrong" });
    expect(wrong.status).toBe(403);
    expect(wrong.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("OPTIONS /api/upload with Origin null → 204 ACAO null; other preflights refused", async () => {
    const pre = await request("/api/upload", { origin: "null", "access-control-request-method": "POST" }, "OPTIONS");
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe("null");
    expect(pre.headers["access-control-allow-headers"]).toContain("x-agent-console");
    expect(pre.headers["access-control-allow-credentials"]).toBeUndefined();
    expect((await request("/api/ping", { origin: "null" }, "OPTIONS")).status).toBe(403);
    expect((await request("/", { origin: "null" }, "OPTIONS")).status).toBe(403);
  });

  it("WS upgrade: foreign Origin → 403, bad Host → 421", async () => {
    expect(await upgradeStatus({ Origin: EVIL })).toBe(403);
    expect(await upgradeStatus({ Host: `evil.example:${port}` })).toBe(421);
    expect(await upgradeStatus({ Host: `127.0.0.1:${port + 1}`, Origin: "null" })).toBe(421);
  });

  it("WS: wrong token → 4401; right token + Origin null → hello.ok", async () => {
    expect((await wsSession("wrong")).closeCode).toBe(4401);
    const ok = await wsSession(token);
    expect(ok.message?.t).toBe("hello.ok");
  });

  it("WS: Origin null without hello → closed 4401 within 7 s", async () => {
    const started = Date.now();
    const result = await wsSession(null);
    expect(result.closeCode).toBe(4401);
    expect(Date.now() - started).toBeLessThan(7000);
  }, 10000);
});
