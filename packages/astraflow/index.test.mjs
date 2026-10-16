import { afterEach, expect, test } from "bun:test"
import { AstraFlowPlugin, _internal } from "./index.mjs"

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const auth = (region = "china", key = "fixture-key") => ({ type: "api", key, metadata: { region } })
const hooks = () => AstraFlowPlugin()
const listing = (data) => Response.json({ object: "list", data })

test("registers an API key provider with seven selectable endpoints and preserves config", async () => {
  const h = await hooks()
  const cfg = { provider: { astraflow: { name: "My AstraFlow", options: { region: "global" }, models: { custom: { name: "Custom" } } } } }
  await h.config(cfg)
  expect(cfg.provider.astraflow.name).toBe("My AstraFlow")
  expect(cfg.provider.astraflow.npm).toBe("@ai-sdk/openai-compatible")
  expect(cfg.provider.astraflow.models.custom.name).toBe("Custom")
  expect(h.auth.methods[0].type).toBe("api")
  expect(h.auth.methods[0].prompts[0].options.map((o) => o.value)).toEqual(Object.keys(_internal.REGIONS))
  expect(h.auth.methods[0].prompts[0].options).toHaveLength(7)
})

test("each selected region controls both the loader and authenticated model discovery", async () => {
  const h = await hooks()
  for (const [region, { host }] of Object.entries(_internal.REGIONS)) {
    globalThis.fetch = async (url, init) => {
      expect(url).toBe(`https://${host}/v1/models`)
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer fixture-key")
      expect(init.redirect).toBe("error")
      expect(init.signal).toBeInstanceOf(AbortSignal)
      return listing([{ id: "deepseek-v4.1-flash" }])
    }
    const opts = await h.auth.loader(async () => auth(region), {})
    expect(opts.baseURL).toBe(`https://${host}/v1`)
    expect(opts.apiKey).toBe("fixture-key")
    const ms = await h.provider.models({}, { auth: auth(region) })
    expect(ms["deepseek-v4.1-flash"].api.url).toBe(opts.baseURL)
  }
})

test("defaults to China, supports config region, and gives account metadata precedence", async () => {
  const h = await hooks()
  const key = { type: "api", key: "  fixture-key  " }
  expect((await h.auth.loader(async () => key)).baseURL).toBe("https://api.modelverse.cn/v1")
  expect((await h.auth.loader(async () => key, { options: { region: "global" } })).baseURL).toBe("https://api.umodelverse.ai/v1")
  expect((await h.auth.loader(async () => auth("singapore"), { options: { region: "global" } })).baseURL).toBe("https://api-sg.umodelverse.ai/v1")
})

test("no sign-in makes no request; invalid credentials and regions fail before network", async () => {
  globalThis.fetch = () => { throw new Error("unexpected request") }
  const h = await hooks()
  const defaults = { bootstrap: { id: "bootstrap" } }
  expect(await h.provider.models({ models: defaults })).toBe(defaults)
  expect(await h.auth.loader(async () => undefined)).toEqual({})
  for (const bad of [auth("invalid"), auth("__proto__"), auth("china", ""), auth("china", "k\r\ninjected"), auth("china", "k\tinjected"), auth("china", "k\u0000injected"), auth("china", "x".repeat(8193))]) {
    await expect(h.auth.loader(async () => bad)).rejects.toThrow("AstraFlow:")
    await expect(h.provider.models({}, { auth: bad })).rejects.toThrow("AstraFlow:")
  }
})

