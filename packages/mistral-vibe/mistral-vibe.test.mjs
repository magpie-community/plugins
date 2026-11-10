// Runs against a local stand-in for Mistral's API: the same paths and the
// shapes measured against it. `bun test` — no network, no key.
import { afterAll, test } from "bun:test"
import assert from "node:assert/strict"
import http from "node:http"

const seen = { bodies: [], keys: [] }
let effortRefused = false
let throttled = 0

// Real Mistral keys are ~45 characters; parseKeys ignores shorter values.
const VIBE_KEY = "vibe-key-0000000000000000000000000001"
const API_KEY = "api-key-00000000000000000000000000002"
const BAD_KEY = "bad-key-0000000000000000000000000000"

// /v1/models: alias families and a non-chat entry, as Mistral serves them.
const API_MODELS = [
  { id: "mistral-medium-latest", name: "mistral-medium-latest", billing_model_name: "mistral-medium-3-5", max_context_length: 128000, aliases: ["mistral-medium-3-5", "mistral-medium"], capabilities: { completion_chat: true, function_calling: true } },
  { id: "mistral-medium-3-5", name: "mistral-medium-latest", billing_model_name: "mistral-medium-3-5", max_context_length: 128000, aliases: ["mistral-medium-latest", "mistral-medium"], capabilities: { completion_chat: true, function_calling: true } },
  { id: "mistral-medium", name: "mistral-medium-latest", billing_model_name: "mistral-medium-3-5", max_context_length: 128000, aliases: ["mistral-medium-latest", "mistral-medium-3-5"], capabilities: { completion_chat: true, function_calling: true } },
  { id: "mistral-embed", name: "mistral-embed", max_context_length: 8192, aliases: [], capabilities: { completion_chat: false } },
  { id: "zai-glm-5-3", name: "zai-glm-5-3", billing_model_name: "zai-glm-5-3", max_context_length: 200000, aliases: ["zai-glm-5", "zai-glm-latest"], capabilities: { completion_chat: true, function_calling: true, reasoning: true } },
  { id: "zai-glm-5", name: "zai-glm-5-3", billing_model_name: "zai-glm-5-3", max_context_length: 200000, aliases: ["zai-glm-5-3", "zai-glm-latest"], capabilities: { completion_chat: true, function_calling: true, reasoning: true } },
  { id: "zai-glm-latest", name: "zai-glm-5-3", billing_model_name: "zai-glm-5-3", max_context_length: 200000, aliases: ["zai-glm-5-3", "zai-glm-5"], capabilities: { completion_chat: true, function_calling: true, reasoning: true } },
  { id: "deepseek-v4-1-flash-1017", name: "deepseek-v4-1-flash-1017", billing_model_name: "deepseek-v4-1-flash-1017", max_context_length: 1048576, aliases: [], capabilities: { completion_chat: true, function_calling: true, reasoning: true, vision: true } },
]

// /v1/model-catalog?surface=vibe-code: the Vibe plan's own list.
const CATALOG = {
  models: [
    { id: "mistral-large-4-0", label: "Mistral Large 4", aliases: ["mistral-large-4-0-3", "mistral-large-4"], max_context_length: 1048576, parameters: { temperature: 1, reasoning: ["low", "medium", "high"] }, capabilities: { completion_chat: true, function_calling: true, vision: true } },
    { id: "mistral-medium-latest", label: "Mistral Medium", aliases: ["mistral-medium", "mistral-medium-3.5", "mistral-vibe-cli-latest"], max_context_length: 262144, parameters: { reasoning: ["none", "high"] }, capabilities: { completion_chat: true, function_calling: true, vision: true } },
    { id: "zai-glm-5-3", label: "GLM 5.3", aliases: ["glm-5-3", "zai-glm-5", "zai-glm-latest"], max_context_length: 1048576, parameters: { reasoning: ["low", "high", "max"] }, capabilities: { completion_chat: true, function_calling: true } },
    { id: "zai-glm-5-3-flash", label: "GLM 5.3 Flash", aliases: [], max_context_length: 1048576, parameters: { reasoning: ["low", "high", "max"] }, capabilities: { completion_chat: true, function_calling: true, vision: true } },
  ],
}

