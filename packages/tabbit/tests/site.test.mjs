// Which Tabbit site an account is served by (#833): web.tabbit.com for the
// Chinese site, web.tabbit.ai for the international one. A token from one is
// refused on the other, so an account goes to the site its token belongs to.
//
// The refusals and the international gate below are the reporter's own
// answers from #833, byte for byte.

import test from "node:test"
import assert from "node:assert/strict"
import { TabbitPlugin } from "../index.mjs"
// A namespace import, so the behaviour tests still load (and fail on what they
// check) against a build without the site helpers.
import * as api from "../src/api.mjs"

const { credsOf, usage } = api

const COM = "web.tabbit.com"
const AI = "web.tabbit.ai"

// What web.tabbit.com answered an international token (#833).
const INVALID_BEARER = "invalid bearer [REDACTED_TOKEN]"
// What web.tabbit.ai answers a run for a plain cookie-bearing call (#833).
const GATE_492 = '{"message": "Welcome to Tabbit Browser (https://www.tabbit.ai/), where you can use the most comprehensive and advanced models for free.", "code": 492, "action": "", "states": "", "details": ""}'

const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const TURN = [
  frame("message_history", { payload: { messages: [{ message_id: "a0", role: "user", content: "hi" }, { message_id: "a1", role: "assistant", content: "" }] } }),
  frame("assistant_message_started", { payload: { run_id: "r1", message_id: "a1" } }),
  frame("assistant_message_delta", { payload: { chunk_payload: { content: "ok" } } }),
  frame("assistant_message_finished", { payload: { message_id: "a1" } }),
  frame("run_completed", { payload: { status: "COMPLETED" } }),
].join("")

