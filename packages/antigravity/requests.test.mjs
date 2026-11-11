// Requests as the built-in sent them (google_test.go's
// TestAntigravityProjectAndEnvelope, the tier tests in
// antigravity_tier_test.go, and codeassist.go's error rules).
import { afterEach, beforeEach, expect, test } from "bun:test"
import { AntigravityAuthPlugin, _internal } from "./index.mjs"
import { auth, fake, real, reset } from "./fake.mjs"

beforeEach(reset)
afterEach(() => (globalThis.fetch = real))

const URL_ = (m, method = "streamGenerateContent") => `https://daily-cloudcode-pa.googleapis.com/v1beta/models/${m}:${method}?alt=sse`
const ask = (text = "hi", extra = {}) => JSON.stringify({ contents: [{ role: "user", parts: [{ text }] }], ...extra })
const sse = (...chunks) => new Response(chunks.map((c) => "data: " + JSON.stringify({ response: c, traceId: "t" }) + "\r\n\r\n").join(""), { status: 200, headers: { "content-type": "text/event-stream" } })
const models = {
  models: {
    "gemini-3.7-flash-high": { displayName: "Gemini 3.7 Flash (High)" },
    "gemini-3.7-flash-low": { displayName: "Gemini 3.7 Flash (Low)" },
    "gemini-3-flash": { displayName: "Gemini 3 Flash" },
  },
}

async function loaderFetch(a) {
  const p = await AntigravityAuthPlugin({})
  const l = await p.auth.loader(async () => a)
  return l.fetch
}

test("a request goes in Antigravity's envelope, and its stream comes back Gemini's", async () => {
  const seen = fake({
    fetchAvailableModels: models,
    streamGenerateContent: () => sse({ candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] }, { candidates: [{ content: { role: "model", parts: [{ text: "lo" }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 3 } }),
  })
  const f = await loaderFetch(auth())
  const res = await f(URL_("gemini-3.7-flash"), { method: "POST", headers: { "content-type": "application/json", "x-magpie-effort": "low" }, body: ask("hi", { generationConfig: { thinkingConfig: { includeThoughts: true } } }) })
  expect(res.status).toBe(200)
  const text = await res.text()
  const chunks = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)))
  expect(chunks.map((c) => c.candidates[0].content.parts[0].text).join("")).toBe("Hello")
  const sent = seen.find((s) => s.name === "streamGenerateContent")
  expect(sent.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse")
  expect(sent.headers.authorization).toBe("Bearer tok")
  expect(sent.headers["user-agent"]).toMatch(/^antigravity\/hub\/3\.1\.4 \w+\/\w+$/)
  expect(sent.json).toMatchObject({ model: "gemini-3.7-flash-low", project: "ag-proj", userAgent: "antigravity", requestType: "agent" })
  expect(sent.json.request.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: "low" })
  expect(sent.json.request.sessionId).toMatch(/^-\d+$/)
  // models are read once
  await f(URL_("gemini-3-flash"), { method: "POST", body: ask() })
  expect(seen.filter((s) => s.name === "fetchAvailableModels").length).toBe(1)
})

test("OpenCode's variant names the level", async () => {
  const seen = fake({ fetchAvailableModels: models, streamGenerateContent: () => sse({ candidates: [] }) })
  const f = await loaderFetch(auth())
  await f(URL_("gemini-3.7-flash"), { method: "POST", body: ask("hi", { generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } } }) })
  expect(seen.find((s) => s.name === "streamGenerateContent").json.model).toBe("gemini-3.7-flash-low")
})

test("a Request input is read", async () => {
  const seen = fake({ fetchAvailableModels: models, streamGenerateContent: () => sse({ candidates: [] }) })
  const f = await loaderFetch(auth())
  const res = await f(new Request(URL_("gemini-3-flash"), { method: "POST", body: ask("from a Request") }))
  expect(res.status).toBe(200)
  expect(seen.find((s) => s.name === "streamGenerateContent").json.request.contents[0].parts[0].text).toBe("from a Request")
})

