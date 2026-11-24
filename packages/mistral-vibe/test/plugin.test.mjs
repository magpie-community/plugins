// Tests against a stand-in for console.mistral.ai and api.mistral.ai: the
// browser sign-in (start → poll → exchange), the request loader's signing,
// the billing usage read and the model list. Set the bases to the mock's own
// URLs; the plugin reads them per call, so this works whatever order the
// tests run in.
import { afterEach, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { MistralVibeAuthPlugin, _internal } from "../index.mjs"

const realFetch = globalThis.fetch

process.env.MISTRAL_VIBE_API_BASE = "http://mock.local/v1"
process.env.MISTRAL_VIBE_CONSOLE_API = "http://mock.local/api"

const KEY = "vibe-key-1"
const state = { polls: 0, chats: [], bodies: [], exchanges: [], whoamis: 0, modelsCalls: 0 }

// mistralRefuse answers as api.mistral.ai does a message field it doesn't know
// (422 extra_forbidden, loc ["body","messages",2,"assistant",
// "reasoning_content"]), and a thinking part that isn't the list of text
// chunks it returns: the tests then fail on the shape that was refused in
// the field. Null when the request is one it takes.
function mistralRefuse(body) {
  if (typeof body !== "string") return null
  let q
  try {
    q = JSON.parse(body)
  } catch {
    return null
  }
  const known = ["role", "content", "tool_calls", "tool_call_id", "name", "prefix"]
  const detail = []
  for (const [i, m] of (q?.messages ?? []).entries()) {
    let fields = known
    if (m?.role === "user") fields = ["role", "content"]
    if (m?.role === "assistant") fields = ["role", "content", "tool_calls", "prefix"]
    for (const k of Object.keys(m ?? {})) {
      if (!fields.includes(k))
        detail.push({ type: "extra_forbidden", loc: ["body", "messages", i, m.role, k], msg: "Extra inputs are not permitted", input: m[k] })
    }
    const parts = Array.isArray(m?.content) ? m.content : []
    for (const [j, p] of parts.entries()) {
      if (p?.type === "text") {
        for (const k of Object.keys(p)) {
          if (k !== "type" && k !== "text")
            detail.push({ type: "extra_forbidden", loc: ["body", "messages", i, m.role, "content", j, "text", k] })
        }
      }
      if (p?.type !== "thinking") continue
      const chunks = p.thinking
      const ok = Array.isArray(chunks) && chunks.every((c) => c?.type === "text" && typeof c.text === "string")
      if (!ok)
        detail.push({
          type: "list_type",
          loc: ["body", "messages", i, "assistant", "content", j, "thinking"],
          msg: "Input should be a valid list",
          input: chunks,
        })
    }
  }
  return detail.length ? detail : null
}

function mockFetch() {
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input)
    const u = new URL(url)
    const h = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } })

    if (u.pathname === "/api/vibe/sign-in" && init.method === "POST") {
      const body = JSON.parse(init.body)
      if (!body.code_challenge || body.code_challenge_method !== "S256") return json({ error: "bad challenge" }, 400)
      return json({
        process_id: "p1",
        sign_in_url: "https://console.mistral.ai/login?process=p1",
        poll_url: "http://mock.local/api/vibe/sign-in/poll/token-p1",
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      })
    }
    if (u.pathname === "/api/vibe/sign-in/poll/token-p1") {
      expect(init.redirect).toBe("error")
      state.polls++
      return state.polls < 2 ? json({ status: "pending" }) : json({ status: "completed", exchange_token: "et-1" })
    }
    if (u.pathname === "/api/vibe/sign-in/p1/exchange" && init.method === "POST") {
      const body = JSON.parse(init.body)
      state.exchanges.push(body)
      if (body.exchange_token !== "et-1" || !body.code_verifier) return json({ error: "bad exchange" }, 400)
      return json({ api_key: KEY })
    }
    if (u.pathname === "/api/vibe/whoami") {
      state.whoamis++
      if (h.get("authorization") !== `Bearer ${KEY}`) return json({ error: "unauthorized" }, 401)
      return json({ plan_name: "INDIVIDUAL", plan_type: "CHAT", has_paid_vibe_entitlement: true, customer_id: "cust-1" })
    }
    if (u.pathname === "/v1/chat/completions" && init.method === "POST") {
      state.chats.push(h.get("authorization"))
      state.bodies.push(init.body)
      const refused = mistralRefuse(init.body)
      if (refused) return json({ detail: refused }, 422)
      return json({ id: "chatcmpl-1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    }
    if (u.pathname === "/v1/models") {
      state.modelsCalls++
      if (h.get("authorization") !== `Bearer ${KEY}`) return json({ error: "unauthorized" }, 401)
      return json({
        object: "list",
        data: [
          {
            id: "mistral-large-4",
            billing_model_name: "mistral-large-4-0-a",
            max_context_length: 1048576,
            capabilities: { function_calling: true, reasoning: true, vision: true },
          },
          {
            id: "codestral-latest",
            billing_model_name: "codestral-2508",
            max_context_length: 256000,
            capabilities: { function_calling: true, reasoning: false, vision: false },
          },
          {
            id: "voxtral-mini-tts-2603",
            max_context_length: 4096,
            capabilities: { completion_chat: false, audio_speech: true },
          },
          { id: "devstral-2" },
        ],
      })
    }
    if (u.pathname === "/v1/billing/subscription")
      return json({ plan_name: "INDIVIDUAL", vibe_payg_enabled: true })
    if (u.pathname === "/v1/billing/budget")
      return json({ vibe_budget: { usage_percentage: 42.5, initial_budget: 100, currency: "EUR", reset_at: "2099-01-01T00:00:00Z", payg_enabled: true } })
    return json({ error: `unexpected ${init.method ?? "GET"} ${u.pathname}` }, 404)
  }
}

afterEach(() => {
  globalThis.fetch = realFetch
})

const plugin = async () => {
  const hooks = await MistralVibeAuthPlugin({ client: { auth: { set: async () => {} } } })
  return hooks
}

test("config declares the mistral-vibe provider", async () => {
  const hooks = await plugin()
  const cfg = { provider: {} }
  await hooks.config(cfg)
  expect(cfg.provider["mistral-vibe"].name).toBe("Mistral Vibe Code")
  expect(cfg.provider["mistral-vibe"].api).toBe("http://mock.local/v1")
  expect(cfg.provider["mistral-vibe"].npm).toBe("@ai-sdk/openai-compatible")
  expect(hooks.auth.provider).toBe("mistral-vibe")
})

test("browser sign-in: start, poll to completed, exchange for a Vibe-budget key", async () => {
  mockFetch()
  const hooks = await plugin()
  const oauth = hooks.auth.methods.find((m) => m.type === "oauth")
  expect(oauth).toBeTruthy()
  const started = await oauth.authorize()
  expect(started.url).toBe("https://console.mistral.ai/login?process=p1")
  expect(started.method).toBe("auto")
  const result = await started.callback()
  expect(result.type).toBe("success")
  expect(result.key).toBe(KEY)
  expect(result.accountId).toBe("cust-1")
  expect(result.metadata).toEqual({ plan: "Mistral Pro", vibeEntitlement: true })
  expect(state.exchanges).toHaveLength(1)
  expect(state.exchanges[0].exchange_token).toBe("et-1")
  expect(typeof state.exchanges[0].code_verifier).toBe("string")
})

test("sign-in reports denial and expiry", async () => {
  const hooks = await plugin()
  const oauth = hooks.auth.methods.find((m) => m.type === "oauth")
  // poll answer forced to denied
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input))
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } })
    if (u.pathname === "/api/vibe/sign-in") return json({ process_id: "p2", sign_in_url: "https://x/", poll_url: "http://mock.local/api/vibe/sign-in/poll/token-p2", expires_at: new Date(Date.now() + 60_000).toISOString() })
    if (u.pathname === "/api/vibe/sign-in/poll/token-p2") return json({ status: "denied", message: "nope" })
    return json({}, 404)
  }
  const started = await oauth.authorize()
  const r = await started.callback()
  expect(r.type).toBe("failed")
  expect(r.error).toContain("nope")
})