const server = http.createServer((req, res) => {
  let raw = ""
  req.on("data", (chunk) => (raw += chunk))
  req.on("end", () => {
    const key = String(req.headers.authorization ?? "").replace(/^Bearer /, "")
    seen.keys.push(key)
    if (key.startsWith("bad")) {
      res.writeHead(401, { "content-type": "application/json" })
      return res.end('{"message":"Invalid API Key"}')
    }
    const url = new URL(req.url, "http://127.0.0.1")
    if (req.method === "GET" && url.pathname === "/v1/model-catalog") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify(CATALOG))
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ data: API_MODELS }))
    }
    if (req.method === "GET" && url.pathname === "/v1/billing/budget") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(
        JSON.stringify({
          vibe_budget: { usage_percentage: 42.5, initial_budget: 50, currency: "USD", reset_at: "2026-12-01T00:00:00Z", payg_enabled: false },
          api_budget: { usage_percentage: 10, initial_budget: 15, currency: "USD", reset_at: "2026-12-01T00:00:00Z", payg_enabled: false },
        }),
      )
    }
    if (req.method === "GET" && url.pathname === "/v1/billing/subscription") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ plan_name: "Pro", vibe_payg_enabled: false }))
    }
    if (req.method === "GET" && url.pathname === "/api/vibe/whoami") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ plan_type: key.startsWith("api-key") ? "API" : "CHAT", plan_name: "Pro" }))
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = JSON.parse(raw)
      seen.bodies.push(body)
      if (body.model === "throttle-me") {
        throttled += 1
        res.writeHead(429, { "content-type": "application/json", "retry-after": "0" })
        return res.end('{"message":"rate limited"}')
      }
      if (body.model === "tie-model" && body.reasoning_effort === "medium") {
        res.writeHead(400, { "content-type": "application/json" })
        return res.end('{"message":"reasoning_effort \'medium\' is not supported for this model, supported: \'low\', \'high\'"}')
      }
      if (body.reasoning_effort === "xhigh" && !effortRefused) {
        effortRefused = true
        res.writeHead(400, { "content-type": "application/json" })
        return res.end('{"message":"reasoning_effort \'xhigh\' is not supported for this model, supported: \'low\', \'high\'"}')
      }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write('data: {"id":"x","model":"zai-glm-5-3","choices":[{"index":0,"delta":{"role":"assistant","content":[{"type":"thinking","thinking":[{"text":"pondering"}]}]}}]}\n\n')
        res.write('data: {"id":"x","model":"zai-glm-5-3","choices":[{"index":0,"delta":{"content":[{"type":"text","text":[{"text":"Hello"}]}],"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"t","arguments":"{}"}}]}}]}\n\n')
        res.write('data: {"id":"x","model":"zai-glm-5-3","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n')
        return res.end("data: [DONE]\n\n")
      }
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(
        JSON.stringify({
          id: "x",
          model: body.model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: [
                  { type: "thinking", thinking: [{ text: "thinking hard" }] },
                  { type: "text", text: [{ text: "plain answer" }] },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
      )
    }
    res.writeHead(404, { "content-type": "application/json" })
    res.end('{"message":"not found"}')
  })
})

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const root = `http://127.0.0.1:${server.address().port}`
process.env.MISTRAL_VIBE_API_ROOT = root
process.env.MISTRAL_VIBE_CONSOLE_ROOT = root

const { MistralVibeAuthPlugin, parseKeys, listed } = await import("./index.mjs")
const plugin = await MistralVibeAuthPlugin()
const auth = async () => ({ type: "api", key: VIBE_KEY })

