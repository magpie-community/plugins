import { afterEach, expect, test } from "bun:test"
import { AtomCodeAuthPlugin, _internal } from "./index.mjs"

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.ATOMCODE_API_BASE
  delete process.env.ATOMCODE_API_KEY
  delete process.env.ATOMGIT_TOKEN
})

test("exports standard Magpie / OpenCode plugin shape", async () => {
  const hooks = await AtomCodeAuthPlugin()
  expect(hooks).toBeDefined()
  expect(typeof hooks.config).toBe("function")
  expect(hooks.auth.provider).toBe("atomcode")
  expect(typeof hooks.auth.loader).toBe("function")
  expect(typeof hooks.auth.usage).toBe("function")
  expect(Array.isArray(hooks.auth.methods)).toBe(true)
  expect(hooks.auth.methods[0].type).toBe("api")
})

test("config registers provider with models and npm package", async () => {
  const hooks = await AtomCodeAuthPlugin()
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const p = cfg.provider.atomcode
  expect(p).toBeDefined()
  expect(p.npm).toBe("@ai-sdk/openai-compatible")
  expect(p.models["glm5.3-flash"]).toBeDefined()
  expect(p.models["qwen3.8-27b"]).toBeDefined()
})

test("resolveBaseURL respects options and environment variable", () => {
  const { resolveBaseURL, DEFAULT_BASE } = _internal
  expect(resolveBaseURL()).toBe(DEFAULT_BASE)
  expect(resolveBaseURL({ baseURL: "http://192.168.1.100:4017/v1/" })).toBe("http://192.168.1.100:4017/v1")

  process.env.ATOMCODE_API_BASE = "http://localhost:4018/v1"
  expect(resolveBaseURL()).toBe("http://localhost:4018/v1")
})

test("resolveApiKey respects auth, options, and env fallback", () => {
  const { resolveApiKey, DEFAULT_KEY } = _internal
  expect(resolveApiKey()).toBe(DEFAULT_KEY)
  expect(resolveApiKey({ key: "custom-key" })).toBe("custom-key")
  expect(resolveApiKey(null, { apiKey: "opt-key" })).toBe("opt-key")

  process.env.ATOMCODE_API_KEY = "env-key"
  expect(resolveApiKey()).toBe("env-key")
})

test("usage reports 5-hour rolling quota window", async () => {
  const hooks = await AtomCodeAuthPlugin()
  const res = await hooks.auth.usage(async () => ({ type: "api", key: "test-token" }))
  expect(res.plan).toBe("AtomGit CodingPlan")
  expect(res.signIn).toBe("kept")
  expect(res.windows.length).toBe(1)
  expect(res.windows[0].name).toBe("5-Hour Quota")
  expect(res.windows[0].limit).toBe(200)
})

test("loader returns empty object when not authenticated", async () => {
  const hooks = await AtomCodeAuthPlugin()
  const loader = await hooks.auth.loader(async () => null)
  expect(loader).toEqual({})
})

test("loader fetch attaches authorization header and forwards body", async () => {
  let capturedHeaders = null
  let capturedBody = null
  let capturedUrl = null

  globalThis.fetch = async (url, init) => {
    capturedUrl = String(url)
    capturedHeaders = new Headers(init.headers)
    capturedBody = init.body
    return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }

  const hooks = await AtomCodeAuthPlugin()
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: "my-secret-key" }))

  expect(loader.baseURL).toBe("http://127.0.0.1:4018/v1")
  expect(loader.apiKey).toBe("my-secret-key")

  const res = await loader.fetch("http://127.0.0.1:4018/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "glm5.3-flash", messages: [{ role: "user", content: "hi" }] }),
  })

  expect(res.status).toBe(200)
  expect(capturedUrl).toBe("http://127.0.0.1:4018/v1/chat/completions")
  expect(capturedHeaders.get("authorization")).toBe("Bearer my-secret-key")
  expect(JSON.parse(capturedBody).model).toBe("glm5.3-flash")
})

test("loader fetch handles network failure with 502 error response", async () => {
  globalThis.fetch = async () => {
    throw new Error("Connection refused")
  }

  const hooks = await AtomCodeAuthPlugin()
  const loader = await hooks.auth.loader(async () => ({ type: "api" }))
  const res = await loader.fetch("http://127.0.0.1:4018/v1/chat/completions", {
    method: "POST",
    body: "{}",
  })

  expect(res.status).toBe(502)
  const data = await res.json()
  expect(data.error.type).toBe("relay_error")
  expect(data.error.message).toContain("Connection refused")
})

test("provider.models discovers models from endpoint and falls back on error", async () => {
  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({
        data: [
          { id: "glm5.3-flash", context_window: 512000 },
          { id: "new-custom-model", context_window: 64000 },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  }

  const hooks = await AtomCodeAuthPlugin()
  const models = await hooks.provider.models()
  expect(models["glm5.3-flash"]).toBeDefined()
  expect(models["new-custom-model"]).toBeDefined()
  expect(models["new-custom-model"].limit.context).toBe(64000)

  // Test fallback on fetch error
  globalThis.fetch = async () => {
    throw new Error("network timeout")
  }
  const fallbackModels = await hooks.provider.models({ models: { "existing-model": {} } })
  expect(fallbackModels["glm5.3-flash"]).toBeDefined()
  expect(fallbackModels["existing-model"]).toBeDefined()
})
