import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, stat, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createToolsWriter, MAX_FILE_BYTES, AGE_CHECK_MS } from "../harnessweight.hooks.mjs"
import { createToolsReader } from "../lib/tools.mjs"

const AGE = 30 * 24 * 3600e3
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "hw-rollover-"))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return join(dir, "tools.jsonl")
}
const sample = (t, id) => ({ t, agent: "test", id })
function padded(row, bytes) {
  const base = JSON.stringify({ ...row, pad: "" }) + "\n"
  return JSON.stringify({ ...row, pad: "x".repeat(bytes - Buffer.byteLength(base)) }) + "\n"
}

test("concurrent appends crossing 8 MiB preserve every row across both generations", async (t) => {
  const file = await fixture(t)
  const now = Date.now()
  await writeFile(file, padded(sample(now, "seed"), MAX_FILE_BYTES - 300))
  const append = createToolsWriter()
  await Promise.all(Array.from({ length: 200 }, (_, i) => append(file, sample(now, i))))
  for (const path of [file, file + ".1"]) assert.ok((await stat(path)).size <= MAX_FILE_BYTES)
  const reader = createToolsReader(file)
  await reader.refresh()
  assert.equal(reader.rows().length, 201)
  assert.equal(new Set(reader.rows().map((r) => r.id)).size, 201)
  assert.equal(reader.rows()[0].id, "seed")
})

test("second rollover retires only the oldest generation", async (t) => {
  const file = await fixture(t)
  const now = Date.now()
  const append = createToolsWriter()
  const full = (id) => JSON.parse(padded(sample(now, id), MAX_FILE_BYTES))
  await append(file, full("first"))
  await append(file, full("second"))
  await append(file, sample(now, "third"))
  const reader = createToolsReader(file)
  await reader.refresh()
  assert.deepEqual(reader.rows().map((r) => r.id), ["second", "third"])
  assert.equal((await stat(file + ".1")).size, MAX_FILE_BYTES)
})

test("age check runs hourly even below 512 KiB and reader expires unchanged rows", async (t) => {
  const file = await fixture(t)
  let now = Date.now()
  const append = createToolsWriter({ now: () => now })
  const old = sample(now - AGE + 1, "aging")
  await writeFile(file, JSON.stringify(old) + "\n")
  await append(file, sample(now, "fresh"))
  now += AGE_CHECK_MS - 1
  await append(file, sample(now, "before-hour"))
  await assert.rejects(stat(file + ".1"), { code: "ENOENT" })
  now += 1
  await append(file, sample(now, "at-hour"))
  assert.ok((await readFile(file + ".1", "utf8")).includes("aging"))
  const reader = createToolsReader(file, { now: () => now })
  await reader.refresh()
  assert.deepEqual(reader.rows().map((r) => r.id), ["fresh", "before-hour", "at-hour"])
  now += AGE + 1
  await reader.refresh()
  assert.deepEqual(reader.rows(), [])
})

test("reader detects same-size inode replacement, ignores malformed and incomplete records", async (t) => {
  const file = await fixture(t)
  const now = Date.now()
  await writeFile(file, JSON.stringify(sample(now, "one")) + "\n")
  const reader = createToolsReader(file)
  await reader.refresh()
  await writeFile(file + ".replacement", JSON.stringify(sample(now, "two")) + "\n")
  await rename(file + ".replacement", file)
  await reader.refresh()
  assert.deepEqual(reader.rows().map((r) => r.id), ["two"])
  await writeFile(file + ".1", 'null\nmalformed\n' + JSON.stringify(sample(now - AGE - 1, "expired")) + "\n")
  await writeFile(file, JSON.stringify(sample(now, "complete")) + "\n" + JSON.stringify(sample(now, "partial")))
  await reader.refresh()
  assert.deepEqual(reader.rows().map((r) => r.id), ["complete"])
})

test("oversized sample is rejected and failed writes do not poison the queue", async (t) => {
  const file = await fixture(t)
  const append = createToolsWriter()
  await assert.rejects(append(file, { pad: "x".repeat(MAX_FILE_BYTES) }), RangeError)
  await writeFile(file, "")
  await assert.rejects(append(join(file, "child"), sample(Date.now(), "fail")))
  // Repair the failed destination and retry the exact same queued path.
  await rm(file)
  await append(join(file, "child"), sample(Date.now(), "recovered"))
  assert.equal(JSON.parse(await readFile(join(file, "child"), "utf8")).id, "recovered")
})
