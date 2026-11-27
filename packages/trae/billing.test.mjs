// The settled charge of a turn is the only place Trae names what it actually
// spent, and the commercial record also names the cache the stream leaves at
// 0. That record is the conversation's (plugins#58), so a turn is read as its
// share of it: the record now, less the record last read for the conversation.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin, TraeGlobalAuthPlugin, _internal } from "./index.mjs"
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
    // the conversation's first turn: a record holding just this turn's own
    // prompt and reply is its charge, and is reported as it is
    const first = await usageOf(await s.turn())
    expect(first.credit).toBe(0.12)
    expect(first.prompt_tokens_details.cached_tokens).toBe(4096)
    expect(first.magpie_cache_unknown).toBeUndefined()
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
  // the record's count must not be written beside it: one cache read, not two
  expect(usage.prompt_tokens_details?.cached_tokens).toBeUndefined()
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
  // the first turn's own charge lands on the second read: it is reported as
  // it is once the record holds it
  const first = await usageOf(await turn())
  expect(first.credit).toBe(0.12)
  expect(first.magpie_cache_unknown).toBeUndefined()
  // its second turn: the record moved, so its share is the one turn's
  const second = await usageOf(await turn())
  expect(second.credit).toBe(0.12)
  expect(second.prompt_tokens_details.cached_tokens).toBe(4096)
  expect(second.magpie_cache_unknown).toBeUndefined()
})

// A caller that names no conversation gives each request a session of its
// own (chatBody's random one), so every turn is the first of its record. The
// record then holds just that turn, and reporting it is right: taking it for
// a baseline only would leave every such turn with no cache and no credits.
test("a turn whose session is its own still reports its charge", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["token_usage", ZERO_CACHE], ["done", { finish_reason: "stop" }]]))
  f.route("POST /api/v1/commercial/get_session_usage", () => json(record(1)))
  const one = await usageOf(await ask({ model: "glm-5", messages: [{ role: "user", content: "hi" }] }, { session: "ses_turn_a" }))
  const two = await usageOf(await ask({ model: "glm-5", messages: [{ role: "user", content: "hi" }] }, { session: "ses_turn_b" }))
  for (const usage of [one, two]) {
    expect(usage.credit).toBe(0.12)
    expect(usage.prompt_tokens_details.cached_tokens).toBe(4096)
    expect(usage.magpie_cache_unknown).toBeUndefined()
  }
})

// The other side of it: a conversation this plugin has not read yet (a plugin
// restarted mid-conversation) has a record holding several turns already, and
// must not be reported as this turn's charge.
test("a conversation this plugin hasn't read is a baseline, not this turn's", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["token_usage", ZERO_CACHE], ["done", { finish_reason: "stop" }]]))
  // five turns of it: its prompt is far more than this turn's own
  f.route("POST /api/v1/commercial/get_session_usage", () => json(record(5)))
  const usage = await usageOf(await ask({ model: "glm-5", messages: [{ role: "user", content: "hi" }] }, { session: "ses_seen" }))
  expect(usage.credit).toBeUndefined()
  expect(usage.magpie_cache_unknown).toBe(true)
})

// The realm's own billing host: Trae CN has one, Trae Global has not been
// measured (api5-normal.trae.ai does not resolve), so a Global turn must not
// ask for a settlement at all.
test("a Trae Global turn reads no settlement: that realm has no billing host", async () => {
  f = fakeTrae("trae-global")
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [{ function: "chat_v3", config_info_list: [{ config_name: "kimi-k2.5", usage: "chat_completion", is_preset: true }] }] }))
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["token_usage", ZERO_CACHE], ["done", { finish_reason: "stop" }]]))
  const hooks = await TraeGlobalAuthPlugin({ client: {} })
  await hooks.provider.models({ models: {} }, { auth: signedIn() })
  const opts = await hooks.auth.loader(async () => signedIn())
  const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "kimi-k2.5", stream: true, messages: [{ role: "user", content: "hi" }] }) })
  expect(res.status).toBe(200)
  await res.text()
  expect(f.seen.filter((r) => r.path === "/api/v1/commercial/get_session_usage").length).toBe(0)
})

