// What Trae's token_usage says the prompt cache read and wrote reaches
// magpie (01huadalang on magpie's Discord: K3, 53 calls, every one 0 hits).
// The event's fields are TRAE SOLO CN's own TokenUsageEvent (its ai-agent's
// serde names): name, prompt_tokens, completion_tokens, total_tokens,
// reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens,
// prompt_tokens_total, completion_tokens_total.
import "./nonet.mjs"
import { afterEach, expect, test } from "bun:test"
import { TraeCNAuthPlugin } from "./index.mjs"
import { fakeTrae, signedIn, sse } from "./fake.mjs"

let f
afterEach(() => f?.close())

async function ask(body) {
  const hooks = await TraeCNAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => signedIn())
  return opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify(body) })
}

const USAGE = {
  name: "kimi-k3",
  prompt_tokens: 12000,
  completion_tokens: 300,
  total_tokens: 12300,
  reasoning_tokens: 120,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 11264,
  prompt_tokens_total: 12000,
  completion_tokens_total: 300,
}

const want = {
  prompt_tokens: 12000,
  completion_tokens: 300,
  total_tokens: 12300,
  cache_read_input_tokens: 11264,
  completion_tokens_details: { reasoning_tokens: 120 },
}

test("a stream's token_usage keeps what the cache read", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["token_usage", USAGE], ["done", { finish_reason: "stop" }]]))
  const res = await ask({ model: "glm-5", stream: true, messages: [{ role: "user", content: "hi" }] })
  const last = (await res.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6))).at(-1)
  expect(last.usage).toEqual(want)
})

test("a single answer keeps it too, and what the cache wrote", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["token_usage", { usage: { ...USAGE, cache_creation_input_tokens: 500 } }], ["done", {}]]))
  const res = await ask({ model: "glm-5", messages: [{ role: "user", content: "hi" }] })
  expect((await res.json()).usage).toEqual({ ...want, cache_creation_input_tokens: 500 })
})

test("OpenAI's own cache count is kept as it came", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["done", { usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 64 } } }]]))
  const res = await ask({ model: "glm-5", messages: [{ role: "user", content: "hi" }] })
  expect((await res.json()).usage).toEqual({ prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: 64 } })
})

// feng2787 on magpie's Discord: every Trae hit 0. Trae answers 0 read and
// 0 written while it bills the turn at its cache price, so a count of 0
// says nothing: the cache is unknown, not a 0% miss. A write alone, the
// first turn of a prefix, is still a miss Trae counted.
test("a cache read and write of 0 is unknown", async () => {
  for (const counts of [{ cache_read_input_tokens: 0 }, { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }]) {
    f?.close()
    f = fakeTrae()
    f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["token_usage", { prompt_tokens: 10, completion_tokens: 5, ...counts }], ["done", {}]]))
    const res = await ask({ model: "glm-5", messages: [{ role: "user", content: "hi" }] })
    expect((await res.json()).usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, magpie_cache_unknown: true })
  }
  f.close()
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["token_usage", { prompt_tokens: 10, completion_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 8 }], ["done", {}]]))
  const res = await ask({ model: "glm-5", messages: [{ role: "user", content: "hi" }] })
  expect((await res.json()).usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cache_creation_input_tokens: 8 })
})

// plugins#455 (chansee97): TRAE CN's own client's llm_utils_chat answer,
// its token_usage lines as captured: an id line, and no space after any
// colon. The cache read it says (4096 of 4122) reaches magpie.
const CAPTURED =
  'id:30\nevent:token_usage\ndata:{"name":"","prompt_tokens":4122,"completion_tokens":63,"total_tokens":4185,"cache_creation_input_tokens":0,"cache_read_input_tokens":4096,"reasoning_tokens":20,"prompt_tokens_total":0,"completion_tokens_total":0,"total_tokens_total":0,"cache_creation_input_tokens_total":0,"cache_read_input_tokens_total":0,"reasoning_tokens_total":0,"cluster":"normal_context"}\n\n'

for (const stream of [true, false]) {
  test(`the captured token_usage keeps its cache read (#455, stream=${stream})`, async () => {
    f = fakeTrae()
    f.route(
      "POST /api/agent/v3/llm_utils_chat",
      () =>
        new Response('id:29\nevent:output\ndata:{"response":"ok"}\n\n' + CAPTURED + 'id:31\nevent:done\ndata:{"finish_reason":"stop"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    )
    const res = await ask({ model: "glm-5", stream, messages: [{ role: "user", content: "hi" }] })
    const usage = stream
      ? (await res.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6))).at(-1).usage
      : (await res.json()).usage
    expect(usage).toEqual({
      prompt_tokens: 4122,
      completion_tokens: 63,
      total_tokens: 4185,
      cache_read_input_tokens: 4096,
      completion_tokens_details: { reasoning_tokens: 20 },
    })
  })
}

// yetone/magpie#3979, #3991 (ferock): every Trae CN call showed cache 0.
// A token_usage that names no cache at all — Trae's own bytes, as
// plugins#455 captured one — is told to magpie as unknown
// (magpie_cache_unknown), so it shows no hit rate, not a 0% Trae never
// said; nor is a count of 0 (above).
const UNCOUNTED = 'event: token_usage\ndata: {"prompt_tokens":1717,"completion_tokens":2,"total_tokens":1719}\n\n'

for (const stream of [true, false]) {
  test(`a token_usage that names no cache says the cache is unknown (#3991, stream=${stream})`, async () => {
    f = fakeTrae()
    f.route(
      "POST /api/agent/v3/llm_utils_chat",
      () =>
        new Response('event: output\ndata: {"response":"[]"}\n\n' + UNCOUNTED + 'event: done\ndata: {"done_with":"end","message":"success"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    )
    const res = await ask({ model: "glm-5", stream, messages: [{ role: "user", content: "hi" }] })
    const usage = stream
      ? (await res.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6))).at(-1).usage
      : (await res.json()).usage
    expect(usage).toEqual({ prompt_tokens: 1717, completion_tokens: 2, total_tokens: 1719, magpie_cache_unknown: true })
  })
}

test("DeepSeek's own prompt_cache_hit_tokens is read as the cache read", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["token_usage", { prompt_tokens: 3000, completion_tokens: 2, prompt_cache_hit_tokens: 2048, prompt_cache_miss_tokens: 952 }], ["done", {}]]))
  const res = await ask({ model: "glm-5", messages: [{ role: "user", content: "hi" }] })
  expect((await res.json()).usage).toEqual({ prompt_tokens: 3000, completion_tokens: 2, total_tokens: 3002, prompt_tokens_details: { cached_tokens: 2048 } })
})
