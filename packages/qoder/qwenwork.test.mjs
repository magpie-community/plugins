// QwenWork on the qoder protocol: the sign-in shapes, and — with fetch
// mocked and every outgoing request recorded — that each hook the QwenWork
// sites set actually reaches the wire: the model list and a chat go out
// signed for the site (its own client type, scene, version, product and RSA
// key), the enterprise account's every call goes to its own domain with
// nothing to gateway.qwenwork.cn, usage reads its account-context, and the
// 503 catalog falls back where a 500 doesn't. Delete a hook and a test
// here goes red.
import { test, expect } from "bun:test"

const client = { app: { log: async () => {} }, auth: { set: async () => {} }, tui: { showToast: async () => {} }, config: { get: async () => ({ data: {} }) } }
const load = async (fresh = "") => {
  const mod = await import(`./index.mjs${fresh}`)
  const pub = await mod.QwenWorkAuthPlugin({ client, directory: process.cwd(), worktree: process.cwd(), $: undefined, project: {} })
  const ent = await mod.QwenWorkEnterpriseAuthPlugin({ client, directory: process.cwd(), worktree: process.cwd(), $: undefined, project: {} })
  return { mod, pub, ent }
}

// the URLs fetch saw, with the headers each was sent with
const seen = []
let answer = async () => new Response("{}", { status: 404 })
const mock = () => {
  const saved = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: { ...(init?.headers ?? {}) } })
    return answer(String(url), init)
  }
  return () => { globalThis.fetch = saved; seen.length = 0 }
}
const header = (i, name) => seen[i]?.headers[name]

// a signed-in account on the enterprise domain
const entCred = (domain = "acme.example.com") => ({ type: "oauth", uid: "u1", email: "alice@acme.example.com", name: "Alice", machineId: "m1", access: "a", refresh: "r", expires: Date.now() + 3_600_000, deviceChat: true, deviceToken: "dt", deviceRefresh: "dtr", vpc: domain, enterpriseHost: domain })

test("the enterprise sign-in asks for a domain and runs on it, with no redirect_uri", async () => {
  const { ent } = await load()
  const m = ent.auth.methods[0]
  expect(m.prompts.some((p) => p.key === "domain")).toBe(true)
  const flow = await m.authorize({ domain: "acme.example.com" })
  expect(flow.url.startsWith("https://acme.example.com/device/selectAccounts?")).toBe(true)
  expect(flow.url.includes("redirect_uri")).toBe(false)
  // the public cloud keeps its own
  const { pub } = await load()
  const pubFlow = await pub.auth.methods[0].authorize()
  expect(pubFlow.url.includes("redirect_uri=qwenwork-cn%3A%2F%2F")).toBe(true)
})

test("the domain input refuses loopback, intranet, ports, paths and IPs", async () => {
  const { ent } = await load()
  const validate = ent.auth.methods[0].prompts.find((p) => p.key === "domain").validate
  for (const bad of ["not a domain", "1.2.3.4", "localhost", "foo.localhost", "foo.local", "foo.internal", "https://a.example:8443", "https://a.example/path", "http://a.example", "https://u:p@a.example"]) {
    expect(validate(bad)).toBeString()
  }
  for (const good of ["your-company.vpc.qwenwork.cn", "https://your-company.vpc.qwenwork.cn", "https://your-company.vpc.qwenwork.cn/"]) {
    expect(validate(good)).toBeUndefined()
  }
})

test("QWENWORK_ENT_DOMAIN presets the domain", async () => {
  process.env.QWENWORK_ENT_DOMAIN = "preset.example.com"
  try {
    const { ent } = await load("?preset")
    const m = ent.auth.methods[0]
    expect(m.prompts.length).toBe(0)
    const flow = await m.authorize({})
    expect(flow.url.startsWith("https://preset.example.com/")).toBe(true)
  } finally {
    delete process.env.QWENWORK_ENT_DOMAIN
  }
})

test("the enterprise sign-in completes on the enterprise's own host, naming the account with its domain", async () => {
  const { ent } = await load()
  const flow = await ent.auth.methods[0].authorize({ domain: "acme.example.com" })
  const restore = mock()
  answer = async (url) => {
    if (url.includes("/api/v1/deviceToken/poll")) return new Response(JSON.stringify({ token: "dt", refresh_token: "dtr", user_id: "u1" }), { status: 200 })
    if (url.includes("/api/v1/adapter/user/account-context")) return new Response(JSON.stringify({ data: { user: { id: "u1", name: "Alice", email: "alice@acme.example.com" } } }), { status: 200 })
    return new Response("{}", { status: 404 })
  }
  try {
    const acct = await flow.callback()
    expect(acct.accountId).toBe("alice@acme.example.com (acme.example.com)")
    expect(acct.enterpriseHost).toBe("acme.example.com")
    expect(seen.every((r) => r.url.startsWith("https://acme.example.com/"))).toBe(true)
    expect(seen.some((r) => r.url.includes("/api/v1/me/jobToken"))).toBe(false) // deviceOnly: no job token
  } finally {
    restore()
  }
})