test("loader signs each request with the account key", async () => {
  mockFetch()
  const hooks = await plugin()
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: KEY }))
  expect(loader.baseURL).toBe("http://mock.local/v1")
  const res = await loader.fetch("http://mock.local/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer stale" }, body: "{}" })
  expect(res.status).toBe(200)
  expect(state.chats).toEqual([`Bearer ${KEY}`])
  const j = await res.json()
  expect(j.choices[0].message.content).toBe("hi")
})

test("loader with no sign-in returns no options", async () => {
  const hooks = await plugin()
  expect(await hooks.auth.loader(async () => null)).toEqual({})
})

test("usage confirms a pasted Vibe key and reports its budget and PAYG", async () => {
  mockFetch()
  const hooks = await plugin()
  const u = await hooks.auth.usage(async () => ({ type: "api", key: KEY }))
  expect(u.plan).toBe("Mistral Pro")
  expect(u.windows[0]).toMatchObject({ used: 42.5, amount: 42.5, limit: 100, unit: "EUR", resetsAt: Date.parse("2099-01-01T00:00:00Z") })
  expect(u.windows[0].span).toBeGreaterThan(3600)
  expect(u.windows[1]).toEqual({ name: "Pay as you go", display: "On", aside: true })
})

test("usage identifies a pasted Studio key without presenting Vibe allowance as its own", async () => {
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname
    if (path === "/api/vibe/whoami") return Response.json({ plan_type: "API", plan_name: "FREE" })
    if (path === "/v1/billing/subscription") return Response.json({ plan_name: "INDIVIDUAL", vibe_payg_enabled: true })
    return Response.json({
      vibe_budget: { usage_percentage: 42.5, initial_budget: 100 },
      api_budget: { usage_percentage: 10, initial_budget: 50, currency: "EUR" },
    })
  }
  const hooks = await plugin()
  const u = await hooks.auth.usage(async () => ({ type: "api", key: "studio-key" }))
  expect(u.plan).toBe("Mistral Studio API")
  expect(u.windows).toEqual([
    { name: "Vibe Code account", display: "Studio API key. Create a Vibe CLI key under Code > Vibe CLI.", aside: true },
    { name: "Platform API credits", used: 10, amount: 5, limit: 50, unit: "EUR", aside: true, resetsAt: undefined, span: 30 * 86400 },
  ])
})

test("a failed billing read preserves the Pro identity and reports missing allowance separately", async () => {
  mockFetch()
  const fetchMock = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).pathname === "/v1/billing/budget") throw new Error("budget request timed out")
    return fetchMock(input, init)
  }
  const hooks = await plugin()
  const u = await hooks.auth.usage(async () => ({ type: "api", key: KEY }))
  expect(u.plan).toBe("Mistral Pro")
  expect(u.windows).toEqual([
    { name: "Monthly Vibe Code", display: "Budget unavailable", aside: true },
    { name: "Pay as you go", display: "On", aside: true },
  ])
})

test("exhausted allowance stays a numeric reading when identity and subscription reads fail", async () => {
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname
    if (path === "/api/vibe/whoami") return Response.json({}, { status: 503 })
    if (path === "/v1/billing/subscription") throw new Error("subscription request timed out")
    return Response.json({ vibe_budget: { usage_percentage: 100, initial_budget: 100, payg_enabled: false } })
  }
  const hooks = await plugin()
  const u = await hooks.auth.usage(async () => ({ type: "api", key: KEY }))
  expect(u.plan).toBeUndefined()
  expect(u.signIn).toBe("kept")
  expect(u.windows[0]).toMatchObject({ name: "Monthly Vibe Code", used: 100, amount: 100, limit: 100, aside: true })
  expect(u.windows[1]).toEqual({ name: "Pay as you go", display: "Off", aside: true })
  expect(u.windows[2]).toEqual({ name: "Vibe Code account", display: "Plan not confirmed", aside: true })
})

test("missing PAYG and amount stay unknown when Mistral reports only a usage percentage", async () => {
  mockFetch()
  const fetchMock = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path === "/v1/billing/subscription") return Response.json({ plan_name: "INDIVIDUAL" })
    if (path === "/v1/billing/budget") return Response.json({ vibe_budget: { usage_percentage: 25, reset_at: "2099-01-01T00:00:00Z" } })
    return fetchMock(input, init)
  }
  const hooks = await plugin()
  const u = await hooks.auth.usage(async () => ({ type: "api", key: KEY }))
  expect(u.windows[0]).toMatchObject({ used: 25, resetsAt: Date.parse("2099-01-01T00:00:00Z") })
  expect(u.windows[0].limit).toBeUndefined()
  expect(u.windows[1]).toEqual({ name: "Pay as you go", display: "Unknown", aside: true })
})