test("generateContent is the stream read whole", async () => {
  fake({ fetchAvailableModels: models, streamGenerateContent: () => sse({ candidates: [{ content: { role: "model", parts: [{ text: "Hel" }] } }] }, { candidates: [{ content: { role: "model", parts: [{ text: "lo" }, { functionCall: { name: "f", args: {} } }] } }] }, { candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }], usageMetadata: { totalTokenCount: 3 } }) })
  const f = await loaderFetch(auth())
  const res = await f(URL_("gemini-3-flash", "generateContent"), { method: "POST", body: ask() })
  const j = await res.json()
  // the stream's last, empty text is left out
  expect(j.candidates[0].content.parts).toEqual([{ text: "Hello" }, { functionCall: { name: "f", args: {} } }])
  expect(j.candidates[0].finishReason).toBe("STOP")
  expect(j.usageMetadata.totalTokenCount).toBe(3)
})

const exhausted = () => new Response(JSON.stringify({ error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } }), { status: 429 })

test("a 429 to a turned-away system prompt is a 400, not a quota", async () => {
  fake({ fetchAvailableModels: models, streamGenerateContent: exhausted })
  const f = await loaderFetch(auth())
  for (const [sys, says] of [
    ["x-anthropic-billing-header: cc_version=2.1", "Claude Code and the Claude Agent SDK"],
    ["You are Codex, a coding agent based on GPT-5.", "Codex's own system prompt"],
    ["You are Hermes Agent, an intelligent AI assistant created by Nous Research.", "Hermes Agent's earlier default persona"],
    ["RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL.\n\n§ Role", "oh-my-pi (omp)'s system prompt"],
  ]) {
    const res = await f(URL_("gemini-3-flash"), { method: "POST", body: ask("hi", { systemInstruction: { parts: [{ text: sys }] } }) })
    expect(res.status).toBe(400)
    const j = await res.json()
    expect(j.error.message).toContain("answered 429 to this system prompt")
    expect(j.error.message).not.toContain("unapproved channel")
    expect(j.error.message).toContain(says)
  }
  // any other prompt's 429 is the quota it says
  const res = await f(URL_("gemini-3-flash"), { method: "POST", body: ask("hi", { systemInstruction: { parts: [{ text: "be brief" }] } }) })
  expect(res.status).toBe(429)
  expect((await res.json()).error.status).toBe("RESOURCE_EXHAUSTED")
})

test("a model Antigravity doesn't have, and a sign-in that is over", async () => {
  fake({ fetchAvailableModels: models, streamGenerateContent: () => new Response("{}", { status: 404 }) })
  let f = await loaderFetch(auth())
  let res = await f(URL_("gemini-9"), { method: "POST", body: ask() })
  expect(res.status).toBe(404)
  expect((await res.json()).error.message).toBe("model gemini-9 not found")

  reset()
  fake({ token: () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 }) })
  f = await loaderFetch({ ...auth(), expires: 0 })
  res = await f(URL_("gemini-3-flash"), { method: "POST", body: ask() })
  expect(res.status).toBe(401)
  expect(res.headers.get("x-magpie-sign-in")).toBe("expired")
  expect((await res.json()).error.message).toContain("sign in again")
})

test("an account with no project is set up for its default tier", async () => {
  const seen = fake({
    loadCodeAssist: { allowedTiers: [{ id: "free-tier", name: "Antigravity", isDefault: true }] },
    onboardUser: (_, all) => (all.filter((s) => s.name === "onboardUser").length < 2 ? { done: false } : { done: true, response: { cloudaicompanionProject: { id: "ag-new" } } }),
    fetchAvailableModels: models,
    streamGenerateContent: () => sse({ candidates: [] }),
  })
  const f = await loaderFetch(auth(""))
  await f(URL_("gemini-3-flash"), { method: "POST", body: ask() })
  const load = seen.find((s) => s.name === "loadCodeAssist")
  expect(load.url).toBe("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist")
  expect(load.json).toEqual({ metadata: { ideType: "ANTIGRAVITY" } })
  const on = seen.find((s) => s.name === "onboardUser")
  expect(on.json).toEqual({ tier_id: "free-tier", metadata: { ide_type: "ANTIGRAVITY", ide_version: "3.1.4", ide_name: "antigravity" } })
  expect(on.headers["user-agent"]).toEndWith(" google-api-nodejs-client/10.3.0")
  expect(on.headers["x-goog-api-client"]).toBe("gl-node/22.21.1")
  expect(seen.find((s) => s.name === "streamGenerateContent").json.project).toBe("ag-new")
})

