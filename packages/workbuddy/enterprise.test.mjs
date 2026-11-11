// An enterprise (team) account is asked for as the enterprise, as
// WorkBuddy's own client asks: X-Enterprise-Id and X-Tenant-Id carry the
// account's enterpriseId on every request, or WorkBuddy answers as the
// personal account and lists the personal plan's models (#75).
import { afterEach, expect, test } from "bun:test"
import { WorkBuddyAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const site = _internal.SITES.workbuddy
const later = () => Date.now() + 3600_000
const config = '{"code":0,"data":{"agents":[{"name":"cli","models":["m"]}],"models":[{"id":"m","name":"M"}]}}'

const enterpriseModelsConfig = ({
  agentModels = ["custom:claude-opus-5-5|claude-opus-5-5", "custom:gpt-5.6-sol|gpt-5.6-sol"],
  detailIds = ["claude-opus-5-5", "gpt-5.6-sol"],
} = {}) => {
  const names = {
    "claude-opus-5-5": "Claude Opus 5.5",
    "gpt-5.6-sol": "GPT-5.6 Sol",
    "custom:claude-opus-5-5|claude-opus-5-5": "Claude Opus 5.5",
  }
  const meta = {
    "claude-opus-5-5": { context: 200000, output: 64000, images: true, price: 3 },
    "gpt-5.6-sol": { context: 272000, output: 100000, images: true, price: 2 },
  }
  const details = detailIds.map((id) => {
    const bare = String(id).replace(/^custom:([^|]+)\|[^|]+$/, "$1")
    return {
      id,
      name: names[id],
      maxInputTokens: meta[bare].context,
      maxOutputTokens: meta[bare].output,
      supportsImages: meta[bare].images,
      credits: meta[bare].price,
      supportsReasoning: true,
      reasoning: { supportedEfforts: ["low", "high"], effort: "high" },
    }
  })
  return JSON.stringify({ code: 0, data: { agents: [{ name: "cli", models: agentModels }], models: details } })
}

const seen = (into) => async (url, init) => {
  into.push({ url: String(url), headers: new Headers(init?.headers) })
  return new Response(config)
}

test("an enterprise account's model list is asked for as the enterprise (#75)", async () => {
  const got = []
  globalThis.fetch = seen(got)
  await _internal.liveModels(site, { access: "a", uid: "u", enterpriseId: "ent-1" })
  expect(got[0].url).toEndWith("/v3/config")
  expect(got[0].headers.get("X-Enterprise-Id")).toBe("ent-1")
  expect(got[0].headers.get("X-Tenant-Id")).toBe("ent-1")
})

test("a personal account's list carries no enterprise", async () => {
  const got = []
  globalThis.fetch = seen(got)
  await _internal.liveModels(site, { access: "a", uid: "u" })
  expect(got[0].headers.has("X-Enterprise-Id")).toBe(false)
  expect(got[0].headers.has("X-Tenant-Id")).toBe(false)
})

test("enterprise custom models keep their full ids and take their details (#1015)", async () => {
  globalThis.fetch = async () => new Response(enterpriseModelsConfig())
  const out = await _internal.liveModels(site, { access: "a", uid: "u", enterpriseId: "ent-1" })
  const byId = Object.fromEntries(out.map((m) => [m.id, m]))

  expect(byId["custom:claude-opus-5-5|claude-opus-5-5"]).toMatchObject({
    name: "Claude Opus 5.5",
    context: 200000,
    output: 64000,
    images: true,
    rate: 3,
    efforts: ["none", "low", "high"],
    effort: "high",
  })
  expect(byId["custom:gpt-5.6-sol|gpt-5.6-sol"]).toMatchObject({
    name: "GPT-5.6 Sol",
    context: 272000,
    output: 100000,
    images: true,
    rate: 2,
    efforts: ["none", "low", "high"],
    effort: "high",
  })
  expect(_internal.nativeOf(site, "custom:claude-opus-5-5|claude-opus-5-5")).toBe(false)
  expect(_internal.modelOf(site, { id: site.id }, byId["custom:claude-opus-5-5|claude-opus-5-5"]).api).toMatchObject({
    npm: "@ai-sdk/openai-compatible",
    url: "https://copilot.tencent.com/v2",
  })
})

test("a bare enterprise model id takes its custom detail's full id (#1015)", async () => {
  globalThis.fetch = async () => new Response(enterpriseModelsConfig({
    agentModels: ["claude-opus-5-5"],
    detailIds: ["custom:claude-opus-5-5|claude-opus-5-5"],
  }))
  const out = await _internal.liveModels(site, { access: "a", uid: "u", enterpriseId: "ent-1" })
  expect(out).toHaveLength(1)
  expect(out[0]).toMatchObject({
    id: "custom:claude-opus-5-5|claude-opus-5-5",
    name: "Claude Opus 5.5",
    context: 200000,
    output: 64000,
    images: true,
    efforts: ["none", "low", "high"],
    effort: "high",
  })
})

test("an unmatched enterprise custom model stays listed, and exact standard ids stay exact", async () => {
  globalThis.fetch = async () => new Response(enterpriseModelsConfig({
    agentModels: ["custom:other-model|other-model", "claude-opus-5-5"],
    detailIds: ["claude-opus-5-5"],
  }))
  const out = await _internal.liveModels(site, { access: "a", uid: "u", enterpriseId: "ent-1" })
  expect(out.map((m) => m.id)).toEqual(["custom:other-model|other-model", "claude-opus-5-5"])
  expect(out[0].name).toBe("custom:other-model|other-model")
  expect(out[0]).not.toHaveProperty("context")
})

test("an enterprise account's chats carry the enterprise too", async () => {
  const got = []
  globalThis.fetch = seen(got)
  const auth = { type: "oauth", access: "a", refresh: "r", expires: later(), uid: "u", enterpriseId: "ent-1" }
  const hooks = await WorkBuddyAuthPlugin({ client: {} })
  const opts = await hooks.auth.loader(async () => auth)
  await opts.fetch("https://copilot.tencent.com/v2/chat/completions", { method: "POST", body: '{"messages":[]}' })
  expect(got.at(-1).headers.get("X-Enterprise-Id")).toBe("ent-1")
  expect(got.at(-1).headers.get("X-Tenant-Id")).toBe("ent-1")
})

// the sign-in, with WorkBuddy's answers as its own client reads them
const signIn = async (account, accounts) => {
  const asked = []
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url))
    asked.push(u.pathname)
    const data =
      u.pathname.endsWith("/auth/state") ? { state: "s", authUrl: "https://www.codebuddy.cn/login" }
      : u.pathname.endsWith("/auth/token") ? { accessToken: "a", refreshToken: "r", expiresIn: 3600 }
      : u.pathname.endsWith("/login/account") ? account
      : u.pathname.endsWith("/accounts") ? { accounts }
      : {}
    return new Response(JSON.stringify({ code: 0, data }))
  }
  const flow = await _internal.browserSignIn(site)
  return { result: await flow.callback(), asked }
}

