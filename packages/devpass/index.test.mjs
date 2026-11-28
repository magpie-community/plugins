import { describe, expect, test } from "bun:test"
import { DevPassPlugin, _internal } from "./index.mjs"

const { createPlugin, active, callable, configModel, costOf, notPremium, rowsOf, usageOf, browserSignIn, BASE, AUTHORIZE, TOKEN, BROWSER_SOURCE, RESPONSES, MESSAGES, CHAT } = _internal
const auth = { type: "api", key: "llmgtwy_test" }

function jsonRes(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function model(id, extra = {}) {
  return {
    id,
    display_name: id,
    family: "google",
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    context_length: 200000,
    max_output: 64000,
    supported_parameters: ["tools"],
    pricing: { prompt: "0.000001", completion: "0.000015", input_cache_read: "0.0000001", input_cache_write: "0.00000125" },
    providers: [{ tools: true, streaming: true, vision: true, reasoning: true, reasoning_efforts: ["LOW", "high"] }],
    ...extra,
  }
}

function fetchWith(calls, handler) {
  return async (input, init) => {
    calls.push({ input, init })
    return handler(input, init, calls.length)
  }
}

describe("browser sign-in", () => {
  async function attempt(fetchImpl) {
    const login = await browserSignIn(fetchImpl)
    const url = new URL(login.url)
    return { login, url, callback: (query) => {
      const target = new URL(url.searchParams.get("callback"))
      for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value)
      return fetch(target)
    } }
  }

  test("opens DevPass's browser approval with PKCE and redeems its one-time code", async () => {
    const calls = []
    const { login, url, callback } = await attempt(fetchWith(calls, () => jsonRes(200, { api_key: "llmgtwy_minted", expires_at: null })))
    expect(url.origin + url.pathname).toBe(AUTHORIZE)
    expect(url.searchParams.get("org")).toBe("devpass")
    expect(url.searchParams.get("source")).toBe(BROWSER_SOURCE)
    expect(url.searchParams.get("source")).toBe("openai-sdk")
    expect(url.searchParams.get("name")).toBe("Magpie")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(new URL(url.searchParams.get("callback")).hostname).toBe("127.0.0.1")
    expect(login.method).toBe("auto")
    const response = await callback({ state: url.searchParams.get("state"), code: "one-time" })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("DevPass is connected")
    expect(await login.callback()).toEqual({ type: "success", provider: "devpass", key: "llmgtwy_minted", metadata: { name: "Magpie (browser)" } })
    expect(calls[0].input).toBe(TOKEN)
    expect(calls[0].init.redirect).toBe("error")
    const body = JSON.parse(calls[0].init.body)
    expect(body.code).toBe("one-time")
    const { createHash } = await import("node:crypto")
    expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(url.searchParams.get("code_challenge"))
    expect((await callback({ state: url.searchParams.get("state"), code: "again" })).status).toBe(409)
  })

  test("rejects a forged callback without exchanging its code", async () => {
    const calls = []
    const { login, url, callback } = await attempt(fetchWith(calls, () => jsonRes(200, {})))
    const response = await callback({ state: "wrong", code: "forged" })
    expect(response.status).toBe(400)
    expect((await login.callback()).type).toBe("failed")
    expect(calls).toHaveLength(0)
  })

  test("reports a browser refusal without asking for a key", async () => {
    const calls = []
    const { login, url, callback } = await attempt(fetchWith(calls, () => jsonRes(200, {})))
    const response = await callback({ state: url.searchParams.get("state"), error: "access_denied", error_description: "Denied by the user" })
    expect(response.status).toBe(400)
    expect(await login.callback()).toEqual({ type: "failed", error: "Denied by the user" })
    expect(calls).toHaveLength(0)
  })

  test("returns upstream exchange failures without saving a credential", async () => {
    const { login, url, callback } = await attempt(() => jsonRes(400, { error_description: "The login code is invalid" }))
    const response = await callback({ state: url.searchParams.get("state"), code: "stale" })
    expect(response.status).toBe(400)
    expect(await login.callback()).toEqual({ type: "failed", error: "The login code is invalid" })
  })

  test("rejects malformed token responses", async () => {
    const { login, url, callback } = await attempt(() => jsonRes(200, { expires_at: null }))
    await callback({ state: url.searchParams.get("state"), code: "one-time" })
    expect((await login.callback()).error).toContain("no API key")
  })

  test("times out and closes an abandoned listener", async () => {
    let closed = false
    const listen = async () => ({ url: "http://127.0.0.1:43210/callback", close: () => { closed = true } })
    const login = await browserSignIn(() => jsonRes(200, {}), listen, 5)
    expect(await login.callback()).toEqual({ type: "failed", error: "DevPass browser sign-in timed out. Please try again." })
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(closed).toBe(true)
  })
})