test("a zero allocation is distinct from an unavailable or exhausted budget", async () => {
  mockFetch()
  const fetchMock = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).pathname === "/v1/billing/budget")
      return Response.json({ vibe_budget: { usage_percentage: 0, initial_budget: 0 } })
    return fetchMock(input, init)
  }
  const hooks = await plugin()
  const u = await hooks.auth.usage(async () => ({ type: "api", key: KEY }))
  expect(u.windows[0]).toEqual({ name: "Monthly Vibe Code", display: "No monthly budget", aside: true })
})

test("a billing plan alone does not confirm the pasted key's account", async () => {
  mockFetch()
  const hooks = await plugin()
  const u = await hooks.auth.usage(async () => ({ type: "api", key: "unverified-key" }))
  expect(u.plan).toBeUndefined()
  expect(u.signIn).toBe("kept")
  expect(u.windows[0]).toMatchObject({ name: "Monthly Vibe Code", used: 42.5, aside: true })
  expect(u.windows[2]).toEqual({ name: "Vibe Code account", display: "Plan not confirmed · Billing reports INDIVIDUAL", aside: true })
})

test("usage without a sign-in says so", async () => {
  const hooks = await plugin()
  const u = await hooks.auth.usage(async () => null)
  expect(u.windows).toEqual([])
  expect(typeof u.error).toBe("string")
})

test("provider.models lists /v1/models as mistral-vibe models", async () => {
  mockFetch()
  const hooks = await plugin()
  const models = await hooks.provider.models({ models: {} }, { auth: { type: "api", key: KEY } })
  expect(Object.keys(models).sort()).toEqual(["codestral-latest", "devstral-2", "mistral-large-4", "voxtral-mini-tts-2603"])
  expect(models["mistral-large-4"].tool_call).toBe(true)
  expect(models["mistral-large-4"].limit.context).toBe(1048576)
  expect(models["mistral-large-4"].capabilities.input.text).toBe(true)
  expect(models["mistral-large-4"].capabilities.input.image).toBe(true)
  expect(models["mistral-large-4"].capabilities.output.text).toBe(true)
  expect(models["mistral-large-4"].cost).toEqual({ input: 0.7, output: 2.1, cache: { read: 0.07, write: 0 } })
  // an alias is priced at the model the vendor bills it as
  expect(models["codestral-latest"].cost).toEqual({ input: 0.3, output: 0.9, cache: { read: 0.03, write: 0 } })
  // a model that gives no text says so, so magpie leaves it out of chat lists
  expect(models["voxtral-mini-tts-2603"].capabilities.output).toEqual({ text: false, image: false, audio: true, video: false, pdf: false })
  expect(models["voxtral-mini-tts-2603"].modalities.output).toEqual(["audio"])
  // a model neither the docs nor models.dev prices has no cost, not a zero
  expect(models["devstral-2"].cost).toBeUndefined()
})

test("prices follow the Mistral docs and each model's billing name", () => {
  const { priceOf, DOCS_PRICES } = _internal
  const large4 = { input: 0.7, output: 2.1, cache: { read: 0.07, write: 0 } }
  const codestral = { input: 0.3, output: 0.9, cache: { read: 0.03, write: 0 } }
  const documented = {
    "mistral-large-4": [0.7, 2.1, 0.07],
    "mistral-large-4-0": [0.7, 2.1, 0.07],
    "mistral-large-4-0-a": [0.7, 2.1, 0.07],
    "mistral-small-2603": [0.15, 0.6, 0.015],
    "ministral-14b-2512": [0.2, 0.2, 0.02],
    "ministral-8b-2512": [0.15, 0.15, 0.015],
    "ministral-3b-2512": [0.1, 0.1, 0.01],
    "codestral-2508": [0.3, 0.9, 0.03],
    "zai-glm-5-3": [1.4, 4.4, 0.14],
    "zai-glm-5-3-flash": [0.15, 0.5, 0.03],
    "deepseek-v4-1-flash-1017": [0.3, 1.2, 0.007],
  }
  expect(Object.keys(DOCS_PRICES).sort()).toEqual(Object.keys(documented).sort())
  for (const [id, [input, output, read]] of Object.entries(documented))
    expect(priceOf({ id }, {})).toEqual({ input, output, cache: { read, write: 0 } })
  // an alias is priced at the model the vendor bills it as
  expect(priceOf({ id: "mistral-large-4-0", billing_model_name: "mistral-large-4-0-a" }, {})).toEqual(large4)
  expect(priceOf({ id: "mistral-code-latest", billing_model_name: "codestral-2508" }, {})).toEqual(codestral)
  // and through /v1/models's aliases when the billing name is not given
  expect(priceOf({ id: "zai-glm-latest", aliases: ["zai-glm-5-3", "zai-glm-5"] }, {})).toEqual({ input: 1.4, output: 4.4, cache: { read: 0.14, write: 0 } })
  expect(priceOf({ id: "mistral-code-latest", aliases: ["codestral-2508", "codestral-latest"] }, {})).toEqual(codestral)
  // mistral-large-latest is billed as Mistral Large 3, not as Large 4
  expect(priceOf({ id: "mistral-large-latest", billing_model_name: "mistral-large-2512" }, {})).toBeUndefined()
  // models.dev prices a model the docs no longer list
  expect(priceOf({ id: "mistral-large-2512" }, { "mistral-large-2512": { cost: { input: 0.5, output: 1.5, cache_read: 0.05 } } })).toEqual({
    input: 0.5,
    output: 1.5,
    cache: { read: 0.05, write: 0 },
  })
  // the billing name and its aliases come before the alias's own stale entry
  const medium = { input: 1.5, output: 7.5, cache: { read: 0.15, write: 0 } }
  expect(
    priceOf(
      { id: "magistral-medium-latest", billing_model_name: "mistral-medium-3-5", aliases: ["mistral-medium-latest"] },
      {
        "mistral-medium-latest": { cost: { input: 1.5, output: 7.5, cache_read: 0.15 } },
        "magistral-medium-latest": { cost: { input: 2, output: 5, cache_read: 0 } },
      }
    )
  ).toEqual(medium)
  // a speech or non-chat model's models.dev price may not be per token
  expect(
    priceOf({ id: "voxtral-small-2507", capabilities: { completion_chat: true, audio: true } }, { "voxtral-small-2507": { cost: { input: 0.1, output: 0.4 } } })
  ).toBeUndefined()
  expect(
    priceOf({ id: "codestral-embed", capabilities: { completion_chat: false } }, { "codestral-embed": { cost: { input: 0.1, output: 0 } } })
  ).toBeUndefined()
  // nothing known is no price, not a zero
  expect(priceOf({ id: "unknown" }, {})).toBeUndefined()
})