test("config declares the provider and no static model ids", async () => {
  const config = {}
  await plugin.config(config)
  const p = config.provider["mistral-vibe"]
  assert.equal(p.name, "Mistral Vibe")
  assert.equal(p.api, `${root}/v1`)
  assert.equal(p.npm, "@ai-sdk/openai-compatible")
  assert.equal(p.models, undefined)
  const kept = { provider: { "mistral-vibe": { name: "Mine", models: { x: { name: "X" } } } } }
  await plugin.config(kept)
  assert.equal(kept.provider["mistral-vibe"].name, "Mine")
  assert.equal(kept.provider["mistral-vibe"].models.x.name, "X")
})

test("one Vibe key lists the catalog plus DeepSeek on the Vibe wallet", async () => {
  const models = await plugin.provider.models({ id: "mistral-vibe", models: {} }, { auth: { type: "api", key: VIBE_KEY } })
  assert.deepEqual(Object.keys(models).sort(), ["deepseek-v4-1-flash-1017", "mistral-large-4-0", "mistral-medium-latest", "zai-glm-5-3", "zai-glm-5-3-flash"])
  assert.equal(models["mistral-large-4-0"].name, "Mistral Large 4 (Vibe budget)")
  assert.equal(models["mistral-large-4-0"].limit.context, 1048576)
  assert.deepEqual(Object.keys(models["mistral-large-4-0"].variants).sort(), ["high", "low", "medium"])
  assert.equal(models["zai-glm-5-3-flash"].capabilities.attachment, true)
  assert.equal(models["deepseek-v4-1-flash-1017"].name, "deepseek-v4-1-flash-1017 (Vibe budget)")
  assert.equal(models["deepseek-v4-1-flash-1017"].capabilities.reasoning, true)
  const fallback = listed(API_MODELS)
  assert.deepEqual(fallback.map((m) => m.id).sort(), ["deepseek-v4-1-flash-1017", "mistral-medium-3-5", "zai-glm-5-3"])
})

test("both keys list every model twice, the alias naming the wallet", async () => {
  assert.deepEqual(parseKeys(`vibe=${VIBE_KEY};api=${API_KEY}`), { vibe: VIBE_KEY, api: API_KEY })
  assert.deepEqual(parseKeys(`${VIBE_KEY};${API_KEY}`), { vibe: VIBE_KEY, api: API_KEY })
  assert.deepEqual(parseKeys(JSON.stringify({ vibe: VIBE_KEY, api: API_KEY })), { vibe: VIBE_KEY, api: API_KEY })
  assert.deepEqual(parseKeys(VIBE_KEY), { vibe: VIBE_KEY })
  assert.deepEqual(parseKeys(`vibe=None;api=${API_KEY}`), { api: API_KEY })

  const models = await plugin.provider.models({ id: "mistral-vibe", models: {} }, { auth: { type: "api", key: `${VIBE_KEY};${API_KEY}` } })
  const ids = Object.keys(models).sort()
  assert.equal(ids.length, 10)
  assert.ok(ids.includes("deepseek-v4-1-flash-1017"))
  assert.ok(ids.includes("deepseek-v4-1-flash-1017--api"))
  assert.equal(models["deepseek-v4-1-flash-1017"].name, "deepseek-v4-1-flash-1017 (Vibe budget)")
  assert.equal(models["deepseek-v4-1-flash-1017--api"].name, "deepseek-v4-1-flash-1017 (API budget)")
  assert.equal(models["deepseek-v4-1-flash-1017--api"].api.id, "deepseek-v4-1-flash-1017--api")
})

