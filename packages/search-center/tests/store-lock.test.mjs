import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, defaults } from "../store.mjs";
import { Center } from "../center.mjs";

function makeDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "search-store-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("corrupt policy.json throws STATE_INVALID and is never overwritten, while corrupt history entry is skipped (B4 / P3)", async t => {
  const root = makeDir(t);
  const store = new Store(root);
  store.append({ id: "ok-1", at: new Date().toISOString(), query: "valid", channels: ["you"], sourcesCount: 1, sources: [] });
  fs.writeFileSync(path.join(root, "history", "9999999999999-corrupt.json"), "{corrupt-history", "utf8");

  const center = new Center({ store });
  const snap = await center.snapshot();
  assert.equal(snap.history.length, 1);
  assert.equal(snap.history[0].id, "ok-1");

  const policyPath = path.join(root, "policy.json");
  fs.writeFileSync(policyPath, "{corrupt-policy", "utf8");
  assert.throws(() => store.policy(), e => e.code === "STATE_INVALID" && e.status === 500);
  await assert.rejects(store.save(defaults()), e => e.code === "STATE_INVALID" && e.status === 500);
  assert.equal(fs.readFileSync(policyPath, "utf8"), "{corrupt-policy");
});

test("live .write-lock blocks concurrent save and reserve with BUSY (B6)", async t => {
  const root = makeDir(t);
  const store = new Store(root, { lockRetries: 3, lockRetryMs: 10, lockStaleMs: 10_000 });
  const lockPath = path.join(root, ".write-lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), owner: "active-holder" }), "utf8");

  await assert.rejects(store.save(defaults()), e => e.code === "BUSY" && e.status === 409);
  await assert.rejects(
    store.reserve("exa", { strategy: "order", keys: [{ id: "k1", label: "K1", ref: "local://k1", enabled: true }] }),
    e => e.code === "BUSY" && e.status === 409,
  );
  assert.ok(fs.existsSync(lockPath));
});

test("stale .write-lock from dead PID or expired timestamp is automatically taken over (P3)", async t => {
  const root = makeDir(t);
  const store = new Store(root, { lockRetries: 3, lockRetryMs: 10, lockStaleMs: 1000 });
  const lockPath = path.join(root, ".write-lock");

  // 1. Dead PID lock
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999, at: Date.now(), owner: "dead-host" }), "utf8");
  const saved1 = await store.save(defaults());
  assert.equal(saved1.revision, 1);
  assert.equal(fs.existsSync(lockPath), false);

  // 2. Expired timestamp lock (even with live PID)
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() - 10_000, owner: "hung-host" }), "utf8");
  const reserved = await store.reserve("exa", {
    strategy: "order",
    keys: [{ id: "k1", label: "K1", ref: "local://k1", enabled: true }],
  });
  assert.equal(reserved.length, 1);
  assert.equal(fs.existsSync(lockPath), false);
});
