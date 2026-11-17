import { test } from "node:test";
import assert from "node:assert/strict";
import { get } from "node:http";
import { startServer } from "../lib/server.mjs";

test("本地页面提供额度接口，校验页面凭证、来源和静态路径", async (context) => {
  let forced = false;
  const service = await startServer({
    port: 0,
    reader: async ({ force }) => {
      forced = force;
      return { accounts: [], source: "gateway" };
    },
  });
  context.after(() => {
    service.server.closeAllConnections();
    return new Promise((resolve) => service.server.close(resolve));
  });
  const base = `http://127.0.0.1:${service.port}`;
  const page = await new Promise((resolve, reject) => {
    get(`${base}/`, { headers: { "sec-fetch-mode": "navigate" } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    }).on("error", reject);
  });
  assert.equal(page.status, 200);
  const key = page.body.match(/name="page-key" content="([^"]+)"/)[1];
  assert.ok(key.length >= 32);
  assert.match(page.headers["content-security-policy"], new RegExp(`http://127.0.0.1:${service.port}`));
  assert.equal((await fetch(`${base}/`)).status, 403);
  const unauthorized = await fetch(`${base}/api/report`);
  assert.equal(unauthorized.status, 401);
  const headers = { "x-provider-quota-key": key, Origin: "null" };
  const response = await fetch(`${base}/api/report?refresh=1`, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "null");
  assert.equal(forced, true);
  assert.deepEqual(await response.json(), { accounts: [], source: "gateway" });
  const external = await fetch(`${base}/api/report`, { headers: { ...headers, Origin: "https://example.test" } });
  assert.equal(external.status, 403);
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/lib/data.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/api/report`, { method: "POST", headers })).status, 405);
  const preflight = await fetch(`${base}/api/report`, { method: "OPTIONS", headers: { Origin: "null" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-headers"), "x-provider-quota-key");
});
