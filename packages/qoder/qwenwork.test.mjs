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