test("signing in as an enterprise keeps the enterprise WorkBuddy named", async () => {
  const { result, asked } = await signIn(
    { uid: "u", nickname: "n", type: "ultimate", enterpriseId: "ent-1", enterpriseName: "WorkBuddy 教育公益版" },
    [],
  )
  expect(result.type).toBe("success")
  expect(result.enterpriseId).toBe("ent-1")
  expect(result.accountId).toBe("n · WorkBuddy 教育公益版")
  expect(asked.some((p) => p.endsWith("/accounts"))).toBe(false)
})

test("an enterprise named by id only takes its name from the account list", async () => {
  const { result } = await signIn({ uid: "u", nickname: "n", type: "ultimate", enterpriseId: "ent-1" }, [
    { uid: "u", type: "personal" },
    { uid: "u", type: "ultimate", enterpriseId: "ent-1", enterpriseName: "某某中学" },
  ])
  expect(result.enterpriseId).toBe("ent-1")
  expect(result.accountId).toBe("n · 某某中学")
})

test("an enterprise WorkBuddy names nowhere is told apart by its id", async () => {
  const { result } = await signIn({ uid: "u", nickname: "n", type: "ultimate", enterpriseId: "ent-123456789" }, [])
  expect(result.enterpriseId).toBe("ent-123456789")
  expect(result.accountId).toBe("n · enterprise 456789")
})

// One person's personal and education accounts share the uid and the
// nickname; magpie keeps one account per name and uid, so the two names
// must differ or the second sign-in replaces the first.
test("a person's personal and enterprise sign-ins are named apart", async () => {
  const list = [
    { uid: "u", type: "personal", lastLogin: false },
    { uid: "u", type: "ultimate", enterpriseId: "ent-2", enterpriseName: "WorkBuddy 教育公益版", lastLogin: true },
  ]
  const personal = (await signIn({ uid: "u", nickname: "n", type: "personal" }, list)).result
  const edu = (await signIn({ uid: "u", nickname: "n", type: "ultimate" }, list)).result
  expect(personal.accountId).toBe("n")
  expect(edu.accountId).toBe("n · WorkBuddy 教育公益版")
  expect(personal.uid).toBe(edu.uid)
})

test("an enterprise account named without its id is found in the account list", async () => {
  const { result } = await signIn({ uid: "u", nickname: "n", type: "ultimate" }, [
    { uid: "u", type: "personal", lastLogin: false },
    { uid: "u", type: "ultimate", enterpriseId: "ent-2", lastLogin: true },
    { uid: "other", type: "ultimate", enterpriseId: "ent-3", lastLogin: true },
  ])
  expect(result.enterpriseId).toBe("ent-2")
})

test("signing in as the personal account keeps no enterprise", async () => {
  const { result, asked } = await signIn({ uid: "u", nickname: "n", type: "personal" }, [
    { uid: "u", type: "ultimate", enterpriseId: "ent-2", lastLogin: true },
  ])
  expect(result.type).toBe("success")
  expect("enterpriseId" in result).toBe(false)
  expect(asked.some((p) => p.endsWith("/accounts"))).toBe(false)
})