test("discovers current chat ids, excludes non-chat products, and replaces the bootstrap list", async () => {
  globalThis.fetch = async () => listing([
    { id: "deepseek-v4.1-flash", pricing: [{ Rates: [{ Price: 4, Currency: "CNY" }] }] },
    { id: "deepseek-v4-flash-vision-exp" }, { id: "zai-org/glm-4.6v" },
    { id: "MiniMax-H3" }, { id: "Qwen/Qwen3-Coder" }, { id: "auto" },
    { id: "qwen-audio-3.0-realtime-flash" }, { id: "Qwen/Qwen-Image-Edit" },
    { id: "doubao-seedream-5-0-pro" }, { id: "wan3.0-video" }, { id: "Wan-AI/Wan2.6-I2V" },
    { id: "kling-v3" }, { id: "cicada-tts" }, { id: "speech-2.8-hd" },
    { id: "BAAI/bge-m3" }, { id: "qwen3-embedding-8b" }, { id: "bge-reranker-v2-m3" },
    { id: "easydoc-parse-premium" }, { id: "qwen3.7-max-batch" },
    { id: "doubao-web-search-custom" }, { id: "qwen-mt-flash" },
    { id: "deepseek-v4.1-flash" }, { id: "__proto__" }, { id: "constructor" },
    { id: "" }, { id: " padded " }, { id: 42 }, null,
  ])
  const h = await hooks()
  const ms = await h.provider.models({ models: { retired: { id: "retired" } } }, { auth: auth() })
  expect(Object.keys(ms)).toEqual(["deepseek-v4.1-flash", "deepseek-v4-flash-vision-exp", "zai-org/glm-4.6v", "MiniMax-H3", "Qwen/Qwen3-Coder", "auto"])
  for (const m of Object.values(ms)) {
    expect(m.api.npm).toBe("@ai-sdk/openai-compatible")
    expect(m.providerID).toBe("astraflow")
    expect(m.limit).toEqual({ context: 0, output: 0 })
    expect(m.cost.input).toBe(0)
    expect(m.free).not.toBe(true)
    expect(m.capabilities.input).toEqual({ text: true })
  }
})

test("refresh sees additions and removals, and different keys/regions never share a list", async () => {
  const h = await hooks()
  let revision = "first"
  globalThis.fetch = async (url, init) => listing([{ id: `${new URL(url).hostname}-${new Headers(init.headers).get("Authorization").slice(7)}-${revision}` }])
  const a = await h.provider.models({}, { auth: auth("china", "key-a") })
  const b = await h.provider.models({}, { auth: auth("singapore", "key-b") })
  expect(Object.keys(a)).toEqual(["api.modelverse.cn-key-a-first"])
  expect(Object.keys(b)).toEqual(["api-sg.umodelverse.ai-key-b-first"])
  revision = "second"
  expect(Object.keys(await h.provider.models({ models: a }, { auth: auth("china", "key-a") }))).toEqual(["api.modelverse.cn-key-a-second"])
})

test("malformed or empty lists fail instead of pretending stale models were refreshed", async () => {
  const h = await hooks()
  for (const body of ["not json", "null", "{}", '{"data":{}}', '{"data":[]}', '{"data":[{"id":"qwen-image"}]}']) {
    globalThis.fetch = async () => new Response(body)
    await expect(h.provider.models({ models: { old: {} } }, { auth: auth() })).rejects.toThrow("AstraFlow: model list")
  }
})

test("list errors keep upstream reasons, mark only 401 expired, and redact the key", async () => {
  const h = await hooks()
  for (const status of [401, 403, 429, 500]) {
    globalThis.fetch = async () => Response.json({ error: { message: "quota exceeded fixture-key request_id=example" } }, { status })
    try {
      await h.provider.models({}, { auth: auth() })
      throw new Error("expected failure")
    } catch (e) {
      expect(e.message).toContain(`HTTP ${status}: quota exceeded [redacted] request_id=example`)
      expect(e.signIn).toBe(status === 401 ? "expired" : undefined)
      expect(e.message).not.toContain("fixture-key")
    }
  }
  globalThis.fetch = async () => { throw new Error("connection failed fixture-key") }
  await expect(h.provider.models({}, { auth: auth() })).rejects.toThrow("connection failed [redacted]")
})

