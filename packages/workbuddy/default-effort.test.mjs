// troilus1011 on X: WorkBuddy's DeepSeek in OpenCode thought at low and
// high, never at the default. OpenCode's default variant names no effort,
// and WorkBuddy doesn't think without one; WorkBuddy's own client sends the
// config's reasoning.defaultEffort (configureThinkingSettings). The config
// below is the China build's own for deepseek-v4.1-flash (2026-10-28), with
// models beside it that take no effort or another default.
//
// runmiNeverstop on X: 2.89 GB up to copilot.tencent.com. WorkBuddy's own
// client gzips a model request's body (GzipRequestProcessor); the plugin
// sent it as plain JSON. Every fetch here is a fake.
import { afterEach, expect, test } from "bun:test"
import { WorkBuddyAuthPlugin, WorkBuddyAIAuthPlugin, _internal } from "./index.mjs"
import { unz } from "./testdata/unz.mjs"

const { SMALL_BUDGET } = _internal

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const CONFIG = {
  code: 0,
  data: {
    agents: [{ name: "cli", models: ["deepseek-v4.1-flash", "glm-5.2", "auto", "odd-default", "claude-opus-5.5"] }],
    models: [
      { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", supportsReasoning: true, onlyReasoning: true,
        reasoning: { canDisableThinking: true, defaultEffort: "high", summary: "auto", supportedEfforts: ["low", "high", "max"] } },
      { id: "glm-5.2", name: "GLM-5.2", supportsReasoning: true,
        reasoning: { canDisableThinking: true, defaultEffort: "xhigh", summary: "auto", supportedEfforts: ["high", "xhigh"] } },
      { id: "auto", name: "Auto" },
      // a default its own levels don't hold: WorkBuddy's client clamps it,
      // the plugin leaves it to the server
      { id: "odd-default", name: "Odd", supportsReasoning: true, reasoning: { defaultEffort: "medium", supportedEfforts: ["low", "high"] } },
      { id: "claude-opus-5.5", name: "Claude-Opus-5.5", supportsReasoning: true, reasoning: { defaultEffort: "high", supportedEfforts: ["low", "high", "xhigh"] } },
    ],
  },
}

const OK = () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })

// serve answers /v3/config with config() and anything else with OK, and
// keeps each request: its URL, headers, the body on the wire and as text
function serve(config = () => Response.json(CONFIG)) {
  const sent = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    sent.push({ url: u, headers: new Headers(init?.headers), wire: init?.body, text: unz(init?.body) })
    if (u.endsWith("/v3/config")) return config()
    return OK()
  }
  return sent
}

const AUTH = { type: "oauth", access: "tok", refresh: "r", uid: "u1", expires: Date.now() + 3600_000 }
const CN_CHAT = "https://copilot.tencent.com/v2/chat/completions"
const chatsOf = (sent) => sent.filter((s) => !s.url.endsWith("/v3/config"))

async function loader(plugin = WorkBuddyAuthPlugin) {
  const h = await plugin({ client: {} })
  return h.auth.loader(async () => AUTH)
}

const ask = (opts, model, extra = {}, url = CN_CHAT) =>
  opts.fetch(url, { method: "POST", body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hi" }], ...extra }) })

test("a DeepSeek chat that names no effort goes at the config's default, as WorkBuddy's client asks it", async () => {
  const sent = serve()
  const opts = await loader()
  expect((await ask(opts, "deepseek-v4.1-flash")).status).toBe(200)
  const [c] = chatsOf(sent)
  expect(JSON.parse(c.text).reasoning_effort).toBe("high")
  // another model's default is its own
  await ask(opts, "glm-5.2")
  expect(JSON.parse(chatsOf(sent)[1].text).reasoning_effort).toBe("xhigh")
  // the list was read once for both
  expect(sent.filter((s) => s.url.endsWith("/v3/config"))).toHaveLength(1)
})

test("an effort the client named goes as it came, none too, and the list isn't read for it", async () => {
  const sent = serve()
  const opts = await loader()
  for (const e of ["none", "low", "max"]) await ask(opts, "deepseek-v4.1-flash", { reasoning_effort: e })
  await ask(opts, "deepseek-v4.1-flash", { reasoning: { effort: "low" } })
  const chats = chatsOf(sent).map((c) => JSON.parse(c.text))
  expect(chats.map((c) => c.reasoning_effort)).toEqual(["none", "low", "max", undefined])
  expect(chats[3].reasoning).toEqual({ effort: "low" })
  expect(sent.filter((s) => s.url.endsWith("/v3/config"))).toHaveLength(0)
})

test("a model that takes no effort, or whose default its levels don't hold, gets none", async () => {
  const sent = serve()
  const opts = await loader()
  await ask(opts, "auto")
  await ask(opts, "odd-default")
  await ask(opts, "not-listed")
  for (const c of chatsOf(sent)) expect(JSON.parse(c.text).reasoning_effort).toBeUndefined()
})

test("a config that can't be read leaves the chat as it came, and is tried again a minute later, not on each chat", async () => {
  const sent = serve(() => new Response("down", { status: 502 }))
  const opts = await loader()
  expect((await ask(opts, "deepseek-v4.1-flash")).status).toBe(200)
  expect((await ask(opts, "deepseek-v4.1-flash")).status).toBe(200)
  for (const c of chatsOf(sent)) expect(JSON.parse(c.text).reasoning_effort).toBeUndefined()
  expect(sent.filter((s) => s.url.endsWith("/v3/config"))).toHaveLength(1)
})

test("a chat goes gzipped, as WorkBuddy's client sends it, on both builds", async () => {
  for (const [plugin, url] of [
    [WorkBuddyAuthPlugin, CN_CHAT],
    [WorkBuddyAIAuthPlugin, "https://www.workbuddy.ai/v2/chat/completions"],
  ]) {
    const sent = serve()
    const opts = await loader(plugin)
    const history = Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `step ${i}: read src/file${i}.ts and run the tests again` }))
    const body = JSON.stringify({ model: "deepseek-v4.1-flash", reasoning_effort: "high", stream: true, messages: [{ role: "system", content: "You are an agent." }, ...history] })
    await opts.fetch(url, { method: "POST", body })
    const [c] = chatsOf(sent)
    expect(c.url).toBe(url)
    expect(c.headers.get("content-encoding")).toBe("gzip")
    expect(c.headers.has("content-length")).toBe(false)
    expect(typeof c.wire).not.toBe("string")
    expect(JSON.parse(c.text)).toEqual(JSON.parse(body))
    expect(c.wire.byteLength * 5).toBeLessThan(Buffer.byteLength(body))
  }
})