test("a paid tier is named, and a tier Google refuses is asked without, once a day", async () => {
  const seen = fake({
    loadCodeAssist: { cloudaicompanionProject: "ag-proj", currentTier: { id: "standard-tier" }, paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } },
    fetchAvailableModels: (s) => (s.json.entitlement ? new Response(JSON.stringify({ error: { code: 400, message: "Invalid tier" } }), { status: 400 }) : models),
  })
  const p = await AntigravityAuthPlugin({})
  const a = auth()
  const got = await p.provider.models({ models: {} }, { auth: a })
  expect(Object.keys(got)).toEqual(["gemini-3-flash", "gemini-3.7-flash"])
  expect(got["gemini-3.7-flash"].variants).toEqual({ low: { thinkingConfig: { thinkingLevel: "low", includeThoughts: true } }, high: { thinkingConfig: { thinkingLevel: "high", includeThoughts: true } } })
  const asks = seen.filter((s) => s.name === "fetchAvailableModels").map((s) => s.json.entitlement?.userTier ?? "")
  expect(asks).toEqual(["g1-pro-tier", "standard-tier", ""])
  _internal.lists.clear()
  await p.provider.models({ models: {} }, { auth: a })
  expect(seen.filter((s) => s.name === "fetchAvailableModels").length).toBe(4)
  const u = await p.auth.usage(async () => a)
  expect(u.plan).toBe("Google AI Pro")
})

test("an exported account is imported", async () => {
  const { imported } = _internal
  expect(imported('{"email":"a@x.com","token":{"refresh_token":"rt1","project_id":"p1"}}')).toEqual([{ rt: "rt1", project: "p1", email: "a@x.com" }])
  expect(imported('{"accounts":[{"email":"a@x.com","refreshToken":"rt1"},{"email":"b@x.com","refresh_token":"rt2","projectId":"p2"}]}').map((a) => a.rt)).toEqual(["rt1", "rt2"])
  expect(imported("# mine\n1//rt-a\n\n1//rt-b\n").map((a) => a.rt)).toEqual(["1//rt-a", "1//rt-b"])
  expect(() => imported('{"type":"kiro","refresh_token":"x"}')).toThrow("kiro")

  const seen = fake({ who: { email: "c@x.com" } })
  const p = await AntigravityAuthPlugin({})
  const m = p.auth.methods[1]
  expect(m.prompts[0].key).toBe("account")
  const a = await m.authorize({ account: "1//rt-c" })
  expect(a.url).toBe("")
  const r = await a.callback()
  expect(r).toMatchObject({ type: "success", access: "tok-new", refresh: "1//rt-c|ag-proj", accountId: "c@x.com" })
  expect(seen.find((s) => s.name === "token").body).toContain("refresh_token=1%2F%2Frt-c")
  expect((await m.authorize({ account: "" })).type).toBe("failed")
})

// An Ultra or Pro account's quota for a model is used up: the app asks
// before it spends Google AI credits, and magpie's switch is that answer.
const withCredits = { cloudaicompanionProject: "ag-proj", currentTier: { id: "standard-tier" }, paidTier: { id: "g1-ultra-tier", name: "Google AI Ultra", availableCredits: [{ creditType: "GOOGLE_ONE_AI", creditAmount: "25000", minimumCreditAmountForUsage: "50" }] } }
const spentQuota = () => new Response(JSON.stringify({ error: { code: 429, message: "You have exhausted your capacity on this model.", status: "RESOURCE_EXHAUSTED" } }), { status: 429, headers: { "content-type": "application/json" } })
const credited = (s) => (s.json.enabled_credit_types ? sse({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] }) : spentQuota())

