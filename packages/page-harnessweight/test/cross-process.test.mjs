import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmod, mkdtemp, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises"
import { chmodSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createToolsWriter, LOCK_TIMEOUT_MS } from "../harnessweight.hooks.mjs"

const CHILD = fileURLToPath(new URL("./fixtures/append-child.mjs", import.meta.url))

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "hw-xproc-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return join(dir, "tools.jsonl")
}
const exists = (path) => stat(path).then(() => true, () => false)
// Resolves with the exit code, even if the child already exited before the
// listener was attached ("exit" fires only once).
const exited = (child) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode)
  else child.once("exit", (code) => resolve(code))
})
async function ids(file) {
  const out = []
  for (const path of [file + ".1", file]) {
    const text = await readFile(path, "utf8").catch(() => "")
    for (const line of text.split("\n").filter(Boolean)) out.push(JSON.parse(line).id)
  }
  return out
}
// A child that holds the main lock until killed.
async function holder(t, file) {
  const child = spawn(process.execPath, [CHILD, "--hold", file], { stdio: ["ignore", "pipe", "inherit"] })
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL") })
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => { if (String(d).includes("LOCKED")) resolve() })
    child.on("exit", () => reject(new Error("holder exited early")))
  })
  return child
}
// A pid that certainly belonged to a process that has exited.
async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""])
  await exited(child)
  return child.pid
}

test("two host processes rotating the same log concurrently lose no row", async (t) => {
  // 64 KiB generations, ~5.9 KB rows: 20 rows fill one generation and part
  // of the next, so exactly one rotation happens and every row must survive.
  for (let round = 0; round < 5; round++) {
    const file = await fixture(t)
    const kids = ["a", "b"].map((tag) =>
      spawn(process.execPath, [CHILD, file, `${tag}${round}`, "10", String(64 * 1024), "5800"], { stdio: "inherit" }))
    const codes = await Promise.all(kids.map(exited))
    assert.deepEqual(codes, [0, 0], "both writers exit cleanly (no ENOENT on rename)")
    const seen = await ids(file)
    assert.equal(seen.length, 20, `round ${round}: every row is present`)
    assert.equal(new Set(seen).size, 20, `round ${round}: no row is duplicated`)
    assert.ok(await exists(file + ".1"), "the boundary was crossed")
    assert.ok(!(await exists(file + ".lock")), "no lock is left behind")
  }
})

test("a crashed holder's lock is reclaimed once its pid is gone", async (t) => {
  const file = await fixture(t)
  const child = await holder(t, file)
  child.kill("SIGKILL")
  await exited(child)
  const append = createToolsWriter({ lockTimeoutMs: 2000, warn: () => {} })
  await append(file, { t: Date.now(), agent: "a", id: "after-crash" })
  assert.deepEqual(await ids(file), ["after-crash"])
  assert.ok(!(await exists(file + ".lock")))
  assert.ok(!(await exists(file + ".reaper.lock")))
})

test("a live holder's lock is never removed; the sample fails closed", async (t) => {
  const file = await fixture(t)
  await writeFile(file, JSON.stringify({ t: Date.now(), agent: "a", id: "old" }) + "\n")
  await holder(t, file)
  const append = createToolsWriter({ lockTimeoutMs: 300, warn: () => {} })
  await assert.rejects(append(file, { t: Date.now(), agent: "a", id: "new" }),
    (e) => e.code === "HW_LOCK_TIMEOUT" && e.reason === "held")
  assert.ok(await exists(file + ".lock"), "the live lock is still there")
  assert.deepEqual(await ids(file), ["old"], "existing data untouched")
})

test("by default a held lock delays a response by about 100 ms, then skips the sample", async (t) => {
  const file = await fixture(t)
  await holder(t, file)
  const append = createToolsWriter({ warn: () => {} }) // default LOCK_TIMEOUT_MS
  const started = performance.now()
  await assert.rejects(append(file, { t: Date.now(), agent: "a", id: "x" }), { code: "HW_LOCK_TIMEOUT" })
  const waited = performance.now() - started
  assert.equal(LOCK_TIMEOUT_MS, 100)
  assert.ok(waited >= 90 && waited < 1500, `waited ${waited.toFixed(0)} ms`)
  assert.ok(!(await exists(file)), "no row written while another host holds the lock")
})

