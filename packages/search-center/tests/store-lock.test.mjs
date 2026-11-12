import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

test("multi-process stale .write-lock takeover is mutually exclusive: never two processes inside fn", { timeout: 30_000 }, async t => {
  const baseRoot = makeDir(t);
  const storeUrl = pathToFileURL(path.resolve(import.meta.dirname, "..", "store.mjs")).href;
  const workerScript = path.join(baseRoot, "lock-worker.mjs");
  const workers = 8;
  const trials = Number(process.env.LOCK_RACE_TRIALS || 6);

  for (let trial = 0; trial < trials; trial++) {
    const trialDir = path.join(baseRoot, `trial-${trial}`);
    const dataDir = path.join(trialDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(trialDir, "ready"), { recursive: true });
    fs.mkdirSync(path.join(trialDir, "done"), { recursive: true });
    fs.mkdirSync(path.join(trialDir, "inside"), { recursive: true });
    fs.writeFileSync(path.join(trialDir, "counter.json"), JSON.stringify({ count: 0 }));
    fs.writeFileSync(
      path.join(dataDir, ".write-lock"),
      JSON.stringify({ pid: 999_999_999, at: Date.now(), owner: "crashed-before-trial" }),
    );
  }

  fs.writeFileSync(workerScript, `
    import fs from "node:fs";
    import path from "node:path";
    import { Store } from ${JSON.stringify(storeUrl)};

    const [baseRoot, workerId, totalTrialsStr] = process.argv.slice(2);
    const totalTrials = Number(totalTrialsStr);
    let maxInsideOverall = 0;

    for (let trial = 0; trial < totalTrials; trial++) {
      const trialDir = path.join(baseRoot, "trial-" + trial);
      const readyDir = path.join(trialDir, "ready");
      const doneDir = path.join(trialDir, "done");
      const insideDir = path.join(trialDir, "inside");
      const goFile = path.join(trialDir, "go");
      const counterFile = path.join(trialDir, "counter.json");
      const store = new Store(path.join(trialDir, "data"), { lockRetries: 250, lockRetryMs: 6, lockStaleMs: 5000 });

      fs.writeFileSync(path.join(readyDir, workerId), "1");
      while (!fs.existsSync(goFile)) {
        await new Promise(r => setTimeout(r, 1));
      }

      await store.lock(async () => {
        const marker = path.join(insideDir, workerId);
        fs.writeFileSync(marker, String(process.pid));
        try {
          for (let step = 0; step < 3; step++) {
            const active = fs.readdirSync(insideDir).length;
            if (active > maxInsideOverall) maxInsideOverall = active;
            if (step < 2) await new Promise(r => setTimeout(r, 10));
          }
          const cur = JSON.parse(fs.readFileSync(counterFile, "utf8"));
          fs.writeFileSync(counterFile, JSON.stringify({ count: cur.count + 1 }));
        } finally {
          try { fs.unlinkSync(marker); } catch {}
        }
      });
      fs.writeFileSync(path.join(doneDir, workerId), "1");
    }
    process.stdout.write(JSON.stringify({ workerId, maxInside: maxInsideOverall }));
  `, "utf8");

  const children = [];
  let workerError = null;
  t.after(() => {
    for (const child of children) {
      try { child.kill(); } catch {}
    }
  });

  const procs = Array.from({ length: workers }, (_, idx) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerScript, baseRoot, `w${idx}`, String(trials)], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(child);
    let out = "", err = "";
    child.stdout.on("data", c => { out += c; });
    child.stderr.on("data", c => { err += c; });
    child.on("error", e => {
      workerError ??= e;
      reject(e);
    });
    child.on("close", code => {
      if (code !== 0) {
        const failure = new Error(`worker w${idx} exited ${code}: ${err}`);
        workerError ??= failure;
        return reject(failure);
      }
      resolve(JSON.parse(out));
    });
  }));
  for (const p of procs) p.catch(() => {});

  for (let trial = 0; trial < trials; trial++) {
    const trialDir = path.join(baseRoot, `trial-${trial}`);
    const deadline = Date.now() + 8_000;
    while (fs.readdirSync(path.join(trialDir, "ready")).length < workers) {
      if (workerError) throw workerError;
      if (Date.now() > deadline) throw new Error(`trial ${trial} timed out waiting for ready barrier`);
      await new Promise(r => setTimeout(r, 1));
    }
    fs.writeFileSync(path.join(trialDir, "go"), "1");
    while (fs.readdirSync(path.join(trialDir, "done")).length < workers) {
      if (workerError) throw workerError;
      if (Date.now() > deadline) throw new Error(`trial ${trial} timed out waiting for done barrier`);
      await new Promise(r => setTimeout(r, 2));
    }
  }

  const outcomes = await Promise.all(procs);
  for (const o of outcomes) {
    assert.equal(o.maxInside, 1, `worker ${o.workerId} observed ${o.maxInside} concurrent holders inside lock()`);
  }
  for (let trial = 0; trial < trials; trial++) {
    const finalCount = JSON.parse(fs.readFileSync(path.join(baseRoot, `trial-${trial}`, "counter.json"), "utf8")).count;
    assert.equal(finalCount, workers, `trial ${trial}: lost update (${finalCount}/${workers})`);
  }
});
