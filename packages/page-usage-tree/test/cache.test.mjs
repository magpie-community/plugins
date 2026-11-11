import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheUsable, loadUsageData } from "../lib/data.mjs";

test("a stale disk cache says so while it refreshes behind the page", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "usage-tree-cache-"));
  const previousCache = process.env.MAGPIE_CACHE_DIR;
  process.env.MAGPIE_CACHE_DIR = root;
  mkdirSync(join(root, "usage-tree"), { recursive: true });
  writeFileSync(
    join(root, "usage-tree", "today.json"),
    JSON.stringify({
      v: 8,
      at: Date.now() - 60_000,
      data: {
        period: "today",
        generatedAt: "old",
        summary: {
          calls: 1,
          cacheRead: 0,
          cacheWrite: 0,
          cacheUnknown: 0,
          cacheUnknownCalls: 0,
        },
        providers: [],
        accounts: [],
        warnings: [],
      },
    }),
    "utf8",
  );

  const gateway = createServer((req, res) => {
    if (req.url.startsWith("/v1/magpie/usage")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        period: "today",
        calls: 2,
        errors: 0,
        input: 2,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        cost: 0,
        unpriced: 0,
        accounts: [],
        models: [],
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${gateway.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => gateway.close(resolve));
    if (previousCache === undefined) delete process.env.MAGPIE_CACHE_DIR;
    else process.env.MAGPIE_CACHE_DIR = previousCache;
    rmSync(root, { recursive: true, force: true });
  });

  const first = await loadUsageData("today", { gateway: base });
  assert.equal(first.cached, true);
  assert.equal(first.stale, true);
  assert.equal(first.summary.calls, 1);

  let latest = first;
  for (let attempt = 0; attempt < 40 && latest.summary.calls !== 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    latest = await loadUsageData("today", { gateway: base });
  }
  assert.equal(latest.summary.calls, 2);
  assert.equal(latest.stale, false);
  if (process.platform !== "win32") {
    assert.equal(statSync(join(root, "usage-tree")).mode & 0o777, 0o700);
    assert.equal(statSync(join(root, "usage-tree", "today.json")).mode & 0o777, 0o600);
  }
});

test("a v6 cache without hit-rate fields is not served as current", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "usage-tree-old-cache-"));
  const previousCache = process.env.MAGPIE_CACHE_DIR;
  process.env.MAGPIE_CACHE_DIR = root;
  mkdirSync(join(root, "usage-tree"), { recursive: true });
  writeFileSync(
    join(root, "usage-tree", "today.json"),
    JSON.stringify({
      v: 6,
      at: Date.now(),
      data: {
        period: "today",
        generatedAt: "old",
        summary: { calls: 1, cache: 0 },
        providers: [],
        accounts: [],
        warnings: [],
      },
    }),
    "utf8",
  );

  const gateway = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      period: "today",
      calls: 2,
      errors: 0,
      input: 2,
      output: 0,
      cache_read: 0,
      cache_write: 0,
      cost: 0,
      unpriced: 0,
      accounts: [],
      models: [],
    }));
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${gateway.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => gateway.close(resolve));
    if (previousCache === undefined) delete process.env.MAGPIE_CACHE_DIR;
    else process.env.MAGPIE_CACHE_DIR = previousCache;
    rmSync(root, { recursive: true, force: true });
  });

  const result = await loadUsageData("today", { gateway: base });
  assert.notEqual(result.summary.calls, 1);
  assert.equal(result.summary.calls, 2);
  assert.equal(result.summary.cacheUnknown, 0);
  assert.equal(result.summary.cacheUnknownCalls, 0);
});

test("a failed per-account request read warns without discarding the usage answer", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "usage-tree-detail-warning-"));
  const previousCache = process.env.MAGPIE_CACHE_DIR;
  process.env.MAGPIE_CACHE_DIR = root;
  t.after(() => {
    if (previousCache === undefined) delete process.env.MAGPIE_CACHE_DIR;
    else process.env.MAGPIE_CACHE_DIR = previousCache;
    rmSync(root, { recursive: true, force: true });
  });

  const gateway = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/v1/magpie/usage/requests")) {
      res.writeHead(503).end(JSON.stringify({ error: "requests unavailable" }));
      return;
    }
    if (req.url.startsWith("/v1/magpie/usage")) {
      res.end(JSON.stringify({
        period: "today",
        calls: 2,
        errors: 0,
        input: 2,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        cost: 0,
        unpriced: 0,
        accounts: [{
          provider: "codex",
          account: "alice@example.com",
          calls: 2,
          errors: 0,
          input: 2,
          output: 0,
          cache_read: 0,
          cache_write: 0,
          cost: 0,
          unpriced: 0,
        }],
        models: [],
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${gateway.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => gateway.close(resolve));
  });

  const result = await loadUsageData("today", { gateway: base, fresh: true });
  assert.equal(result.summary.calls, 2);
  assert.equal(result.accounts.length, 1);
  assert.deepEqual(result.warnings, [{ code: "model-details", count: 1 }]);
});

test("cached trees must carry every cache hit-rate field", () => {
  const fields = {
    cacheRead: 1,
    cacheWrite: 2,
    cacheUnknown: 3,
    cacheUnknownCalls: 4,
  };
  assert.equal(cacheUsable({ summary: fields, providers: [], accounts: [] }), true);
  assert.equal(cacheUsable({ summary: { cacheRead: 0 }, providers: [], accounts: [] }), false);
  assert.equal(cacheUsable({
    summary: fields,
    providers: [{ ...fields }],
    accounts: [{ cacheRead: 0 }],
  }), false);
  assert.equal(cacheUsable({
    summary: fields,
    providers: [],
    accounts: [{ ...fields, models: [{ cacheRead: 0 }] }],
  }), false);
  assert.equal(cacheUsable({
    summary: fields,
    providers: [{ ...fields, accounts: [{ ...fields, models: [fields] }] }],
    accounts: [],
  }), true);
  assert.equal(cacheUsable({
    summary: fields,
    providers: [{ ...fields, accounts: [{ ...fields, models: [{ cacheRead: 0 }] }] }],
    accounts: [],
  }), false);
});
