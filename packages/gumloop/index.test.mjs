import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GumloopPlugin, _internal } from "./index.mjs"
import { FALLBACK_PRICES, Store, creditsFor, parseModels, priceRef, usageCost } from "./gumloop.mjs"

const { createPlugin, aliasesFor, normalize } = _internal

const KEY = "glkey-AAAAAAAAAAAAAAAAAAAA"
const USER = "userAAAA1111"
const auth = { type: "api", key: KEY, metadata: { userId: USER, email: "ada@example.com" } }
const env = { GUMLOOP_API_BASE: "https://gl.test/api", GUMLOOP_WS_BASE: "https://gl.test/ws", GUMLOOP_OPENROUTER_BASE: "https://or.test/v1" }

const json = (status, body, headers = {}) =>
  new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
const sse = (frames) =>
  new Response(frames.map((f) => (typeof f === "string" ? f : `data: ${JSON.stringify(f)}\n\n`)).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })

const opt = (value, extra = {}) => ({
  value,
  label: value.toUpperCase(),
  status: "active",
  restricted: false,
  metadata: { capabilities: ["functions", "vision"], context_window: 1000000 },
  ...extra,
})
const MODELS = {
  model_groups: [
    { groupLabel: "Auto", options: [opt("gumloop-chew")] },
    {
      groupLabel: "Anthropic",
      options: [
        opt("claude-sonnet-5-5", { metadata: { capabilities: ["functions", "vision"], context_window: 1000000, short_context_window: 300000 } }),
        opt("claude-opus-5-5"),
        opt("claude-opus-4-8", { status: "hidden" }),
      ],
    },
    { groupLabel: "OpenAI", options: [opt("gpt-6-sol", { metadata: { capabilities: ["functions", "reasoning"], context_window: 272000 } })] },
    { groupLabel: "Fireworks", options: [opt("accounts/fireworks/models/glm-5p3", { metadata: { capabilities: ["functions", "reasoning"] } })] },
    { groupLabel: "Other", options: [opt("typesafe/jev-1", { metadata: { capabilities: ["decisions"] } }), opt("x/classifier", { is_classifier_model: true })] },
  ],
}
const BIG_USAGE = { prompt_tokens: 100000, completion_tokens: 5000, prompt_tokens_details: { cached_tokens: 60000, cache_write_tokens: 20000 } }

// fake routes requests by URL; `chat` answers /ws/chat/completions.
function fake(chat = () => json(200, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })) {
  const calls = []
  const fetchImpl = async (input, init = {}) => {
    const url = String(input)
    const headers = new Headers(init.headers)
    const call = { url, headers, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined }
    calls.push(call)
    if (url.startsWith("https://gl.test/api/models")) {
      if (headers.get("authorization") !== `Bearer ${KEY}` || headers.get("x-auth-key") !== USER) return json(403, { error: "forbidden" })
      return json(200, MODELS)
    }
    if (url.startsWith("https://gl.test/ws/chat/completions")) return chat(call, calls)
    if (url === "https://or.test/v1/models") {
      return json(200, {
        data: [
          { id: "anthropic/claude-sonnet-5.5", pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003", input_cache_write: "0.00000375" } },
          { id: "z-ai/glm-5.3", pricing: { prompt: "0.000000079", completion: "0.0000048" } },
        ],
      })
    }
    if (url === "https://or.test/v1/models/z-ai/glm-5.3/endpoints") {
      return json(200, {
        data: {
          endpoints: [
            { provider_name: "Wafer", pricing: { prompt: "0.000000079", completion: "0.0000048" } },
            { provider_name: "Fireworks", pricing: { prompt: "0.0000014", completion: "0.0000044", input_cache_read: "0.00000026" } },
          ],
        },
      })
    }
    return json(404, {})
  }
  return { calls, fetchImpl }
}

const dirs = []
function plugin(f, extra = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gumloop-test-"))
  dirs.push(directory)
  let t = extra.t ?? 1_800_000_000_000
  const p = createPlugin({ directory, fetchImpl: f.fetchImpl, env, now: () => t, ...extra })
  return Object.assign(p, { directory, tick: (ms) => (t += ms) })
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function chatOnce(p, body, signal) {
  const loaded = await p.auth.loader(async () => auth)
  const res = await loaded.fetch("https://gl.test/ws/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", "content-length": "999" },
    body: JSON.stringify(body),
    signal,
  })
  const text = await res.text()
  return { res, text }
}