test("queued requests behind a held lock do not add up their waits", async (t) => {
  const file = await fixture(t)
  await holder(t, file)
  const lines = []
  const original = console.warn
  console.warn = (msg) => lines.push(String(msg))
  t.after(() => { console.warn = original })
  const append = createToolsWriter() // default 100 ms, default throttled warning
  const started = performance.now()
  const results = await Promise.allSettled(Array.from({ length: 30 }, (_, i) =>
    append(file, { t: Date.now(), agent: "a", id: `q${i}` })))
  const elapsed = performance.now() - started
  assert.ok(results.every((r) => r.status === "rejected" && r.reason.code === "HW_LOCK_TIMEOUT"))
  // 30 × 100 ms would be 3 s; the shared budget keeps it near 100 ms.
  assert.ok(elapsed < 1500, `30 queued requests took ${elapsed.toFixed(0)} ms`)
  t.diagnostic(`30 queued requests behind a held lock: ${elapsed.toFixed(0)} ms in total`)
  assert.equal(lines.length, 1, "one warning for 30 skipped samples")
  assert.match(lines[0], /tool sample skipped: tools\.jsonl\.lock is held by another host/)
})

test("under a concurrent peak from two hosts, every accepted row is kept and latency stays bounded", async (t) => {
  const file = await fixture(t)
  // The other host writes 200 rows continuously while this one takes a burst.
  const other = spawn(process.execPath, [CHILD, file, "other", "200", String(1 << 20), "200"], { stdio: "inherit" })
  const append = createToolsWriter({ maxBytes: 1 << 20, warn: () => {} }) // default 100 ms
  await new Promise((r) => setTimeout(r, 20))
  const latencies = []
  const results = await Promise.allSettled(Array.from({ length: 100 }, async (_, i) => {
    const started = performance.now()
    try { await append(file, { t: Date.now(), agent: "peak", id: `peak-${i}` }) }
    finally { latencies.push(performance.now() - started) }
  }))
  assert.equal(await exited(other), 0)
  const kept = new Set(await ids(file))
  const accepted = results.map((r, i) => r.status === "fulfilled" && `peak-${i}`).filter(Boolean)
  const skipped = results.filter((r) => r.status === "rejected")
  assert.ok(skipped.every((r) => r.reason.code === "HW_LOCK_TIMEOUT"), "only lock timeouts skip")
  for (const id of accepted) assert.ok(kept.has(id), `accepted ${id} is in the log`)
  for (let i = 0; i < 100; i++) if (results[i].status === "rejected") assert.ok(!kept.has(`peak-${i}`))
  for (let i = 0; i < 200; i++) assert.ok(kept.has(`other-${i}`), `other host row ${i} kept`)
  const worst = Math.max(...latencies)
  assert.ok(worst < 1500, `worst response delay ${worst.toFixed(0)} ms`)
  t.diagnostic(`peak: ${accepted.length}/100 kept, ${skipped.length} skipped, worst delay ${worst.toFixed(0)} ms`)
})

test("an uncontended append takes the lock without waiting", async (t) => {
  const file = await fixture(t)
  const append = createToolsWriter({ warn: () => {} })
  await append(file, { t: Date.now(), agent: "a", id: "warm" })
  const started = performance.now()
  for (let i = 0; i < 20; i++) await append(file, { t: Date.now(), agent: "a", id: `n${i}` })
  const each = (performance.now() - started) / 20
  assert.ok(each < 100, `per append ${each.toFixed(2)} ms`)
})

test("an empty or corrupt lock is not reclaimed", async (t) => {
  for (const content of ["", "{not json", JSON.stringify({ token: "x" })]) {
    const file = await fixture(t)
    await writeFile(file + ".lock", content)
    const append = createToolsWriter({ lockTimeoutMs: 150, warn: () => {} })
    await assert.rejects(append(file, { t: Date.now(), agent: "a", id: "x" }),
      (e) => e.code === "HW_LOCK_TIMEOUT" && e.reason === "unreadable")
    assert.equal(await readFile(file + ".lock", "utf8"), content)
    assert.ok(!(await exists(file)))
  }
})

test("a leftover reaper lock blocks reclaiming instead of being removed", async (t) => {
  const file = await fixture(t)
  await writeFile(file + ".lock", JSON.stringify({ pid: await deadPid(), token: "dead" }))
  await writeFile(file + ".reaper.lock", "")
  const append = createToolsWriter({ lockTimeoutMs: 150, warn: () => {} })
  await assert.rejects(append(file, { t: Date.now(), agent: "a", id: "x" }),
    (e) => e.code === "HW_LOCK_TIMEOUT" && e.reason === "reaper")
  assert.ok(await exists(file + ".lock"))
  assert.ok(await exists(file + ".reaper.lock"))
})

test("an error inside the critical section releases the lock", async (t) => {
  const file = await fixture(t)
  await mkdir(file) // appendFile on a directory fails with EISDIR
  const append = createToolsWriter({ lockTimeoutMs: 1000, warn: () => {} })
  await assert.rejects(append(file, { t: Date.now(), agent: "a", id: "fail" }), { code: "EISDIR" })
  assert.ok(!(await exists(file + ".lock")), "lock released in finally")
  await rm(file, { recursive: true })
  await append(file, { t: Date.now(), agent: "a", id: "ok" })
  assert.deepEqual(await ids(file), ["ok"])
})

