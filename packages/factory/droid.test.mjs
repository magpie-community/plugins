// magpie #506: Codex on glm-5.3-flash through the plugin's Factory account
// got 403 "Factory refused this account the request…", where the built-in
// (since v0.1.630, e413dd84) opens another agent's request to /api/llm/o as
// droid 0.231.0 opens its own: Responses' instructions, or chat
// completions' first system message, start with droid's line, joined with
// "\n". droid's own requests go on byte for byte on each API.
// The cases are the built-in's TestFactoryOpensAsDroid.
import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const { DROID_LINE } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const API = "https://api.factory.ai"
const chat = API + "/api/llm/o/v1/chat/completions"
const responses = API + "/api/llm/o/v1/responses"
const messages = API + "/api/llm/a/v1/messages"

async function loaded(auth) {
  const sent = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname === "/api/cli/whoami") return new Response(JSON.stringify({ userId: "user_k", orgId: "fac_K", email: "k@example.com", region: "" }))
    sent.push({ url: String(url), headers: new Headers(init.headers), body: init.body })
    return new Response('{"id":"ok"}')
  }
  let saved = auth
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async ({ body }) => (saved = body) } } })
  const l = await hooks.auth.loader(async () => saved)
  const send = async (url, body) => {
    const res = await l.fetch(url, { method: "POST", headers: { "content-type": "application/json", "content-length": String(body.length) }, body })
    expect(res.status).toBe(200)
    return sent.at(-1)
  }
  return { send, sent, saved: () => saved, hooks }
}

const signedIn = {
  type: "oauth",
  access: "tok",
  refresh: "r",
  expires: Date.now() + 3_600_000,
  accountId: "d@example.com",
  activeOrganizationId: "fac_D",
  region: "",
  premBaseHost: "",
}

test("another agent's request to /api/llm/o opens with droid's line", async () => {
  const { send } = await loaded({ ...signedIn })
  // Codex on glm-5.3-flash, its Responses request made chat completions
  let s = await send(chat, `{"model":"glm-5.3-flash","messages":[{"role":"system","content":"You are Codex, a coding agent."},{"role":"user","content":"hi <b> & co"}],"stream":true,"reasoning_effort":"high"}`)
  let b = JSON.parse(s.body)
  expect(b.messages).toEqual([
    { role: "system", content: DROID_LINE + "\nYou are Codex, a coding agent." },
    { role: "user", content: "hi <b> & co" },
  ])
  expect(b.model).toBe("glm-5.3-flash")
  expect(b.reasoning_effort).toBe("high")
  expect(b.stream).toBe(true)
  // the length was the old body's: it isn't sent on
  expect(s.headers.get("content-length")).toBe(null)
  expect(s.headers.get("x-api-provider")).toBe("fireworks")
  expect(s.headers.get("x-client-version")).toBe("0.231.0")
  expect(s.headers.get("user-agent")).toBe("factory-cli/0.231.0")
  expect(s.headers.get("x-factory-org-id")).toBe("fac_D")
  // Claude Code's system blocks, made chat completions as parts: joined
  b = JSON.parse((await send(chat, `{"model":"kimi-k3","messages":[{"role":"system","content":[{"type":"text","text":"You are Claude Code."},{"type":"text","text":"Be brief."}]},{"role":"user","content":"hi"}]}`)).body)
  expect(b.messages[0]).toEqual({ role: "system", content: DROID_LINE + "\nYou are Claude Code.\nBe brief." })
  expect(b.messages.length).toBe(2)
  // no system prompt: droid's line alone, before the rest
  b = JSON.parse((await send(chat, `{"model":"glm-5.3","messages":[{"role":"user","content":"hi"}]}`)).body)
  expect(b.messages).toEqual([{ role: "system", content: DROID_LINE }, { role: "user", content: "hi" }])
  // Codex on GPT, Responses: the instructions open with the line
  b = JSON.parse((await send(responses, `{"model":"gpt-5.5","instructions":"You are Codex, a coding agent.","input":[{"role":"user","content":"hi"}],"stream":true}`)).body)
  expect(b.instructions).toBe(DROID_LINE + "\nYou are Codex, a coding agent.")
  expect(b.input.length).toBe(1)
  b = JSON.parse((await send(responses, `{"model":"grok-4.7","input":"hi"}`)).body)
  expect(b.instructions).toBe(DROID_LINE)
})

test("droid's own requests go on byte for byte on each API", async () => {
  const { send } = await loaded({ ...signedIn })
  for (const [url, body] of [
    [chat, `{"model":"glm-5.3-flash","messages":[{"role":"system","content":"${DROID_LINE}\\nYou work in the user's terminal."},{"role":"user","content":"hi"}],"stream":true,"n":1.0}`],
    [responses, `{"model":"gpt-5.5","input":[],"store":false,"instructions":"${DROID_LINE}\\nYou work in the user's terminal.","stream":true}`],
    [messages, `{"model":"claude-opus-5-5","system":[{"type":"text","text":"${DROID_LINE}"}],"messages":[{"role":"user","content":"hi"}]}`],
    [messages, `{"model":"minimax-m2.7","system":[{"type":"text","text":"${DROID_LINE}"}],"messages":[{"role":"user","content":"hi"}]}`],
  ]) {
    const s = await send(url, body)
    expect(s.body).toBe(body)
    expect(s.headers.get("content-length")).toBe(String(body.length))
  }
})