describe("model catalogue", () => {
  test("selects native protocols from the model family", () => {
    expect(configModel(model("gpt-5.5", { family: "openai" })).provider).toEqual({ npm: RESPONSES, api: BASE })
    expect(configModel(model("claude-sonnet-5", { family: "anthropic" })).provider).toEqual({ npm: MESSAGES, api: BASE })
    expect(configModel(model("gemini-3.1-pro")).provider).toEqual({ npm: CHAT, api: BASE })
    expect(configModel(model("gpt-5.5", { family: "OpenAI" })).provider.npm).toBe(RESPONSES)
  })

  test("maps canonical ids, limits, images, tools, reasoning, service tiers and million-token prices", () => {
    const row = rowsOf([model("gemini-3.1-pro", { providers: [{ tools: true, reasoning_efforts: ["low", "medium"], service_tiers: [{ id: "priority" }, { id: "priority" }] }] })])[0]
    expect(row.id).toBe("gemini-3.1-pro")
    expect(row.api).toEqual({ id: "gemini-3.1-pro", url: BASE, npm: CHAT })
    expect(row.limit).toEqual({ context: 200000, output: 64000 })
    expect(row.capabilities).toMatchObject({ reasoning: true, toolcall: true, attachment: true, input: { text: true, image: true } })
    expect(row.variants).toEqual({ low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" } })
    expect(row.serviceTiers).toEqual(["priority"])
    expect(row.cost).toEqual({ input: 1, output: 15, cache: { read: 0.1, write: 1.25 } })
    expect(configModel(model("gpt", { family: "openai" })).variants).toEqual({ low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } })
    expect(configModel(model("claude", { family: "anthropic" })).variants).toEqual({ low: { effort: "low" }, high: { effort: "high" } })
    expect(costOf({ prompt: "0.15e-6", completion: "0.6e-6" })).toEqual({ input: 0.15, output: 0.6 })
  })

  test("excludes virtual, pinned, expired, non-text and non-tool models without discarding unknown future models by name", () => {
    const data = [
      model("keep-me"),
      model("auto"),
      model("custom"),
      model("price"),
      model("smart"),
      model("openai/gpt-5.5"),
      model("virtual", { virtual_model_target: "keep-me" }),
      model("gateway", { family: "llmgateway" }),
      model("expired", { deactivated_at: "2020-01-01T00:00:00Z" }),
      model("future-provider-disabled", { providers: [{ tools: true, deactivated_at: "2020-01-01T00:00:00Z" }] }),
      model("image-output", { architecture: { output_modalities: ["text", "image"] } }),
      model("no-tools", { providers: [{ tools: false }] }),
      model("unknown-future-family", { family: "new-vendor" }),
    ]
    expect(rowsOf(data).map((row) => row.id)).toEqual(["keep-me", "unknown-future-family"])
    expect(active(model("disabled", { deactivated_at: "2020-01-01T00:00:00Z" }))).toBe(false)
    expect(callable(model("fallback-tools", { providers: undefined, supported_parameters: ["tools"] }))).toBe(true)
    expect(callable(model("no-fallback-tools", { providers: undefined, supported_parameters: [] }))).toBe(false)
  })

  test("rejects a malformed list instead of replacing it with nothing", () => {
    for (const data of [undefined, {}, "bad", [{ id: 42 }], [null]]) expect(() => rowsOf(data)).toThrow("invalid model list")
    expect(rowsOf([])).toEqual([])
  })

  test("identifies premium models from actual catalogue prices", () => {
    const rows = rowsOf([
      model("standard", { pricing: { prompt: "0.0000049", completion: "0.0000149" } }),
      model("premium-input", { pricing: { prompt: "0.000005", completion: "0.00001" } }),
      model("premium-output", { pricing: { prompt: "0.000001", completion: "0.000015" } }),
    ])
    expect(notPremium(rows)).toEqual(["standard"])
    expect(notPremium([])).toEqual([])
  })

  test("an unread catalogue leaves the premium window applying to every model", () => {
    const usage = usageOf({ devPlan: "pro", devPlanPremiumCreditsUsed: "1", devPlanPremiumWeeklyLimit: "10" })
    expect(usage.windows[0]).toMatchObject({ name: "Premium weekly", used: 10 })
    expect(usage.windows[0].notModels).toBeUndefined()
  })
})

describe("provider.models", () => {
  test("sends the current account key to the filtered catalogue", async () => {
    const calls = []
    const plugin = createPlugin({ fetchImpl: fetchWith(calls, () => jsonRes(200, { data: [model("gpt-5.5", { family: "openai" })] })) })
    const models = await plugin.provider.models({ models: {} }, { auth })
    expect(Object.keys(models)).toEqual(["gpt-5.5"])
    expect(models["gpt-5.5"].api.npm).toBe(RESPONSES)
    expect(calls[0].input).toBe(`${BASE}/models?exclude_deprecated=true`)
    expect(calls[0].init.headers.authorization).toBe("Bearer llmgtwy_test")
    expect(calls[0].init.headers["x-api-key"]).toBe("llmgtwy_test")
    expect(calls[0].init.redirect).toBe("error")
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  test("keeps the prior list on network, status and malformed-answer failures", async () => {
    const kept = { models: { old: { id: "old" } } }
    for (const handler of [() => jsonRes(500, {}), () => { throw new Error("offline") }]) expect(await createPlugin({ fetchImpl: handler }).provider.models(kept, { auth })).toBe(kept.models)
    await expect(createPlugin({ fetchImpl: () => new Response("not json") }).provider.models(kept, { auth })).rejects.toThrow("valid model list")
    const empty = createPlugin({ fetchImpl: () => jsonRes(200, { data: [] }) })
    expect(await empty.provider.models(kept, { auth })).toEqual({})
  })

  test("marks a refused key expired and lists nothing without an account", async () => {
    const plugin = createPlugin({ fetchImpl: () => jsonRes(401, {}) })
    await expect(plugin.provider.models({ models: {} }, { auth })).rejects.toMatchObject({ signIn: "expired" })
    const kept = { models: { old: {} } }
    expect(await plugin.provider.models(kept, {})).toBe(kept.models)
    expect(await plugin.provider.models(kept, { auth: { type: "oauth" } })).toBe(kept.models)
  })
})

describe("request loader", () => {
  test("loads an account-scoped empty SDK key and offers the expected sign-in method", async () => {
    const plugin = await DevPassPlugin()
    const loaded = await plugin.auth.loader(async () => auth)
    expect(loaded.baseURL).toBe(BASE)
    expect(loaded.apiKey).toBe("llmgtwy_test")
    expect(plugin.auth.methods.map(({ type, label }) => ({ type, label }))).toEqual([
      { type: "oauth", label: "DevPass (browser)" },
      { type: "api", label: "DevPass or LLM Gateway API key" },
    ])
    expect(await import("./package.json", { with: { type: "json" } })).toMatchObject({ default: { magpie: { name: "DevPass" } } })
    expect(await plugin.auth.loader(async () => undefined)).toEqual({})
    expect(plugin.provider.id).toBe("devpass")
    const config = {}
    await plugin.config(config)
    expect(config.provider.devpass).toMatchObject({ name: "DevPass", npm: CHAT, api: BASE, models: {} })
  })

  for (const [path, family, npm] of [
    ["/responses", "openai", RESPONSES],
    ["/messages", "anthropic", MESSAGES],
    ["/chat/completions", "google", CHAT],
  ]) {
    test(`routes a ${family} model to ${path}`, async () => {
      const calls = []
      const plugin = createPlugin({ fetchImpl: fetchWith(calls, () => jsonRes(200, { data: [model("served", { family })] })) })
      const rows = await plugin.provider.models({ models: {} }, { auth })
      expect(rows.served.api).toEqual({ id: "served", url: BASE, npm })
      expect(`${BASE}${path}`).toBe(rows.served.api.url + path)
    })
  }

  test("signs every request with the current key, preserves a source and streams untouched", async () => {
    const calls = []
    let current = "llmgtwy_first"
    const plugin = createPlugin({
      fetchImpl: fetchWith(calls, () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: {\"usage\":{\"cost\":0.01,\"cost_details\":{}},\"metadata\":{\"used_provider\":\"openai\"}}\n\n"))
          controller.close()
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } })),
    })
    const loaded = await plugin.auth.loader(async () => ({ type: "api", key: current }))
    const init = { headers: { "content-type": "application/json" }, body: "{}" }
    const first = await loaded.fetch(`${BASE}/responses`, init)
    expect(first.headers.get("X-Magpie-Sign-In")).toBe("renewed")
    expect(first.headers.get("content-encoding")).toBeNull()
    expect(calls[0].init.headers.get("authorization")).toBe("Bearer llmgtwy_first")
    expect(calls[0].init.headers.get("x-api-key")).toBe("llmgtwy_first")
    expect(calls[0].init.headers.get("x-source")).toBe("usemagpie.ai")
    expect(await first.text()).toContain('"cost_details"')

    current = "llmgtwy_second"
    await loaded.fetch(new Request(`${BASE}/messages`, { method: "POST", headers: { "x-source": "example.com" }, body: "{}" }))
    expect(calls[1].init.headers.get("authorization")).toBe("Bearer llmgtwy_second")
    expect(calls[1].init.headers.get("x-source")).toBe("example.com")
  })

  test("marks only 401 as an expired sign-in and preserves other failures", async () => {
    for (const status of [200, 401, 402, 403, 429, 500]) {
      const plugin = createPlugin({ fetchImpl: () => new Response("upstream error", { status }) })
      const loaded = await plugin.auth.loader(async () => auth)
      const response = await loaded.fetch(`${BASE}/responses`, {})
      expect(response.status).toBe(status)
      expect(response.headers.get("X-Magpie-Sign-In")).toBe(status === 401 ? "expired" : status === 200 ? "renewed" : "kept")
      expect(await response.text()).toBe("upstream error")
    }
    const plugin = createPlugin()
    const loaded = await plugin.auth.loader(async () => ({ type: "api", key: "" }))
    expect(loaded).toEqual({})
    expect(await plugin.auth.loader(async () => ({ type: "oauth" }))).toEqual({})
  })
})

