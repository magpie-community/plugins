import test from "node:test";
import assert from "node:assert/strict";
import { aggregateGatewayUsage } from "../lib/usage.mjs";
import { startServer } from "../lib/server.mjs";

// A fresh install has no usage yet. The gateway answers with zero calls and
// no accounts, and the page must show an empty tree with a note, not a 500.
test("a fresh install has an empty tree, not an error", async (t) => {
  const empty = aggregateGatewayUsage({ calls: 0, accounts: [] }, {}, { period: "7d" });

  assert.deepEqual(empty.providers, []);
  assert.deepEqual(empty.accounts, []);
  assert.equal(empty.summary.calls, 0);
  assert.equal(empty.summary.accounts, 0);
  assert.ok(empty.warnings.some((item) => item.code === "no-usage"));

  const info = await startServer({
    port: 0,
    load: async () => empty,
  });
  t.after(() => info.close());
  const res = await fetch(`http://127.0.0.1:${info.port}/api/tree?period=7d`, {
    headers: { "x-usage-tree-token": info.token },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.accounts, []);
  assert.ok(body.warnings.some((item) => item.code === "no-usage"));
});