test("bytes are read as the string, and what isn't JSON goes as it is", () => {
  const { droidBody } = _internal
  const out = droidBody("/api/llm/o/v1/responses", new TextEncoder().encode(`{"model":"gpt-5.5","input":"hi"}`))
  expect(JSON.parse(out).instructions).toBe(DROID_LINE)
  expect(droidBody("/api/llm/o/v1/responses", "not json")).toBe("not json")
  expect(droidBody("/api/llm/o/v1/responses", `{"instructions":[1]}`)).toBe(`{"instructions":[1]}`)
  expect(droidBody("/api/llm/o/v1/models", `{"a":1}`)).toBe(`{"a":1}`)
})

test("GLM-5.3-Flash takes images, as droid 0.231.0's registry says", async () => {
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => {} } } })
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const m = cfg.provider.factory.models["glm-5.3-flash"]
  expect(m.attachment).toBe(true)
  expect(m.modalities.input).toEqual(["text", "image"])
})

// droid's FACTORY_API_KEY, as the built-in's factory_key.go keeps one: the
// key is the bearer with droid's headers, no X-Factory-Org-Id, no WorkOS;
// whoami asked with the key says whose it is and where its org is served.
test("an API key account is the bearer, with no org and no renewal", async () => {
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => {} } } })
  const api = hooks.auth.methods.find((m) => m.type === "api")
  expect(api.label).toBe("Factory API key (fk-…)")

  const seen = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    seen.push({ host: u.host, path: u.pathname, headers: new Headers(init.headers) })
    if (u.pathname === "/api/cli/whoami") return new Response(JSON.stringify({ userId: "user_k", orgId: "fac_K", email: "k@example.com", region: "eu" }))
    return new Response('{"id":"ok"}')
  }
  let saved = { type: "api", key: "fk-test-0123456789" }
  const h2 = await FactoryAuthPlugin({ client: { auth: { set: async ({ body }) => (saved = body) } } })
  const l = await h2.auth.loader(async () => saved)
  expect(typeof l.fetch).toBe("function")
  for (let i = 0; i < 2; i++) {
    const res = await l.fetch(chat, { method: "POST", body: `{"model":"glm-5.3-flash","messages":[{"role":"user","content":"hi"}]}` })
    expect(res.status).toBe(200)
  }
  const whoamis = seen.filter((s) => s.path === "/api/cli/whoami")
  expect(whoamis.length).toBe(1) // once; then it is kept
  expect(whoamis[0].headers.get("authorization")).toBe("Bearer fk-test-0123456789")
  expect(whoamis[0].headers.get("x-factory-org-id")).toBe(null)
  const reqs = seen.filter((s) => s.path === "/api/llm/o/v1/chat/completions")
  expect(reqs.length).toBe(2)
  for (const r of reqs) {
    expect(r.host).toBe("api.eu.factory.ai") // whoami's region
    expect(r.headers.get("authorization")).toBe("Bearer fk-test-0123456789")
    expect(r.headers.get("x-factory-org-id")).toBe(null)
    expect(r.headers.get("x-factory-client")).toBe("cli")
  }
  expect(seen.some((s) => s.host === "api.workos.com")).toBe(false)
  expect(saved).toEqual({ type: "api", key: "fk-test-0123456789", metadata: { email: "k@example.com", userId: "user_k", region: "eu", premBaseHost: "" } })

  // a 403 to a key isn't mended with an org: Factory's answer, explained
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "nope" } }), { status: 403 })
  const res = await l.fetch(chat, { method: "POST", body: `{"model":"glm-5.3","messages":[]}` })
  expect(res.status).toBe(403)
  expect((await res.json()).error.message).toMatch(/^nope — Factory takes/)
})

test("a key account's usage reads the limits with the key", async () => {
  let asked
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname === "/api/billing/limits") {
      asked = { host: u.host, auth: new Headers(init.headers).get("authorization") }
      return new Response(JSON.stringify({ limits: { standard: { fiveHour: { usedPercent: 5 } } } }))
    }
    return new Response("{}", { status: 500 })
  }
  const auth = { type: "api", key: "fk-test-0123456789", metadata: { email: "k@example.com", region: "", premBaseHost: "" } }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => {} } } })
  const u = await hooks.auth.usage(async () => auth)
  expect(u.error).toBeUndefined()
  expect(u.windows[0].used).toBe(5)
  expect(asked).toEqual({ host: "api.factory.ai", auth: "Bearer fk-test-0123456789" })
})
