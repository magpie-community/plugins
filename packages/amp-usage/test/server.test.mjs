import { request } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../lib/server.mjs";

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
  const denied = await fetch(base + "/api/status");
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "reconnect");
  assert.equal(
    (
      await fetch(base + "/api/status", {
        headers: { "x-amp-usage-token": token, origin: "https://evil.test" },
      })
    ).status,
    403,
  );
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