// Each test has its own token: the site a token turned out to belong to is
// remembered for the process.
let n = 0
function tokenFor(label) {
  n += 1
  const payload = Buffer.from(JSON.stringify({ sub: `${label}-${n}`, exp: 4102444800 })).toString("base64url")
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.sig-${label}-${n}`
}

// tabbit stubs both sites. `accepts` lists the hosts that take the token;
// any other host refuses it the way web.tabbit.com refused it in #833.
function tabbit({ accepts, down = [], runs } = {}) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url)
    const method = (init.method ?? "GET").toUpperCase()
    const headers = new Headers(init.headers ?? {})
    calls.push({ host: url.host, method, path: url.pathname, origin: headers.get("origin"), referer: headers.get("referer") })
    if (down.includes(url.host)) throw new TypeError("fetch failed")
    // The catalog answers any token, on both sites (api.mjs says so).
    if (url.pathname === "/proxy/v1/model_config/models") {
      return Response.json({ models: [{ display_name: url.host === AI ? "AI-Only-Model" : "Com-Only-Model", model_access_type: "free_unlimited" }] })
    }
    if (!accepts.includes(url.host)) return new Response(INVALID_BEARER, { status: 401 })
    if (url.pathname === "/api/commerce/quota/v1/usage") {
      return Response.json({ member_level: "standard", usage_percentage: "0%", current_cycle_start: "2026.11.03", current_cycle_end: "2026.11.10" })
    }
    if (url.pathname === "/api/v3/chat/rooms" && method === "POST") return Response.json({ room_id: "room-1" })
    if (url.pathname.endsWith("/runs") && method === "POST") {
      if (runs) return runs(url)
      return Response.json({ run_id: "run-1" })
    }
    if (url.pathname.endsWith("/join") && method === "POST") {
      return new Response(TURN, { status: 200, headers: { "content-type": "text/event-stream" } })
    }
    return new Response("not found", { status: 404 })
  }
  return { calls, restore: () => (globalThis.fetch = original) }
}

const hosts = (calls) => [...new Set(calls.map((c) => c.host))]

async function chatOnce(auth, model = "Default") {
  const hooks = await TabbitPlugin()
  const loader = await hooks.auth.loader(async () => auth)
  return await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  })
}

test("a pasted international token is served by web.tabbit.ai, and its usage reads", async () => {
  const auth = { type: "api", key: tokenFor("intl") }
  const { calls, restore } = tabbit({ accepts: [AI] })
  try {
    const hooks = await TabbitPlugin()
    const u = await hooks.auth.usage(async () => auth)
    assert.equal(u.error, undefined, `usage failed: ${u.error}`)
    assert.equal(u.signIn, undefined)
    assert.equal(u.plan, "Tabbit standard")
    const answered = calls.filter((c) => c.host === AI)
    assert.ok(answered.length > 0, "web.tabbit.ai was never asked")
    assert.equal(answered[0].origin, "https://web.tabbit.ai")
    assert.equal(answered[0].referer, "https://web.tabbit.ai/newtab")

    // Settled: the next calls go straight to web.tabbit.ai.
    calls.length = 0
    await hooks.auth.usage(async () => auth)
    assert.deepEqual(hosts(calls), [AI])
  } finally {
    restore()
  }
})

test("an international token's model list is web.tabbit.ai's catalog", async () => {
  const auth = { type: "api", key: tokenFor("intl-models") }
  const { restore } = tabbit({ accepts: [AI] })
  try {
    const hooks = await TabbitPlugin()
    const rows = await hooks.provider.models({ models: {} }, { auth })
    assert.deepEqual(Object.keys(rows), ["AI-Only-Model"])
  } finally {
    restore()
  }
})

test("an international token's turn goes to web.tabbit.ai, and its 492 gate is not a lost sign-in", async () => {
  const auth = { type: "api", key: tokenFor("intl-chat") }
  const ok = tabbit({ accepts: [AI] })
  try {
    const res = await chatOnce(auth)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.choices[0].message.content, "ok")
    // web.tabbit.com is asked once, refuses, and every later call is
    // web.tabbit.ai's: the run and its stream included.
    assert.equal(ok.calls.filter((c) => c.host === COM).length, 1)
    const turn = ok.calls.filter((c) => /\/(runs|join)$/.test(c.path))
    assert.equal(turn.length, 2)
    assert.deepEqual(hosts(turn), [AI])
  } finally {
    ok.restore()
  }

  const gated = { type: "api", key: tokenFor("intl-gate") }
  const gate = tabbit({ accepts: [AI], runs: () => new Response(GATE_492, { status: 429, headers: { "content-type": "application/json" } }) })
  try {
    const res = await chatOnce(gated)
    assert.equal(res.status, 429)
    assert.equal(res.headers.get("x-magpie-sign-in"), null)
    assert.match((await res.json()).error.message, /Welcome to Tabbit Browser/)
  } finally {
    gate.restore()
  }
})

test("a web.tabbit.com token never asks web.tabbit.ai anything", async () => {
  const auth = { type: "api", key: tokenFor("com") }
  const { calls, restore } = tabbit({ accepts: [COM] })
  try {
    const hooks = await TabbitPlugin()
    const u = await hooks.auth.usage(async () => auth)
    assert.equal(u.plan, "Tabbit standard")
    const rows = await hooks.provider.models({ models: {} }, { auth })
    assert.deepEqual(Object.keys(rows), ["Com-Only-Model"])
    const res = await chatOnce(auth)
    assert.equal(res.status, 200)
    assert.deepEqual(hosts(calls), [COM])
    assert.equal(calls[0].origin, "https://web.tabbit.com")
  } finally {
    restore()
  }
})

test("a token both sites refuse is a lost sign-in, settled on web.tabbit.com", async () => {
  const auth = { type: "api", key: tokenFor("expired") }
  const { calls, restore } = tabbit({ accepts: [] })
  try {
    const first = await chatOnce(auth)
    assert.equal(first.status, 401)
    assert.equal(first.headers.get("x-magpie-sign-in"), "expired")
    assert.deepEqual(hosts(calls).sort(), [AI, COM].sort())

    calls.length = 0
    const again = await chatOnce(auth)
    assert.equal(again.status, 401)
    assert.deepEqual(hosts(calls), [COM])
  } finally {
    restore()
  }
})

test("web.tabbit.ai out of reach leaves web.tabbit.com's refusal standing, and settles nothing", async () => {
  const auth = { type: "api", key: tokenFor("ai-down") }
  const { calls, restore } = tabbit({ accepts: [], down: [AI] })
  try {
    const first = await chatOnce(auth)
    assert.equal(first.status, 401)
    assert.equal(first.headers.get("x-magpie-sign-in"), "expired")

    calls.length = 0
    await chatOnce(auth)
    assert.ok(calls.some((c) => c.host === AI), "web.tabbit.ai was not asked again after it was out of reach")
  } finally {
    restore()
  }
})

test("a 5xx or the catalog settles no site", async () => {
  const auth = { type: "api", key: tokenFor("intl-5xx") }
  const creds = credsOf(auth)
  const original = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url)
    if (url.pathname === "/proxy/v1/model_config/models") return Response.json({ models: [] })
    return new Response("bad gateway", { status: 502 })
  }
  try {
    await assert.rejects(usage(creds), /HTTP 502/)
    await api.listModels(creds)
  } finally {
    globalThis.fetch = original
  }
  // Once web.tabbit.com refuses it, the token still finds web.tabbit.ai.
  const { calls, restore } = tabbit({ accepts: [AI] })
  try {
    const data = await usage(creds)
    assert.equal(data.member_level, "standard")
    assert.ok(calls.some((c) => c.host === AI))
  } finally {
    restore()
  }
})

test("an account that recorded its site goes there without asking the other", async () => {
  const auth = { type: "oauth", key: `token=${tokenFor("desktop-ai")}; user_id=u-ai`, metadata: { userId: "u-ai", source: "desktop", site: "https://web.tabbit.ai" } }
  const { calls, restore } = tabbit({ accepts: [AI] })
  try {
    const hooks = await TabbitPlugin()
    const rows = await hooks.provider.models({ models: {} }, { auth })
    assert.deepEqual(Object.keys(rows), ["AI-Only-Model"])
    const u = await hooks.auth.usage(async () => auth)
    assert.equal(u.plan, "Tabbit standard")
    assert.deepEqual(hosts(calls), [AI])
  } finally {
    restore()
  }
})

test("siteOfValue takes only Tabbit's two sites", () => {
  assert.equal(api.siteOfValue("web.tabbit.ai"), "https://web.tabbit.ai")
  assert.equal(api.siteOfValue("https://web.tabbit.ai/newtab"), "https://web.tabbit.ai")
  assert.equal(api.siteOfValue("https://WEB.TABBIT.COM"), "https://web.tabbit.com")
  assert.equal(api.siteOfValue("https://evil.example"), null)
  assert.equal(api.siteOfValue(""), null)
  assert.equal(api.siteOfValue(undefined), null)
  const creds = credsOf({ key: tokenFor("odd"), metadata: { site: "https://evil.example" } })
  assert.equal(api.siteOf(creds), "https://web.tabbit.com")
})

test("usage on its own settles an international token's site", async () => {
  const auth = { type: "api", key: tokenFor("intl-usage") }
  const { restore } = tabbit({ accepts: [AI] })
  try {
    const creds = credsOf(auth)
    assert.equal(api.siteOf(creds), "https://web.tabbit.com")
    await usage(creds)
    assert.equal(api.siteOf(creds), "https://web.tabbit.ai")
  } finally {
    restore()
  }
})