test("the model list goes out signed for the site: client type, scene, version, product and its own key", async () => {
  const { ent } = await load()
  const restore = mock()
  answer = async () => new Response(JSON.stringify({ qwork: [{ key: "flash", display_name: "标准", is_vl: false, is_reasoning: false, max_input_tokens: 4096 }] }), { status: 200 })
  try {
    const models = await ent.provider.models({ models: {} }, { auth: entCred() })
    expect(Object.keys(models)).toContain("flash")
    // QwenWork's RSA key is byte-equal to Qoder's (checked: it is), so the
    // blob's key can't tell them apart — the headers can
    expect(header(0, "Cosy-ClientType")).toBe("6")
    expect(header(0, "Cosy-Scene")).toBe("qwork")
    expect(header(0, "Cosy-Business-Product")).toBe("qoder_work")
    expect(header(0, "Cosy-Version")).toBe("1.1.59")
    expect(seen[0].url.startsWith("https://acme.example.com/")).toBe(true)
  } finally {
    restore()
  }
})

test("a chat goes out signed and written for the site: headers and body", async () => {
  const { mod, pub } = await load()
  const restore = mock()
  // the full answer an SSE chat round needs: skipped, as ask() streams; a
  // 400 from upstream exercises the signing path and returns an error
  answer = async (url) => {
    if (url.includes("/model/list")) return new Response(JSON.stringify({ qwork: [{ key: "flash", display_name: "标准", is_vl: false, is_reasoning: false, max_input_tokens: 4096 }] }), { status: 200 })
    return new Response(JSON.stringify({ code: "400", message: "no" }), { status: 400, headers: { "Content-Type": "application/json" } })
  }
  try {
    const cred = { type: "oauth", uid: "u1", email: "a@b.c", name: "A", machineId: "m1", access: "a", refresh: "r", expires: Date.now() + 3_600_000, deviceChat: true, deviceToken: "dt", deviceRefresh: "dtr" }
    const l = await pub.auth.loader(async () => cred, { models: {} })
    const chatRes = await l.fetch("https://gateway.qwenwork.cn/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "flash", messages: [{ role: "user", content: "hi" }], max_tokens: 5 }), // bare: the gateway strips the provider prefix
    })
    expect([400, 502]).toContain(chatRes.status) // the mocked upstream's answer, surfaced
    const chatReq = seen.find((r) => r.url.includes("/agent_chat_generation"))
    expect(chatReq).toBeDefined()
    // signed for the site
    expect(chatReq.headers["Cosy-ClientType"]).toBe("6")
    expect(chatReq.headers["Cosy-Scene"]).toBe("qwork")
    expect(chatReq.headers["Cosy-Business-Product"]).toBe("qoder_work")
    expect(chatReq.headers["Cosy-Version"]).toBe("1.1.59")
  } finally {
    restore()
  }
})

test("the chat body carries the site's session type, business product and system prompt", async () => {
  const { pub } = await load()
  const restore = mock()
  answer = async (url) => {
    if (url.includes("/model/list")) return new Response(JSON.stringify({ qwork: [{ key: "flash", display_name: "标准", is_vl: false, is_reasoning: false, max_input_tokens: 4096 }] }), { status: 200 })
    return new Response(JSON.stringify({ code: "400", message: "no" }), { status: 400, headers: { "Content-Type": "application/json" } })
  }
  // capture the body too
  const savedBody = globalThis.fetch
  const bodies = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: { ...(init?.headers ?? {}) } })
    if (init?.body) bodies.push(String(init.body))
    return answer(String(url), init)
  }
  try {
    const cred = { type: "oauth", uid: "u1", email: "a@b.c", name: "A", machineId: "m1", access: "a", refresh: "r", expires: Date.now() + 3_600_000, deviceChat: true, deviceToken: "dt", deviceRefresh: "dtr" }
    const l = await pub.auth.loader(async () => cred, { models: {} })
    await l.fetch("https://gateway.qwenwork.cn/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "flash", messages: [{ role: "user", content: "hi" }], max_tokens: 5 }),
    })
    const { decodeBody } = (await import("./index.mjs"))._internal
    const chatBody = bodies.map((b) => { try { return JSON.parse(decodeBody(b)) } catch { return null } }).find((x) => x && x.session_type)
    expect(chatBody).toBeDefined()
    expect(chatBody.session_type).toBe("qoder_work")            // not "app"
    expect(chatBody.business.product).toBe("qoder_work")
    expect(chatBody.business.version).toBe("1.1.59")
    expect(chatBody.system?.[0]?.text).toContain("You are QwenWork")
    expect(chatBody.system?.[0]?.text).not.toContain("Qoder")
  } finally {
    globalThis.fetch = savedBody
    restore()
  }
})

test("usage reads the account-context on the account's own host, and nothing reaches the public cloud", async () => {
  const { ent } = await load()
  const restore = mock()
  answer = async (url) => {
    if (url.startsWith("https://acme.example.com/")) return new Response(JSON.stringify({ data: { plan: { name: "Enterprise" }, quota: { total: 100, remaining: 60 } } }), { status: 200 })
    return new Response("{}", { status: 404 })
  }
  try {
    const usage = await ent.auth.usage(async () => entCred())
    expect(usage.plan).toBe("Enterprise")
    expect(usage.windows[0].display).toBe("40 / 100 credits")
    expect(seen.some((r) => r.url.includes("gateway.qwenwork.cn"))).toBe(false)
  } finally {
    restore()
  }
})

