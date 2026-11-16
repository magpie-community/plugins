import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as entry from "./index.mjs"
import { TokenCakeAuthPlugin } from "./index.mjs"
import { TokenCakeAuthPlugin as fromOpencode } from "./opencode.mjs"

const BASE = "https://api.test.tokenca.ke"
const API = `${BASE}/v1`
const KEY = `sk-${"t3st".repeat(4)}`
const AUTH = { type: "api", key: KEY }
const FALLBACK = ["z-ai/glm-5.3", "z-ai/glm-5.3-flash", "deepseek/deepseek-v4.1-flash-1017"]
const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017"
const GLM = ["z-ai/glm-5.3", "z-ai/glm-5.3-flash"]
const REASONED = [...GLM, DEEPSEEK]
// models.dev's zai entries for both GLM ids: reasoning, effort low/high/max.
// The DeepSeek v4 family statements (deepseek-v4-flash/v4-pro) are the same
// shape; the plugin applies them to DEEPSEEK, as asked.
const LEVELS = {
  low: { reasoningEffort: "low" },
  high: { reasoningEffort: "high" },
  max: { reasoningEffort: "max" },
}

const realFetch = globalThis.fetch
let calls = []

function stubFetch(handler) {
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ input, init })
    return await handler(input, init)
  }
}

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const plugin = () => TokenCakeAuthPlugin()

