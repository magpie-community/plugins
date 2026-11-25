// The settled charge of a turn is the only place Trae names what it actually
// spent, and the commercial record also names the cache the stream leaves at
// 0. That record is the conversation's (plugins#58), so a turn is read as its
// share of it: the record now, less the record last read for the conversation.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin } from "./index.mjs"
import { fakeTrae, json, signedIn, sse } from "./fake.mjs"

let f
afterEach(() => f?.close())

// ask sends a chat as magpie's host does, with the conversation magpie names
// it by (a session header), and answers its response.
async function ask(chat, { session = "ses_billing" } = {}) {
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const out = { headers: {} }
  await hooks["chat.headers"]({ sessionID: session, model: { providerID: "trae-cn", id: "glm-5" }, provider: { info: { id: "trae-cn" } } }, out)
  const opts = await hooks.auth.loader(async () => signedIn())
  return opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", headers: new Headers(out.headers), body: JSON.stringify(chat) })
}

// a token_usage that names a cache of 0, as Trae sends while billing at its
// cache price: the plugin marks it unknown until the commercial record says
// what the cache really read
const ZERO_CACHE = { prompt_tokens: 12000, completion_tokens: 300, total_tokens: 12300, cache_read_input_tokens: 0 }

// the record a conversation of n settled turns has: Trae's own credits for
// them (credits_by_source, a string, where credits_float rounds a small
// charge to 0), its cache and token totals
const record = (n) => ({
  user_usage_group_by_session: {
    credits_float: 0,
    credits_by_source: { trae: (0.12 * n).toFixed(5) },
    extra_info: { cache_read_token: 4096 * n, input_token: 12000 * n, output_token: 300 * n },
    usage_group_details: [{ group_key: "default", credits_by_source: { trae: (0.12 * n).toFixed(5) } }],
  },
})

// serve answers n turns of one conversation with a cut-free reply, and the
// record those turns come to
let seq = 0
function serve({ stream = false, cache = 0, session = "ses_" + ++seq } = {}) {
  f = fakeTrae()
  const turns = new Map()
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => {
    const id = r.json.session_id
    turns.set(id, (turns.get(id) ?? 0) + 1)
    return sse([["output", { response: "ok" }], ["token_usage", { ...ZERO_CACHE, ...(cache ? { cache_read_input_tokens: cache } : {}) }], ["done", { finish_reason: "stop" }]])
  })
  f.route("POST /api/v1/commercial/get_session_usage", (r) => {
    expect(r.headers.get("authorization")).toBe("Cloud-IDE-JWT jwt-1")
    return json(record(turns.get(r.json.session_id) ?? 1))
  })
  return { stream, session, turn: () => ask({ model: "glm-5", stream, messages: [{ role: "user", content: "hi" }] }, { session }) }
}

const usageOf = async (res) => {
  const body = await res.text()
  if (!body.includes("data: {")) return JSON.parse(body).usage
  return body.split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6))).filter((x) => x.usage).at(-1)?.usage
}

for (const stream of [false, true]) {
  test(`a turn reports its own share of the conversation's record (${stream ? "streamed" : "one body"})`, async () => {
    const s = serve({ stream })
    // the conversation's first turn: nothing to take a share from, so only
    // what Trae's stream said goes on, and this reading is the baseline
    const first = await usageOf(await s.turn())
    expect(first.credit).toBeUndefined()
    expect(first.magpie_cache_unknown).toBe(true)
    // its second turn: the record now less the reading above
    const usage = await usageOf(await s.turn())
    expect(usage.credit).toBe(0.12)
    expect(usage.prompt_tokens_details.cached_tokens).toBe(4096)
    expect(usage.magpie_cache_unknown).toBeUndefined()
  })
}

test("a cache the stream named is not overwritten by the commercial record", async () => {
  const s = serve({ cache: 8192 })
  await s.turn()
  const usage = await usageOf(await s.turn())
  expect(usage.cache_read_input_tokens).toBe(8192)
  expect(usage.credit).toBe(0.12)
})

test("a commercial record that cannot be read leaves the answer alone", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["token_usage", ZERO_CACHE], ["done", { finish_reason: "stop" }]]))
  f.route("POST /api/v1/commercial/get_session_usage", () => json({ code: 40001, message: "invalid session" }))
  const usage = await usageOf(await ask({ model: "glm-5", messages: [{ role: "user", content: "hi" }] }))
  expect(usage.credit).toBeUndefined()
  expect(usage.credits).toBeUndefined()
  expect(usage.magpie_cache_unknown).toBe(true)
})

test("a record that never answers does not hold the answer's end", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["token_usage", ZERO_CACHE], ["done", { finish_reason: "stop" }]]))
  // one that never answers: the read has a timeout of its own, and a stream's
  // end waits for it only a little
  f.route("POST /api/v1/commercial/get_session_usage", () => new Promise(() => {}))
  const at = Date.now()
  const usage = await usageOf(await ask({ model: "glm-5", stream: true, messages: [{ role: "user", content: "hi" }] }))
  const took = Date.now() - at
  expect(usage.credit).toBeUndefined()
  expect(usage.magpie_cache_unknown).toBe(true)
  expect(took).toBeLessThan(2000)
})

// A record that lands on the second read after the answer (about 150 ms,
// well inside a stream's wait). Until it moves past the last reading it
// holds the earlier turns only: accepting it as this turn's would report
// before - before = 0, a 0% cache hit and no credits, the next turn taking
// both. So a reading that hasn't moved is one still being written.
test("a record that hasn't moved yet is not this turn's 0", async () => {
  f = fakeTrae()
  let turns = 0
  let asks = 0
  let settled = 0
  f.route("POST /api/agent/v3/llm_utils_chat", () => {
    turns++
    asks = 0
    return sse([["output", { response: "ok" }], ["token_usage", ZERO_CACHE], ["done", { finish_reason: "stop" }]])
  })
  f.route("POST /api/v1/commercial/get_session_usage", () => {
    asks++
    if (asks >= 2) settled = turns
    return json(record(settled))
  })
  const session = "ses_late"
  const turn = () => ask({ model: "glm-5", stream: true, messages: [{ role: "user", content: "hi" }] }, { session })
  // the first turn's charge is not in the record yet: its reading is the
  // baseline of the conversation, and it reports nothing
  const first = await usageOf(await turn())
  expect(first.credit).toBeUndefined()
  expect(first.magpie_cache_unknown).toBe(true)
  // its second turn: the record moved, so its share is the one turn's
  const second = await usageOf(await turn())
  expect(second.credit).toBe(0.12)
  expect(second.prompt_tokens_details.cached_tokens).toBe(4096)
  expect(second.magpie_cache_unknown).toBeUndefined()
})
