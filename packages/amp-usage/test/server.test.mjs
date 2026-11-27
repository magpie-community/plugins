import { request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../lib/server.mjs";
import { acquireLock } from "../lib/collector.mjs";
import plugin from "../index.mjs";

test("loopback service protects every API and accepts authenticated sandbox requests", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "amp-service-"));
  let scanned = 0;
  const fake = {
    view: () => ({ phase: "idle" }),
    run: async () => {
      scanned++;
    },
    close: async () => {},
  };
  const s = await startServer({
    port: 0,
    dataDir: dir,
    configDir: dir,
    collector: fake,
  });
  t.after(async () => {
    await s.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${s.port}`;
  // Only a navigation reads the page that carries the token; Node's fetch
  // always says cors.
  const page = (mode) =>
    new Promise((resolve, reject) => {
      const req = request(
        base,
        { headers: { "sec-fetch-mode": mode } },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () =>
            resolve({ status: res.statusCode, body, headers: res.headers }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  assert.equal((await page("cors")).status, 403);
  const root = await page("navigate");
  assert.equal(root.headers["access-control-allow-origin"], undefined);
  const token = root.body.match(
    /name="service-token" content="([a-f0-9]+)"/,
  )[1];
  const denied = await fetch(base + "/api/status", {
    headers: { origin: "null", "x-amp-usage-token": "stale" },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), "null");
  assert.equal(denied.headers.get("vary"), "Origin");
  assert.equal((await denied.json()).code, "reconnect");
  const staleRefresh = await fetch(base + "/api/refresh", {
    method: "POST",
    headers: {
      origin: "null",
      "x-amp-usage-token": "stale",
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(staleRefresh.status, 403);
  assert.equal(staleRefresh.headers.get("access-control-allow-origin"), "null");
  assert.equal(scanned, 0);
  const foreign = await fetch(base + "/api/status", {
    headers: { "x-amp-usage-token": token, origin: "https://evil.test" },
  });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get("access-control-allow-origin"), null);
  const badHost = await new Promise((resolve, reject) => {
    const req = request(
      base + "/api/status",
      { headers: { "x-amp-usage-token": token, Host: "evil.test" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(badHost, 403);
  const response = await fetch(base + "/api/refresh", {
    method: "POST",
    headers: {
      "x-amp-usage-token": token,
      origin: "null",
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("access-control-allow-origin"), "null");
  assert.equal(scanned, 1);
  assert.equal(
    (
      await fetch(base + "/api/refresh", {
        method: "POST",
        headers: {
          "x-amp-usage-token": token,
          "content-type": "application/json",
        },
        body: "{",
      })
    ).status,
    400,
  );
  assert.equal((await fetch(base + "/unknown")).status, 404);
});

test("a page opened before the service restarts keeps working", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "amp-service-"));
  const fake = { view: () => ({ phase: "idle" }), close: async () => {} };
  const tokenOf = async (s) => {
    const html = await new Promise((resolve, reject) => {
      const req = request(
        `http://127.0.0.1:${s.port}/`,
        { headers: { "sec-fetch-mode": "navigate" } },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve(body));
        },
      );
      req.on("error", reject);
      req.end();
    });
    return html.match(/name="service-token" content="([a-f0-9]+)"/)[1];
  };
  const first = await startServer({ port: 0, dataDir: dir, collector: fake });
  const token = await tokenOf(first);
  await first.close();
  const second = await startServer({ port: 0, dataDir: dir, collector: fake });
  t.after(async () => {
    await second.close();
    await rm(dir, { recursive: true, force: true });
  });
  const r = await fetch(`http://127.0.0.1:${second.port}/api/status`, {
    headers: { origin: "null", "x-amp-usage-token": token },
  });
  assert.equal(r.status, 200);
  assert.equal(await tokenOf(second), token);
});

test("a service whose lock is still held waits for it without blocking the host", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warned = t.mock.method(console, "warn", () => {});
  const dir = await mkdtemp(join(tmpdir(), "amp-service-"));
  const port = await new Promise((resolve) => {
    const s = createNetServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
  const status = () =>
    new Promise((resolve) => {
      const req = request(`http://127.0.0.1:${port}/`, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", () => resolve(0));
      req.end();
    });
  // A retiring host's service, as Magpie's update restart leaves it.
  const release = await acquireLock(join(dir, "amp-usage"));
  t.after(async () => {
    // An invalid port fails at once, after closing the service it replaces.
    await assert.rejects(plugin.server({ directory: dir }, { port: -1 }));
    await rm(dir, { recursive: true, force: true });
  });
  assert.deepEqual(await plugin.server({ directory: dir }, { port }), {});
  assert.equal(warned.mock.callCount(), 1);
  assert.equal(await status(), 0);
  t.mock.timers.tick(5_000);
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  assert.equal(await status(), 0);
  await release();
  t.mock.timers.tick(5_000);
  let code = 0;
  for (let i = 0; i < 200 && !code; i++) {
    await new Promise((r) => setImmediate(r));
    code = await status();
  }
  assert.equal(code, 200);
  assert.equal(warned.mock.callCount(), 1);
});