test("a body handed over as bytes goes gzipped too", async () => {
  const sent = serve()
  const opts = await loader()
  const body = JSON.stringify({ model: "glm-5.2", reasoning_effort: "high", stream: true, messages: [{ role: "system", content: "You are an agent." }, { role: "user", content: "hi" }] })
  await opts.fetch(CN_CHAT, { method: "POST", body: new TextEncoder().encode(body) })
  const [c] = chatsOf(sent)
  expect(c.headers.get("content-encoding")).toBe("gzip")
  expect(JSON.parse(c.text)).toEqual(JSON.parse(body))
})

test("a Claude request on Messages goes as it came: neither gzipped nor given an effort", async () => {
  const sent = serve()
  const opts = await loader()
  const body = JSON.stringify({ model: "claude-opus-5.5", max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] })
  await opts.fetch("https://copilot.tencent.com/v1/messages", { method: "POST", body })
  const [c] = chatsOf(sent)
  expect(c.headers.has("content-encoding")).toBe(false)
  expect(c.wire).toBe(body)
})

test("defaultEffortOf reads defaultEffort, else effort, held to the model's levels", () => {
  const { defaultEffortOf } = _internal
  expect(defaultEffortOf({ reasoning: { defaultEffort: "high" } }, ["low", "high"])).toBe("high")
  expect(defaultEffortOf({ reasoning: { effort: "medium" } }, ["low", "medium", "high", "max"])).toBe("medium")
  expect(defaultEffortOf({ reasoning: { defaultEffort: "medium" } }, ["low", "high"])).toBeUndefined()
  expect(defaultEffortOf({}, ["low"])).toBeUndefined()
})

test("a chat with a small max_tokens is not given a default reasoning effort", async () => {
  // itspig (#643): title requests at max_tokens 64 spent all 64 on reasoning
  // at the default high and answered no text. Anthropic's API takes no
  // thinking budget under 1024, so a budget of SMALL_BUDGET or less was
  // never one to think in; a larger one, or none, still goes at the default
  expect(SMALL_BUDGET).toBe(1024)
  const sent = serve()
  const opts = await loader()
  for (const max_tokens of [64, 100, 256, 1000, 1024]) {
    await ask(opts, "deepseek-v4.1-flash", { max_tokens })
  }
  await ask(opts, "deepseek-v4.1-flash", { max_completion_tokens: 64 })
  await ask(opts, "deepseek-v4.1-flash", { max_tokens: 64, reasoning_effort: "low" })
  await ask(opts, "deepseek-v4.1-flash", { max_tokens: 1025 })
  await ask(opts, "deepseek-v4.1-flash", { max_completion_tokens: 32000 })
  await ask(opts, "deepseek-v4.1-flash", { max_tokens: 0 })
  const chats = chatsOf(sent).map((c) => JSON.parse(c.text))
  for (let i = 0; i < 6; i++) expect(chats[i].reasoning_effort).toBeUndefined()
  expect(chats[6].reasoning_effort).toBe("low")
  expect(chats[7].reasoning_effort).toBe("high")
  expect(chats[8].reasoning_effort).toBe("high")
  expect(chats[9].reasoning_effort).toBe("high")
  // the WorkBuddy AI build alike
  const sent2 = serve()
  const ai = await loader(WorkBuddyAIAuthPlugin)
  await ask(ai, "deepseek-v4.1-flash", { max_tokens: 64 }, "https://www.workbuddy.ai/v2/chat/completions")
  expect(JSON.parse(chatsOf(sent2)[0].text).reasoning_effort).toBeUndefined()
})