test("usage renews an expired account rather than marking it lapsed", async () => {
  const { ent } = await load()
  const restore = mock()
  answer = async (url) => {
    if (url.includes("/api/v1/deviceToken/refresh")) return new Response(JSON.stringify({ token: "dt2", refresh_token: "dtr2", expires_in: 3600 }), { status: 200 })
    if (url.startsWith("https://acme.example.com/")) return new Response(JSON.stringify({ data: { plan: { name: "Enterprise" }, quota: { total: 100, remaining: 60 } } }), { status: 200 })
    return new Response("{}", { status: 404 })
  }
  try {
    const expired = { ...entCred(), expires: Date.now() - 1_000 }
    const usage = await ent.auth.usage(async () => expired)
    expect(usage.signIn).not.toBe("expired")
    expect(usage.plan).toBe("Enterprise")
  } finally {
    restore()
  }
})

test("a 503 catalog falls back to the shipped list; a 500 doesn't", async () => {
  const { ent } = await load()
  const restore = mock()
  answer = async (url) => {
    if (url.includes("/model/list")) return new Response(JSON.stringify({ code: "503", message: "Model catalog is unavailable" }), { status: 503 })
    return new Response("{}", { status: 200 })
  }
  try {
    const models = await ent.provider.models({ models: {} }, { auth: entCred() })
    expect(Object.keys(models)).toContain("flash")
    expect(seen.every((r) => r.url.startsWith("https://acme.example.com/"))).toBe(true)
  } finally {
    restore()
  }
  answer = async () => new Response("nope", { status: 500 })
  try {
    const models = await ent.provider.models({ models: {} }, { auth: entCred() })
    expect(Object.keys(models)).not.toContain("flash")
  } finally {
    restore()
  }
})

test("the public plugin offers no PAT and no check-in", async () => {
  const { pub, ent } = await load()
  expect(pub.auth.methods.some((m) => m.label.includes("PAT"))).toBe(false)
  expect(ent.auth.methods.some((m) => m.label.includes("PAT"))).toBe(false)
  expect(pub.auth.checkin).toBeUndefined()
})


test("usage rotates a refused device token and stays signed in; a refused refresh expires", async () => {
  const { ent } = await load()
  const restore = mock()
  let accountAnswers = 0
  let refreshes = 0
  let refuseRefresh = false
  answer = async (url) => {
    if (url.includes("/api/v1/deviceToken/refresh")) {
      refreshes += 1
      if (refuseRefresh) return new Response(JSON.stringify({ code: "401" }), { status: 401 })
      return new Response(JSON.stringify({ token: "dt2", refresh_token: "dtr2", expires_in: 3600 }), { status: 200 })
    }
    if (url.includes("/api/v1/adapter/user/account-context")) {
      accountAnswers += 1
      // the live device token is refused once, the rotated one succeeds
      if (accountAnswers === 1) return new Response("{}", { status: 401 })
      return new Response(JSON.stringify({ data: { plan: { name: "Enterprise" }, quota: { total: 100, remaining: 60 } } }), { status: 200 })
    }
    return new Response("{}", { status: 404 })
  }
  // a live access token: fresh() doesn't renew; the 401 has to be rotated through
  const live = { ...entCred(), access: "dt", expires: Date.now() + 3_600_000 }
  try {
    const usage = await ent.auth.usage(async () => live)
    expect(usage.signIn).not.toBe("expired")
    expect(usage.plan).toBe("Enterprise")
    expect(refreshes).toBe(1)          // the rotation refreshed the device token
    expect(accountAnswers).toBe(2)     // refused, then read
    // and when the refresh itself is refused, the account is expired
    refuseRefresh = true
    accountAnswers = 0
    const gone = await ent.auth.usage(async () => ({ ...live, deviceToken: "dt3", expires: Date.now() + 3_600_000 }))
    expect(gone.signIn).toBe("expired")
  } finally {
    restore()
  }
})

test("the device token refresh is asked with target: 'c'", async () => {
  const { ent } = await load()
  const restore = mock()
  const bodies = []
  const saved = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: { ...(init?.headers ?? {}) } })
    if (init?.body) bodies.push(String(init.body))
    if (String(url).includes("/api/v1/deviceToken/refresh")) return new Response(JSON.stringify({ token: "dt2", refresh_token: "dtr2", expires_in: 3600 }), { status: 200 })
    if (String(url).includes("/api/v1/adapter/user/account-context")) return new Response(JSON.stringify({ data: { plan: { name: "Enterprise" }, quota: { total: 100, remaining: 60 } } }), { status: 200 })
    return new Response("{}", { status: 404 })
  }
  try {
    // an expired access token: fresh() renews through refreshDevice
    const expired = { ...entCred(), expires: Date.now() - 1_000 }
    const usage = await ent.auth.usage(async () => expired)
    expect(usage.plan).toBe("Enterprise")
    const refreshBody = bodies.map((b) => { try { return JSON.parse(b) } catch { return null } }).find((x) => x && x.refresh_token)
    expect(refreshBody).toBeDefined()
    expect(refreshBody.target).toBe("c")   // QwenWork's refresh target, not Qoder's absent one
  } finally {
    globalThis.fetch = saved
    restore()
  }
})