test("the holder releases its lock even when the lock can no longer be read", async (t) => {
  const file = await fixture(t)
  // now() runs inside the critical section: make the held lock unreadable
  // there, as a failed read (EMFILE, EIO) at release time would.
  const append = createToolsWriter({ warn: () => {}, now: () => { writeFileSync(file + ".lock", ""); return Date.now() } })
  await append(file, { t: Date.now(), agent: "a", id: "one" })
  assert.ok(!(await exists(file + ".lock")), "a live holder never leaves its lock behind")
  await append(file, { t: Date.now(), agent: "a", id: "two" })
  assert.deepEqual(await ids(file), ["one", "two"])
})

test("a failed release is reported, throttled and without sample content", async (t) => {
  const file = await fixture(t)
  const dir = dirname(file)
  const lines = []
  const original = console.warn
  console.warn = (msg) => lines.push(String(msg))
  t.after(async () => { console.warn = original; await chmod(dir, 0o755).catch(() => {}) })
  // Inside the critical section, make the directory read-only: the append
  // still works (the file is open for append) but unlinking the lock fails.
  await writeFile(file, "")
  const append = createToolsWriter({ warn: () => {}, now: () => { chmodSync(dir, 0o555); return Date.now() } })
  await append(file, { t: Date.now(), agent: "a", id: "SECRET" })
  await chmod(dir, 0o755)
  assert.ok(await exists(file + ".lock"), "the release really failed")
  await rm(file + ".lock")
  await append(file, { t: Date.now(), agent: "a", id: "SECRET2" })
  await chmod(dir, 0o755)
  await rm(file + ".lock", { force: true })
  assert.equal(lines.length, 1, "one warning per minute")
  assert.match(lines[0], /could not release tools\.jsonl\.lock \(EACCES\)/)
  assert.ok(!lines[0].includes("SECRET") && !lines[0].includes(dir))
})

test("a lock whose close fails is removed, not left naming a live pid", async (t) => {
  const file = await fixture(t)
  const probe = await open(file + ".probe", "w")
  const proto = Object.getPrototypeOf(probe)
  await probe.close()
  // Node defines close per handle, so hook writeFile (shared) and make the
  // close of that one handle — the lock file's — fail after really closing.
  const writeFileOrig = proto.writeFile
  let failNext = true
  proto.writeFile = async function (...args) {
    const result = await writeFileOrig.apply(this, args)
    if (failNext) {
      failNext = false
      const close = this.close
      this.close = async () => { await close.call(this); throw Object.assign(new Error("close failed"), { code: "EIO" }) }
    }
    return result
  }
  t.after(() => { proto.writeFile = writeFileOrig })
  const append = createToolsWriter({ warn: () => {} })
  // The first handle.writeFile in append is the lock file's owner record.
  await assert.rejects(append(file, { t: Date.now(), agent: "a", id: "x" }), { code: "EIO" })
  assert.ok(!(await exists(file + ".lock")), "no orphaned lock")
  await append(file, { t: Date.now(), agent: "a", id: "ok" })
  assert.deepEqual(await ids(file), ["ok"])
})

test("reclaiming a dead lock still respects the deadline", async (t) => {
  const file = await fixture(t)
  await writeFile(file + ".lock", JSON.stringify({ pid: await deadPid(), token: "dead" }))
  // A deadline already passed: reclaiming must not loop on past it.
  const append = createToolsWriter({ lockTimeoutMs: -1, warn: () => {} })
  await assert.rejects(append(file, { t: Date.now(), agent: "a", id: "late" }),
    (e) => e.code === "HW_LOCK_TIMEOUT" && e.reason === "reclaimed")
  assert.ok(!(await exists(file + ".lock")), "the dead lock was still reclaimed")
  await createToolsWriter({ warn: () => {} })(file, { t: Date.now(), agent: "a", id: "next" })
  assert.deepEqual(await ids(file), ["next"])
})

test("skipped samples warn at most once a minute and name no sample content", async (t) => {
  const file = await fixture(t)
  await writeFile(file + ".lock", "")
  const lines = []
  const original = console.warn
  console.warn = (msg) => lines.push(String(msg))
  t.after(() => { console.warn = original })
  const append = createToolsWriter({ lockTimeoutMs: 50 })
  for (let i = 0; i < 3; i++) await append(file, { t: Date.now(), agent: "secret-agent", id: "SECRET" }).catch(() => {})
  assert.equal(lines.length, 1)
  assert.match(lines[0], /tools\.jsonl\.lock is empty or corrupt/)
  assert.ok(!lines[0].includes("SECRET") && !lines[0].includes(file))
})