test("package.json gives the plugin its own logo", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  expect(pkg.magpie.icon.startsWith("data:image/svg+xml;base64,")).toBe(true)
  const svg = Buffer.from(pkg.magpie.icon.slice(pkg.magpie.icon.indexOf(",") + 1), "base64").toString("utf8")
  const file = await readFile(new URL("../assets/icon.svg", import.meta.url), "utf8")
  // the working tree's line endings are the checkout's business; the bytes
  // the icon is made of are not
  const lf = (s) => s.replace(/\r\n/g, "\n")
  expect(lf(svg)).toBe(lf(file))
  expect(svg).toContain("<svg")
  expect(svg).toContain("</svg>")
  expect(pkg.files).toContain("assets/icon.svg")
})

test("provider.models falls back to the provider's own list when the key is refused", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
  const hooks = await plugin()
  const fallback = { models: { "mistral-large-4": { name: "Mistral Large 4" } } }
  const models = await hooks.provider.models(fallback, { auth: { type: "api", key: "bad" } })
  expect(models).toEqual(fallback.models)
})

test("api method is offered for pasting a Vibe Code key", async () => {
  const hooks = await plugin()
  const api = hooks.auth.methods.find((m) => m.type === "api")
  expect(api).toBeTruthy()
  expect(typeof api.placeholder).toBe("string")
})

// api.mistral.ai turns a message field it doesn't know away as 422
// extra_forbidden, and an earlier assistant turn's thinking comes back from
// most clients as reasoning_content: it goes in the typed thinking part
// Mistral returns it in, ahead of the turn's text.
test("an earlier turn's thinking goes in the typed part Mistral takes", () => {
  const { mistralBody } = _internal
  const body = JSON.stringify({
    model: "deepseek-v4-1-flash-1017",
    messages: [
      { role: "user", content: "Is 91 prime?" },
      { role: "assistant", content: "91 = 7 x 13.", reasoning_content: "7*13=91." },
      { role: "user", content: "And 97?" },
    ],
  })
  // the stand-in refuses the field the way Mistral does, so what goes out is
  // pinned to the shape Mistral takes
  expect(mistralRefuse(body)).toBeTruthy()
  expect(mistralRefuse(mistralBody(body))).toBeNull()
  const out = JSON.parse(mistralBody(body))
  expect(out.messages[0]).toEqual({ role: "user", content: "Is 91 prime?" })
  expect(out.messages[2]).toEqual({ role: "user", content: "And 97?" })
  expect(out.messages[1]).toEqual({
    role: "assistant",
    content: [{ type: "thinking", thinking: [{ type: "text", text: "7*13=91." }] }, { type: "text", text: "91 = 7 x 13." }],
  })
  expect(out.messages[1].reasoning_content).toBeUndefined()

  // a tool-call turn: content null, the thinking part alone, its calls kept
  const calls = [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }]
  const toolTurn = JSON.stringify({
    model: "m",
    messages: [
      { role: "user", content: "Read note.txt." },
      { role: "assistant", content: null, tool_calls: calls, reasoning_content: "Let me read it." },
      { role: "tool", tool_call_id: "call_1", content: "secret" },
    ],
  })
  const t = JSON.parse(mistralBody(toolTurn))
  expect(t.messages[1]).toEqual({
    role: "assistant",
    content: [{ type: "thinking", thinking: [{ type: "text", text: "Let me read it." }] }],
    tool_calls: calls,
  })

  // reasoning and reasoning_details go the same way; a non-assistant message
  // carrying one loses it and keeps its content
  const others = JSON.stringify({
    model: "m",
    messages: [
      { role: "user", content: "hi", reasoning: "not a turn's" },
      { role: "assistant", content: "ok", reasoning_details: [{ type: "reasoning.text", text: "a" }, { summary: "b" }] },
      { role: "assistant", content: "cut", reasoning_content: "" },
    ],
  })
  const o = JSON.parse(mistralBody(others))
  expect(o.messages[0]).toEqual({ role: "user", content: "hi" })
  expect(o.messages[1].content).toEqual([
    { type: "thinking", thinking: [{ type: "text", text: "ab" }] },
    { type: "text", text: "ok" },
  ])
  expect(o.messages[1].reasoning_details).toBeUndefined()
  // no thinking at all: the field goes, the turn is left as it was
  expect(o.messages[2]).toEqual({ role: "assistant", content: "cut" })
})

// a body with no thinking, or not a chat request's JSON, comes back byte for
// byte: every other request keeps its bytes on the way
test("a body with nothing to move comes back untouched", () => {
  const { mistralBody } = _internal
  const plain = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] })
  expect(mistralBody(plain)).toBe(plain)
  const prefill = JSON.stringify({
    model: "m",
    messages: [{ role: "assistant", content: "The answer is", prefix: true, reasoning_content: "think" }],
  })
  // a prefill's text is what goes on: its content stays, only the field goes
  expect(JSON.parse(mistralBody(prefill)).messages[0]).toEqual({ role: "assistant", content: "The answer is", prefix: true })
  const embeddings = JSON.stringify({ model: "m", input: ["reasoning"] })
  expect(mistralBody(embeddings)).toBe(embeddings)
  expect(mistralBody("not json at all, reasoning")).toBe("not json at all, reasoning")
  expect(mistralBody(undefined)).toBe(undefined)
})

// ---- the transport ------------------------------------------------------
//
// Bun's fetch pools keep-alive connections and hands a socket Cloudflare has
// already closed to the next request; the write fails with
//
//   ECONNRESET: The socket connection was closed unexpectedly. For more
//   information, pass verbose: true in the second argument to fetch()
//
// Only read-only calls replay a transient failure.

const resetError = () => {
  const e = new Error("ECONNRESET: The socket connection was closed unexpectedly. For more information, pass verbose: true in the second argument to fetch()")
  e.code = "ECONNRESET"
  return e
}

