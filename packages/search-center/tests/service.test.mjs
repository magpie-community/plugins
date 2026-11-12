import test from "node:test";
import assert from "node:assert/strict";
import { createService } from "../service.mjs";
import { VERSION } from "../version.mjs";
test("page nonce protects API, sandbox CORS does not expose HTML, and endpoint rejects bad origins", async t => {
  const calls = [];
  let snapshots = 0;
  const server = createService({
    snapshot: async () => { snapshots++; return { policy: {}, history: [] }; },
    savePolicy: async x => { calls.push(x); return x; },
  }, { agents: () => [] });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const page = await fetch(base);
  assert.equal(page.headers.get("access-control-allow-origin"), null);
  const token = (await page.text()).match(/name="search-center-token" content="([^"]+)"/)[1];
  const health = await (await fetch(base + "health")).json();
  assert.equal(health.plugin, "magpie-search-center"); assert.equal(health.version,VERSION);
  for (const path of ["magpie.css", "vendor/dsh/route.css", "vendor/dsh/search-log.css"])
    assert.equal((await fetch(base + path)).status, 200, path);
  assert.equal((await fetch(base + "api/state")).status, 403);
  const expired = await fetch(base + "api/state", { headers: { "X-Search-Center": "expired-page-nonce", Origin: "null" } });
  assert.equal(expired.status, 200);
  assert.deepEqual(await expired.json(), { uiVersion: VERSION, sessionExpired: true });
  assert.equal(snapshots, 0, "expired pages must not access private state");
  const unauthorizedSave = await fetch(base + "api/policy", { method: "POST", headers: { "X-Search-Center": "expired-page-nonce" }, body: "{}" });
  assert.equal(unauthorizedSave.status, 403); assert.equal(calls.length, 0);
  assert.equal((await fetch(base + "api/state", { headers: { "X-Search-Center": token, Origin: "https://evil.example" } })).status, 403);
  const valid = await fetch(base + "api/state", { headers: { "X-Search-Center": token, Origin: "null" } });
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).uiVersion,VERSION);
  assert.equal(valid.headers.get("access-control-allow-origin"), "null");
  const saved = await fetch(base + "api/policy", { method: "POST", headers: { "X-Search-Center": token, "Content-Type": "application/json" }, body: '{"revision":1}' });
  assert.equal(saved.status, 200); assert.equal(calls[0].revision, 1);
});