test("a queued chat's status request is signed for the site", async () => {
  const { pub } = await load()
  const restore = mock()
  // the first chat answer is a queue refusal, as Qoder's own flow sees one;
  // the queue status asked afterwards must carry the site's headers
  answer = async (url) => {
    if (url.includes("/model/list")) return new Response(JSON.stringify({ qwork: [{ key: "flash", display_name: "标准", is_vl: false, is_reasoning: false, max_input_tokens: 4096 }] }), { status: 200 })
    if (url.includes("/agent_chat_generation")) return new Response(JSON.stringify({ code: "10605", message: "request queued", data: { isQueued: true, queueType: "global", modelKey: "flash", retryAfterSeconds: 0 } }), { status: 403, headers: { "Content-Type": "application/json" } })
    if (url.includes("/queue/status")) return new Response(JSON.stringify({ isQueued: false, retryAfterSeconds: 0 }), { status: 200, headers: { "Content-Type": "application/json" } })
    return new Response("{}", { status: 404 })
  }
  try {
    const cred = { type: "oauth", uid: "u1", email: "a@b.c", name: "A", machineId: "m1", access: "a", refresh: "r", expires: Date.now() + 3_600_000, deviceChat: true, deviceToken: "dt", deviceRefresh: "dtr" }
    const l = await pub.auth.loader(async () => cred, { models: {} })
    await l.fetch("https://gateway.qwenwork.cn/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "flash", messages: [{ role: "user", content: "hi" }], max_tokens: 5 }),
    })
    const statusReq = seen.find((r) => r.url.includes("/queue/status"))
    expect(statusReq).toBeDefined()
    expect(statusReq.headers["Cosy-ClientType"]).toBe("6")
    expect(statusReq.headers["Cosy-Scene"]).toBe("qwork")
    expect(statusReq.headers["Cosy-Version"]).toBe("1.1.59")
  } finally {
    restore()
  }
})
// #385: a public-cloud personal account's account-context has quota total
// and used null, only remaining; the pools are in /api/v1/adapter/user/wallets.
// These are the reporter's bytes.
const pubCred = () => ({ type: "oauth", uid: "u1", email: "bob@example.com", name: "Bob", machineId: "m1", access: "a", refresh: "r", expires: Date.now() + 3_600_000, deviceChat: true, deviceToken: "dt", deviceRefresh: "dtr" })
const WALLETS = { active_wallets: { wallets: [{ balance: 98.6035, valid_to: "2026-10-26T00:00:00+08:00" }, { balance: 2000, valid_to: "2026-12-18T19:50:23.14+08:00" }] }, daily_credits: { total_balance: 98.6035 }, longterm_credits: { total_balance: 2000 }, monthly_credits: { total_balance: 0 } }
const PERSONAL_QUOTA = { total: null, used: null, remaining: 2098.6336, exceeded: false }

for (const [shape, wrap] of [["wrapped in data", (v) => ({ data: v })], ["bare", (v) => v]]) {
  test(`a personal account with only what is left shows it as the balance, with each pool (${shape}, #385)`, async () => {
    const { pub } = await load()
    const restore = mock()
    answer = async (url) => {
      if (url.startsWith("https://gateway.qwenwork.cn/api/v1/adapter/user/account-context")) return new Response(JSON.stringify(wrap({ user: { id: "u1" }, plan: { name: "Free" }, quota: PERSONAL_QUOTA })), { status: 200 })
      if (url === "https://gateway.qwenwork.cn/api/v1/adapter/user/wallets") return new Response(JSON.stringify(wrap(WALLETS)), { status: 200 })
      return new Response("{}", { status: 404 })
    }
    try {
      const usage = await pub.auth.usage(async () => pubCred())
      expect(usage.error).toBeUndefined()
      expect(usage.plan).toBe("Free")
      expect(usage.balance).toBe("2098.63 credits (daily 98.6 · long-term 2000)")
      expect(usage.windows).toBeUndefined()
      const w = seen.find((r) => r.url.endsWith("/api/v1/adapter/user/wallets"))
      expect(w?.headers.Authorization).toBe("Bearer dt")
      expect(seen.some((r) => r.url.includes("/sash/"))).toBe(false)
    } finally {
      restore()
    }
  })
}

test("a personal account's wallets that can't be read leave the balance without pools (#385)", async () => {
  const { pub } = await load()
  const restore = mock()
  answer = async (url) => {
    if (url.includes("/account-context")) return new Response(JSON.stringify({ data: { quota: PERSONAL_QUOTA } }), { status: 200 })
    return new Response("oops", { status: 500 })
  }
  try {
    const usage = await pub.auth.usage(async () => pubCred())
    expect(usage.error).toBeUndefined()
    expect(usage.balance).toBe("2098.63 credits")
  } finally {
    restore()
  }
})

test("a personal account with nothing left is a spent window, not a share made up (#385)", async () => {
  const { pub } = await load()
  const restore = mock()
  answer = async (url) => {
    if (url.includes("/account-context")) return new Response(JSON.stringify({ data: { quota: { total: null, used: null, remaining: 0, exceeded: true } } }), { status: 200 })
    if (url.endsWith("/wallets")) return new Response(JSON.stringify({ data: { daily_credits: { total_balance: 0 }, longterm_credits: { total_balance: 0 } } }), { status: 200 })
    return new Response("{}", { status: 404 })
  }
  try {
    const usage = await pub.auth.usage(async () => pubCred())
    expect(usage.balance).toBe("0 credits")
    expect(usage.windows).toEqual([{ name: "Credits", used: 100, display: "no credits left" }])
  } finally {
    restore()
  }
})