test("a generation POST is not replayed after reset", async () => {
  const { send } = _internal
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) throw resetError()
    return new Response("ok")
  }
  await expect(send("http://mock.local/v1/chat/completions", { method: "POST", body: "{}" })).rejects.toThrow(/ECONNRESET/)
  expect(calls).toBe(1)
})

test("a GET retries twice, and a repeated failure still surfaces", async () => {
  const { send } = _internal
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    throw resetError()
  }
  await expect(send("http://mock.local/v1/models")).rejects.toThrow(/ECONNRESET/)
  expect(calls).toBe(3)
})

test("an error that is not a stale socket is not retried", async () => {
  const { send } = _internal
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    const e = new Error("getaddrinfo ENOTFOUND api.mistral.ai")
    e.code = "ENOTFOUND"
    throw e
  }
  await expect(send("http://mock.local/v1/models")).rejects.toThrow(/ENOTFOUND/)
  expect(calls).toBe(1)
})

test("an abort is not retried", async () => {
  const { send } = _internal
  let calls = 0
  const ac = new AbortController()
  globalThis.fetch = async () => {
    calls++
    ac.abort()
    const e = new Error("The operation was aborted")
    e.name = "AbortError"
    throw e
  }
  await expect(send("http://mock.local/v1/models", { signal: ac.signal })).rejects.toThrow()
  expect(calls).toBe(1)
})

// Bun's AbortSignal.timeout surfaces as a TimeoutError whose message says
// nothing about sockets; asking a peer that never answered again only spends
// the caller's deadline a second time
test("a timeout is not retried", async () => {
  const { send, readJSON } = _internal
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    const e = new Error("The operation timed out.")
    e.name = "TimeoutError"
    throw e
  }
  await expect(send("http://mock.local/v1/models", { signal: AbortSignal.timeout(50) })).rejects.toThrow(/timed out/)
  expect(calls).toBe(1)
  calls = 0
  await expect(readJSON("http://mock.local/v1/models", { signal: AbortSignal.timeout(50) })).rejects.toThrow(/timed out/)
  expect(calls).toBe(1)
})

test("a stream body is sent once, never replayed", async () => {
  const { send } = _internal
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    throw resetError()
  }
  const body = new ReadableStream({ start: (c) => c.close() })
  await expect(send("http://mock.local/v1/chat/completions", { method: "POST", body })).rejects.toThrow(/ECONNRESET/)
  expect(calls).toBe(1)
})

test("a Request generation body is sent only once", async () => {
  const { send } = _internal
  const seen = []
  let calls = 0
  globalThis.fetch = async (input) => {
    calls++
    seen.push(await (input instanceof Request ? input.text() : String(input)))
    if (calls === 1) throw resetError()
    return new Response("ok")
  }
  const req = new Request("http://mock.local/v1/chat/completions", { method: "POST", body: "{\"a\":1}" })
  await expect(send(req)).rejects.toThrow(/ECONNRESET/)
  expect(calls).toBe(1)
  expect(seen).toEqual(["{\"a\":1}"])
})

test("a refusal is drained so its connection goes back whole", async () => {
  mockFetch()
  const { whoami, listModels } = _internal
  // the stand-in answers whoami with 401 for any key but KEY
  expect(await whoami("bad")).toBeNull()
  // a refusal from /v1/models falls back to no list
  expect(await listModels("bad")).toBeNull()
})

// fetch resolves at the response headers, so a peer that resets the
// connection after them fails the body read instead of the call. A read has
// no side effect to repeat, so readJSON asks again from the top.
test("a reset after the headers is retried, body and all", async () => {
  const { readJSON } = _internal
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"data":'))
          c.error(resetError())
        },
      })
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
    }
    return new Response('{"data":[{"id":"m"}]}', { status: 200, headers: { "content-type": "application/json" } })
  }
  const { res, data } = await readJSON("http://mock.local/v1/models")
  expect(res.status).toBe(200)
  expect(data).toEqual({ data: [{ id: "m" }] })
  expect(calls).toBe(2)
})

test("a body read that keeps failing still surfaces", async () => {
  const { readJSON } = _internal
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    const body = new ReadableStream({
      start(c) {
        c.error(resetError())
      },
    })
    return new Response(body, { status: 200 })
  }
  await expect(readJSON("http://mock.local/v1/models")).rejects.toThrow(/ECONNRESET/)
  expect(calls).toBe(3)
})

test("a refusal is not replayed by readJSON", async () => {
  const { readJSON } = _internal
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response('{"detail":"nope"}', { status: 401, headers: { "content-type": "application/json" } })
  }
  const { res, data } = await readJSON("http://mock.local/api/vibe/whoami")
  expect(res.status).toBe(401)
  expect(data).toBeNull()
  expect(calls).toBe(1)
})

// a Request whose body was locked before the clone has nothing left to send,
// so a second attempt would replace the real error with "Body already used"
test("a Request with an uncloneable body is not replayed", async () => {
  const { send } = _internal
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    throw resetError()
  }
  const req = new Request("http://mock.local/v1/chat/completions", { method: "POST", body: "{}" })
  await req.text() // spends the body: clone() now throws
  await expect(send(req)).rejects.toThrow(/ECONNRESET/)
  expect(calls).toBe(1)
})

test("the loader keeps only Mistral's fields on user messages", async () => {
  mockFetch()
  state.bodies = []
  const hooks = await plugin()
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: KEY }))
  const system = { role: "system", content: "Answer briefly." }
  const user = { role: "user", content: [{ type: "text", text: "Say OK." }] }
  const body = JSON.stringify({
    model: "deepseek-v4-1-flash-1017",
    messages: [system, {
      ...user,
      agent: "cli",
      conversationRequestId: "workbuddy-request",
      startsNewUserRequest: true,
      name: "client-user",
    }],
  })
  expect(mistralRefuse(body).map((issue) => issue.loc)).toEqual([
    ["body", "messages", 1, "user", "agent"],
    ["body", "messages", 1, "user", "conversationRequestId"],
    ["body", "messages", 1, "user", "startsNewUserRequest"],
    ["body", "messages", 1, "user", "name"],
  ])
  const res = await loader.fetch("http://mock.local/v1/chat/completions", { method: "POST", body })
  expect(res.status).toBe(200)
  expect(state.bodies).toHaveLength(1)
  expect(JSON.parse(state.bodies[0]).messages).toEqual([system, user])

  const escaped = body.replace('"agent"', String.raw`"\u0061gent"`).replace('"conversationRequestId"', String.raw`"\u0063onversationRequestId"`)
  expect(JSON.parse(escaped)).toEqual(JSON.parse(body))
  expect(JSON.parse(_internal.mistralBody(escaped)).messages).toEqual([system, user])
})

