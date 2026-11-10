import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createActivityTracker } from "../lib/activity.mjs"
import { onRequest, onResponse } from "../harnessweight.hooks.mjs"
import { createHandler } from "../service.mjs"

test("overlapping requests finish independently and duplicate finishes are harmless", () => {
  const tracker = createActivityTracker()
  const a = { state: {} }, b = { state: {} }, c = { state: {} }
  tracker.start("one", a, "dsh")
  tracker.start("one", a, "dsh")
  tracker.start("one", b, "dsh")
  tracker.start("two", c, "claude")
  assert.deepEqual(tracker.snapshot("one").agents, [{ agent: "dsh", count: 2 }])
  tracker.finish(b)
  tracker.finish(b)
  assert.equal(tracker.snapshot("one").total, 1)
  assert.equal(tracker.snapshot("two").total, 1)
  tracker.finish(a)
  assert.equal(tracker.snapshot("one").total, 0)
})

test("unknown tracking is distinct from idle; unmatched requests expire explicitly", () => {
  let now = 0
  const tracker = createActivityTracker({ now: () => now, maxAgeMs: 100 })
  assert.equal(tracker.snapshot("one").available, false)
  tracker.start("one", {}, "untrackable")
  assert.equal(tracker.snapshot("one").available, false)
  const a = { state: {} }
  tracker.start("one", a, "dsh")
  now = 99
  assert.equal(tracker.snapshot("one").total, 1)
  now = 100
  const result = tracker.snapshot("one")
  assert.equal(result.total, 0)
  assert.equal(result.expired, 1)
  assert.equal(result.available, true)
  tracker.finish(a)
  assert.equal(tracker.snapshot("one").expired, 1)
})

test("hook lifecycle reaches authenticated service, including failures and hook-signal abort", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "hw-activity-"))
  const server = createServer()
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const port = server.address().port
  server.on("request", createHandler({ port, token: "test", dataDir }))
  const url = `http://127.0.0.1:${port}/api/activity`
  assert.equal((await fetch(url)).status, 403)
  const get = async () => (await fetch(url + "?k=test")).json()
  assert.equal((await get()).available, false)
  const controller = new AbortController()
  const ctx = { state: {}, agent: "dsh", options: { dataDir }, signal: controller.signal }
  const second = { state: {}, agent: "dsh", options: { dataDir } }
  assert.equal(await onRequest({}, ctx), undefined)
  await onRequest({}, second)
  controller.abort() // Host does this after onRequest, not after the request.
  assert.deepEqual((await get()).agents, [{ agent: "dsh", count: 2 }])
  await onResponse(null, { ...ctx, success: false })
  assert.equal((await get()).total, 1)
  await onResponse({}, { ...second, success: true })
  assert.equal((await get()).total, 0)
})
