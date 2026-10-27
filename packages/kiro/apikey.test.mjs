// A Kiro API key (ksk_…) is used as kiro-cli uses it. Recorded from kiro-cli
// 2.32.0 with KIRO_API_KEY set to a made-up key, in a sandbox HOME, against
// a local recorder (no real key, no real Kiro):
//
//   GetProfile             POST management/            X-Amz-Target AmazonCodeWhispererService.GetProfile, body {}
//   ListAvailableModels    POST management/?origin=KIRO_CLI  X-Amz-Target KiroControlPlaneBearerService.ListAvailableModels, body {"origin":"KIRO_CLI"}
//   GetUsageLimits         POST management/?origin=KIRO_CLI  X-Amz-Target AmazonCodeWhispererService.GetUsageLimits, body {"origin":"KIRO_CLI"}
//   GenerateAssistantResponse  no profileArn in the body
//
// each with Content-Type application/x-amz-json-1.0, Authorization Bearer
// <key> and tokentype API_KEY, and no profile named even when GetProfile
// gave one. With every management host refused, kiro-cli asked GetProfile
// in us-east-1, eu-central-1 (then GovCloud and ISO), and went on to list
// models and chat in us-east-1 all the same.
//
// Hollowhere (magpie's Discord, kiro-cli 2.33.1): a key kiro-cli lists
// claude-opus-5.5 with got Auto alone here, and every request failed with
// "Kiro didn't take the API key: 400 Bad Request" — GetProfile's 400.
import { test, expect, afterAll, beforeAll, afterEach } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let plugin
beforeAll(async () => {
  // Bun reads HOME once, at start: run as HOME=$(mktemp -d) bun test
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ KiroAuthPlugin: plugin } = await import("./index.mjs"))
})
const offline = async () => {
  throw new Error("no network in tests")
}
const real = globalThis.fetch
globalThis.fetch = offline
afterAll(() => {
  globalThis.fetch = real
})
afterEach(() => {
  globalThis.fetch = offline
})

const KEY = "ksk_test_not_a_real_key"
const EU = "arn:aws:codewhisperer:eu-central-1:333333333333:profile/EUKEY"
const MODELS = [
  { modelId: "auto", modelName: "Auto", tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 64000 } },
  { modelId: "claude-opus-5.5", modelName: "Claude Opus 5.5", tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 128000 } },
]
const MORE = [{ modelId: "claude-sonnet-5.5", modelName: "Claude Sonnet 5.5", tokenLimits: { maxInputTokens: 1000000, maxOutputTokens: 64000 } }]

// kiro is Kiro's API as an API key sees it, answering only what kiro-cli
// sends: GetProfile's answer in each region is given (a 400 where none),
// the REST calls a sign-in makes answer 400, and a chat stops at a 500.
function kiro({ profileIn = {} } = {}) {
  const seen = { calls: [], chats: [] }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const h = Object.fromEntries(new Headers(init.headers).entries())
    const region = url.hostname.split(".")[1]
    if (h.authorization !== `Bearer ${KEY}` || h.tokentype !== "API_KEY") return new Response("{}", { status: 403 })
    if (url.hostname.startsWith("management.")) {
      const target = h["x-amz-target"] ?? ""
      seen.calls.push({ region, path: url.pathname, query: url.search, target, body: init.body })
      if (url.pathname !== "/" || h["content-type"] !== "application/x-amz-json-1.0" || init.method !== "POST")
        return new Response(JSON.stringify({ message: "profileArn is required for this request." }), { status: 400 })
      const body = JSON.parse(init.body)
      if (target === "AmazonCodeWhispererService.GetProfile") {
        if (profileIn[region]) return Response.json({ profile: { arn: profileIn[region], profileName: "key" } })
        return new Response(JSON.stringify({ __type: "ValidationException", message: "Invalid request" }), { status: 400 })
      }
      if (url.search !== "?origin=KIRO_CLI" || body.origin !== "KIRO_CLI" || "profileArn" in body)
        return new Response(JSON.stringify({ message: "Invalid request" }), { status: 400 })
      if (target === "KiroControlPlaneBearerService.ListAvailableModels") {
        if (body.nextToken === "p2") return Response.json({ models: MORE })
        return Response.json({ models: MODELS, defaultModel: { modelId: "auto" }, nextToken: "p2" })
      }
      if (target === "AmazonCodeWhispererService.GetUsageLimits")
        return Response.json({ subscriptionInfo: { subscriptionTitle: "KIRO PRO+" },
          usageBreakdownList: [{ displayNamePlural: "Credits", currentUsageWithPrecision: 10, usageLimitWithPrecision: 2000 }] })
    }
    if (url.pathname === "/generateAssistantResponse") {
      const b = JSON.parse(init.body)
      seen.chats.push({ region, profileArn: b.profileArn, model: b.conversationState.currentMessage.userInputMessage.modelId })
      return new Response(JSON.stringify({ message: "stop here" }), { status: 500 })
    }
    throw new Error("unexpected " + url)
  }
  return seen
}

