import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"

const roots = []
const previous = {
  config: process.env.MAGPIE_CONFIG_DIR,
  publish: process.env.COMPRESS_CORE_NO_PUBLISH,
}

process.env.COMPRESS_CORE_NO_PUBLISH = "1"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "output-strategy-stats-"))
  roots.push(root)
  process.env.MAGPIE_CONFIG_DIR = root
  return root
}

async function freshWriter(label) {
  return import(`../stats-writer.js?${label}-${Date.now()}-${Math.random()}`)
}

function runProcess(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "worker.mjs")], {
      env: { ...process.env, OUTPUT_STRATEGY_DATA_DIR: join(root, "output-strategy"), OUTPUT_STRATEGY_NO_PUBLISH: "1" },
      stdio: "ignore",
    })
    child.once("error", reject)
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)))
  })
}

async function writeWorker(root, source) {
  await writeFile(join(root, "worker.mjs"), source, "utf8")
}

afterEach(async () => {
  if (previous.config === undefined) delete process.env.MAGPIE_CONFIG_DIR
  else process.env.MAGPIE_CONFIG_DIR = previous.config
  process.env.COMPRESS_CORE_NO_PUBLISH = "1"
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

afterAll(() => {
  if (previous.publish === undefined) delete process.env.COMPRESS_CORE_NO_PUBLISH
  else process.env.COMPRESS_CORE_NO_PUBLISH = previous.publish
})

describe("stats-writer", () => {
  test("accumulates applied and skipped results without retaining request bodies", async () => {
    const root = await fixture()
    const writer = await freshWriter("counts")

    writer.record({
      body: { messages: [{ role: "user", content: "private request" }] },
      applied: true,
      skippedReason: null,
      appliedStyles: ["terse-prose", "ponytail"],
      addedBytes: 42,
      ts: "2026-11-04T00:00:00.000Z",
    })
    writer.record({
      body: { messages: [{ role: "user", content: "another secret" }] },
      applied: false,
      skippedReason: "media",
      appliedStyles: [],
      addedBytes: 0,
      ts: "2026-11-04T00:00:01.000Z",
    })
    await writer.flush(true)

    expect(writer.statsPath()).toBe(join(root, "output-strategy", "stats.json"))
    const stored = JSON.parse(await readFile(writer.statsPath(), "utf8"))
    expect(stored).toMatchObject({
      requests: 2,
      applied: 1,
      skipped: 1,
      injectedBytes: 42,
      styles: { "terse-prose": 1, ponytail: 1 },
      reasons: { media: 1 },
    })
    expect(stored.recent).toHaveLength(2)
    expect(stored.recent[0]).toEqual({
      ts: "2026-11-04T00:00:01.000Z",
      applied: false,
      skippedReason: "media",
      appliedStyles: [],
      addedBytes: 0,
    })
    expect(JSON.stringify(stored)).not.toContain("private request")
    expect(JSON.stringify(stored)).not.toContain("another secret")
    expect(JSON.stringify(stored)).not.toContain('"body"')
  })

  test("merges counters and bounded recent entries across a process restart", async () => {
    await fixture()
    const first = await freshWriter("first-process")
    first.record({ applied: true, skippedReason: null, appliedStyles: ["less-code"], addedBytes: 10, ts: "2026-11-04T00:00:00.000Z" })
    await first.flush(true)

    const second = await freshWriter("second-process")
    second.record({ applied: true, skippedReason: null, appliedStyles: ["less-code"], addedBytes: 15, ts: "2026-11-04T00:00:01.000Z" })
    for (let i = 0; i < 25; i++) {
      second.record({ applied: false, skippedReason: "marker", appliedStyles: [], addedBytes: 0, ts: `2026-11-04T00:01:${String(i).padStart(2, "0")}.000Z` })
    }
    await second.flush(true)

    const stored = JSON.parse(await readFile(second.statsPath(), "utf8"))
    expect(stored.requests).toBe(27)
    expect(stored.applied).toBe(2)
    expect(stored.skipped).toBe(25)
    expect(stored.injectedBytes).toBe(25)
    expect(stored.styles).toEqual({ "less-code": 2 })
    expect(stored.reasons).toEqual({ marker: 25 })
    expect(stored.recent).toHaveLength(20)
    expect(stored.recent[0].ts).toBe("2026-11-04T00:01:24.000Z")
  })

  test("persists stats without publishing when disabled", async () => {
    const root = await fixture()
    const writer = await freshWriter("no-publish")
    writer.record({ applied: false, skippedReason: "unknown_shape", appliedStyles: [], addedBytes: 0 })
    await writer.flush(true)

    const persisted = JSON.parse(await readFile(writer.statsPath(), "utf8"))
    expect(persisted.requests).toBe(1)
    await expect(readFile(join(root, "output-strategy", "page", "stats.js"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("throttles non-forced flushes for thirty seconds", async () => {
    await fixture()
    const writer = await freshWriter("throttle")
    writer.record({ applied: true, skippedReason: null, appliedStyles: ["ponytail"], addedBytes: 5 })
    await writer.flush(true)

    writer.record({ applied: true, skippedReason: null, appliedStyles: ["ponytail"], addedBytes: 7 })
    await writer.flush()

    expect(writer.snapshot().requests).toBe(2)
    expect(JSON.parse(await readFile(writer.statsPath(), "utf8")).requests).toBe(1)
  })

  test("keeps record fail-open when persisted JSON is malformed", async () => {
    const root = await fixture()
    const writer = await freshWriter("malformed")
    const path = writer.statsPath()
    await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, "output-strategy"), { recursive: true }))
    await writeFile(path, "not json", "utf8")

    expect(() => writer.record({ applied: true, skippedReason: null, appliedStyles: ["ponytail"], addedBytes: 8 })).not.toThrow()
    await writer.flush(true)
    expect(JSON.parse(await readFile(path, "utf8")).requests).toBe(1)
  })
  test("serializes concurrent process writers without losing counters", async () => {
    const root = await fixture()
    const writerUrl = pathToFileURL(join(process.cwd(), "stats-writer.js")).href
    await writeWorker(root, `
      const writer = await import(${JSON.stringify(writerUrl)})
      for (let i = 0; i < 25; i++) writer.record({ applied: true, appliedStyles: ["ponytail"], addedBytes: 1 })
      await writer.flush(true)
    `)
    await Promise.all([runProcess(root), runProcess(root), runProcess(root), runProcess(root)])
    const stored = JSON.parse(await readFile(join(root, "output-strategy", "stats.json"), "utf8"))
    expect(stored.requests).toBe(100)
    expect(stored.applied).toBe(100)
    expect(stored.injectedBytes).toBe(100)
  }, 15000)

  test("flushes the throttled remainder before process exit", async () => {
    const root = await fixture()
    const hooksUrl = pathToFileURL(join(process.cwd(), "observability.hooks.js")).href
    const writerUrl = pathToFileURL(join(process.cwd(), "stats-writer.js")).href
    await writeWorker(root, `
      const { onRequest } = await import(${JSON.stringify(hooksUrl)})
      const { flush } = await import(${JSON.stringify(writerUrl)})
      const ctx = { origin: "local", options: { styles: { ponytail: true } } }
      await onRequest({ messages: [{ role: "user", content: "first" }] }, ctx)
      await flush(true)
      await onRequest({ messages: [{ role: "user", content: "second" }] }, ctx)
    `)
    await runProcess(root)
    expect(JSON.parse(await readFile(join(root, "output-strategy", "stats.json"), "utf8")).requests).toBe(2)
  }, 15000)
  test("an old lock owner cannot release a replacement owner's lock", async () => {
    const root = await fixture()
    const file = join(root, "stats.json")
    const { acquireLock, assertLockOwner, releaseLock } = await import("../lock-file.js")
    const first = await acquireLock(file, 20)
    const past = new Date(Date.now() - 20_000)
    await utimes(`${file}.lock`, past, past)
    const second = await acquireLock(file, 100)
    await releaseLock(first)
    await assertLockOwner(second)
    expect(await acquireLock(file, 20)).toBeNull()
    await releaseLock(second)
    const third = await acquireLock(file, 20)
    expect(third).not.toBeNull()
    await releaseLock(third)
  })
})

describe("Bun onRequest adapter", () => {
  test("records local telemetry without rewriting the request body", async () => {
    await fixture()
    const { onRequest } = await import("../observability.hooks.js")
    const { flush, statsPath } = await import("../stats-writer.js")
    const body = { messages: [{ role: "user", content: "hello" }] }
    const options = { styles: { ponytail: true }, telemetry: true }

    const returned = await onRequest(body, { origin: "local", options })
    await flush(true)

    expect(returned).toBeUndefined()
    expect(body).toEqual({ messages: [{ role: "user", content: "hello" }] })
    const stored = JSON.parse(await readFile(statsPath(), "utf8"))
    expect(stored.requests).toBe(1)
    expect(stored.applied).toBe(1)
    expect(stored.styles).toEqual({ ponytail: 1 })
    expect(stored.injectedBytes).toBeGreaterThan(0)
    expect(JSON.stringify(stored)).not.toContain("hello")
  })

  test("records a replayed request once via ctx.state", async () => {
    await fixture()
    const { onRequest } = await import("../observability.hooks.js")
    const { flush, statsPath } = await import("../stats-writer.js")
    const options = { styles: { ponytail: true }, telemetry: true }
    const state = {}

    await onRequest({ messages: [{ role: "user", content: "hello" }] }, { origin: "local", options, state })
    await onRequest({ messages: [{ role: "user", content: "hello" }] }, { origin: "local", options, state })
    await flush(true)

    const stored = JSON.parse(await readFile(statsPath(), "utf8"))
    expect(stored.requests).toBe(1)
  })

  test("skips telemetry for remote, disabled and unselected requests without recording", async () => {
    await fixture()
    const { onRequest } = await import("../observability.hooks.js")
    const { statsPath } = await import("../stats-writer.js")
    const options = { styles: { ponytail: true }, telemetry: true }

    const remote = await onRequest({ messages: [{ role: "user", content: "remote" }] }, { origin: "remote", options })
    const disabled = await onRequest({ messages: [{ role: "user", content: "disabled" }] }, { origin: "local", options: { ...options, telemetry: false } })
    const unselected = await onRequest({ messages: [{ role: "user", content: "plain" }] }, { origin: "local", options: { styles: {} } })

    expect(remote).toBeUndefined()
    expect(disabled).toBeUndefined()
    expect(unselected).toBeUndefined()
    await expect(readFile(statsPath(), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })
})