// The second turn's charge lands only after that turn's wait is over (the
// fifth read of the test): the turn reports nothing - no credit, no
// cached_tokens, magpie_cache_unknown kept - rather than a false 0, and the
// third turn's share then covers both turns.
test("a record that lands after the wait is not reported as this turn's 0", async () => {
  f = fakeTrae()
  let turns = 0
  let reads = 0
  f.route("POST /api/agent/v3/llm_utils_chat", () => {
    turns++
    return sse([["output", { response: "ok" }], ["token_usage", ZERO_CACHE], ["done", { finish_reason: "stop" }]])
  })
  f.route("POST /api/v1/commercial/get_session_usage", () => {
    reads++
    // turn 1's charge is in the record by its own read; turn 2's only after
    // its wait, which the fifth read is past
    return json(record(reads <= 4 ? 1 : turns))
  })
  const session = "ses_late2"
  const turn = () => ask({ model: "glm-5", stream: true, messages: [{ role: "user", content: "hi" }] }, { session })
  const first = await usageOf(await turn())
  expect(first.credit).toBe(0.12) // its own charge, from its own record
  const second = await usageOf(await turn())
  expect(second.credit).toBeUndefined()
  expect(second.magpie_cache_unknown).toBe(true)
  const third = await usageOf(await turn())
  expect(third.credit).toBe(0.24) // both turns now that the record has moved
  expect(third.prompt_tokens_details.cached_tokens).toBe(8192)
  expect(third.magpie_cache_unknown).toBeUndefined()
})

// Its books going back is another record (a new period, a reset): the turn
// takes it as the baseline and reports nothing of it.
test("a record that went back is a new baseline, not this turn's charge", async () => {
  f = fakeTrae()
  let reads = 0
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["token_usage", ZERO_CACHE], ["done", { finish_reason: "stop" }]]))
  f.route("POST /api/v1/commercial/get_session_usage", () => {
    reads++
    const settled = reads <= 1 ? 5 : reads <= 3 ? 1 : 2
    return json(record(settled))
  })
  const session = "ses_back"
  const turn = () => ask({ model: "glm-5", stream: true, messages: [{ role: "user", content: "hi" }] }, { session })
  // five turns of the conversation, none of them this plugin's: a baseline
  const first = await usageOf(await turn())
  expect(first.credit).toBeUndefined()
  // the record went back to one turn: another record, reported as nothing
  const second = await usageOf(await turn())
  expect(second.credit).toBeUndefined()
  expect(second.magpie_cache_unknown).toBe(true)
  // and from that baseline the next turn's share is a turn's
  const third = await usageOf(await turn())
  expect(third.credit).toBe(0.12)
})

// Two accounts of one conversation are two conversations to Trae (#58), and
// each keeps its own last reading: one account's record must not be taken as
// the other's baseline.
test("two accounts of one session keep their own readings", async () => {
  f = fakeTrae()
  const calls = new Map()
  f.route("POST /api/v1/commercial/get_session_usage", (r) => {
    const token = String(r.headers.get("authorization") ?? "").replace("Cloud-IDE-JWT ", "")
    const n = (calls.get(token) ?? 0) + 1
    calls.set(token, n)
    return json(record(token === "jwt-a" ? n : 5))
  })
  const site = _internal.SITES["trae-cn"]
  const a = { token: "jwt-a", uid: "u-a" }
  const b = { token: "jwt-b", uid: "u-b" }
  const session = "ses_accounts"
  // a's first read is its own record: this plugin has no baseline, so it is one
  expect(await _internal.turnBilling(a, site, session, { wait: 400 })).toBeNull()
  // b's first read: b has no baseline of its own, and a's is not it
  expect(await _internal.turnBilling(b, site, session, { wait: 400 })).toBeNull()
  // a's next turn, from its own baseline
  const share = await _internal.turnBilling(a, site, session, { wait: 400 })
  expect(share.credits).toBe(0.12)
  expect(share.cacheRead).toBe(4096)
})

// A record Trae refuses (a 4xx, or a code in the envelope) will not settle
// during the turn: it is asked for once, not retried.
test("a record Trae refuses is asked for once", async () => {
  f = fakeTrae()
  let reads = 0
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["token_usage", ZERO_CACHE], ["done", { finish_reason: "stop" }]]))
  f.route("POST /api/v1/commercial/get_session_usage", () => {
    reads++
    return json({ code: 40001, message: "invalid session" })
  })
  const usage = await usageOf(await ask({ model: "glm-5", messages: [{ role: "user", content: "hi" }] }, { session: "ses_refused" }))
  expect(reads).toBe(1)
  expect(usage.credit).toBeUndefined()
  expect(usage.magpie_cache_unknown).toBe(true)
})