test("the enterprise flagship and a biz account never read the wallets (#385)", async () => {
  const { ent, pub } = await load()
  const restore = mock()
  answer = async (url) => {
    if (url.includes("/account-context")) return new Response(JSON.stringify({ data: { user: { id: "u1", is_biz: true }, quota: { total: 100, remaining: 60 } } }), { status: 200 })
    return new Response("{}", { status: 404 })
  }
  try {
    await ent.auth.usage(async () => entCred())
    const biz = await pub.auth.usage(async () => pubCred())
    expect(biz.windows[0].display).toBe("40 / 100 credits")
    expect(biz.balance).toBe("60 credits")
    expect(seen.some((r) => r.url.includes("/wallets"))).toBe(false)
  } finally {
    restore()
  }
})

// tnt1223 on Discord: QwenWork's model list answered 403 "User identity
// could not be verified". What QwenWorkCN.app 1.2.1 does that the plugin
// didn't: it names itself on every gateway call (openApiJsonRequest), and
// refreshes a biz account's device token for its own team (refreshDeviceToken).
test("every QwenWork gateway call names the client, as QwenWork's own does (tnt1223)", async () => {
  const { pub } = await load()
  const flow = await pub.auth.methods[0].authorize()
  const restore = mock()
  answer = async (url) => {
    if (url.includes("/api/v1/deviceToken/poll")) return new Response(JSON.stringify({ token: "dt", refresh_token: "dtr", user_id: "u1" }), { status: 200 })
    if (url.includes("/api/v1/adapter/user/account-context")) return new Response(JSON.stringify({ data: { user: { id: "u1", email: "a@b.cn" }, plan: { name: "Free" }, quota: { total: 100, remaining: 60 } } }), { status: 200 })
    if (url.includes("/api/v1/deviceToken/refresh")) return new Response(JSON.stringify({ token: "dt2", refresh_token: "dtr2", expires_in: 3600 }), { status: 200 })
    return new Response("{}", { status: 404 })
  }
  try {
    const acct = await flow.callback()
    await pub.auth.usage(async () => ({ ...acct, type: "oauth", expires: Date.now() - 1_000 }))
    const calls = seen.filter((r) => r.url.startsWith("https://gateway.qwenwork.cn/api/v1/"))
    expect(calls.some((r) => r.url.includes("/deviceToken/poll"))).toBe(true)
    expect(calls.some((r) => r.url.includes("/deviceToken/refresh"))).toBe(true)
    expect(calls.some((r) => r.url.includes("/account-context"))).toBe(true)
    for (const r of calls) {
      expect(r.headers["User-Agent"]).toBe("qoderwork/1.2.1")
      expect(r.headers["X-QwenWork-Version"]).toBe("1.2.1")
      expect(r.headers["X-QwenWork-Release-Version"]).toBe("1.2.1-26092107")
      expect(r.headers["X-QwenWork-Build"]).toBe("26092107")
      expect(r.headers["X-QwenWork-Platform"]).toBe(process.platform)
      expect(r.headers["X-QwenWork-Arch"]).toBe(process.arch)
      expect(r.headers["X-QwenWork-Channel"]).toBe("stable")
      expect(r.headers["X-Request-Id"]).toMatch(/^[0-9a-f-]{36}$/)
    }
    // each call its own request id
    expect(new Set(calls.map((r) => r.headers["X-Request-Id"])).size).toBe(calls.length)
  } finally {
    restore()
  }
})

test("Qoder's own gateway calls don't take QwenWork's names", async () => {
  const mod = await import("./index.mjs")
  const restore = mock()
  answer = async () => new Response("{}", { status: 200 })
  try {
    await mod.protocol.openapi(mod._internal.SITES.qoder, "/api/v1/userinfo", { token: "t" })
    expect(Object.keys(seen[0].headers).some((k) => k.startsWith("X-QwenWork"))).toBe(false)
    expect(seen[0].headers["User-Agent"]).toBeUndefined()
  } finally {
    restore()
  }
})

test("a biz account is signed in as biz, and its device token refreshed for its own team (tnt1223)", async () => {
  const { pub } = await load()
  const flow = await pub.auth.methods[0].authorize()
  const restore = mock()
  const bodies = []
  const saved = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: { ...(init?.headers ?? {}) } })
    if (String(url).includes("/api/v1/deviceToken/refresh")) {
      bodies.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ token: "dt2", refresh_token: "dtr2", expires_in: 3600 }), { status: 200 })
    }
    if (String(url).includes("/api/v1/deviceToken/poll")) return new Response(JSON.stringify({ token: "dt", refresh_token: "dtr", user_id: "u1" }), { status: 200 })
    // the shape fetchUserInfo reads: is_biz on the user, org and team on the organization
    if (String(url).includes("/api/v1/adapter/user/account-context")) return new Response(JSON.stringify({ code: "200", data: { user: { id: "u1", email: "a@corp.cn", is_biz: true }, organization: { org_id: "o9", team_id: "t7" }, plan: { name: "Team" }, quota: { total: 100, remaining: 60 } } }), { status: 200 })
    return new Response("{}", { status: 404 })
  }
  try {
    const acct = await flow.callback()
    expect(acct.identity).toBe("biz")
    expect(acct.teamId).toBe("t7")
    await pub.auth.usage(async () => ({ ...acct, type: "oauth", expires: Date.now() - 1_000 }))
    expect(bodies.length).toBe(1)
    expect(bodies[0]).toEqual({ refresh_token: "dtr", target: "biz", team_id: "t7", client_id: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb", redirect_uri: "qwenwork-cn://" })
  } finally {
    globalThis.fetch = saved
    restore()
  }
})