describe("usage", () => {
  const devPlan = {
    label: "My coding tool",
    devPlan: "pro",
    devPlanCreditsUsed: "25",
    devPlanCreditsLimit: "158",
    devPlanCreditsRemaining: "133.00",
    devPlanDailyLimit: "14.22",
    devPlanDailyCreditsUsed: "3.10",
    devPlanDayResetsAt: "2026-08-22T09:30:00.000Z",
    devPlanPremiumWeeklyLimit: "18.96",
    devPlanPremiumCreditsUsed: "5.00",
    devPlanPremiumWeekResetsAt: "2026-08-28T12:00:00.000Z",
  }

  test("maps all three DevPass allowance meters without a fixed monthly span", () => {
    const rows = rowsOf([model("standard", { pricing: { prompt: "0.000001", completion: "0.000002" } })])
    const usage = usageOf(devPlan, rows)
    expect(usage.plan).toBe("DevPass Pro")
    expect(usage.user).toBe("My coding tool")
    expect(usage.windows).toHaveLength(3)
    expect(usage.windows[0]).toMatchObject({ name: "Daily allowance", used: (3.1 / 14.22) * 100, amount: 3.1, limit: 14.22, span: 86400, resetsAt: devPlan.devPlanDayResetsAt, unit: "USD", display: "$3.10 / $14.22" })
    expect(usage.windows[1]).toMatchObject({ name: "Premium weekly", amount: 5, limit: 18.96, span: 604800, resetsAt: devPlan.devPlanPremiumWeekResetsAt, notModels: ["standard"], unit: "USD", display: "$5.00 / $18.96" })
    expect(usage.windows[1].used).toBeCloseTo((5 / 18.96) * 100)
    expect(usage.windows[2]).toEqual({ name: "Monthly allowance", used: (25 / 158) * 100, amount: 25, limit: 158, unit: "USD", display: "$25.00 / $158.00", aside: true })
    expect(usage.windows[2].span).toBeUndefined()
    expect(usage.windows[2].resetsAt).toBeUndefined()
    expect(usageOf({ ...devPlan, devPlan: "lite" }).plan).toBe("DevPass Lite")
    expect(usageOf({ ...devPlan, devPlan: "max" }).plan).toBe("DevPass Max")
  })

  test("does not invent reset times, percentages or amounts for inactive or malformed windows", () => {
    const usage = usageOf({ devPlan: "lite", devPlanDailyCreditsUsed: "0.00", devPlanDailyLimit: "4.64", devPlanDayResetsAt: null, devPlanPremiumCreditsUsed: "bad", devPlanPremiumWeeklyLimit: "5.80", devPlanPremiumWeekResetsAt: null })
    expect(usage.windows[0]).toMatchObject({ name: "Daily allowance", used: 0, amount: 0, limit: 4.64, display: "$0.00 / $4.64" })
    expect(usage.windows[0].resetsAt).toBeUndefined()
    expect(usage.windows[1]).toMatchObject({ name: "Premium weekly", display: "$0.00 / $5.80" })
    expect(usage.windows[1].used).toBeUndefined()
    expect(usage.windows[1].amount).toBeUndefined()
    expect(usage.windows[1].limit).toBeUndefined()
    expect(usage.windows[1].resetsAt).toBeUndefined()
    expect(usage.windows).toHaveLength(2)
    expect(usageOf({ devPlan: "pro", devPlanDailyCreditsUsed: "20", devPlanDailyLimit: "0" }).windows[0].used).toBeUndefined()
  })

  test("reports all-time PAYG usage and an optional key limit", () => {
    expect(usageOf({ devPlan: "none", usage: "31.42", limit: "50" })).toEqual({ plan: "LLM Gateway · Pay as you go", windows: [{ name: "Key usage", aside: true, amount: 31.42, limit: 50, unit: "USD", display: "$31.42 / $50.00" }] })
    expect(usageOf({ devPlan: "none", usage: "2.5", limit: null }).windows[0]).toMatchObject({ amount: 2.5, display: "$2.50" })
    expect(usageOf({ devPlan: "none", usage: "not-a-number" }).windows).toEqual([])
    expect(usageOf({}).plan).toBe("LLM Gateway · Pay as you go")
  })

  test("reads the real endpoint and marks only an authentication refusal expired", async () => {
    const calls = []
    const plugin = createPlugin({ fetchImpl: fetchWith(calls, () => jsonRes(200, { data: devPlan })) })
    expect(await plugin.auth.usage(async () => auth)).toMatchObject({ plan: "DevPass Pro", user: "My coding tool", signIn: "kept" })
    expect(calls[0].input).toBe(`${BASE}/key`)
    expect(calls[0].init.headers.authorization).toBe("Bearer llmgtwy_test")
    for (const status of [401, 402, 403, 429, 500]) {
      const rejected = createPlugin({ fetchImpl: () => jsonRes(status, {}) })
      const card = await rejected.auth.usage(async () => auth)
      expect(card.signIn).toBe(status === 401 ? "expired" : "kept")
      expect(card.windows).toEqual([])
    }
    const offline = createPlugin({ fetchImpl: () => { throw new Error("offline") } })
    expect((await offline.auth.usage(async () => auth)).error).toContain("offline")
    const malformed = createPlugin({ fetchImpl: () => new Response("bad") })
    expect(await malformed.auth.usage(async () => auth)).toMatchObject({ signIn: "kept", windows: [] })
    expect(await malformed.auth.usage(async () => undefined)).toEqual({})
  })

  test("a later premium-window read uses the latest fetched catalogue", async () => {
    const plugin = createPlugin({ fetchImpl: (input) => String(input).endsWith("/key") ? jsonRes(200, { data: devPlan }) : jsonRes(200, { data: [model("standard", { pricing: { prompt: "0.000001", completion: "0.000002" } })] }) })
    await plugin.provider.models({ models: {} }, { auth })
    const card = await plugin.auth.usage(async () => auth)
    expect(card.windows[1].notModels).toEqual(["standard"])
  })
})