test("the loader strips host metadata from assistant messages and text parts in streaming history", async () => {
  mockFetch()
  state.bodies = []
  const hooks = await plugin()
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: KEY }))
  const text = { type: "text", text: "Hello.\n\n" }
  const thinking = { type: "thinking", thinking: [{ type: "text", text: "Think first." }] }
  const assistant = { role: "assistant", content: [text, thinking] }
  const messages = [
    { role: "system", content: "Answer briefly." },
    { role: "user", content: "Say hello." },
    {
      ...assistant,
      content: [{ ...text, annotations: [], logprobs: [] }, thinking],
      conversationRequestId: "workbuddy-request",
      messageId: "workbuddy-message",
      name: "client-assistant",
    },
    { role: "user", content: "Now say OK." },
  ]
  const body = JSON.stringify({ model: "deepseek-v4-1-flash-1017", stream: true, messages })
  expect(mistralRefuse(body).map((issue) => issue.loc.at(-1))).toEqual([
    "conversationRequestId", "messageId", "name", "annotations", "logprobs",
  ])

  const res = await loader.fetch("http://mock.local/v1/chat/completions", { method: "POST", body })
  expect(res.status).toBe(200)
  expect(state.bodies).toHaveLength(1)
  const out = JSON.parse(state.bodies[0])
  expect(out.stream).toBe(true)
  expect(out.messages).toEqual(messages.with(2, assistant))
})

// and the loader does it on the way out, so a gateway that sends an earlier
// turn's thinking as reasoning_content reaches Mistral with the part instead
test("the loader puts an earlier turn's thinking in the typed part", async () => {
  mockFetch()
  state.bodies = []
  const hooks = await plugin()
  const loader = await hooks.auth.loader(async () => ({ type: "api", key: KEY }))
  const sent = JSON.stringify({
    model: "deepseek-v4-1-flash-1017",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "Let me check.", reasoning_content: "thinking here" },
      { role: "user", content: "say ok" },
    ],
  })
  const res = await loader.fetch("http://mock.local/v1/chat/completions", { method: "POST", headers: { "content-length": "999" }, body: sent })
  expect(res.status).toBe(200)
  expect(state.bodies).toHaveLength(1)
  const out = JSON.parse(state.bodies[0])
  expect(out.messages[1]).toEqual({
    role: "assistant",
    content: [{ type: "thinking", thinking: [{ type: "text", text: "thinking here" }] }, { type: "text", text: "Let me check." }],
  })
  expect(state.bodies[0]).not.toContain("reasoning_content")
})

// ---- the sign-in over a dead socket -------------------------------------
//
// The browser sign-in runs once, by hand, and its three calls are the ones
// the user can't repeat without another trip through the browser. Each of
// them goes through readJSON, so a socket the pool had already lost is
// replaced instead of ending the sign-in.
test("a reset while the sign-in starts is retried, and the process is kept", async () => {
  const { startSignIn } = _internal
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) throw resetError()
    return new Response(
      JSON.stringify({
        process_id: "p9",
        sign_in_url: "https://console.mistral.ai/login?process=p9",
        poll_url: "http://mock.local/api/vibe/sign-in/poll/token-p9",
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  }
  const p = await startSignIn()
  expect(p.process_id).toBe("p9")
  expect(p.code_verifier.length).toBeGreaterThan(20)
  expect(calls).toBe(2)
})

test("a reset while the sign-in polls or exchanges is retried", async () => {
  const { pollSignIn, exchangeSignIn } = _internal
  let calls = 0
  globalThis.fetch = async (input, init = {}) => {
    calls++
    if (calls === 1) throw resetError()
    const u = new URL(String(input))
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } })
    if (u.pathname === "/api/vibe/sign-in/poll/token-p9") return json({ status: "completed", exchange_token: "et-2" })
    if (u.pathname.endsWith("/exchange")) return json({ api_key: KEY })
    return json({})
  }
  expect((await pollSignIn("http://mock.local/api/vibe/sign-in/poll/token-p9")).exchange_token).toBe("et-2")
  calls = 0
  expect(await exchangeSignIn("p9", "et-2", "verifier")).toBe(KEY)
  expect(calls).toBe(2)
})

test("the sign-in's failures carry what the console said", async () => {
  const { startSignIn, pollSignIn } = _internal
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ detail: "Too many sign-in attempts" }), { status: 429, headers: { "content-type": "application/json" } })
  await expect(startSignIn()).rejects.toThrow(/429\): Too many sign-in attempts/)
  const e = await pollSignIn("http://mock.local/api/vibe/sign-in/poll/token-p9").catch((x) => x)
  expect(e.transient).toBe(true)
  expect(String(e.message)).toContain("Too many sign-in attempts")
})

test("a poll refusal that is not a rate limit or a 5xx ends the sign-in", async () => {
  const { pollSignIn } = _internal
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: "unknown process" }), { status: 404 })
  const e = await pollSignIn("http://mock.local/api/vibe/sign-in/poll/token-p9").catch((x) => x)
  expect(e.transient).toBeUndefined()
  expect(String(e.message)).toContain("404: unknown process")
})

test("the sign-in resumes polling after a rate limit without Retry-After", async () => {
  const hooks = await plugin()
  const oauth = hooks.auth.methods.find((m) => m.type === "oauth")
  let polls = 0
  globalThis.fetch = async (input) => {
    const u = new URL(String(input))
    const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } })
    if (u.pathname === "/api/vibe/sign-in")
      return json({
        process_id: "p3",
        sign_in_url: "https://console.mistral.ai/login?process=p3",
        poll_url: "http://mock.local/api/vibe/sign-in/poll/token-p3",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
    if (u.pathname === "/api/vibe/sign-in/poll/token-p3") {
      polls++
      if (polls === 1) return json({ detail: "slow down" }, 429)
      return json({ status: "completed", exchange_token: "et-3" })
    }
    if (u.pathname.endsWith("/exchange")) return json({ api_key: KEY })
    if (u.pathname === "/api/vibe/whoami") return json({ plan_name: "Vibe Pro", customer_id: "cust-3" })
    return json({}, 404)
  }
  const started = await oauth.authorize()
  const r = await started.callback()
  expect(r.type).toBe("success")
  expect(r.key).toBe(KEY)
  expect(polls).toBe(2)
})