test("the identity is read as QwenWork's client reads it: biz only with both org and team", async () => {
  const mod = await import("./index.mjs")
  const { accountIdentity } = mod._internal
  expect(accountIdentity({ data: { user: { id: "u", is_biz: true, team_id: "t" }, orgId: "o" } })).toEqual({ identity: "biz", teamId: "t" })
  expect(accountIdentity({ data: { id: "u", isBiz: true, organization: { id: "o", teamId: "t" } } })).toEqual({ identity: "biz", teamId: "t" })
  expect(accountIdentity({ data: { user: { id: "u", is_biz: true }, organization: { org_id: "o" } } })).toEqual({})
  expect(accountIdentity({ data: { user: { id: "u", is_biz: false }, organization: { org_id: "o", team_id: "t" } } })).toEqual({})
  expect(accountIdentity({ data: { user: { id: "u" } } })).toEqual({})
  expect(accountIdentity(null)).toEqual({})
})

test("an enterprise account's refresh carries no redirect_uri, as its sign-in had none", async () => {
  const mod = await import("./index.mjs")
  const s = mod.protocol.siteOf(mod._internal.SITES["qwenwork-enterprise"], entCred())
  expect(mod._internal.deviceRefreshBody(s, "r", entCred())).toEqual({ refresh_token: "r", target: "c" })
  // and Qoder's sites ask with the token alone
  expect(mod._internal.deviceRefreshBody(mod._internal.SITES["qoder-cn"], "r", {})).toEqual({ refresh_token: "r" })
})

test("the identity 403 on the model list says to sign in again (tnt1223)", async () => {
  const mod = await import("./index.mjs")
  const restore = mock()
  // the reporter's bytes
  answer = async () => new Response(`{"code":"403","message":"User identity could not be verified"}`, { status: 403 })
  try {
    const err = await mod._internal.fetchListing(mod._internal.SITES.qwenwork, entCred()).catch((e) => e)
    expect(err.message).toBe(`QwenWork models: HTTP 403: {"code":"403","message":"User identity could not be verified"} — QwenWork didn't recognise this sign-in's identity; sign in to the account again`)
    // another 403 is told as it was
    answer = async () => new Response(`{"code":"403","message":"forbidden"}`, { status: 403 })
    const other = await mod._internal.fetchListing(mod._internal.SITES.qwenwork, entCred()).catch((e) => e)
    expect(other.message).toBe(`QwenWork models: HTTP 403: {"code":"403","message":"forbidden"}`)
  } finally {
    restore()
  }
})

// qwenwork.ai is an Ory issuer of its own with its own OAuth client:
// qwenwork-desktop-app, whose only registered redirect is the .ai gateway's
// /oauth/callback. The public cloud's qwenwork-cn:// is refused there, so
// the site must not inherit it.
test("qwenwork-intl signs in through the site's own device wrapper, with the pair it alone accepts", async () => {
  const mod = await import("./index.mjs")
  const intl = await mod.QwenWorkIntlAuthPlugin({ client, directory: process.cwd(), worktree: process.cwd(), $: undefined, project: {} })
  const flow = await intl.auth.methods[0].authorize()
  const url = new URL(flow.url)
  // the wrapper is on the gateway, and it holds the desktop app's own client
  // id with the bare deeplink scheme: any other pair is 400 not_allowed
  expect(url.origin).toBe("https://gateway.qwenwork.ai")
  expect(url.pathname).toBe("/device/selectAccounts")
  expect(url.searchParams.get("client_id")).toBe("cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a")
  expect(url.searchParams.get("redirect_uri")).toBe("qwenwork://")
  expect(url.searchParams.get("challenge_method")).toBe("S256")
  expect(url.searchParams.get("challenge")).toBeString()
  expect(url.searchParams.get("nonce")).toBeString()
  expect(url.searchParams.get("machine_id")).toBeString()
  // the public cloud's scheme is not sent anywhere: .ai has it unregistered
  expect(flow.url.includes("qwenwork-cn")).toBe(false)
  // the issuer keeps the client and redirect the wrapper mints for it
  const site = mod._internal.SITES["qwenwork-intl"]
  expect(site.clientId).toBe("qwenwork-desktop-app")
  expect(site.redirect).toBe("https://gateway.qwenwork.ai/oauth/callback")
  expect(site.deviceClientId).not.toBe(site.clientId)
  expect(site.deviceRedirect).not.toBe(site.redirect)
})

