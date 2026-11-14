import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import plugin from "../index.mjs";
import { DATA } from "../runtime.mjs";
import { createService } from "../service.mjs";
import { VERSION } from "../version.mjs";

function rawGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", c => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("page nonce protects API, sandbox CORS does not expose HTML, Host/Origin/CSP guards hold (B1/B2/B3/B5)", async t => {
  const calls = [];
  let snapshots = 0;
  const server = createService({
    snapshot: async () => { snapshots++; return { policy: {}, history: [] }; },
    savePolicy: async x => { calls.push(x); return x; },
  }, { agents: () => [], instanceId: "test-instance-01" });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => server.close(r)));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/`;

  // B5 & CSP frame-ancestors check on HTML
  const page = await fetch(base);
  assert.equal(page.headers.get("access-control-allow-origin"), null);
  const csp = page.headers.get("content-security-policy") || "";
  assert.match(csp, /frame-ancestors 'self' http:\/\/127\.0\.0\.1:\*.*wails:/);
  const token = (await page.text()).match(/name="search-center-token" content="([^"]+)"/)[1];

  // B3: DNS rebinding / bad Host header rejected with 403 HOST_DENIED
  const badHost = await rawGet(port, "/api/state", { Host: `evil.example:${port}`, "X-Search-Center": token });
  assert.equal(badHost.status, 403);
  assert.equal(JSON.parse(badHost.body).code, "HOST_DENIED");
  const badHostRoot = await rawGet(port, "/", { Host: `evil.example:${port}` });
  assert.equal(badHostRoot.status, 403);

  const health = await (await fetch(base + "health")).json();
  assert.equal(health.plugin, "magpie-search-center");
  assert.equal(health.version, VERSION);
  assert.equal(health.instanceId, "test-instance-01");

  for (const asset of ["magpie.css", "vendor/dsh/route.css", "vendor/dsh/search-log.css"]) {
    assert.equal((await fetch(base + asset)).status, 200, asset);
  }
  assert.equal((await fetch(base + "api/state")).status, 403);

  const expired = await fetch(base + "api/state", { headers: { "X-Search-Center": "expired-page-nonce", Origin: "null" } });
  assert.equal(expired.status, 200);
  assert.deepEqual(await expired.json(), { uiVersion: VERSION, sessionExpired: true });
  assert.equal(snapshots, 0, "expired pages must not access private state");

  const unauthorizedSave = await fetch(base + "api/policy", { method: "POST", headers: { "X-Search-Center": "expired-page-nonce" }, body: "{}" });
  assert.equal(unauthorizedSave.status, 403);
  assert.equal(calls.length, 0);

  // B2: Cross-origin POST/GET rejected
  assert.equal((await fetch(base + "api/state", { headers: { "X-Search-Center": token, Origin: "https://evil.example" } })).status, 403);
  const textPlainNoNonce = await fetch(base + "api/policy", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: '{"revision":1}',
  });
  assert.equal(textPlainNoNonce.status, 403);

  const valid = await fetch(base + "api/state", { headers: { "X-Search-Center": token, Origin: "null" } });
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).uiVersion, VERSION);
  assert.equal(valid.headers.get("access-control-allow-origin"), "null");

  const saved = await fetch(base + "api/policy", {
    method: "POST",
    headers: { "X-Search-Center": token, "Content-Type": "application/json" },
    body: '{"revision":1}',
  });
  assert.equal(saved.status, 200);
  assert.equal(calls[0].revision, 1);
});

test("index.mjs takeover check verifies instanceId on EADDRINUSE", async t => {
  const expectedId = createHash("sha256").update(DATA).digest("hex").slice(0, 16);
  let reportedInstanceId = "other-data-dir-00";
  const fakeOccupant = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      plugin: "magpie-search-center",
      version: VERSION,
      service: "dsh-ui-port",
      instanceId: reportedInstanceId,
    }));
  });
  await new Promise(r => fakeOccupant.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => fakeOccupant.close(r)));
  const port = fakeOccupant.address().port;

  await assert.rejects(
    () => plugin.server(undefined, { port }),
    /搜索中心端口被其他服务占用/,
  );

  reportedInstanceId = expectedId;
  const hooks = await plugin.server(undefined, { port });
  assert.deepEqual(Object.keys(hooks.tool), ["search", "capabilities"]);
});