describe("config", () => {
  test("declares gumloop with slash-free model ids and keeps a configured provider", async () => {
    const p = plugin(fake())
    const mine = { provider: { gumloop: { name: "Mine" } } }
    await p.config(mine)
    expect(mine.provider.gumloop.name).toBe("Mine")
    const cfg = {}
    await p.config(cfg)
    const g = cfg.provider.gumloop
    expect(g.npm).toBe("@ai-sdk/openai-compatible")
    expect(g.api).toBe("https://gl.test/ws")
    expect(Object.keys(g.models).every((k) => !k.includes("/"))).toBe(true)
    expect(g.models["glm-5p3"].cost.input).toBe(1.4)
    expect(g.models["claude-opus-5-5"].variants.high).toEqual({ reasoningEffort: "high" })
  })
  test("the exported plugin loads without a network", async () => {
    const hooks = await GumloopPlugin({ directory: mkdtempSync(join(tmpdir(), "gumloop-test-")) }, undefined)
    expect(hooks.auth.provider).toBe("gumloop")
    expect(hooks.auth.methods[0].type).toBe("api")
  })
})

describe("sign-in", () => {
  test("checks the key and user id against /models and keeps them", async () => {
    const f = fake()
    const p = plugin(f)
    const m = p.auth.methods[0]
    expect(m.prompts.map((q) => q.key)).toEqual(["key", "userId", "email", "balance"])
    const ok = await m.authorize({ key: ` ${KEY} `, userId: USER, email: "ada@example.com", balance: "7,142" })
    expect(m.keyless).toBe(true)
    expect(ok.type).toBe("success")
    expect(ok.key).toBe(KEY)
    // magpie merges the prompts' answers into the metadata: the key must not ride along
    expect(JSON.parse(JSON.stringify({ ...{ key: KEY, userId: USER }, ...ok.metadata }))).toEqual({
      userId: USER,
      email: "ada@example.com",
      balance: 7142,
      balanceAt: 1_800_000_000_000,
    })
    expect(f.calls[0].headers.get("x-auth-key")).toBe(USER)
    const bad = await m.authorize({ key: "glkey-ZZZZZZZZZZZZZZZZZZZZ", userId: USER })
    expect(bad.type).toBe("failed")
    expect(bad.error).toContain("403")
    expect((await m.authorize({ key: KEY })).type).toBe("failed")
  })
  test("prompts validate the formats", () => {
    const [key, user, , balance] = plugin(fake()).auth.methods[0].prompts
    expect(key.validate("short")).toBeString()
    expect(key.validate(KEY)).toBeUndefined()
    expect(user.validate(USER)).toBeUndefined()
    expect(balance.validate("")).toBeUndefined()
    expect(balance.validate("7,142")).toBeUndefined()
    expect(balance.validate("12.5")).toBeUndefined()
    expect(balance.validate("lots")).toBeString()
    expect(balance.validate("-3")).toBeString()
  })
})

