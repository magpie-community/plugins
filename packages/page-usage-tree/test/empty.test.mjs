import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUsageData } from "../lib/data.mjs";
import { startServer } from "../lib/server.mjs";

// A fresh install has no usage.jsonl yet: magpie writes it on its first
// call. The page asks for a tree anyway, and must get an empty one with a
// note, not a 500.
test("a fresh install has no ledger: an empty tree, not an error", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "usage-tree-empty-"));
  process.env.MAGPIE_CONFIG_DIR = home;
  process.env.MAGPIE_CACHE_DIR = join(home, "cache");
  // no magpie on PATH: the read goes straight to the ledger fallback
  process.env.PATH = "";

  const data = await loadUsageData("7d", { fresh: true });

  assert.deepEqual(data.providers, []);
  assert.deepEqual(data.accounts, []);
  assert.equal(data.summary.calls, 0);
  assert.equal(data.summary.accounts, 0);
  assert.ok(data.warnings.some((item) => item.code === "no-ledger"));

  // and the page asks for it over HTTP: 200 with an empty tree, not a 500
  const info = await startServer({ port: 0 });
  t.after(() => info.close());
  const res = await fetch(`http://127.0.0.1:${info.port}/api/tree?period=7d`, {
    headers: { "x-usage-tree-token": info.token },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.accounts, []);
  assert.ok(body.warnings.some((item) => item.code === "no-ledger"));
});
