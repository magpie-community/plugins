// #98: Qoder's queue refusing a chat (code 10605) is Qoder being busy for
// the plan, not a lapsed sign-in. The body is the one Qoder gave a real
// trial account on 2026-10-12, byte for byte (testdata/queued-10605.json).
// The other codes are read as Qoder's own client reads them (QoderErrorCode
// in Qoder.app's qoder-agent-sdk worker): only 105 is loginExpired there.
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { QoderAuthPlugin, _internal } from "./index.mjs"

const QUEUED = readFileSync(new URL("./testdata/queued-10605.json", import.meta.url), "utf8").trim()

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const API_CHAT = "https://api3.qoder.sh/v1/chat/completions"
const ASK = { method: "POST", body: JSON.stringify({ model: "efficient", messages: [{ role: "user", content: "hi" }] }) }
const LISTING = { chat: [{ key: "efficient", display_name: "Efficient", enable: true }] }
const json = (v) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } })
const sse = (v) => new Response(`data:${JSON.stringify(v)}\n\n`, { headers: { "Content-Type": "text/event-stream" } })

// the loader's fetch against the listing and a chat reply; sets counts what
// the plugin wrote to the account
async function chat(reply) {
  const auth = { type: "oauth", access: "jt", refresh: "rt", expires: Date.now() + 3_600_000, accountId: "one@x", uid: "u1", machineId: "m1" }
  globalThis.fetch = async (url) => (new URL(String(url)).pathname.endsWith("/model/list") ? json(LISTING) : reply())
  const sets = []
  const hooks = await QoderAuthPlugin({ client: { auth: { set: async ({ body }) => sets.push(body) } } })
  const l = await hooks.auth.loader(async () => auth)
  return { fetch: l.fetch, sets }
}

const busy = async (res) => ({
  status: res.status,
  retryAfter: res.headers.get("Retry-After"),
  signIn: res.headers.get("X-Magpie-Sign-In"),
  message: (await res.json()).error.message,
})

const WANT = {
  status: 503,
  retryAfter: "30",
  signIn: null,
  message: "Qoder is busy for efficient (this plan's queue: p3); try again in 30s",
}

test("a 403 with Qoder's queue code 10605 is a 503 to retry after its 30s, the sign-in untouched", async () => {
  const { fetch, sets } = await chat(() => new Response(QUEUED, { status: 403, headers: { "Content-Type": "application/json" } }))
  expect(await busy(await fetch(API_CHAT, ASK))).toEqual(WANT)
  expect(sets).toEqual([])
})

test("10605 in the stream, before any answer, is the same", async () => {
  const { fetch, sets } = await chat(() => sse({ headers: {}, body: QUEUED, statusCodeValue: 403, statusCode: "FORBIDDEN" }))
  expect(await busy(await fetch(API_CHAT, ASK))).toEqual(WANT)
  expect(sets).toEqual([])
})

test("the queue's own wait is used, a queued request says so, and with no wait it is 30s", () => {
  const q = (queue, code = "10605", status = 403) => _internal.failure(status, JSON.stringify({ code, message: JSON.stringify(queue) }))
  expect(q({ isQueued: true, modelKey: "ultimate", retryAfterSeconds: 12.2 })).toMatchObject({
    status: 503,
    retryAfter: 13,
    message: "Qoder queued the request for ultimate; try again in 13s",
  })
  expect(q({ serviceAvailable: false })).toMatchObject({ status: 503, retryAfter: 30 })
  // the code alone, the message plain text
  expect(_internal.failure(403, JSON.stringify({ code: "10605", message: "busy" }))).toMatchObject({ status: 503, retryAfter: 30 })
  // a queue state under another status (429) is the same wait
  expect(q({ serviceAvailable: false, retryAfterSeconds: 5 }, "", 429)).toMatchObject({ status: 503, retryAfter: 5 })
})

test("Qoder's other codes on a 403 aren't a lapsed sign-in either; 105 and no code are", () => {
  const f = (code, message = "m") => _internal.failure(403, JSON.stringify({ code, message }))
  for (const code of ["110", "112", "113", "114", "115", "116", "117", "118", "119", "122"])
    expect(f(code, "credits used up")).toEqual({ status: 429, message: "usage limit reached: credits used up", signIn: "" })
  for (const code of ["406", "416", "430", "80411", "80412", "100400", "100401", "100403"])
    expect(f(code, "no")).toEqual({ status: 400, message: `Qoder refused the request (${code}): no`, signIn: "" })
  expect(f("105", "login expired")).toEqual({ status: 401, message: "the sign-in lapsed — sign in again (Qoder said 403: login expired)" })
  expect(_internal.failure(403, "")).toEqual({ status: 401, message: "the sign-in lapsed — sign in again" })
})