async function creditsFetch(on) {
  const p = await AntigravityAuthPlugin({ magpie: { option: (id, key) => (id === "antigravity" && key === "use-ai-credits" ? on : undefined) } })
  const l = await p.auth.loader(async () => auth())
  return { f: l.fetch, p }
}

test("with Use AI credits on, a request the quota refuses is asked again with the account's credits", async () => {
  const seen = fake({ loadCodeAssist: withCredits, fetchAvailableModels: models, streamGenerateContent: credited })
  const { f } = await creditsFetch(true)
  const res = await f(URL_("gemini-3-flash"), { method: "POST", body: ask() })
  expect(res.status).toBe(200)
  const sent = seen.filter((s) => s.name === "streamGenerateContent")
  expect(sent.length).toBe(2)
  expect(sent[0].json.enabled_credit_types).toBeUndefined()
  expect(sent[1].json.enabled_credit_types).toEqual(["GOOGLE_ONE_AI"])
})

test("when the asking with credits is refused too, the quota's 429 is what comes back, and a retry works the same", async () => {
  const seen = fake({
    loadCodeAssist: withCredits,
    fetchAvailableModels: models,
    streamGenerateContent: (s) => (s.json.enabled_credit_types ? new Response(JSON.stringify({ error: { code: 403, message: "credits refused", status: "PERMISSION_DENIED" } }), { status: 403 }) : spentQuota()),
  })
  const { f } = await creditsFetch(true)
  for (let i = 0; i < 2; i++) {
    const res = await f(URL_("gemini-3-flash"), { method: "POST", body: ask() })
    expect(res.status).toBe(429)
    expect((await res.json()).error.message).toContain("exhausted your capacity")
  }
  expect(seen.filter((s) => s.name === "streamGenerateContent").length).toBe(4)
})

test("a request the quota covers never asks for credits", async () => {
  const seen = fake({ loadCodeAssist: withCredits, fetchAvailableModels: models, streamGenerateContent: () => sse({ candidates: [] }) })
  const { f } = await creditsFetch(true)
  await f(URL_("gemini-3-flash"), { method: "POST", body: ask() })
  expect(seen.filter((s) => s.name === "streamGenerateContent").map((s) => s.json.enabled_credit_types)).toEqual([undefined])
})

test("with the switch off, a refused request is not asked again, and the 429 says what would spend the credits", async () => {
  const seen = fake({ loadCodeAssist: withCredits, fetchAvailableModels: models, streamGenerateContent: credited })
  const { f } = await creditsFetch(false)
  const res = await f(URL_("gemini-3-flash"), { method: "POST", body: ask() })
  expect(res.status).toBe(429)
  expect(seen.filter((s) => s.name === "streamGenerateContent").length).toBe(1)
  const j = await res.json()
  expect(j.error.message).toContain("exhausted your capacity")
  expect(j.error.message).toContain("Use AI credits")
})

test("an account with no credits is not asked again, with the switch on", async () => {
  const seen = fake({ loadCodeAssist: { cloudaicompanionProject: "ag-proj", paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } }, fetchAvailableModels: models, streamGenerateContent: credited })
  const { f } = await creditsFetch(true)
  const res = await f(URL_("gemini-3-flash"), { method: "POST", body: ask() })
  expect(res.status).toBe(429)
  expect(seen.filter((s) => s.name === "streamGenerateContent").length).toBe(1)
  expect((await res.json()).error.message).not.toContain("Use AI credits")
})

test("the plugin offers the switch, off unless set", async () => {
  const p = await AntigravityAuthPlugin({})
  expect(p.auth.options.map((o) => o.key)).toEqual(["use-ai-credits"])
  expect(_internal.creditsOf({ paidTier: { availableCredits: [{ creditType: "GOOGLE_ONE_AI", creditAmount: "10", minimumCreditAmountForUsage: "50" }] } })).toBe(false)
  expect(_internal.creditsOf({ paidTier: { availableCredits: [{ creditType: "GOOGLE_ONE_AI", minimumCreditAmountForUsage: "50" }] } })).toBe(true)
})
