import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startServer } from "../lib/server.mjs";

const data = {
  period: "7d",
  generatedAt: "2026-10-31T00:00:00.000Z",
  summary: { accounts: 0, calls: 0, tokens: 0 },
  accounts: [],
  warnings: [],
};

// Several loopback servers run in this file. On Windows the HTTP client can
// still be retiring a reused socket as the next test finishes; keep them
// serial so one server's teardown cannot overlap another's.
test("the page's service routes", { concurrency: false }, async (t) => {
  await t.test("serves a token-protected account tree", async (t) => {
    const info = await startServer({
      port: 0,
      load: async () => data,
    });
    t.after(async () => {
      await info.close();
    });

    const html = await fetch(`http://127.0.0.1:${info.port}/`);
    assert.equal(html.status, 200);
    const htmlBody = await html.text();
    assert.match(htmlBody, /meta name="usage-tree-token"/);
    assert.match(htmlBody, /<main class="view">/);
    assert.match(htmlBody, /usage-tree-currency" content="usd"/);

    const configured = await fetch(
      `http://127.0.0.1:${info.port}/?lang=zh&theme=dark&currency=cny&chineseUnits=1&usdCny=7.2`,
    );
    assert.equal(configured.status, 200);
    const configuredBody = await configured.text();
    assert.match(configuredBody, /usage-tree-currency" content="cny"/);
    assert.match(configuredBody, /usage-tree-chinese-units" content="true"/);
    assert.match(configuredBody, /usage-tree-usd-cny" content="7.2"/);

    const denied = await fetch(`http://127.0.0.1:${info.port}/api/tree?period=7d`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`http://127.0.0.1:${info.port}/api/tree?period=7d`, {
      headers: { "x-usage-tree-token": info.token },
    });
    assert.equal(allowed.status, 200);
    const jsonBody = await allowed.json();
    assert.deepEqual(jsonBody, data);
  });

  await t.test("answers the preflight for both page APIs", async (t) => {
    const info = await startServer({
      port: 0,
      load: async () => data,
    });
    t.after(async () => {
      await info.close();
    });

    for (const path of ["/api/tree", "/api/settings"]) {
      const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
        method: "OPTIONS",
        headers: {
          Origin: "null",
          "Access-Control-Request-Headers": "x-usage-tree-token",
        },
      });
      assert.equal(res.status, 204, `${path} preflight`);
      assert.equal(res.headers.get("access-control-allow-origin"), "null");
      assert.match(res.headers.get("access-control-allow-headers"), /token/);
    }
  });

  await t.test("a failed fresh read keeps the old answer marked stale", async (t) => {
    let calls = 0;
    const info = await startServer({
      port: 0,
      load: async (_period, options) => {
        calls += 1;
        if (options.fresh) throw new Error("gateway down");
        return { ...data, revision: calls };
      },
    });
    t.after(async () => {
      await info.close();
    });

    const html = await (await fetch(`http://127.0.0.1:${info.port}/`)).text();
    const token = html.match(/name="usage-tree-token" content="([^"]+)"/)?.[1];
    assert.ok(token);

    const first = await fetch(`http://127.0.0.1:${info.port}/api/tree?period=7d`, {
      headers: { "x-usage-tree-token": token },
    });
    assert.equal(first.status, 200);

    const fresh = await fetch(`http://127.0.0.1:${info.port}/api/tree?period=7d&fresh=1`, {
      headers: { "x-usage-tree-token": token },
    });
    const body = await fresh.json();
    assert.equal(fresh.status, 200);
    assert.equal(fresh.headers.get("x-usage-tree-cache"), "stale");
    assert.equal(body.stale, true);
    assert.equal(body.revision, 1);
  });

  await t.test("rejects a non-loopback host", async (t) => {
    const info = await startServer({
      port: 0,
      load: async () => data,
    });

    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: info.port,
          path: "/healthz",
          headers: { Host: `example.com:${info.port}` },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await info.close();
  });
});