test("qwenwork-intl's calls go to its own gateway, not the CN one", async () => {
  const mod = await import("./index.mjs")
  const restore = mock()
  answer = async () => new Response(JSON.stringify({ token: "dt", refresh_token: "dtr", user_id: "u1" }), { status: 200 })
  try {
    const s = mod._internal.SITES["qwenwork-intl"]
    expect(s.openapi).toBe("https://gateway.qwenwork.ai")
    expect(s.api).toBe("https://gateway.qwenwork.ai")
    expect(s.web).toBe("https://qwenwork.ai")
    // the poll follows the site's openapi host, and no CN host is reached
    await mod.protocol.openapi(s, "/api/v1/deviceToken/poll", { query: { nonce: "n", verifier: "v", challenge_method: "S256" } })
    expect(seen.length).toBe(1)
    expect(seen[0].url.startsWith("https://gateway.qwenwork.ai/api/v1/deviceToken/poll?")).toBe(true)
    expect(seen.some((r) => r.url.includes("qwenwork.cn"))).toBe(false)
  } finally {
    restore()
  }
})

test("qwenwork-intl keeps QwenWork's own client identity, as the public cloud does", async () => {
  const mod = await import("./index.mjs")
  const intl = mod._internal.SITES["qwenwork-intl"]
  const base = mod._internal.SITES.qwenwork
  // everything the protocol needs is shared; the client, the redirect, the
  // hosts and the model catalog differ (the catalog is a test of its own)
  for (const key of ["rsaKey", "cosyVersion", "deviceOnly", "deviceRefreshTarget", "modelScene", "listAllModels", "clientType", "businessProduct", "sessionType", "usagePath", "userInfoPath"]) {
    expect(intl[key]).toEqual(base[key])
  }
  expect(intl.clientType).toBe("6")
  expect(intl.businessProduct).toBe("qoder_work")
  expect(intl.clientId).not.toBe(base.clientId)
  expect(intl.redirect).not.toBe(base.redirect)
})

// The international gateway's catalog is three tiers and nothing else: its
// /algo/api/v2/model/list fills only `qwork`, and every named id the public
// cloud has answers `unknown or disabled model` there — measured on the
// gateway with the signed-in id list. Inheriting QWENWORK_MODELS would offer
// magpie models the gateway refuses before anyone signs in.
test("qwenwork-intl lists the three tiers its gateway serves, not the public cloud's named models", async () => {
  const mod = await import("./index.mjs")
  const intl = mod._internal.SITES["qwenwork-intl"]
  const base = mod._internal.SITES.qwenwork
  expect(intl.models.map((m) => m.id)).toEqual(["qwork-auto", "qwork-advanced", "qwork-ultimate"])
  expect(intl.models.every((m) => typeof m.name === "string" && m.name.length > 0)).toBe(true)
  // none of the public cloud's ids leaks in — each one is refused there
  const named = new Set(base.models.map((m) => m.id))
  for (const m of intl.models) expect(named.has(m.id)).toBe(false)
  // the flagship's fallback list is the public cloud's, untouched
  expect(intl.fallbackModels).toBeUndefined()
  expect(mod._internal.SITES["qwenwork-enterprise"].fallbackModels.qwork.map((m) => m.key)).toEqual(base.models.map((m) => m.id))
})

// A price_factor of 0 is Qoder's "costs the plan nothing"; on this site it
// is not. All three tiers carry it, and every call still draws on the Free
// plan's credit pool (700 → 552 in one session), so magpie showed 免费 / 0×
// beside a balance that was falling. The site sets freePricing: false, which
// leaves is_free alone as the answer — and the public cloud, where 0× really
// is free, keeps it.
test("qwenwork-intl's tiers are priced, not free: a Free plan pays them from its credits", async () => {
  const mod = await import("./index.mjs")
  const intl = await mod.QwenWorkIntlAuthPlugin({ client, directory: process.cwd(), worktree: process.cwd(), $: undefined, project: {} })
  const restore = mock()
  const tiers = [
    { key: "qwork-auto", display_name: "Standard｜Qwen3.8-Flash", enable: true, price_factor: 0, is_free: null },
    { key: "qwork-advanced", display_name: "Pro", enable: true, price_factor: 0, is_free: null },
    { key: "qwork-ultimate", display_name: "Flagship", enable: true, price_factor: 0, is_free: null },
  ]
  answer = async (url) => (url.includes("/model/list")
    ? new Response(JSON.stringify({ qwork: tiers }), { status: 200 })
    : new Response("{}", { status: 404 }))
  try {
    const cred = { type: "oauth", uid: "u1", email: "a@b.c", name: "A", machineId: "m1", access: "a", refresh: "r", expires: Date.now() + 3_600_000, deviceChat: true, deviceToken: "dt", deviceRefresh: "dtr" }
    const ms = await intl.provider.models({ models: {} }, { auth: cred })
    expect(Object.fromEntries(Object.entries(ms).map(([k, m]) => [k, m.free]))).toEqual({ "qwork-auto": false, "qwork-advanced": false, "qwork-ultimate": false })
    // the site's switch is what decides, not a guess about the price
    expect(mod._internal.SITES["qwenwork-intl"].freePricing).toBe(false)
    expect(mod._internal.SITES.qwenwork.freePricing).toBeUndefined()
    // freeOf unchanged where nothing sets it: 0× is still free on Qoder's own billing
    expect(mod._internal.modelInfo({ key: "x", price_factor: 0 }).free).toBe(true)
    expect(mod._internal.modelInfo({ key: "x", price_factor: 0 }, mod._internal.SITES["qwenwork-intl"]).free).toBe(false)
    // is_free is still the answer on this site when the listing says it
    expect(mod._internal.modelInfo({ key: "x", is_free: true }, mod._internal.SITES["qwenwork-intl"]).free).toBe(true)
    // and the public cloud's same listing still reads 0× as free
    seen.length = 0
    const { pub } = await load()
    const cn = await pub.provider.models({ models: {} }, { auth: cred })
    expect(Object.values(cn).map((m) => m.free)).toEqual([true, true, true])
  } finally {
    restore()
  }
})