test("the bare alias spends the Vibe key, the --api alias the API key", async () => {
  const loader = await plugin.auth.loader(async () => ({ type: "api", key: `${VIBE_KEY};${API_KEY}` }))
  assert.equal(loader.baseURL, `${root}/v1`)

  const vibeCall = await loader.fetch(`${root}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer stale" },
    body: JSON.stringify({ model: "glm-5.3", messages: [{ role: "assistant", content: "hi", reasoning_content: "old", index: 3 }] }),
  })
  assert.equal(vibeCall.status, 200)
  assert.equal(seen.keys.at(-1), VIBE_KEY)
  const sent = seen.bodies.at(-1)
  assert.equal(sent.model, "zai-glm-5-3")
  assert.equal(sent.max_tokens, 131072)
  assert.equal(sent.messages[0].reasoning_content, undefined)
  assert.equal(sent.messages[0].index, undefined)
  const body = await vibeCall.json()
  assert.equal(body.choices[0].message.content, "plain answer")
  assert.equal(body.choices[0].message.reasoning_content, "thinking hard")

  const apiCall = await loader.fetch(`${root}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-1-flash-1017--api", messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(apiCall.status, 200)
  assert.equal(seen.keys.at(-1), API_KEY)
  assert.equal(seen.bodies.at(-1).model, "deepseek-v4-1-flash-1017")
})

test("a streamed GLM reply keeps its deltas and ends tool_calls", async () => {
  const loader = await plugin.auth.loader(auth)
  const response = await loader.fetch(`${root}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "zai-glm-5-3", stream: true, messages: [{ role: "tool", content: "r" }], tools: [{ type: "function", function: { name: "t", parameters: {} } }] }),
  })
  const text = await response.text()
  const events = text.split("\n\n").filter(Boolean).map((e) => e.replace(/^data: /, ""))
  assert.equal(events.at(-1), "[DONE]")
  const chunks = events.slice(0, -1).map((e) => JSON.parse(e))
  assert.equal(chunks[0].choices[0].delta.content, "")
  assert.equal(chunks[0].choices[0].delta.reasoning_content, "pondering")
  assert.equal(chunks[1].choices[0].delta.content, "Hello")
  assert.equal(chunks[2].choices[0].finish_reason, "tool_calls")
  assert.equal(seen.bodies.at(-1).stream_options.include_usage, true)
  assert.equal(seen.bodies.at(-1).reasoning_effort, "high")
})

test("a refused reasoning_effort is retried once at a level the model lists", async () => {
  const loader = await plugin.auth.loader(auth)
  const response = await loader.fetch(`${root}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mistral-large-4-0", reasoning_effort: "xhigh", messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(response.status, 200)
  assert.equal(seen.bodies.at(-1).reasoning_effort, "high")
})

test("a tie at medium leans towards more reasoning", async () => {
  const loader = await plugin.auth.loader(auth)
  const response = await loader.fetch(`${root}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "tie-model", reasoning_effort: "medium", messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(response.status, 200)
  assert.equal(seen.bodies.at(-1).reasoning_effort, "high")
})

test("a 429 is returned as it came, once", async () => {
  const loader = await plugin.auth.loader(auth)
  const before = throttled
  const response = await loader.fetch(`${root}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "throttle-me", messages: [{ role: "user", content: "hi" }] }),
  })
  assert.equal(response.status, 429)
  assert.equal(throttled - before, 1)
  assert.equal(response.headers.get("retry-after"), "0")
})

test("usage shows the Vibe window first and the API one set aside", async () => {
  const usage = await plugin.auth.usage(auth)
  assert.equal(usage.plan, "Pro")
  assert.equal(usage.windows.length, 2)
  assert.equal(usage.windows[0].name, "Vibe Code budget")
  assert.equal(usage.windows[0].used, 42.5)
  assert.equal(usage.windows[0].display, "21.25 / 50.00 USD")
  assert.equal(usage.windows[0].resetsAt, "2026-12-01T00:00:00.000Z")
  assert.equal(usage.windows[0].aside, undefined)
  assert.equal(usage.windows[1].name, "API budget")
  assert.equal(usage.windows[1].aside, true)
  assert.equal(usage.signIn, "kept")

  const apiUsage = await plugin.auth.usage(async () => ({ type: "api", key: API_KEY }))
  assert.equal(apiUsage.windows[0].aside, true)
  assert.equal(apiUsage.windows[1].name, "API budget")
  assert.equal(apiUsage.windows[1].aside, undefined)
})

test("a refused key marks the account expired", async () => {
  const usage = await plugin.auth.usage(async () => ({ type: "api", key: BAD_KEY }))
  assert.equal(usage.signIn, "expired")
  assert.equal(usage.windows.length, 0)
  assert.match(usage.error, /refused this Vibe key/)
})

afterAll(() => server.close())
