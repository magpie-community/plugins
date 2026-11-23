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
  assert.deepEqual(await response.json(), { accounts: [], source: "gateway", canReset: false });
  const external = await fetch(`${base}/api/report`, { headers: { ...headers, Origin: "https://example.test" } });
  assert.equal(external.status, 403);
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/lib/data.mjs`)).status, 404);
  assert.equal((await fetch(`${base}/api/report`, { method: "POST", headers })).status, 405);
  const preflight = await fetch(`${base}/api/report`, { method: "OPTIONS", headers: { Origin: "null" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-headers"), "x-provider-quota-key, content-type");
});

test("页面可为有重置卡的账号使用重置卡，密钥只保存在服务内存中", async (context) => {
  const account = {
    id: "codex-one", user: "one@example.test", resets: { count: 2, each: [{ id: "a" }, { id: "b" }] },
    resetTarget: { user: "one@example.test", provider: "" },
  };
  const asked = [];
  const service = await startServer({
    port: 0,
    reader: async () => ({ accounts: [account, { id: "plain", resets: null, resetTarget: null }], source: "gateway" }),
    resetter: async (ask) => {
      asked.push(ask);
      if (ask.key !== "gk-test") throw Object.assign(new Error("bad key"), { code: "bad_key", status: 401 });
      return { code: "reset", windows: 2 };
    },
  });
  context.after(() => {
    service.server.closeAllConnections();
    return new Promise((resolve) => service.server.close(resolve));
  });
  const base = `http://127.0.0.1:${service.port}`;
  const page = await new Promise((resolve, reject) => {
    get(`${base}/`, { headers: { "sec-fetch-mode": "navigate" } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve(text));
    }).on("error", reject);
  });
  const key = page.match(/name="page-key" content="([^"]+)"/)[1];
  const post = (body, headers = {}) => fetch(`${base}/api/reset`, {
    method: "POST",
    headers: { "x-provider-quota-key": key, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  assert.equal((await post({ id: "codex-one" }, { "x-provider-quota-key": "wrong" })).status, 401);
  assert.equal((await fetch(`${base}/api/reset`, { headers: { "x-provider-quota-key": key } })).status, 405);
  assert.equal((await post({ id: "plain" })).status, 404);
  assert.equal((await post({ id: "codex-one", credit: "missing" })).status, 400);
  const denied = await post({ id: "codex-one", key: "wrong" });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).code, "bad_key");
  const used = await post({ id: "codex-one", credit: "b", key: "gk-test" });
  assert.equal(used.status, 200);
  const body = await used.json();
  assert.equal(body.code, "reset");
  assert.equal(body.report.canReset, true);
  assert.deepEqual(asked.at(-1), { user: "one@example.test", provider: "", credit: "b", key: "gk-test" });
  assert.equal((await post({ id: "codex-one" })).status, 200);
  assert.equal(asked.at(-1).key, "gk-test");
  const report = await fetch(`${base}/api/report`, { headers: { "x-provider-quota-key": key } }).then((response) => response.json());
  assert.equal(report.canReset, true);
  assert.ok(!JSON.stringify(report).includes("gk-test"));
});