// The gateway carries the sign-in and its routes — start, poll, refresh,
// account-context — but answers 404 to the wallets route, which only
// openapi.qoder.sh serves. A wallets read sent to the gateway comes back
// empty and leaves a personal balance without its pools, so the site names
// walletsHost; the refresh must stay on the gateway (where a bad token is a
// 401, not a 404).
test("qwenwork-intl keeps the gateway's routes, and reads wallets where they are served", async () => {
  const mod = await import("./index.mjs")
  const intl = mod._internal.SITES["qwenwork-intl"]
  expect(intl.deviceWeb).toBe("https://gateway.qwenwork.ai")
  expect(intl.openapi).toBe("https://gateway.qwenwork.ai")
  expect(intl.api).toBe("https://gateway.qwenwork.ai")
  // the refresh has no override: it is on the gateway
  expect(intl.refreshHost).toBeUndefined()
  expect(intl.walletsHost).toBe("https://openapi.qoder.sh")
})

test("qwenwork-intl's refresh goes to its own gateway, where the route is served", async () => {
  const mod = await import("./index.mjs")
  const restore = mock()
  answer = async () => new Response(JSON.stringify({ device_token: "dt2", refresh_token: "dtr2", expires_at: Date.now() + 7_200_000 }), { status: 200 })
  try {
    await mod._internal.refreshDevice(mod._internal.SITES["qwenwork-intl"], "dtr", false, {})
    expect(seen.length).toBe(1)
    expect(seen[0].url.startsWith("https://gateway.qwenwork.ai/api/v1/deviceToken/refresh")).toBe(true)
    // the public cloud keeps its own, unchanged
    seen.length = 0
    await mod._internal.refreshDevice(mod._internal.SITES.qwenwork, "dtr", false, {})
    expect(seen[0].url.startsWith("https://gateway.qwenwork.cn/api/v1/deviceToken/refresh")).toBe(true)
  } finally {
    restore()
  }
})

test("qwenwork-intl renews its device token with the wrapper's pair, not the issuer's", async () => {
  const mod = await import("./index.mjs")
  const intl = mod._internal.SITES["qwenwork-intl"]
  // the wrapper minted the token, so the wrapper's client and scheme are the
  // pair that renews it; the issuer's qwenwork-desktop-app and gateway
  // callback never go on a refresh
  expect(mod._internal.deviceRefreshBody(intl, "r", {})).toEqual({
    refresh_token: "r",
    target: "c",
    client_id: "cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a",
    redirect_uri: "qwenwork://",
  })
  // a biz account keeps its own target and team, and still the wrapper's pair
  expect(mod._internal.deviceRefreshBody(intl, "r", { identity: "biz", teamId: "t7" })).toEqual({
    refresh_token: "r",
    target: "biz",
    team_id: "t7",
    client_id: "cc65e5fc-05bd-4f5d-a4e8-0df19aa3d75a",
    redirect_uri: "qwenwork://",
  })
  // the public cloud's two identities are one and the same, so its body is
  // unchanged; a site without a wrapper of its own falls back to its own pair
  expect(mod._internal.deviceRefreshBody(mod._internal.SITES.qwenwork, "r", {})).toEqual({
    refresh_token: "r",
    target: "c",
    client_id: "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb",
    redirect_uri: "qwenwork-cn://",
  })
  // the enterprise flagship's account signed in with no redirect_uri at all,
  // so its renewal carries none either
  const ent = mod.protocol.siteOf(mod._internal.SITES["qwenwork-enterprise"], entCred())
  expect(mod._internal.deviceRefreshBody(ent, "r", {})).toEqual({ refresh_token: "r", target: "c" })
})

// The gateway's own field check settles the pair, with a dummy token: only
// the wrapper's pair is forwarded to the issuer (401 carrying Ory's
// invalid_grant upstream); the issuer's pair and every mixed pair are
// refused before they leave (400 INVALID_REFRESH_REQUEST, no upstream).
test("qwenwork-intl's refresh carries the wrapper's pair, the only one the gateway forwards", async () => {
  const mod = await import("./index.mjs")
  const intl = mod._internal.SITES["qwenwork-intl"]
  const body = mod._internal.deviceRefreshBody(intl, "r", {})
  expect(body.client_id).toBe(intl.deviceClientId)
  expect(body.redirect_uri).toBe(intl.deviceRedirect)
  // the issuer's pair is a different one on this site, and never travels here
  expect(body.client_id).not.toBe(intl.clientId)
  expect(body.redirect_uri).not.toBe(intl.redirect)
  // no cookie, no machine identity, nothing else the wrapper would refuse
  expect(Object.keys(body).sort()).toEqual(["client_id", "redirect_uri", "refresh_token", "target"])
})