beforeEach(() => {
  calls = []
  // No test reaches the network: a request without its own stub fails loudly.
  globalThis.fetch = async (input) => {
    throw new Error(`unexpected fetch: ${String(input)}`)
  }
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("entry", () => {
  test("exports one plugin function and opencode.mjs re-exports it", () => {
    expect(Object.keys(entry)).toEqual(["TokenCakeAuthPlugin"])
    expect(typeof TokenCakeAuthPlugin).toBe("function")
    expect(fromOpencode).toBe(TokenCakeAuthPlugin)
  })

  test("serves the tokencake provider from those hooks", async () => {
    const p = await plugin()
    expect(typeof p.config).toBe("function")
    expect(p.provider.id).toBe("tokencake")
    expect(typeof p.provider.models).toBe("function")
    expect(p.auth.provider).toBe("tokencake")
    expect(typeof p.auth.loader).toBe("function")
    expect(typeof p.auth.usage).toBe("function")
    expect(p.auth.methods.map((m) => m.type)).toEqual(["api"])
  })

  test("sign-in hints at TokenCake's key shape without echoing the answer", async () => {
    const p = await plugin()
    const prompt = p.auth.methods[0].prompts[0]
    expect(prompt.validate(KEY)).toBeUndefined()
    const bad = "sk-short"
    const hint = prompt.validate(bad)
    expect(typeof hint).toBe("string")
    expect(hint).not.toContain(bad)
    const ok = await p.auth.methods[0].authorize({ apiKey: ` ${KEY} ` })
    expect(ok).toEqual({ type: "success", key: KEY })
    const failed = await p.auth.methods[0].authorize({ apiKey: bad })
    expect(failed.type).toBe("failed")
    expect(failed.error).not.toContain(bad)
  })
})

describe("config", () => {
  test("declares TokenCake and its fallback list", async () => {
    const p = await plugin()
    const cfg = {}
    await p.config(cfg)
    const conf = cfg.provider.tokencake
    expect(conf.name).toBe("TokenCake")
    expect(conf.npm).toBe("@ai-sdk/openai-compatible")
    expect(conf.api).toBe(API)
    expect(Object.keys(conf.models)).toEqual(FALLBACK)
    for (const id of REASONED) expect(conf.models[id]).toEqual({ name: id, reasoning: true, variants: LEVELS })
  })

  test("keeps the provider a user configured", async () => {
    const p = await plugin()
    const mine = { name: "Mine", npm: "@ai-sdk/openai-compatible", api: "https://example.test/v1", models: { mine: { name: "Mine" } } }
    const cfg = { provider: { tokencake: mine, other: { name: "Other" } } }
    await p.config(cfg)
    expect(cfg.provider.tokencake).toBe(mine)
    expect(cfg.provider.other).toEqual({ name: "Other" })
  })
})

describe("provider.models", () => {
  test("returns the account's catalog with ids whole and no fallback mixed in", async () => {
    const p = await plugin()
    const provider = { models: { stale: { name: "Stale" } } }
    stubFetch(async () =>
      json(200, {
        object: "list",
        data: [
          { id: "z-ai/glm-5.3", name: "GLM-5.3" },
          { id: "deepseek/deepseek-v4.1-flash-1017" },
          { id: "z-ai/glm-5.3-flash", name: "" },
          { id: "no-slash" },
        ],
      }),
    )
    const models = await p.provider.models(provider, { auth: AUTH })
    expect(models).toEqual({
      "z-ai/glm-5.3": { name: "GLM-5.3", capabilities: { reasoning: true }, variants: LEVELS },
      [DEEPSEEK]: { name: DEEPSEEK, capabilities: { reasoning: true }, variants: LEVELS },
      "z-ai/glm-5.3-flash": { name: "z-ai/glm-5.3-flash", capabilities: { reasoning: true }, variants: LEVELS },
      "no-slash": { name: "no-slash" },
    })
    expect(models.stale).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(String(calls[0].input)).toBe(`${API}/models`)
    const headers = new Headers(calls[0].init.headers)
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`)
    expect(calls[0].init.redirect).toBe("error")
  })

  test("skips catalog entries without a usable id", async () => {
    const p = await plugin()
    stubFetch(async () => json(200, { data: [{ id: 42 }, {}, null, { id: "" }, { id: "ok/model" }] }))
    const models = await p.provider.models({ models: {} }, { auth: AUTH })
    expect(models).toEqual({ "ok/model": { name: "ok/model" } })
  })

  const kept = { models: { kept: { name: "Kept" } } }
  const fallbacks = [
    ["no sign-in", undefined, null],
    ["an oauth sign-in", { type: "oauth", access: "x" }, null],
    ["a network failure", AUTH, () => { throw new Error("network down") }],
    ["a 500", AUTH, () => json(500, { error: { message: "remote-secret-detail" } })],
    ["a 401", AUTH, () => json(401, { error: { message: "remote-secret-detail" } })],
    ["a body that isn't JSON", AUTH, () => new Response("not json", { status: 200 })],
    ["a non-OpenAI body", AUTH, () => json(200, { models: [{ id: "x/y" }] })],
    ["an empty catalog", AUTH, () => json(200, { data: [] })],
    ["entries with no usable id", AUTH, () => json(200, { data: [{ id: 1 }, null] })],
  ]
  for (const [name, auth, handler] of fallbacks)
    test(`keeps the provider's list on ${name}`, async () => {
      const p = await plugin()
      if (handler) stubFetch(handler)
      const models = await p.provider.models(kept, { auth })
      expect(models).toBe(kept.models)
      if (!handler) expect(calls).toHaveLength(0)
    })
})

describe("reasoning levels", () => {
  test("the two GLM ids and deepseek-v4.1-flash-1017 carry low/high/max and nothing else does", async () => {
    const p = await plugin()
    const cfg = {}
    await p.config(cfg)
    const models = cfg.provider.tokencake.models
    for (const id of REASONED) {
      expect(models[id].reasoning).toBe(true)
      expect(Object.keys(models[id].variants)).toEqual(["low", "high", "max"])
    }
  })

  test("a known catalog id keeps the same levels under the hook's capabilities", async () => {
    const p = await plugin()
    stubFetch(async () => json(200, { data: REASONED.map((id) => ({ id })) }))
    const models = await p.provider.models({ models: {} }, { auth: AUTH })
    for (const id of REASONED) {
      expect(models[id].capabilities).toEqual({ reasoning: true })
      expect(models[id].variants).toEqual(LEVELS)
    }
  })

  test("an id no metadata covers gets no variants and no reasoning", async () => {
    const p = await plugin()
    stubFetch(async () => json(200, { data: [{ id: "z-ai/glm-6" }, { id: "z-ai/glm-5.3-preview" }] }))
    const models = await p.provider.models({ models: {} }, { auth: AUTH })
    expect(models).toEqual({
      "z-ai/glm-6": { name: "z-ai/glm-6" },
      "z-ai/glm-5.3-preview": { name: "z-ai/glm-5.3-preview" },
    })
  })

  test("the fallback list keeps its levels when the catalog can't be read", async () => {
    const p = await plugin()
    const cfg = {}
    await p.config(cfg)
    const provider = { models: cfg.provider.tokencake.models }
    stubFetch(async () => json(500, {}))
    const models = await p.provider.models(provider, { auth: AUTH })
    expect(models).toBe(provider.models)
    for (const id of REASONED) expect(models[id]).toEqual({ name: id, reasoning: true, variants: LEVELS })
  })
})

describe("usage", () => {
  test("shows the plan's four windows in credits", async () => {
    const p = await plugin()
    stubFetch(async () =>
      json(200, {
        plan: { name: "Pro" },
        unit: "credits",
        windows: [
          { window: "5h", used: 10, limit: 100, remaining: 90, reset_at: "2026-11-14T12:00:00Z" },
          { window: "7d", used: 0, limit: 200, remaining: 200, reset_at: null },
          { window: "14d", used: 50, limit: 400, remaining: 200, reset_at: "2026-11-20T00:00:00+08:00" },
          { window: "monthly", used: 0, limit: 1000, remaining: 1000, reset_at: null },
        ],
      }),
    )
    const usage = await p.auth.usage(async () => AUTH)
    expect(usage.plan).toBe("Pro")
    expect(usage.signIn).toBe("kept")
    expect(usage.error).toBeUndefined()
    expect(usage.windows.map((w) => w.name)).toEqual(["5h", "7d", "14d", "monthly"])
    expect(usage.windows[0]).toEqual({
      name: "5h",
      used: 10,
      amount: 10,
      limit: 100,
      unit: "credits",
      display: "10 / 100 credits",
      span: 5 * 3600,
      resetsAt: "2026-11-14T12:00:00.000Z",
    })
    expect(usage.windows[1]).toEqual({
      name: "7d",
      used: 0,
      amount: 0,
      limit: 200,
      unit: "credits",
      display: "0 / 200 credits",
      span: 7 * 86400,
    })
    expect(usage.windows[2].used).toBe(50)
    expect(usage.windows[2].span).toBe(14 * 86400)
    expect(usage.windows[2].resetsAt).toBe("2026-11-19T16:00:00.000Z")
    expect(usage.windows[3]).toEqual({
      name: "monthly",
      used: 0,
      amount: 0,
      limit: 1000,
      unit: "credits",
      display: "0 / 1000 credits",
    })
    expect("span" in usage.windows[3]).toBe(false)
    expect("resetsAt" in usage.windows[1]).toBe(false)
    expect(calls).toHaveLength(1)
    expect(String(calls[0].input)).toBe(`${API}/codeplan/usage`)
    expect(new Headers(calls[0].init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
    expect(calls[0].init.redirect).toBe("error")
  })

  test("skips unknown windows, impossible quotas and repeats, inventing none", async () => {
    const p = await plugin()
    stubFetch(async () =>
      json(200, {
        plan: { name: "Pro" },
        unit: "credits",
        windows: [
          { window: "5h", limit: 100, remaining: 90, reset_at: null },
          { window: "1h", limit: 10, remaining: 10 },
          { window: "7d", limit: 0, remaining: 0 },
          { window: "14d", limit: 100, remaining: -1 },
          { window: "monthly", limit: 100, remaining: 101 },
          { window: "5h", limit: 100, remaining: 0 },
          { window: "monthly", limit: 10.5, remaining: 5 },
          { window: "14d", limit: 100, remaining: 25 },
        ],
      }),
    )
    const usage = await p.auth.usage(async () => AUTH)
    expect(usage.signIn).toBe("kept")
    expect(usage.windows.map((w) => w.name)).toEqual(["5h", "14d"])
    expect(usage.windows[0].used).toBe(10)
    expect(usage.windows[0].amount).toBe(10)
    expect(usage.windows[1].used).toBe(75)
    expect(usage.windows[1].amount).toBe(75)
  })

  const formats = [
    ["a non-credits unit", { plan: { name: "Pro" }, unit: "tokens", windows: [{ window: "5h", limit: 1, remaining: 1 }] }],
    ["no window list", { plan: { name: "Pro" }, unit: "credits" }],
    ["no readable window", { plan: { name: "Pro" }, unit: "credits", windows: [{ window: "1h", limit: 1, remaining: 1 }] }],
    ["not an object", [{ window: "5h" }]],
    ["null", null],
  ]
  for (const [name, body] of formats)
    test(`reports ${name} without making windows up`, async () => {
      const p = await plugin()
      stubFetch(async () => json(200, body))
      const usage = await p.auth.usage(async () => AUTH)
      expect(usage.windows).toEqual([])
      expect(typeof usage.error).toBe("string")
      expect(usage.error.length).toBeGreaterThan(0)
      expect(usage.signIn).toBe("kept")
    })

  test("asks for a sign-in without an API key", async () => {
    const p = await plugin()
    const usage = await p.auth.usage(async () => undefined)
    expect(usage.windows).toEqual([])
    expect(typeof usage.error).toBe("string")
    expect(usage.signIn).toBe("kept")
    expect(calls).toHaveLength(0)
  })

  test("marks a 401 as an expired sign-in without repeating the answer", async () => {
    const p = await plugin()
    stubFetch(async () => json(401, { error: { message: "remote-secret-detail" } }))
    const usage = await p.auth.usage(async () => AUTH)
    expect(usage.signIn).toBe("expired")
    expect(usage.windows).toEqual([])
    expect(usage.error).toContain("401")
    expect(usage.error).not.toContain("remote-secret-detail")
  })

  test("keeps the sign-in on another status and names only the status", async () => {
    const p = await plugin()
    stubFetch(async () => json(500, { error: { message: "remote-secret-detail" } }))
    const usage = await p.auth.usage(async () => AUTH)
    expect(usage.signIn).toBe("kept")
    expect(usage.windows).toEqual([])
    expect(usage.error).toContain("500")
    expect(usage.error).not.toContain("remote-secret-detail")
  })

  test("keeps the sign-in when the request fails", async () => {
    const p = await plugin()
    stubFetch(async () => {
      throw new Error("remote-secret-detail")
    })
    const usage = await p.auth.usage(async () => AUTH)
    expect(usage.signIn).toBe("kept")
    expect(usage.windows).toEqual([])
    expect(typeof usage.error).toBe("string")
    expect(usage.error).not.toContain("remote-secret-detail")
  })
})

describe("loader", () => {
  test("loads nothing without an API key", async () => {
    const p = await plugin()
    expect(await p.auth.loader(async () => undefined)).toEqual({})
    expect(await p.auth.loader(async () => ({ type: "oauth", access: "x" }))).toEqual({})
    expect(await p.auth.loader(async () => ({ type: "api", key: "" }))).toEqual({})
    expect(calls).toHaveLength(0)
  })

  test("signs a Request with Bearer, keeping its method, body and headers", async () => {
    const p = await plugin()
    const loaded = await p.auth.loader(async () => AUTH)
    expect(loaded.baseURL).toBe(API)
    expect(loaded.apiKey).toBe(KEY)
    let sent
    stubFetch(async (input, init) => {
      sent = { input, init }
      return new Response("upstream", { status: 429, headers: { "x-remote": "1" } })
    })
    const body = JSON.stringify({ model: "z-ai/glm-5.3", messages: [] })
    const request = new Request(`${API}/chat/completions`, {
      method: "POST",
      headers: { "x-keep": "yes", authorization: "Bearer placeholder" },
      body,
    })
    const res = await loaded.fetch(request)
    expect(res.status).toBe(429)
    expect(res.headers.get("x-remote")).toBe("1")
    expect(await res.text()).toBe("upstream")
    expect(sent.input).toBe(request)
    expect(sent.init.redirect).toBe("error")
    const headers = new Headers(sent.init.headers)
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`)
    expect(headers.get("x-keep")).toBe("yes")
    expect(request.method).toBe("POST")
    expect(await request.text()).toBe(body)
  })

  test("signs a plain URL with its init headers kept", async () => {
    const p = await plugin()
    const loaded = await p.auth.loader(async () => AUTH)
    let sent
    stubFetch(async (input, init) => {
      sent = { input, init }
      return new Response("{}", { status: 200 })
    })
    await loaded.fetch(`${API}/chat/completions`, { method: "POST", headers: { "x-keep": "yes" }, body: "{}" })
    expect(String(sent.input)).toBe(`${API}/chat/completions`)
    expect(sent.init.method).toBe("POST")
    expect(new Headers(sent.init.headers).get("authorization")).toBe(`Bearer ${KEY}`)
    expect(new Headers(sent.init.headers).get("x-keep")).toBe("yes")
    expect(sent.init.redirect).toBe("error")
  })
})