test("the browser sign-in speaks as the official client on a closed connection", async () => {
  mockFetch()
  const fetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("/api/vibe/")) {
      const h = new Headers(init?.headers)
      seen.push({ ua: h.get("user-agent"), conn: h.get("connection") })
    }
    return fetch(input, init)
  }
  const oauth = (await plugin()).auth.methods.find((m) => m.type === "oauth")
  const started = await oauth.authorize()
  expect((await started.callback()).type).toBe("success")
  expect(seen.length).toBeGreaterThan(0)
  for (const req of seen) {
    expect(req.ua).toBe("mistral-client-python/Mistral-Vibe/3.1.3")
    expect(req.conn).toBe("close")
  }
})

test("the browser sign-in gives up after six consecutive 429s", async () => {
  process.env.MISTRAL_VIBE_POLL_MS = "5"
  let polls = 0
  globalThis.fetch = async (input) => {
    const u = new URL(String(input))
    if (u.pathname === "/api/vibe/sign-in")
      return Response.json({
        process_id: "p-429",
        sign_in_url: "https://console.mistral.ai/login?process=p-429",
        poll_url: "http://mock.local/api/vibe/sign-in/poll/token-429",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
    if (u.pathname === "/api/vibe/sign-in/poll/token-429") {
      polls++
      return Response.json({ detail: "Too many requests. Retry later." }, { status: 429, headers: { "retry-after": "0" } })
    }
    return Response.json({}, { status: 404 })
  }
  const oauth = (await plugin()).auth.methods.find((m) => m.type === "oauth")
  const started = await oauth.authorize()
  const r = await started.callback()
  delete process.env.MISTRAL_VIBE_POLL_MS
  expect(r.type).toBe("failed")
  expect(r.error).toContain("rate-limited (429)")
  expect(polls).toBe(6)
})

test.each(["seconds", "HTTP date"])("the sign-in honors Retry-After in %s before polling again", async (format) => {
  mockFetch()
  const fetch = globalThis.fetch
  let polls = 0
  let retryAt = 0
  let resumedAt = 0
  globalThis.fetch = async (input, init) => {
    if (!String(input).endsWith("/poll/token-p1")) return fetch(input, init)
    if (++polls === 1) {
      const now = Date.now()
      retryAt = format === "seconds" ? now + 2000 : Math.ceil((now + 2000) / 1000) * 1000
      const value = format === "seconds" ? "2" : new Date(retryAt).toUTCString()
      return Response.json({ detail: "slow down" }, { status: 429, headers: { "Retry-After": value } })
    }
    resumedAt = Date.now()
    return Response.json({ status: "completed", exchange_token: "et-1" })
  }

  const oauth = (await plugin()).auth.methods.find((m) => m.type === "oauth")
  const started = await oauth.authorize()
  const result = await started.callback()

  expect(result.type).toBe("success")
  expect(polls).toBe(2)
  expect(resumedAt).toBeGreaterThanOrEqual(retryAt - 10)
})

test("a Retry-After beyond link expiry ends sign-in without another poll", async () => {
  mockFetch()
  const fetch = globalThis.fetch
  let polls = 0
  globalThis.fetch = async (input, init) => {
    if (!String(input).endsWith("/poll/token-p1")) return fetch(input, init)
    polls++
    return Response.json({ detail: "slow down" }, { status: 429, headers: { "Retry-After": "660" } })
  }

  const oauth = (await plugin()).auth.methods.find((m) => m.type === "oauth")
  const started = await oauth.authorize()
  const result = await started.callback()

  expect(result.type).toBe("failed")
  expect(result.error).toMatch(/429.*Start sign-in again/)
  expect(polls).toBe(1)
})

test("an expired sign-in avoids polling and still honors cancellation", async () => {
  mockFetch()
  const fetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async (input, init) => {
    requests++
    const response = await fetch(input, init)
    const started = await response.json()
    return Response.json({ ...started, expires_at: new Date(Date.now() - 1000).toISOString() })
  }

  const oauth = (await plugin()).auth.methods.find((m) => m.type === "oauth")
  const started = await oauth.authorize()
  expect((await started.callback()).error).toContain("timed out")
  await expect(started.callback(undefined, { signal: AbortSignal.abort() })).rejects.toHaveProperty("name", "AbortError")
  expect(requests).toBe(1)
})

test.each([
  [9004, "This Mistral workspace is not eligible for Vibe (403/9004)"],
  [9005, "Mistral sign-in exchange failed (403): exchange refused"],
])("exchange 403 with error code %d returns its login error without retrying", async (code, message) => {
  mockFetch()
  const fetch = globalThis.fetch
  let exchanges = 0
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith("/poll/token-p1")) return Response.json({ status: "completed", exchange_token: "et-1" })
    if (path.endsWith("/exchange")) {
      exchanges++
      return Response.json({ error_code: code, detail: "exchange refused" }, { status: 403 })
    }
    return fetch(input, init)
  }

  const oauth = (await plugin()).auth.methods.find((m) => m.type === "oauth")
  const started = await oauth.authorize()
  const result = await started.callback()

  expect(result.type).toBe("failed")
  expect(result.error).toContain(message)
  expect(exchanges).toBe(1)
})

test("the sign-in retries the exchange after a rate limit and a server error", async () => {
  mockFetch()
  const fetch = globalThis.fetch
  const statuses = [429, 503]
  const bodies = []
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname
    if (path === "/api/vibe/sign-in/poll/token-p1") return Response.json({ status: "completed", exchange_token: "et-1" })
    if (path.endsWith("/exchange")) {
      const status = statuses[bodies.length]
      bodies.push(init.body)
      if (status) return Response.json({ detail: "try again" }, { status })
    }
    return fetch(input, init)
  }

  const hooks = await plugin()
  const oauth = hooks.auth.methods.find((m) => m.type === "oauth")
  const started = await oauth.authorize()
  const result = await started.callback()

  expect(result.type).toBe("success")
  expect(result.key).toBe(KEY)
  expect(bodies).toHaveLength(3)
  expect(new Set(bodies).size).toBe(1)
})

