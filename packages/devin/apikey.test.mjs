// A key typed in (a service user's cog_… from Devin's settings) is a sign-in
// method of its own, saved as OpenCode saves any API key: {type:"api", key},
// no metadata. The chat and usage paths take it as they take a browser
// sign-in's token, and the first usage read names the account.
import { afterEach, expect, test } from "bun:test"
import { DevinAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const LABEL = "Devin API key (cog_…)"
const configs = () => new Response(new _internal.PB().bytes(1, new _internal.PB().bytes(22, "swe-2")).done())

test("the API key method is offered after the two sign-ins, with nothing to authorize", async () => {
  const { auth } = await DevinAuthPlugin({})
  expect(auth.methods.map((m) => [m.type, m.label])).toEqual([
    ["oauth", "Devin (browser)"],
    ["oauth", "Devin CLI's sign-in"],
    ["api", LABEL],
  ])
  // the host saves the key as typed only when there is no authorize
  expect(auth.methods[2].authorize).toBeUndefined()
})

test("a typed key is sent to GetChatMessage as a sign-in's token is", async () => {
  const seen = []
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/GetCliModelConfigs")) return configs()
    seen.push({ url: String(url), auth: new Headers(init.headers).get("Authorization") })
    return new Response("", { status: 402 })
  }
  const key = { type: "api", key: "cog_chat_test" }
  const { auth } = await DevinAuthPlugin({})
  const opts = await auth.loader(async () => key)
  expect(opts.apiKey).toBe("cog_chat_test")
  const res = await opts.fetch("https://devin.invalid/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "swe-2", messages: [{ role: "user", content: "hi" }] }),
  })
  expect(res.status).toBe(402)
  const chat = seen.find((s) => s.url.endsWith("/GetChatMessage"))
  expect(chat?.url).toBe("https://server.codeium.com/exa.api_server_pb.ApiServerService/GetChatMessage")
  expect(chat.auth).toBe("Basic cog_chat_test")
})

test("usage reads a typed key's plan and names its account", async () => {
  const seen = []
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/GetCliModelConfigs")) return configs()
    seen.push(JSON.parse(init.body))
    return Response.json({
      userStatus: {
        email: "svc@example.com",
        teamId: "team-1",
        planStatus: { planInfo: { planName: "Teams", devinInfo: { orgId: "org-1" } }, planEnd: "2026-12-01T00:00:00Z", dailyQuotaRemainingPercent: 80 },
      },
    })
  }
  const sets = []
  const key = { type: "api", key: "cog_usage_test" }
  const { auth } = await DevinAuthPlugin({ client: { auth: { set: async (a) => sets.push(a) } } })
  const u = await auth.usage(async () => key)
  expect(u.signIn).toBe("renewed")
  expect(u.error).toBeUndefined()
  expect(seen[0].metadata.apiKey).toBe("cog_usage_test")
  expect(sets).toEqual([{ path: { id: "devin" }, body: { type: "api", key: "cog_usage_test", metadata: { email: "svc@example.com", orgId: "org-1", teamId: "team-1" } } }])
})

test("OpenCode 2 offers a key method, and its credential is read as an API key", async () => {
  const methods = []
  const ctx = {
    integration: {
      transform: async (cb) => cb({ method: { update: (m) => methods.push(m) } }),
      connection: { active: async () => null, resolve: async () => null },
    },
    provider: { transform: async () => {}, reload: async () => {} },
    model: { transform: async () => {}, reload: async () => {} },
    aisdk: { hook: async () => {} },
    event: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) },
  }
  await _internal.v2Setup(ctx)
  expect(methods.filter((m) => m.method?.type === "key").map((m) => [m.integrationID, m.method.label])).toEqual([["devin", LABEL]])
  expect(_internal.v2Auth({ type: "key", key: "cog_v2" })).toEqual({ type: "api", key: "cog_v2", metadata: {} })
})
