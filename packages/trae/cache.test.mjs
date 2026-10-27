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

test("no cache count adds no field", async () => {
  f = fakeTrae()
  f.route("POST /api/agent/v3/llm_utils_chat", () => sse([["output", { response: "ok" }], ["token_usage", { prompt_tokens: 10, completion_tokens: 5, cache_read_input_tokens: 0 }], ["done", {}]]))
  const res = await ask({ model: "glm-5", messages: [{ role: "user", content: "hi" }] })
  expect((await res.json()).usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
})