test("a dead socket at the very start is not reported as a sign-in failure", async () => {
  const hooks = await plugin()
  const oauth = hooks.auth.methods.find((m) => m.type === "oauth")
  let calls = 0
  globalThis.fetch = async (input) => {
    calls++
    if (calls === 1) throw resetError()
    const u = new URL(String(input))
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } })
    if (u.pathname === "/api/vibe/sign-in") return json({ process_id: "p4", sign_in_url: "https://x/", poll_url: "http://mock.local/api/vibe/sign-in/poll/token-p4", expires_at: new Date(Date.now() + 60_000).toISOString() })
    if (u.pathname === "/api/vibe/sign-in/poll/token-p4") return json({ status: "completed", exchange_token: "et-4" })
    if (u.pathname.endsWith("/exchange")) return json({ api_key: KEY })
    return json({})
  }
  const started = await oauth.authorize()
  expect(started.url).toBe("https://x/")
  expect(calls).toBe(2)
})

// The host hands authorize a signal that lives as long as the authorize call.
// It is usually already aborted by the time the browser comes back, and the
// callback must not inherit that: it would cancel the first poll and the
// sign-in would never be seen through.
test("an authorize signal that ended with authorize does not cancel the callback", async () => {
  const hooks = await plugin()
  const oauth = hooks.auth.methods.find((m) => m.type === "oauth")
  globalThis.fetch = async (input) => {
    const u = new URL(String(input))
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } })
    if (u.pathname === "/api/vibe/sign-in")
      return json({ process_id: "p5", sign_in_url: "https://x/", poll_url: "http://mock.local/api/vibe/sign-in/poll/token-p5", expires_at: new Date(Date.now() + 60_000).toISOString() })
    if (u.pathname === "/api/vibe/sign-in/poll/token-p5") return json({ status: "completed", exchange_token: "et-5" })
    if (u.pathname.endsWith("/exchange")) return json({ api_key: KEY })
    if (u.pathname === "/api/vibe/whoami") return json({ plan_name: "Vibe Pro", customer_id: "cust-5" })
    return json({}, 404)
  }
  const gone = new AbortController()
  const started = await oauth.authorize({}, { signal: gone.signal })
  gone.abort()
  const r = await started.callback()
  expect(r.type).toBe("success")
  expect(r.key).toBe(KEY)
})

// A callback signal the host does supply is still honoured.
test("a callback signal that aborts ends the wait", async () => {
  const hooks = await plugin()
  const oauth = hooks.auth.methods.find((m) => m.type === "oauth")
  globalThis.fetch = async (input) => {
    const u = new URL(String(input))
    const json = (v) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } })
    if (u.pathname === "/api/vibe/sign-in")
      return json({ process_id: "p6", sign_in_url: "https://x/", poll_url: "http://mock.local/api/vibe/sign-in/poll/token-p6", expires_at: new Date(Date.now() + 60_000).toISOString() })
    return json({ status: "pending" })
  }
  const started = await oauth.authorize()
  const stop = new AbortController()
  const pending = started.callback(undefined, { signal: stop.signal })
  setTimeout(() => stop.abort(), 50)
  const e = await pending.catch((x) => x)
  expect(e).toBeTruthy()
  expect(e.name).toBe("AbortError")
})


test("loader pins Bearer to chat and forwards the original 429", async () => {
  const loader = await (await plugin()).auth.loader(async () => ({ type: "api", key: KEY }))
  let calls = 0
  globalThis.fetch = async (_input, init) => {
    calls++
    expect(init.redirect).toBe("error")
    expect(init.headers.get("user-agent")).toBe("magpie-mistral-vibe/0.2.0")
    return new Response("limited", { status: 429, headers: { "retry-after": "0" } })
  }
  for (const url of ["http://other.local/v1/chat/completions", "http://mock.local/v1/models"]) {
    await expect(loader.fetch(url)).rejects.toThrow(/Unexpected Mistral request target/)
  }
  const response = await loader.fetch("http://mock.local/v1/chat/completions", { method: "POST", redirect: "follow" })
  expect(response.status).toBe(429)
  expect(response.headers.get("retry-after")).toBe("0")
  expect(calls).toBe(1)
})

test("quota refreshes share only active reads", async () => {
  mockFetch()
  const fetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (...args) => { calls++; return fetch(...args) }
  const usage = (await plugin()).auth.usage
  const auth = async () => ({ type: "api", key: KEY })
  await Promise.all([usage(auth), usage(auth)])
  expect(calls).toBe(3)
  await usage(auth)
  expect(calls).toBe(6)
})

test("polling only accepts the configured console's poll endpoint with one token", async () => {
  globalThis.fetch = async () => { throw new Error("unexpected fetch") }
  for (const url of [
    "http://other.local/api/vibe/sign-in/poll/token-p9",
    "http://mock.local/api/vibe/sign-in/p9/poll",
    "http://mock.local/api/vibe/sign-in/poll/",
    "http://mock.local/api/vibe/sign-in/poll/token-p9/extra",
    "http://mock.local/api/vibe/sign-in/poll/token%2Fp9",
    "http://mock.local/api/vibe/sign-in/poll/token-p9?extra=1",
  ]) {
    await expect(_internal.pollSignIn(url)).rejects.toThrow(/Unexpected Mistral request target/)
  }
})


for (const ending of ["cancel", "eof", "read error"]) {
  test(`generation releases the queued request after ${ending}`, async () => {
    const loader = await (await plugin()).auth.loader(async () => ({ type: "api", key: `fixture-stream-${ending}` }))
    let sent = 0
    let firstController
    let upstreamCanceled = false
    globalThis.fetch = async () => {
      const ordinal = ++sent
      return new Response(new ReadableStream({
        start(controller) { if (ordinal === 1) firstController = controller },
        cancel() { if (ordinal === 1) upstreamCanceled = true },
      }))
    }
    const generate = () => loader.fetch("http://mock.local/v1/chat/completions", { method: "POST" })
    const first = await Promise.all(Array.from({ length: 4 }, generate))
    const fifth = generate()
    await Promise.resolve()
    expect(sent).toBe(4)
    if (ending === "cancel") {
      await first[0].body.cancel()
      expect(upstreamCanceled).toBe(true)
    } else {
      const reader = first[0].body.getReader()
      const read = reader.read()
      if (ending === "eof") {
        firstController.close()
        expect((await read).done).toBe(true)
      } else {
        firstController.error(new Error("fixture read failed"))
        await expect(read).rejects.toThrow("fixture read failed")
      }
    }
    const last = await fifth
    expect(sent).toBe(5)
    await Promise.all([...first.slice(1), last].map((res) => res.body.cancel()))
  })
}
