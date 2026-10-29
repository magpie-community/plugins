// 01huadalang on Discord: signed in on the Go plan, magpie listed models
// only GOAT and above may use. Command Code's list is the same for every
// plan (testdata/models-2026-10-13.json, 87 models, as api.commandcode.ai
// answered it with a GOAT key and without one, the same but for
// "created"); which of them a plan may use is the CLI's own table
// (command-code 1.79.2, evaluateModelAccess), and the Provider API turns
// the rest away only when asked (testdata/refused-*.json: a GOAT key
// asking Claude Opus 5.5 and GPT-6 Sol). Each plan's list is Command
// Code's less what the plan refuses; a plan not read keeps all of it, and
// so does an account with credits beyond the plan's.
//
// testdata/subscriptions-goat.json and credits-goat.json are a GOAT
// account's billing replies (its ids zeroed); a Go account's is the same
// reply with Go's planId, as there is no Go account here to read one from.
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { CommandCodePlugin, _internal } from "./index.mjs"

// talking leaves out the decision model (Jev, jev.test.mjs), which every
// plan's list has beside the models it talks to
const talking = (ms) => {
  delete ms[_internal.JEV]
  return ms
}

const real = globalThis.fetch
const saved = { ..._internal.waits }
afterEach(() => {
  globalThis.fetch = real
  _internal.subsSeen.clear()
  _internal.extraSeen.clear()
  Object.assign(_internal.waits, saved)
})

const data = (f) => readFileSync(join(import.meta.dir, "testdata", f), "utf8")
const LIST = data("models-2026-10-13.json")
const ALL = JSON.parse(LIST).data.map((m) => m.id)
const subOf = (planId) => {
  const s = JSON.parse(data("subscriptions-goat.json"))
  s.data.planId = planId
  return JSON.stringify(s)
}
const CREDITS = data("credits-goat.json")
const withExtra = (field) => {
  const c = JSON.parse(CREDITS)
  c.credits[field] = 5
  return JSON.stringify(c)
}

// the models the provider.models hook lists for a key whose
// billing/subscriptions answers sub and billing/credits credits (a body,
// or a status)
async function listed({ sub, credits = CREDITS, list = LIST, metadata } = {}) {
  _internal.subsSeen.clear() // a plan read is kept ten minutes
  const reply = (r) => (typeof r === "number" ? new Response("", { status: r }) : new Response(r, { status: 200 }))
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname
    if (path === "/alpha/billing/subscriptions") return reply(sub)
    if (path === "/alpha/billing/credits") return reply(credits)
    if (path === "/provider/v1/models") return reply(list)
    return new Response("", { status: 404 })
  }
  _internal.waits.subWait = 50
  _internal.waits.creditWait = 50
  const hooks = await CommandCodePlugin()
  const config = { provider: {} }
  await hooks.config(config)
  return talking(await hooks.provider.models({ models: config.provider["commandcode-plan"].models }, { auth: { type: "api", key: "k", ...(metadata ? { metadata } : {}) } }))
}

// the CLI 1.79.2's models GOAT may use and Go may not: a Go account was
// shown Claude Haiku 5.5 ("haiku 5.5 in goat plan")
const GOAT_NOT_GO = ["claude-sonnet-5-5", "claude-haiku-5-5", "gpt-5.6-sol", "xai/grok-4.6", "xai/grok-4.7", "meta/muse-spark-1.2", "meta/muse-spark-1.3", "google/gemini-3.7-flash", "google/gemini-3.8-flash"]
const PREMIUM = ["claude-sonnet-5", "claude-opus-5-5", "claude-fable-5-1", "claude-haiku-4-5-20251001", "gpt-6-sol", "gpt-6.1-sol", "gpt-5.5", "sakana/fugu-ultra", "meta/muse-spark-1.1", "google/gemini-3.5-flash"]

test("a Go account lists none of GOAT's models, nor the premium ones", async () => {
  const got = Object.keys(await listed({ sub: subOf("individual-go") }))
  for (const id of [...GOAT_NOT_GO, ...PREMIUM, "xiaomi/mimo-v2.6-pro-ultraspeed"]) expect(got).not.toContain(id)
  for (const id of ["gpt-6-luna", "gpt-5.6-luna", "deepseek/deepseek-v4-pro", "moonshotai/Kimi-K3", "mistral/mistral-large-4", "stealth/glyph-cluster:free", "xai/grok-4.5"]) expect(got).toContain(id)
  // 87 less the 21 premium and the 10 Go is blocked
  expect(got.length).toBe(56)
})

