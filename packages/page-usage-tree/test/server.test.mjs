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

test("serves a token-protected account tree", async (t) => {
  const info = await startServer({
    port: 0,
    load: async () => data,
  });
  t.after(() => info.close());

  const html = await fetch(`http://127.0.0.1:${info.port}/`);
  assert.equal(html.status, 200);
  const body = await html.text();
  assert.match(body, /meta name="usage-tree-token"/);
  assert.match(body, /<main class="view">/);

  const denied = await fetch(`http://127.0.0.1:${info.port}/api/tree?period=7d`);
  assert.equal(denied.status, 401);

  const allowed = await fetch(`http://127.0.0.1:${info.port}/api/tree?period=7d`, {
    headers: { "x-usage-tree-token": info.token },
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), data);
});

test("rejects a non-loopback host", async (t) => {
  const info = await startServer({
    port: 0,
    load: async () => data,
  });
  t.after(() => info.close());

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
});
