import { expect, test } from "bun:test"
import { TrialPool, trialAccountKey, waitForTrial } from "./trial-pool.mjs"

test("changing the shared limit drains each lane and preserves in-flight calls", async () => {
  const pool = new TrialPool(2)
  const releases = await Promise.all([
    pool.acquire("a"), pool.acquire("a"), pool.acquire("b"), pool.acquire("b"),
  ])
  const queuedA = pool.acquire("a"), queuedB = pool.acquire("b")
  expect(pool.accounts.get("a").queue.length).toBe(1)
  expect(pool.accounts.get("b").queue.length).toBe(1)
  pool.setLimit(3)
  const thirdA = await queuedA, thirdB = await queuedB
  expect(pool.accounts.get("a").active).toBe(3)
  expect(pool.accounts.get("b").active).toBe(3)
  pool.setLimit(2)
  let entered = false
  const next = pool.acquire("a").then((release) => { entered = true; return release })
  releases[0]()
  await Promise.resolve()
  expect(entered).toBe(false)
  expect(pool.accounts.get("a").active).toBe(2)
  releases[1]()
  const releaseNext = await next
  expect(entered).toBe(true)
  expect(pool.accounts.get("a").active).toBe(2)
  releases.forEach((release) => release())
  thirdA()
  thirdB()
  releaseNext()
  expect(pool.accounts.size).toBe(0)
  expect(() => pool.setLimit(0)).toThrow()
})

test("one account has two slots, another has its own two slots", async () => {
  const pool = new TrialPool(2)
  const releases = await Promise.all([
    pool.acquire("a"), pool.acquire("a"), pool.acquire("b"), pool.acquire("b"),
  ])
  expect(pool.accounts.get("a").active).toBe(2)
  expect(pool.accounts.get("b").active).toBe(2)
  let entered = false
  const third = pool.acquire("a").then((release) => {
    entered = true
    return release
  })
  await Promise.resolve()
  expect(entered).toBe(false)
  releases[0]()
  const releaseThird = await third
  expect(entered).toBe(true)
  expect(pool.accounts.get("a").active).toBe(2)
  releases.forEach((release) => release())
  releaseThird()
  expect(pool.accounts.size).toBe(0)
})

test("queued calls keep FIFO order and a cancelled waiter takes no slot", async () => {
  const pool = new TrialPool(1)
  const first = await pool.acquire("a")
  const abort = new AbortController()
  const cancelled = pool.acquire("a", abort.signal)
  cancelled.catch(() => {})
  const order = []
  const next = pool.acquire("a").then((release) => { order.push(1); return release })
  const last = pool.acquire("a").then((release) => { order.push(2); return release })
  abort.abort()
  await expect(cancelled).rejects.toThrow()
  expect(pool.accounts.get("a").queue.length).toBe(2)
  first()
  const releaseNext = await next
  expect(order).toEqual([1])
  releaseNext()
  const releaseLast = await last
  expect(order).toEqual([1, 2])
  releaseLast()
  expect(pool.accounts.size).toBe(0)
})

test("an already-cancelled call never opens a lane or sends a request", async () => {
  const pool = new TrialPool(2)
  const abort = new AbortController()
  abort.abort()
  let sends = 0
  await expect(pool.run("a", abort.signal, async () => {
    sends++
    return new Response("unexpected")
  })).rejects.toThrow()
  expect(sends).toBe(0)
  expect(pool.accounts.size).toBe(0)
})

test("a forward error frees its slot exactly once", async () => {
  const pool = new TrialPool(1)
  await expect(pool.run("a", undefined, async () => {
    throw new Error("offline transport failed")
  })).rejects.toThrow("offline transport failed")
  expect(pool.accounts.size).toBe(0)
  const response = await pool.run("a", undefined, async () => new Response(null, { status: 204 }))
  expect(response.status).toBe(204)
  expect(pool.accounts.size).toBe(0)
})

test("an SSE reply holds its slot until the complete stream is consumed", async () => {
  const pool = new TrialPool(1)
  const response = await pool.run("a", undefined, async () => new Response(
    "data: one\n\ndata: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  ))
  expect(pool.accounts.get("a").active).toBe(1)
  let entered = false
  const queued = pool.acquire("a").then((release) => { entered = true; return release })
  await Promise.resolve()
  expect(entered).toBe(false)
  expect(await response.text()).toContain("[DONE]")
  const release = await queued
  expect(entered).toBe(true)
  release()
  expect(pool.accounts.size).toBe(0)
})

test("a client cancelling its response body frees the next call", async () => {
  const pool = new TrialPool(1)
  let vendorCancelled = false
  const response = await pool.run("a", undefined, async () => new Response(new ReadableStream({
    cancel() { vendorCancelled = true },
  })))
  const queued = pool.acquire("a")
  await response.body.cancel()
  const release = await queued
  expect(vendorCancelled).toBe(true)
  release()
  expect(pool.accounts.size).toBe(0)
})

test("aborting an unread response also frees the slot", async () => {
  const pool = new TrialPool(1)
  const abort = new AbortController()
  const response = await pool.run("a", abort.signal, async () => new Response(new ReadableStream()))
  abort.abort()
  await expect(response.text()).rejects.toThrow()
  expect(pool.accounts.size).toBe(0)
})

test("a response body failing mid-read does not leak its slot", async () => {
  const pool = new TrialPool(1)
  const response = await pool.run("a", undefined, async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error("stream dropped")) },
  })))
  await expect(response.text()).rejects.toThrow("stream dropped")
  expect(pool.accounts.size).toBe(0)
})

test("retry sleep observes cancellation without another upstream request", async () => {
  const abort = new AbortController()
  const waiting = waitForTrial(60_000, abort.signal)
  abort.abort()
  await expect(waiting).rejects.toThrow()
})

test("JWT renewal, model selection, and key rotation do not split a known user's pool", () => {
  const jwt = (sub, exp) => `test.${Buffer.from(JSON.stringify({ sub, exp })).toString("base64url")}.test`
  const first = trialAccountKey({}, { site: "zai", jwt: jwt("a", 1), key: "old" })
  const renewed = trialAccountKey({}, { site: "zai", jwt: jwt("a", 2), key: "new" })
  expect(first).toBe(renewed)
  expect(first).toBe(trialAccountKey({ uid: "a" }, { site: "zai", jwt: "", key: "third" }))
  expect(first).not.toBe(trialAccountKey({}, { site: "zai", jwt: jwt("b", 1), key: "old" }))
  expect(first).not.toBe(trialAccountKey({}, { site: "bigmodel", jwt: jwt("a", 1), key: "old" }))
})

test("a named account with no UID keeps its slots across renewal", () => {
  const first = trialAccountKey({ accountId: "offline-account-a" }, { site: "zai", jwt: "old", key: "" })
  const renewed = trialAccountKey({ accountId: "offline-account-a" }, { site: "zai", jwt: "renewed", key: "" })
  expect(first).toBe(renewed)
  expect(first).not.toBe(trialAccountKey({ accountId: "offline-account-b" }, { site: "zai", jwt: "renewed", key: "" }))
  expect(trialAccountKey({}, { site: "zai", jwt: "old" }))
    .toBe(trialAccountKey({}, { site: "zai", jwt: "renewed" }))
})
