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
    assert.match(htmlBody, /usage-tree-settings" content="0"/);
    assert.match(htmlBody, /<script src="bridge\.js">/);

    const bridge = await fetch(`http://127.0.0.1:${info.port}/bridge.js`);
    assert.equal(bridge.status, 200);
    const bridgeBody = await bridge.text();
    assert.doesNotMatch(bridgeBody, /read: \(name, params\)|call\("read"/);
    assert.match(bridgeBody, /call\("hello"\)/);
    assert.match(bridgeBody, /onTheme\(fn\)/);
    assert.match(bridgeBody, /if \(parent === window\) return Promise\.resolve\(undefined\)/);
    assert.match(bridgeBody, /call\("hello"\)\.then\(\(hello = \{\}\) => \{/);

    const configured = await fetch(
      `http://127.0.0.1:${info.port}/?lang=zh&theme=dark&currency=cny&chineseUnits=1&usdCny=7.2`,
    );
    assert.equal(configured.status, 200);
    const configuredBody = await configured.text();
    assert.match(configuredBody, /usage-tree-currency" content="cny"/);
    assert.match(configuredBody, /usage-tree-chinese-units" content="true"/);
    assert.match(configuredBody, /usage-tree-usd-cny" content="7.2"/);
    assert.match(configuredBody, /usage-tree-settings" content="0"/);

    const settingsEnabled = await fetch(`http://127.0.0.1:${info.port}/?settings=1`);
    assert.match(await settingsEnabled.text(), /usage-tree-settings" content="1"/);

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

    // A quiet follow-up must still see the stale mark and retry. Previously
    // the failure was written to an object the cache had already replaced.
    const followUp = await fetch(`http://127.0.0.1:${info.port}/api/tree?period=7d`, {
      headers: { "x-usage-tree-token": token },
    });
    const followUpBody = await followUp.json();
    assert.equal(followUp.headers.get("x-usage-tree-cache"), "stale");
    assert.equal(followUpBody.stale, true);
    assert.equal(followUp.headers.get("x-usage-tree-refresh"), "failed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(calls >= 3, "the next stale read starts another refresh");
  });

  await t.test("an older disk cache is stale without being a failed refresh", async (t) => {
    let calls = 0;
    const info = await startServer({
      port: 0,
      load: async () => {
        calls += 1;
        return calls === 1
          ? { ...data, cached: true, stale: true }
          : { ...data, revision: calls };
      },
    });
    t.after(async () => {
      await info.close();
    });

    const html = await (await fetch(`http://127.0.0.1:${info.port}/`)).text();
    const token = html.match(/name="usage-tree-token" content="([^"]+)"/)?.[1];
    assert.ok(token);
    const headers = { "x-usage-tree-token": token };

    const first = await fetch(`http://127.0.0.1:${info.port}/api/tree?period=7d`, { headers });
    const firstBody = await first.json();
    assert.equal(first.headers.get("x-usage-tree-refresh"), "ok");
    assert.equal(firstBody.stale, true);
    assert.equal(firstBody.cached, true);

    // The first stale read starts a real refresh behind the page. Once it
    // succeeds, the service stops reporting a failure and serves good data.
    await fetch(`http://127.0.0.1:${info.port}/api/tree?period=7d`, { headers });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const recovered = await fetch(`http://127.0.0.1:${info.port}/api/tree?period=7d`, { headers });
    const recoveredBody = await recovered.json();
    assert.equal(recovered.headers.get("x-usage-tree-refresh"), "ok");
    assert.notEqual(recoveredBody.stale, true);
    assert.ok(calls >= 2);
  });

  await t.test("a failed refresh stays failed until the loader really recovers", async (t) => {
    let calls = 0;
    const info = await startServer({
      port: 0,
      load: async (_period, options) => {
        calls += 1;
        if (options.fresh && calls <= 3) throw new Error("gateway down");
        return { ...data, revision: calls };
      },
    });
    t.after(async () => {
      await info.close();
    });

    const html = await (await fetch(`http://127.0.0.1:${info.port}/`)).text();
    const token = html.match(/name="usage-tree-token" content="([^"]+)"/)?.[1];
    assert.ok(token);
    const headers = { "x-usage-tree-token": token };
    const tree = (query = "") => fetch(`http://127.0.0.1:${info.port}/api/tree?period=7d${query}`, { headers });

    const initial = await tree();
    await initial.json();
    assert.equal(initial.headers.get("x-usage-tree-refresh"), "ok");

    const firstFailure = await tree("&fresh=1");
    const firstFailureBody = await firstFailure.json();
    assert.equal(firstFailure.headers.get("x-usage-tree-refresh"), "failed");
    assert.equal(firstFailureBody.stale, true);
    assert.equal(firstFailureBody.revision, 1);

    // A follow-up while the gateway is still down must not accidentally
    // clear the failure, even though a new retry now owns the cache entry.
    const secondFailure = await tree("&fresh=1");
    const secondFailureBody = await secondFailure.json();
    assert.equal(secondFailure.headers.get("x-usage-tree-refresh"), "failed");
    assert.equal(secondFailureBody.stale, true);
    assert.equal(secondFailureBody.revision, 1);

    const recovered = await tree("&fresh=1");
    const recoveredBody = await recovered.json();
    assert.equal(recovered.headers.get("x-usage-tree-refresh"), "ok");
    assert.notEqual(recoveredBody.stale, true);
    assert.equal(recoveredBody.revision, 4);
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