test("a GOAT account lists GOAT's models and none of the premium ones", async () => {
  const ms = await listed({ sub: data("subscriptions-goat.json") })
  const got = Object.keys(ms)
  for (const id of GOAT_NOT_GO) expect(got).toContain(id)
  for (const id of PREMIUM) expect(got).not.toContain(id)
  expect(got.length).toBe(87 - 21)
  expect(ms[Symbol.for("magpie.fellBack")]).toBeUndefined()
})

test("each plan lists what the CLI's table lets it use", async () => {
  const of = async (planId) => Object.keys(await listed({ sub: subOf(planId) }))
  const pro = await of("individual-pro-monthly")
  for (const id of ["claude-opus-5-5", "claude-fable-5-1", "gpt-6-astra", "gpt-6.1-sol", "sakana/fugu-ultra"]) expect(pro).not.toContain(id)
  for (const id of ["claude-sonnet-5", "gpt-6-sol", "claude-haiku-4-5-20251001", "claude-sonnet-5-5"]) expect(pro).toContain(id)
  expect(pro.length).toBe(87 - 9)
  expect(await of("individual-pro-v1")).toEqual(pro)
  expect(await of("individual-provider")).toEqual(ALL.filter((id) => id !== "gpt-6.1-sol"))
  for (const p of ["individual-max", "individual-ultra", "teams-pro"]) expect(await of(p)).toEqual(ALL)
})

test("a plan not read keeps the whole list; one saved with the key stands for it", async () => {
  // billing/subscriptions failing, nothing saved: unknown, not refused
  expect(Object.keys(await listed({ sub: 503 }))).toEqual(ALL)
  // no plan at all (credits alone): the CLI lets every model
  expect(Object.keys(await listed({ sub: JSON.stringify({ success: true, data: null }) }))).toEqual(ALL)
  expect(Object.keys(await listed({ sub: 503, metadata: { plan: "GOAT" } })).length).toBe(87 - 21)
})

test("credits beyond the plan's let it every model; credits not read leave the plan's list", async () => {
  for (const field of ["purchasedCredits", "freeCredits"]) {
    _internal.extraSeen.clear()
    expect(Object.keys(await listed({ sub: data("subscriptions-goat.json"), credits: withExtra(field) }))).toEqual(ALL)
    // Go's list, less only what isn't for text (none of these 87)
    expect(Object.keys(await listed({ sub: subOf("individual-go"), credits: withExtra(field) }))).toEqual(ALL)
  }
  _internal.extraSeen.clear()
  expect(Object.keys(await listed({ sub: data("subscriptions-goat.json"), credits: 503 })).length).toBe(87 - 21)
  // as last read, when it can't be read now
  _internal.extraSeen.set("k", true)
  expect(Object.keys(await listed({ sub: data("subscriptions-goat.json"), credits: 503 }))).toEqual(ALL)
})

test("the default list stands in less what the plan refuses", async () => {
  const ms = await listed({ sub: data("subscriptions-goat.json"), list: 500 })
  expect(ms[Symbol.for("magpie.fellBack")]).toBe(true)
  expect(Object.keys(ms)).toEqual(["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash", "moonshotai/Kimi-K3", "zai-org/GLM-5.3", "MiniMaxAI/MiniMax-M3"])
})

// the plan's data unknown or behind Command Code's: a model the plan
// hasn't is still told as Command Code tells it
test("a model the plan refuses reaches the agent as Command Code's refusal", async () => {
  for (const [path, f, model] of [["/provider/v1/messages", "refused-messages.json", "claude-opus-5-5"], ["/provider/v1/chat/completions", "refused-chat.json", "gpt-6-sol"]]) {
    const body = data(f)
    globalThis.fetch = async (url) => {
      const p = new URL(String(url)).pathname
      if (p === "/alpha/billing/subscriptions") return new Response(data("subscriptions-goat.json"))
      if (p === path) return new Response(body, { status: 403, headers: { "Content-Type": "application/json" } })
      return new Response("", { status: 404 })
    }
    const hooks = await CommandCodePlugin()
    const opts = await hooks.auth.loader(async () => ({ type: "api", key: "goat-key" }))
    const res = await opts.fetch("https://api.commandcode.ai" + path, { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) })
    expect(res.status).toBe(403)
    expect(await res.text()).toBe(body)
    expect(body).toContain("MODEL_NOT_IN_PLAN")
  }
  // and on Go's endpoint, as failure says it
  expect(_internal.failure(403, data("refused-chat.json"))).toEqual({ status: 403, message: "Model not in plan: GPT-6 Sol available in Pro and above plans or extra on demand usage" })
})
