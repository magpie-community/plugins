import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCollector, acquireLock, gatewayURL } from "../lib/collector.mjs";
const at = "2026-01-01T00:00:00Z";
const thread = () => ({
  id: "T-example",
  messages: [
    {
      messageId: 1,
      role: "assistant",
      state: { type: "complete" },
      usage: {
        model: "gpt-test",
        timestamp: at,
        inputTokens: 10,
        outputTokens: 20,
      },
    },
  ],
});
async function setup(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "amp-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = Date.parse(at) + 1000000;
  const sent = [],
    rows = new Map();
  const data = thread();
  const opts = {
    dataDir: join(dir, "state"),
    configDir: dir,
    options: { settleSeconds: 30 },
    clock: () => now,
    source: async () => ({ threads: [data], errors: [] }),
    fetchImpl: async (_url, req) => {
      const batch = JSON.parse(req.body);
      sent.push(batch);
      return Response.json({
        records: batch.map((r, index) => {
          const status = rows.has(r.rid) ? "skipped" : "accepted";
          rows.set(r.rid, r);
          return { index, rid: r.rid, status };
        }),
      });
    },
    ...extra,
  };
  let collector = await createCollector(opts);
  t.after(() => collector.close());
  return {
    dir,
    opts,
    data,
    sent,
    rows,
    get collector() {
      return collector;
    },
    advance: () => {
      now += 31000;
    },
    async restart() {
      await collector.close();
      collector = await createCollector(opts);
    },
  };
}
test("preview never imports; enabled collection settles, imports, and survives restart", async (t) => {
  const h = await setup(t);
  const a = await h.collector.run(false);
  assert.equal(a.pending, 1);
  assert.equal(h.sent.length, 0);
  h.advance();
  await h.collector.configure({ enabled: true, mode: "local" });
  const b = await h.collector.run(true);
  assert.equal(b.imported, 1);
  assert.equal(h.rows.size, 1);
  await h.restart();
  await h.collector.run(true);
  assert.equal(h.sent.length, 1);
});
test("changed records are diagnosed without adding a second row", async (t) => {
  const h = await setup(t);
  await h.collector.run();
  h.advance();
  await h.collector.configure({ enabled: true, mode: "local" });
  await h.collector.run(true);
  h.data.messages[0].usage.outputTokens = 99;
  const s = await h.collector.run(true);
  assert.equal(s.issues.changedAfterImport, 1);
  assert.equal(h.sent.length, 1);
});
test("a transport failure is retried with the same RID", async (t) => {
  let fail = true,
    first;
  const h = await setup(t, {
    fetchImpl: async (_u, req) => {
      const batch = JSON.parse(req.body);
      if (fail) {
        first = batch[0].rid;
        fail = false;
        throw new Error("Network unavailable");
      }
      assert.equal(batch[0].rid, first);
      return Response.json({
        records: batch.map((r) => ({ rid: r.rid, status: "skipped" })),
      });
    },
  });
  await h.collector.run();
  h.advance();
  await h.collector.configure({ enabled: true, mode: "local" });
  assert.ok((await h.collector.run(true)).errors.length);
  assert.equal((await h.collector.run(true)).skipped, 1);
});
test("the gateway's matching usage is not imported again", async (t) => {
  const h = await setup(t);
  await writeFile(
    join(h.dir, "usage.jsonl"),
    JSON.stringify({
      t: at,
      model: "provider/gpt-test",
      in: 10,
      out: 20,
      session: "T-example",
    }) + "\n",
  );
  assert.equal((await h.collector.run()).issues.gatewayDuplicate, 1);
  assert.equal(h.sent.length, 0);
});
test("paused sync is read-only and settings cannot race an active scan", async (t) => {
  let finish;
  const h = await setup(t, {
    source: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const run = h.collector.run(true);
  await assert.rejects(
    h.collector.configure({ enabled: true, mode: "local" }),
    /Wait/,
  );
  finish({ threads: [thread()] });
  await run;
  assert.equal(h.sent.length, 0);
});
test("corrupt state fails closed", async (t) => {
  const h = await setup(t);
  await h.collector.run();
  await h.collector.close();
  await writeFile(join(h.opts.dataDir, "state.json"), "{broken");
  await assert.rejects(createCollector(h.opts), /invalid JSON/);
});
test("one service owns a data directory", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "amp-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const release = await acquireLock(dir);
  await assert.rejects(acquireLock(dir), /Another/);
  await release();
  const release2 = await acquireLock(dir);
  await release2();
});
test("gateway destination is loopback-only", () => {
  assert.equal(gatewayURL("http://127.0.0.1:3425/v1"), "http://127.0.0.1:3425");
  for (const s of [
    "https://example.com",
    "http://127.0.0.1.evil.test",
    "http://u:p@127.0.0.1",
    "http://127.0.0.1/?token=x",
  ])
    assert.throws(() => gatewayURL(s));
});
test("a disappearing record must settle again before import", async (t) => {
  const h = await setup(t);
  await h.collector.run();
  h.advance();
  const m = h.data.messages.pop();
  await h.collector.run();
  h.data.messages.push(m);
  await h.collector.configure({ enabled: true, mode: "local" });
  const s = await h.collector.run(true);
  assert.equal(s.pending, 1);
  assert.equal(s.imported, 0);
});
test("identity changes with identical usage are held rather than duplicated", async (t) => {
  const h = await setup(t);
  await h.collector.run();
  h.advance();
  await h.collector.configure({ enabled: true, mode: "local" });
  await h.collector.run(true);
  h.data.messages[0].messageId = 2;
  const s = await h.collector.run(true);
  assert.equal(s.issues.identityChanged, 1);
  assert.equal(h.sent.length, 1);
});
test("switching source clears the previous preview but keeps confirmed records", async (t) => {
  const h = await setup(t);
  await h.collector.run();
  h.advance();
  await h.collector.configure({ enabled: true, mode: "cloud" });
  await h.collector.run(true);
  const next = await h.collector.configure({ enabled: false, mode: "local" });
  assert.equal(next.settings.mode, "local");
  assert.equal(next.lastScan, null);
  assert.equal(next.eligible, 0);
  assert.deepEqual(next.issues, {});
  assert.equal(next.totalImported, 1);
});
