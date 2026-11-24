// The settled charge of a turn is the only place Trae names what it actually
// spent, and the commercial record also names the cache the stream leaves at
// 0. Both must reach the client's usage, in a body and in a stream.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin } from "./index.mjs"
import { fakeTrae, json, signedIn, sse } from "./fake.mjs"

let f
afterEach(() => f?.close())

async function ask(body) {
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn())
  return opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify(body) })
}

const BILL = {
  user_usage_group_by_session: {
    credits_float: 0.12,
    extra_info: { cache_read_token: 4096, input_token: 12000, output_token: 300 },
    usage_group_details: [{ credits_float: 0.12 }],
  },
}

// a token_usage that names a cache of 0, as Trae sends while billing at its
// cache price: the plugin marks it unknown until the commercial record says
// what the cache really read
const ZERO_CACHE = { prompt_tokens: 12000, completion_tokens: 300, total_tokens: 12300, cache_read_input_tokens: 0 }

function routes(bill = BILL) {
  let ids = []
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => {
    ids = [r.json.request_id, r.json.session_id]
    return sse([["output", { response: "ok" }], ["token_usage", ZERO_CACHE], ["done", { finish_reason: "stop" }]])
  })
  f.route("POST /api/v1/commercial/get_session_usage", (r) => {
    expect(r.headers.get("authorization")).toBe("Cloud-IDE-JWT jwt-1")
    expect(ids).toContain(r.json.session_id)
    return bill instanceof Response ? bill : json(bill)
  })
}

test("a body's usage carries the settled credits and the real cache read", async () => {
  f = fakeTrae()
  routes()
  const res = await ask({ model: "glm-5", messages: [{ role: "user", content: "hi" }] })
  expect((await res.json()).usage).toEqual({
    prompt_tokens: 12000,
    completion_tokens: 300,
    total_tokens: 12300,
    prompt_tokens_details: { cached_tokens: 4096 },
    credit: 0.12, // magpie's ledger reads `credit` (yetone/magpie#4328)
    credits: 0.12,
  })
})

test("a stream's usage carries the settled credits and the real cache read", async () => {
  f = fakeTrae()
  routes()
  const res = await ask({ model: "glm-5", stream: true, messages: [{ role: "user", content: "hi" }] })
  const usage = (await res.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6))).at(-1).usage
  expect(usage).toEqual({
    prompt_tokens: 12000,
    completion_tokens: 300,
    total_tokens: 12300,
    prompt_tokens_details: { cached_tokens: 4096 },
    credit: 0.12,
    credits: 0.12,
  })
})

test("a cache the stream named is not overwritten by the commercial record", async () => {
  f = fakeTrae()
  let turn
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => {
    turn = r.json.request_id
    return sse([["output", { response: "ok" }], ["token_usage", { ...ZERO_CACHE, cache_read_input_tokens: 8192 }], ["done", { finish_reason: "stop" }]])
  })
  f.route("POST /api/v1/commercial/get_session_usage", () => json(BILL))
  const res = await ask({ model: "glm-5", messages: [{ role: "user", content: "hi" }] })
  const usage = (await res.json()).usage
  expect(usage.cache_read_input_tokens).toBe(8192)
  expect(usage.credit).toBe(0.12)
  expect(usage.credits).toBe(0.12)
})

test("a turn names itself as the session the billing record is read by", async () => {
  f = fakeTrae()
  let turn
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => {
    turn = r.json.request_id
    expect(r.json.session_id).toBe(turn) // per-turn, not the conversation's
    return sse([["output", { response: "ok" }], ["token_usage", ZERO_CACHE], ["done", { finish_reason: "stop" }]])
  })
  f.route("POST /api/v1/commercial/get_session_usage", (r) => {
    expect(r.json.session_id).toBe(turn)
    return json(BILL)
  })
  const res = await ask({ model: "glm-5", messages: [{ role: "user", content: "hi" }] })
  const usage = (await res.json()).usage
  expect(usage.credit).toBe(0.12)
  expect(usage.credits).toBe(0.12)
  expect(usage.prompt_tokens_details.cached_tokens).toBe(4096)
})

test("a commercial record that cannot be read leaves the answer alone", async () => {
  f = fakeTrae()
  routes(json({ code: 40001, message: "invalid session" }))
  const res = await ask({ model: "glm-5", messages: [{ role: "user", content: "hi" }] })
  const usage = (await res.json()).usage
  expect(usage.credit).toBeUndefined()
  expect(usage.credits).toBeUndefined()
  expect(usage.magpie_cache_unknown).toBe(true)
})

// an enterprise built-in model, as its list gives it: the only reply Trae
// cuts at 2000 and asks on (continued), which makes one reply several asks
const ENT = { config_name: "AI/acme-qwen", usage: "chat_completion", config_source: 2, is_preset: false, is_custom_model: true, status: true,
  display_config: { display_name: "Acme Qwen", is_custom_model: true },
  model_detail_list: [{ model_name: "acme-qwen", provider: "AI", max_tokens: 32768 }] }

test("a reply asked on in rounds names one session, and its bill is read once", async () => {
  f = fakeTrae()
  f.route("POST /api/ide/v1/batch_get_detail_param", () => json({ function_configs: [{ function: "chat_v3", config_info_list: [ENT] }] }))
  const asks = []
  f.route("POST /api/agent/v3/llm_utils_chat", (r) => {
    asks.push(r.json)
    return asks.length === 1
      ? sse([["output", { response: "first half " }], ["done", { finish_reason: "stop", usage: { prompt_tokens: 100, completion_tokens: 2000 } }]])
      : sse([["output", { response: "second half" }], ["done", { finish_reason: "stop", usage: { prompt_tokens: 20, completion_tokens: 40 } }]])
  })
  const billed = []
  f.route("POST /api/v1/commercial/get_session_usage", (r) => {
    billed.push(r.json.session_id)
    return json(BILL)
  })
  const hooks = await TraeCNAuthPlugin({ client: {} })
  await hooks.provider.models({ models: {} }, { auth: signedIn() })
  const opts = await hooks.auth.loader(async () => signedIn())
  const res = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: ENT.config_name, max_tokens: 32768, messages: [{ role: "user", content: "hi" }] }) })
  const body = await res.json()
  expect(body.choices[0].message.content).toBe("first half second half")
  // one reply, two requests: each names itself, and the reply names both
  expect(asks.length).toBe(2)
  expect(asks[1].request_id).not.toBe(asks[0].request_id)
  expect(asks[1].session_id).toBe(asks[0].session_id)
  // the record is the reply's, so it is read once, by that session
  expect(billed).toEqual([asks[0].session_id])
  expect(body.usage.credit).toBe(0.12)
  expect(body.usage.prompt_tokens_details.cached_tokens).toBe(4096)
  // and the reply's tokens are both asks'
  expect(body.usage.completion_tokens).toBe(2040)
})