const hooks = () => plugin({ client: { auth: { set: async () => {} } } })
const auth = { type: "api", key: KEY }
const ask = async (h, model) => {
  const l = await h.auth.loader(async () => auth)
  return l.fetch("https://kiro.invalid/v1/messages", { method: "POST", body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }) })
}

test("a key GetProfile finds no profile for lists its models, as kiro-cli lists them", async () => {
  const seen = kiro()
  const h = await hooks()
  const models = await h.provider.models({ models: { auto: {} } }, { auth })
  expect(Object.keys(models)).toEqual(["auto", "claude-opus-5.5", "claude-sonnet-5.5"])
  // GetProfile in both of Kiro's regions, then the list in us-east-1, each page
  expect(seen.calls.map((c) => [c.region, c.target])).toEqual([
    ["us-east-1", "AmazonCodeWhispererService.GetProfile"],
    ["eu-central-1", "AmazonCodeWhispererService.GetProfile"],
    ["us-east-1", "KiroControlPlaneBearerService.ListAvailableModels"],
    ["us-east-1", "KiroControlPlaneBearerService.ListAvailableModels"],
  ])
  expect(JSON.parse(seen.calls[2].body)).toEqual({ origin: "KIRO_CLI" })
  expect(JSON.parse(seen.calls[3].body)).toEqual({ origin: "KIRO_CLI", nextToken: "p2" })
})

test("a key GetProfile finds no profile for chats in us-east-1, naming no profile", async () => {
  const seen = kiro()
  const h = await hooks()
  const res = await ask(h, "claude-opus-5.5")
  await res.text()
  expect(seen.chats).toEqual([{ region: "us-east-1", profileArn: undefined, model: "claude-opus-5.5" }])
  // GetProfile isn't asked again on the next request
  await (await ask(h, "auto")).text()
  expect(seen.calls.filter((c) => c.target.endsWith("GetProfile")).length).toBe(2)
})

test("a key whose profile is in eu-central-1 is used there, its calls naming no profile", async () => {
  const seen = kiro({ profileIn: { "eu-central-1": EU } })
  const h = await hooks()
  const models = await h.provider.models({ models: { auto: {} } }, { auth })
  expect(Object.keys(models)).toContain("claude-opus-5.5")
  await (await ask(h, "claude-opus-5.5")).text()
  expect(seen.calls.filter((c) => c.target.endsWith("ListAvailableModels")).map((c) => c.region)).toEqual(["eu-central-1", "eu-central-1"])
  expect(seen.chats).toEqual([{ region: "eu-central-1", profileArn: undefined, model: "claude-opus-5.5" }])
})

test("a key's credits are GetUsageLimits as kiro-cli asks it", async () => {
  const seen = kiro()
  const h = await hooks()
  const u = await h.auth.usage(async () => auth)
  expect(u.error).toBeUndefined()
  expect(u.plan).toBe("Kiro Pro+")
  expect(u.windows[0].display).toBe("10 / 2000")
  const call = seen.calls.find((c) => c.target === "AmazonCodeWhispererService.GetUsageLimits")
  expect(call.query).toBe("?origin=KIRO_CLI")
  expect(JSON.parse(call.body)).toEqual({ origin: "KIRO_CLI" })
})
