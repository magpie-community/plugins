import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFile,
  mkdtemp,
  mkdir,
  open,
  rm,
  writeFile,
} from "node:fs/promises";
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
test("a record settles, is imported once, and survives restart", async (t) => {
  const h = await setup(t);
  const a = await h.collector.run();
  assert.equal(a.pending, 1);
  assert.equal(h.sent.length, 0);
  h.advance();
  const b = await h.collector.run();
  assert.equal(b.imported, 1);
  assert.equal(h.rows.size, 1);
  await h.restart();
  await h.collector.run();
  assert.equal(h.sent.length, 1);
});
test("changed records are diagnosed without adding a second row", async (t) => {
  const h = await setup(t);
  await h.collector.run();
  h.advance();
  await h.collector.run();
  h.data.messages[0].usage.outputTokens = 99;
  const s = await h.collector.run();
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
  assert.ok((await h.collector.run()).errors.length);
  assert.equal((await h.collector.run()).skipped, 1);
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
  // Magpie rotates the ledger; the verdict must survive it.
  await rm(join(h.dir, "usage.jsonl"));
  h.advance();
  await h.restart();
  assert.equal((await h.collector.run()).issues.gatewayDuplicate, 1);
  h.advance();
  await h.collector.run();
  assert.equal(h.sent.length, 0);
});
test("a batch Magpie refuses whole is split until the bad record stands alone", async (t) => {
  const posts = [];
  const h = await setup(t, {
    fetchImpl: async (_u, req) => {
      const batch = JSON.parse(req.body);
      posts.push(batch.length);
      if (batch.some((r) => r.out === 20))
        return new Response("", { status: 400 });
      return Response.json({
        records: batch.map((r) => ({ rid: r.rid, status: "accepted" })),
      });
    },
  });
  for (let id = 2; id <= 5; id++)
    h.data.messages.push({
      ...h.data.messages[0],
      messageId: id,
      usage: { ...h.data.messages[0].usage, outputTokens: 20 + id },
    });
  await h.collector.run();
  h.advance();
  const s = await h.collector.run();
  assert.deepEqual(s.errors, []);
  assert.equal(s.imported, 4);
  assert.equal(s.issues.rejected, 1);
  assert.equal(posts[0], 5);
  assert.ok(posts.length <= 7);
});
test("one malformed thread leaves the others' records", async (t) => {
  const h = await setup(t, {
    source: async () => ({ threads: [{ id: "bad" }, thread()], errors: [] }),
  });
  const s = await h.collector.run();
  assert.equal(s.issues.invalidThread, 1);
  assert.equal(s.usage[0].calls, 1);
  assert.deepEqual(s.errors, []);
});
test("a gateway log line still being written waits", async (t) => {
  const h = await setup(t, { options: { settleSeconds: 30, sync: false } });
  const log = join(h.dir, "usage.jsonl");
  const row = (patch) =>
    JSON.stringify({ t: at, model: "gpt-test", in: 10, out: 20, ...patch });
  await writeFile(log, row({ out: 21 }) + "\n");
  assert.equal((await h.collector.run()).issues.gatewayDuplicate, undefined);
  // A line still being written is not a row yet.
  const line = row({ session: "T-example" });
  await appendFile(log, line.slice(0, 20));
  assert.equal((await h.collector.run()).issues.gatewayDuplicate, undefined);
  await appendFile(log, line.slice(20) + "\n");
  assert.equal((await h.collector.run()).issues.gatewayDuplicate, 1);
});
test("gateway log bytes before the offset are not read again", async (t) => {
  const h = await setup(t, { options: { settleSeconds: 30, sync: false } });
  const log = join(h.dir, "usage.jsonl");
  const row = (patch) =>
    JSON.stringify({ t: at, model: "gpt-test", in: 10, out: 20, ...patch });
  await writeFile(log, row({ model: "gpt-tesx" }) + "\n");
  assert.equal((await h.collector.run()).issues.gatewayDuplicate, undefined);
  // Rewritten in place to a match, same length and inode: only a reader that
  // starts over from byte 0 would see it.
  const fh = await open(log, "r+");
  await fh.write(row({}), 0);
  await fh.close();
  await appendFile(log, row({ out: 21 }) + "\n");
  assert.equal((await h.collector.run()).issues.gatewayDuplicate, undefined);
});
test("a rotated gateway log is indexed afresh", async (t) => {
  const h = await setup(t, { options: { settleSeconds: 30, sync: false } });
  const log = join(h.dir, "usage.jsonl");
  const row = (patch) =>
    JSON.stringify({ t: at, model: "gpt-test", in: 10, out: 20, ...patch }) +
    "\n";
  await writeFile(log, row({ out: 21 }).repeat(3));
  assert.equal((await h.collector.run()).issues.gatewayDuplicate, undefined);
  // Shorter than what was read, so the offset cannot carry over.
  await rm(log);
  await writeFile(log, row({ session: "T-example" }));
  assert.equal((await h.collector.run()).issues.gatewayDuplicate, 1);
});
test("a record Magpie rejects does not block the others", async (t) => {
  const h = await setup(t, {
    fetchImpl: async (_u, req) =>
      Response.json({
        records: JSON.parse(req.body).map((r) => ({
          rid: r.rid,
          status: r.out === 20 ? "rejected" : "accepted",
        })),
      }),
  });
  h.data.messages.push({
    ...h.data.messages[0],
    messageId: 2,
    usage: { ...h.data.messages[0].usage, outputTokens: 21 },
  });
  await h.collector.run();
  h.advance();
  const s = await h.collector.run();
  assert.equal(s.imported, 1);
  assert.equal(s.issues.rejected, 1);
  assert.equal(s.totalImported, 1);
});
test("with sync off the collector only reads", async (t) => {
  const h = await setup(t, { options: { settleSeconds: 30, sync: false } });
  await h.collector.run();
  h.advance();
  const s = await h.collector.run();
  assert.equal(s.eligible, 1);
  assert.equal(s.usage[0].calls, 1);
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
test("a torn or dead lock is taken over", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "amp-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const left of ["", "{broken", '{"pid":2147483646}']) {
    await writeFile(join(dir, "collector.lock"), left);
    await (
      await acquireLock(dir)
    )();
  }
});
test("gateway rows are read only for undecided records", async (t) => {
  const h = await setup(t);
  await h.collector.run();
  h.advance();
  assert.equal((await h.collector.run()).imported, 1);
  // Unreadable now, but nothing is left to decide.
  await mkdir(join(h.dir, "usage.jsonl"));
  assert.deepEqual((await h.collector.run()).errors, []);
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
  const s = await h.collector.run();
  assert.equal(s.pending, 1);
  assert.equal(s.imported, 0);
});
test("identity changes with identical usage are held rather than duplicated", async (t) => {
  const h = await setup(t);
  await h.collector.run();
  h.advance();
  await h.collector.run();
  h.data.messages[0].messageId = 2;
  const s = await h.collector.run();
  assert.equal(s.issues.identityChanged, 1);
  assert.equal(h.sent.length, 1);
});
test("the page gets usage by local hour and model", async (t) => {
  const h = await setup(t);
  h.data.messages.push({
    ...h.data.messages[0],
    messageId: 2,
    usage: { ...h.data.messages[0].usage, cacheReadInputTokens: 5 },
  });
  const row = (await h.collector.run()).usage;
  assert.equal(row.length, 1);
  assert.deepEqual(
    { ...row[0], hour: undefined },
    {
      hour: undefined,
      model: "gpt-test",
      calls: 2,
      in: 20,
      out: 40,
      cache_read: 5,
      cache_write: 0,
    },
  );
  assert.match(row[0].hour, /^\d{4}-\d\d-\d\dT\d\d$/);
});
test("a record held by two sources is counted once, from the first", async (t) => {
  const copy = thread();
  copy.messages[0].usage.outputTokens = 99;
  const h = await setup(t, {
    source: async () => ({ threads: [thread(), copy], errors: [] }),
  });
  const s = await h.collector.run();
  assert.equal(s.scannedThreads, 1);
  assert.equal(s.usage[0].calls, 1);
  assert.equal(s.usage[0].out, 20);
});