describe("loader and requests", () => {
  test("loads nothing without a complete sign-in", async () => {
    const p = plugin(fake())
    expect(await p.auth.loader(async () => undefined)).toEqual({})
    expect(await p.auth.loader(async () => ({ type: "api", key: KEY }))).toEqual({})
  })
  test("signs the request, maps the alias back and rewrites the body for Gumloop", async () => {
    const f = fake((call) => json(200, { model: call.body.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
    const p = plugin(f)
    const loaded = await p.auth.loader(async () => auth)
    expect(loaded.baseURL).toBe("https://gl.test/ws")
    expect(loaded.apiKey).toBe(KEY)
    const { res } = await chatOnce(p, {
      model: "claude-sonnet-5-5",
      stream: false,
      stream_options: { include_usage: true },
      max_completion_tokens: 50,
      store: true,
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(res.status).toBe(200)
    const up = f.calls.find((c) => c.url.includes("/ws/"))
    expect(up.headers.get("authorization")).toBe(`Bearer ${KEY}`)
    expect(up.headers.get("x-auth-key")).toBe(USER)
    expect(up.headers.get("content-length")).toBeNull()
    expect(up.body).toMatchObject({ max_tokens: 50, reasoning: { effort: "high" }, cache_control: { type: "ephemeral", ttl: "1h" } })
    expect(up.body.max_completion_tokens).toBeUndefined()
    expect(up.body.store).toBeUndefined()
    expect(up.body.stream_options).toBeUndefined()

    await chatOnce(p, { model: "glm-5p3", stream: true, messages: [] })
    const glm = f.calls.filter((c) => c.url.includes("/ws/")).pop()
    expect(glm.body.model).toBe("accounts/fireworks/models/glm-5p3")
    expect(glm.body.cache_control).toBeUndefined()
    expect(glm.body.stream_options).toEqual({ include_usage: true })
  })
  test("the 1-hour cache can be turned off", () => {
    expect(normalize({ model: "claude-opus-5-5" }, { cache1h: false }).cache_control).toBeUndefined()
    expect(normalize({ model: "claude-opus-5-5", cache_control: { type: "x" } }, { cache1h: true }).cache_control).toEqual({ type: "x" })
  })
  test("learns a model's output cap from a 400 and retries once", async () => {
    const f = fake((call) =>
      call.body.max_tokens > 128000
        ? json(400, { error: { message: `max_tokens: ${call.body.max_tokens} > 128000, which is the maximum` } })
        : json(200, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    )
    const p = plugin(f)
    const first = await chatOnce(p, { model: "claude-sonnet-5-5", max_tokens: 256000, messages: [] })
    expect(first.res.status).toBe(200)
    const chats = () => f.calls.filter((c) => c.url.includes("/ws/"))
    expect(chats().map((c) => c.body.max_tokens)).toEqual([256000, 128000])
    await chatOnce(p, { model: "claude-sonnet-5-5", max_tokens: 256000, messages: [] })
    expect(chats().pop().body.max_tokens).toBe(128000)
    expect(chats().length).toBe(3)
  })
  test("an out-of-credits answer becomes a 429 that keeps the sign-in and zeroes the estimate", async () => {
    const f = fake(() => json(403, { error: "credit_limit_exceeded", message: "You have reached your credit limit." }))
    const p = plugin(f)
    const { res, text } = await chatOnce(p, { model: "claude-sonnet-5-5", messages: [] })
    expect(res.status).toBe(429)
    expect(res.headers.get("x-magpie-sign-in")).toBe("kept")
    expect(text).toContain("out of credits")
    // a balance read before the refusal doesn't undo it
    const card = await p.auth.usage(async () => ({ ...auth, metadata: { ...auth.metadata, balance: 500, balanceAt: 1 } }))
    expect(card.windows[0]).toMatchObject({ balance: 0 })
    // a newer one does
    p.tick(1000)
    const later = await p.auth.usage(async () => ({ ...auth, metadata: { ...auth.metadata, balance: 800, balanceAt: 1_800_000_000_500 } }))
    expect(later.windows[0]).toMatchObject({ balance: 800 })
  })
  test("a refused key marks the account expired; other errors pass through", async () => {
    const f = fake(() => json(403, { error: "Invalid API key" }))
    const { res } = await chatOnce(plugin(f), { model: "gpt-6-sol", messages: [] })
    expect(res.status).toBe(403)
    expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
    const g = fake(() => json(500, { error: "boom" }))
    const other = await chatOnce(plugin(g), { model: "gpt-6-sol", messages: [] })
    expect(other.res.status).toBe(500)
    expect(other.res.headers.get("x-magpie-sign-in")).toBeNull()
  })
})

describe("credit estimate", () => {
  test("charges a stream's usage (cache reads and writes, rounded up) and a tiny call one credit", async () => {
    const f = fake((call) =>
      call.body.stream
        ? sse([
            { id: "c1", model: call.body.model, choices: [{ index: 0, delta: { content: "Hi" } }] },
            { id: "c1", choices: [], usage: BIG_USAGE },
            "data: [DONE]\n\n",
          ])
        : json(200, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    )
    const p = plugin(f)
    const metaAuth = { ...auth, metadata: { ...auth.metadata, balance: 7142, balanceAt: 42 } }
    const loaded = await p.auth.loader(async () => metaAuth)
    // calibrate from the sign-in before spending
    await p.auth.usage(async () => metaAuth)
    const r = await loaded.fetch("https://gl.test/ws/chat/completions", { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5-5", stream: true, messages: [] }) })
    const text = await r.text()
    expect(text).toContain('"content":"Hi"')
    expect(text).toContain("[DONE]")
    await (await loaded.fetch("https://gl.test/ws/chat/completions", { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [] }) })).text()

    const ledger = JSON.parse(readFileSync(join(p.directory, "gumloop-ledger.json"), "utf8")).accounts[USER]
    // the usage check read OpenRouter's sonnet price [3,15,0.3,3.75]:
    // 20k*3 + 60k*0.3 + 20k*3.75 + 5k*15 = $0.228 -> 46 credits; the tiny call -> 1
    expect(ledger.month).toMatchObject({ credits: 47, calls: 2 })
    expect(ledger.spent).toBe(47)
    expect(ledger.last).toMatchObject({ credits: 1, in: 10, out: 5 })
    const card = await p.auth.usage(async () => metaAuth)
    expect(card.balance).toBe("7095 credits")
    expect(card.windows[0]).toMatchObject({ name: "Credits", balance: 7095, unit: "credits" })
    expect(card.windows[1]).toMatchObject({ aside: true, amount: 47 })
    // the same sign-in balance isn't applied twice
    expect(JSON.parse(readFileSync(join(p.directory, "gumloop-ledger.json"), "utf8")).accounts[USER].spent).toBe(47)
  })
  test("built-in prices stand in when OpenRouter can't be read", async () => {
    const f = fake((call) => sse([{ choices: [], usage: BIG_USAGE }, "data: [DONE]\n\n"]))
    const p = plugin({ fetchImpl: (u, i) => (String(u).startsWith("https://or.test") ? json(503, "") : f.fetchImpl(u, i)) })
    await p.auth.usage(async () => auth)
    const loaded = await p.auth.loader(async () => auth)
    await (await loaded.fetch("https://gl.test/ws/chat/completions", { method: "POST", body: JSON.stringify({ model: "claude-sonnet-5-5", stream: true }) })).text()
    // built-in sonnet [2,10,0.1,2.5]: 20k*2 + 60k*0.1 + 20k*2.5 + 5k*10 = $0.146 -> 30 credits
    expect(JSON.parse(readFileSync(join(p.directory, "gumloop-ledger.json"), "utf8")).accounts[USER].spent).toBe(30)
  })
  test("an allowance option turns the balance into a used/limit window", async () => {
    const p = plugin(fake(), { options: { balance: { [USER]: 15000 }, allowance: 20000 } })
    const card = await p.auth.usage(async () => auth)
    expect(card.windows[0]).toMatchObject({ amount: 5000, limit: 20000, unit: "credits" })
    expect(card.user).toBe("ada@example.com")
  })
  test("says the estimate isn't calibrated until a balance is given", async () => {
    const card = await plugin(fake()).auth.usage(async () => auth)
    expect(card.windows[0].display).toContain("Not calibrated")
    expect(card.windows[0].used).toBeUndefined()
    expect(card.balance).toBeUndefined()
  })
  test("a stopped stream with no usage is counted as unbilled", async () => {
    let push
    const f = fake(() => {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "a" } }] })}\n\n`))
          push = c
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
    })
    const p = plugin(f)
    const loaded = await p.auth.loader(async () => auth)
    const ac = new AbortController()
    const res = await loaded.fetch("https://gl.test/ws/chat/completions", { method: "POST", body: JSON.stringify({ model: "gpt-6-sol", stream: true }), signal: ac.signal })
    const reader = res.body.getReader()
    await reader.read()
    ac.abort()
    push.close()
    await reader.cancel().catch(() => {})
    const card = await p.auth.usage(async () => auth)
    expect(card.windows[1].display).toContain("1 stopped without usage")
  })
  test("a refused key on the usage check marks the account", async () => {
    const card = await plugin(fake()).auth.usage(async () => ({ type: "api", key: "glkey-ZZZZZZZZZZZZZZZZZZZZ", metadata: { userId: USER } }))
    expect(card.signIn).toBe("expired")
  })
})

describe("provider.models", () => {
  test("lists the account's chat models with aliases, limits and live prices", async () => {
    const f = fake()
    const p = plugin(f)
    const models = await p.provider.models({ models: {} }, { auth })
    expect(Object.keys(models)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5", "gpt-6-sol", "glm-5p3"])
    expect(models["claude-sonnet-5-5"].limit.context).toBe(300000)
    expect(models["claude-sonnet-5-5"].capabilities.input.image).toBe(true)
    expect(models["gpt-6-sol"].capabilities.input.image).toBe(false)
    expect(models["claude-opus-5-5"].reasoning).toBe(true)
    // OpenRouter's live list replaces the built-in sonnet price
    expect(models["claude-sonnet-5-5"].cost.input).toBe(3)
    // Fireworks-hosted models are priced at Fireworks' endpoint, not the cheapest host
    expect(models["glm-5p3"].cost).toMatchObject({ input: 1.4, output: 4.4, cache_read: 0.26 })
    // prices are cached for 12 hours
    const n = f.calls.filter((c) => c.url.startsWith("https://or.test")).length
    await p.provider.models({ models: {} }, { auth })
    expect(f.calls.filter((c) => c.url.startsWith("https://or.test")).length).toBe(n)
  })
  test("keeps the previous list on errors and marks a refused key", async () => {
    const kept = { models: { x: { name: "kept" } } }
    expect(await plugin(fake()).provider.models(kept, {})).toBe(kept.models)
    const down = plugin({ fetchImpl: async () => { throw new Error("offline") } })
    expect(await down.provider.models(kept, { auth })).toBe(kept.models)
    const err = plugin({ fetchImpl: async () => json(502, "") })
    expect(await err.provider.models(kept, { auth })).toBe(kept.models)
    const refused = plugin({ fetchImpl: async () => json(401, {}) })
    await expect(refused.provider.models(kept, { auth })).rejects.toMatchObject({ signIn: "expired" })
    const junk = plugin({ fetchImpl: async () => json(200, { nope: 1 }) })
    await expect(junk.provider.models(kept, { auth })).rejects.toThrow("no model list")
  })
})

describe("helpers", () => {
  test("parseModels drops routers, hidden, classifier and tool-less models", () => {
    expect(parseModels(MODELS).map((m) => m.id)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5", "gpt-6-sol", "accounts/fireworks/models/glm-5p3"])
    expect(() => parseModels({ model_groups: [] })).toThrow()
  })
  test("aliases are the last path part unless two ids share it", () => {
    const a = aliasesFor(["a/x/glm", "b/glm", "claude-opus-5-5"])
    expect(a.get("a/x/glm")).toBe("a--x--glm")
    expect(a.get("b/glm")).toBe("b--glm")
    expect(a.get("claude-opus-5-5")).toBe("claude-opus-5-5")
  })
  test("priceRef finds OpenRouter ids", () => {
    expect(priceRef("claude-sonnet-5-5").orIds).toContain("anthropic/claude-sonnet-5.5")
    expect(priceRef("accounts/fireworks/models/glm-5p3")).toMatchObject({ fireworks: true, orIds: ["z-ai/glm-5.3"] })
    expect(priceRef("google/gemma-4-26b-a4b-it").orIds[0]).toBe("google/gemma-4-26b-a4b-it")
  })
  test("usageCost uses the long-context tier past its threshold", () => {
    const entry = { p: [1, 2, 0.1, null], longAt: 1000, long: [2, 4, 0.2, null] }
    expect(usageCost(entry, { prompt_tokens: 999, completion_tokens: 0 }).usd).toBeCloseTo(999 / 1e6)
    expect(usageCost(entry, { prompt_tokens: 1000, completion_tokens: 0 }).usd).toBeCloseTo(2000 / 1e6)
  })
  test("credits round every call up", () => {
    expect(creditsFor(0)).toBe(0)
    expect(creditsFor(0.0001)).toBe(1)
    expect(creditsFor(0.005)).toBe(1)
    expect(creditsFor(0.0051)).toBe(2)
  })
  test("the store anchors each source once and survives a missing file", () => {
    const s = new Store(undefined, () => 5)
    expect(s.anchor("u", 100, "a")).toBe(true)
    s.change("u", (a) => (a.spent += 10))
    expect(s.anchor("u", 100, "a")).toBe(false)
    expect(s.remaining("u")).toBe(90)
    expect(s.price("claude-opus-5-5").p).toEqual(FALLBACK_PRICES["claude-opus-5-5"])
  })
  test("a balance applied late still counts the calls made after it was read", () => {
    const s = new Store(undefined, () => 50)
    s.change("u", (a) => {
      Store.spend(a, 7, 10)
      Store.spend(a, 3, 30)
    })
    expect(s.anchor("u", 100, "login:20", 20)).toBe(true)
    expect(s.remaining("u")).toBe(97)
  })
})