test("chat fetch signs the selected endpoint and leaves streaming bodies and errors intact", async () => {
  const h = await hooks()
  const opts = await h.auth.loader(async () => auth("singapore"), {})
  const ctl = new AbortController()
  const body = JSON.stringify({ model: "deepseek-v4.1-flash", stream: true, tools: [{ type: "function", function: { name: "weather" } }] })
  let captured
  const response = new Response("data: {\"choices\":[]}\n\ndata: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } })
  globalThis.fetch = async (req) => { captured = req; return response }
  const res = await opts.fetch(opts.baseURL + "/chat/completions?trace=1", {
    method: "POST", headers: { Authorization: "Bearer caller", "x-api-key": "caller", "Content-Type": "application/json" }, body, signal: ctl.signal,
  })
  expect(res).toBe(response)
  expect(res.bodyUsed).toBe(false)
  expect(captured.url).toBe(opts.baseURL + "/chat/completions?trace=1")
  expect(captured.headers.get("Authorization")).toBe("Bearer fixture-key")
  expect(captured.headers.has("x-api-key")).toBe(false)
  expect(captured.headers.get("Content-Type")).toBe("application/json")
  expect(await captured.text()).toBe(body)
  ctl.abort()
  expect(captured.signal.aborted).toBe(true)
  expect(await res.text()).toContain("[DONE]")
  const denied = Response.json({ error: { message: "No permission to use the model", type: "invalid_request_error" } }, { status: 403, headers: { "x-request-id": "fixture-id" } })
  globalThis.fetch = async () => denied
  const blocked = await opts.fetch(new Request(opts.baseURL + "/chat/completions", { method: "POST", body: "{}" }))
  expect(blocked.status).toBe(403)
  expect(blocked.headers.get("x-request-id")).toBe("fixture-id")
  expect(await blocked.json()).toEqual(await denied.clone().json())
  expect(denied.bodyUsed).toBe(false)
})

test("fetch reads the account's current key and refuses foreign hosts, paths and redirects", async () => {
  let saved = auth()
  const h = await hooks()
  const opts = await h.auth.loader(async () => saved, {})
  let calls = 0
  globalThis.fetch = async (req) => {
    calls++
    expect(req.headers.get("Authorization")).toBe("Bearer new-key")
    expect(req.redirect).toBe("error")
    return new Response("ok")
  }
  saved = auth("china", "new-key")
  await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: "{}" })
  for (const url of ["https://evil.example/v1/chat/completions", "http://api.modelverse.cn/v1/chat/completions", opts.baseURL + "/responses", opts.baseURL + "/messages"]) {
    await expect(opts.fetch(url)).rejects.toThrow("outside the selected endpoint")
  }
  saved = undefined
  await expect(opts.fetch(opts.baseURL + "/chat/completions")).rejects.toThrow("not signed in")
  expect(calls).toBe(1)
})

test("OAuth discovery enriches actual models and applies only the selected key's explicit grants", async () => {
  const h = await hooks()
  const oauth = { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3600_000,
    issuer: "ucloud", projectId: "fixture-project", keyId: "fixture-key-id", inferenceKey: "fixture-key", metadata: { region: "china" } }
  globalThis.fetch = async (_url, init) => {
    if (init.method !== "POST") return listing([{ id: "allowed" }, { id: "denied" }])
    const body = JSON.parse(init.body)
    if (body.Action === "ListUMInferAPIKey") return Response.json({ RetCode: 0, Data: [
      { KeyId: "other-key", GrantAllModels: true },
      { KeyId: "fixture-key-id", GrantAllModels: false, GrantedModels: ["allowed"] },
    ] })
    expect(body.Action).toBe("ListUFSquareModel")
    return Response.json({ RetCode: 0, SquareModels: [{ Id: "allowed", Name: "Readable model", MaxModelLen: 65536,
      Tiers: [{ Rates: [{ ChargeItem: "input", Price: "2.5", Currency: "USD", UnitEn: "million tokens" }] }] },
      { Id: "not-in-inference", Name: "Must not add" }] })
  }
  const result = await h.provider.models({}, { auth: oauth })
  expect(Object.keys(result)).toEqual(["allowed"])
  expect(result.allowed.name).toBe("Readable model")
  expect(result.allowed.limit.context).toBe(65536)
  expect(result.allowed.cost.input).toBe(2.5)
  expect(result.allowed.options).toEqual({})
  globalThis.fetch = async (_url, init) => {
    if (init.method === "POST") return Response.json({ RetCode: 1, Message: "no optional permission" })
    return listing([{ id: "allowed" }, { id: "denied" }])
  }
  expect(Object.keys(await h.provider.models({}, { auth: oauth }))).toEqual(["allowed", "denied"])
})

test("loader translates documented thinking and exposes only precise quota refusal as retryable", async () => {
  const h = await hooks()
  const opts = await h.auth.loader(async () => auth())
  let sent
  globalThis.fetch = async (req) => {
    sent = await req.json()
    return Response.json({ error: { message: "api key quota exceeded: fixture-key" } }, { status: 403 })
  }
  const tools = [{ type: "function", function: { name: "weather" } }]
  const response = await opts.fetch(opts.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({
    model: "ByteDance/doubao-seed-1.6", reasoning_effort: "none", messages: [{ role: "user", content: "hello" }], tools,
  }) })
  expect(sent.thinking).toEqual({ type: "disabled" })
  expect(sent.reasoning_effort).toBeUndefined()
  expect(sent.tools).toEqual(tools)
  expect(response.status).toBe(429)
  expect(response.headers.get("x-magpie-sign-in")).toBe("kept")
  expect(await response.text()).not.toContain("fixture-key")
})
