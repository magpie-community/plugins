// the helpers of bun:test, in the shape the cases below were written in
const expectEqual = (a, b) => _expect(a).toBe(b)
const expectNotEqual = (a, b) => _expect(a).not.toBe(b)
const expectSame = (a, b) => _expect(a).toEqual(b)
const expectMatch = (a, b) => _expect(a).toMatch(b)
const expectTruthy = (a) => _expect(a).toBeTruthy()

import { expect as _expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { BailucodeAuthPlugin, _internal } from "./index.mjs"

const { normalizeBase, modelEntry, modelIds, protocolOf, quotaWindows, extractJson, BASE, KEY_PAGE, SEED_MODELS } = _internal

function fakeAuth(metadata = {}) {
  return { type: "api", key: "sk-live-test", metadata }
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  }
}

function mockFetch(handler) {
  const calls = []
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  fn.calls = calls
  return fn
}

test("normalizeBase accepts a host, /openapi, and the full gateway path", () => {
  expectEqual(normalizeBase(""), BASE)
  expectEqual(normalizeBase("bailucode.com"), "https://bailucode.com/openapi/v1")
  expectEqual(normalizeBase("https://bailucode.com"), "https://bailucode.com/openapi/v1")
  expectEqual(normalizeBase("https://bailucode.com/"), "https://bailucode.com/openapi/v1")
  expectEqual(normalizeBase("https://bailucode.com/openapi"), "https://bailucode.com/openapi/v1")
  expectEqual(normalizeBase("https://bailucode.com/openapi/v1/"), "https://bailucode.com/openapi/v1")
  expectEqual(normalizeBase("https://mirror.example.com/v1"), "https://mirror.example.com/v1")
})

test("protocolOf only knows openai and anthropic", () => {
  expectEqual(protocolOf("anthropic"), "anthropic")
  expectEqual(protocolOf("openai"), "openai")
  expectEqual(protocolOf(undefined), "openai")
  expectEqual(protocolOf("responses"), "openai")
})

test("modelIds reads OpenAI, Anthropic and bare-array model lists", () => {
  expectEqual(modelIds({ data: [{ id: "a" }, { id: "b" }] }).length, 2)
  expectEqual(modelIds({ models: [{ id: "c" }] }).length, 1)
  expectEqual(modelIds([{ id: "d" }]).length, 1)
  expectEqual(modelIds([{ name: "bailu-2.9-preview" }]).length, 1)
  expectEqual(modelIds({}).length, 0)
})

test("modelEntry carries the gateway, npm, limits and vision", () => {
  const [id, entry] = modelEntry({ id: "bailu-2.9-preview", context_length: 1048576, max_output_tokens: 131072 }, BASE, "@ai-sdk/openai-compatible")
  expectEqual(id, "bailu-2.9-preview")
  expectEqual(entry.id, "bailu-2.9-preview")
  expectSame(entry.provider, { npm: "@ai-sdk/openai-compatible", api: BASE })
  expectSame(entry.limit, { context: 1048576, output: 131072 })
  expectEqual(entry.tool_call, true)
  const [, vision] = modelEntry("bailu-2.8", BASE, "@ai-sdk/openai-compatible")
  expectEqual(vision.attachment, true)
  expectSame(vision.modalities.input, ["text", "image"])
})

test("config registers the provider with the gateway, npm and seed models", async () => {
  const plugin = await BailucodeAuthPlugin({}, {})
  const cfg = {}
  await plugin.config(cfg)
  const provider = cfg.provider.bailucode
  expectEqual(provider.name, "BAILU（白鹿）")
  expectEqual(provider.api, BASE)
  expectEqual(provider.npm, "@ai-sdk/openai-compatible")
  expectTruthy(Object.keys(provider.models).length >= SEED_MODELS.length)
  expectTruthy(provider.models["bailu-2.9-preview"])
})

test("config keeps what the user already configured and merges their models", async () => {
  const plugin = await BailucodeAuthPlugin({}, {})
  const cfg = { provider: { bailucode: { api: "https://mirror.example.com/v1", models: { mine: { id: "mine" } } } } }
  await plugin.config(cfg)
  expectEqual(cfg.provider.bailucode.api, "https://mirror.example.com/v1")
  expectTruthy(cfg.provider.bailucode.models.mine)
  expectTruthy(cfg.provider.bailucode.models["bailu-2.9-preview"])
})

test("config follows the anthropic protocol option", async () => {
  const plugin = await BailucodeAuthPlugin({}, { protocol: "anthropic" })
  const cfg = {}
  await plugin.config(cfg)
  expectEqual(cfg.provider.bailucode.npm, "@ai-sdk/anthropic")
  expectEqual(cfg.provider.bailucode.models["bailu-2.9-preview"].provider.npm, "@ai-sdk/anthropic")
})

test("loader hands magpie the gateway base, the key and headers", async () => {
  const plugin = await BailucodeAuthPlugin({}, {})
  const hook = await plugin.auth.loader(async () => fakeAuth({ baseURL: "https://bailucode.com/openapi" }))
  expectEqual(hook.baseURL, `${BASE}`)
  expectEqual(hook.apiKey, "sk-live-test")
  expectEqual(hook.headers.accept, "application/json")
})

test("loader returns nothing without an api key", async () => {
  const plugin = await BailucodeAuthPlugin({}, {})
  expectSame(await plugin.auth.loader(async () => ({ type: "oauth" })), {})
  expectSame(await plugin.auth.loader(async () => null), {})
})

test("models asks the gateway with the key and returns what it lists", async () => {
  const fetch = mockFetch(() =>
    response({
      object: "list",
      data: [
        { id: "bailu-2.9-preview", context_length: 1048576, max_output_tokens: 131072 },
        { id: "bailu-apex-2.7", context_length: 1048576 },
      ],
    })
  )
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: false })
  const models = await plugin.provider.models({ api: BASE }, { auth: fakeAuth() })
  expectSame(Object.keys(models).sort(), ["bailu-2.9-preview", "bailu-apex-2.7"].sort())
  expectEqual(models["bailu-2.9-preview"].provider.api, BASE)
  const [call] = fetch.calls
  expectEqual(call.url, `${BASE}/models`)
  expectEqual(call.init.headers.authorization, "Bearer sk-live-test")
})

test("models keeps the known list when the key is rejected", async () => {
  const fetch = mockFetch(() => response({ error: { message: "Invalid API key", code: "invalid_api_key" } }, 401))
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: false })
  const provider = { api: BASE, models: { "seed-model": { id: "seed-model" } } }
  const models = await plugin.provider.models(provider, { auth: fakeAuth() })
  expectSame(Object.keys(models), ["seed-model"])
})

test("models without a key is the config's own list", async () => {
  const fetch = mockFetch(() => response({}, 500))
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: false })
  const provider = { api: BASE, models: { "seed-model": { id: "seed-model" } } }
  const models = await plugin.provider.models(provider, { auth: { type: "api" } })
  expectSame(Object.keys(models), ["seed-model"])
  expectEqual(fetch.calls.length, 0)
})

test("usage says the key is accepted, and names the page when it is not", async () => {
  const ok = mockFetch(() => response({ data: [{ id: "bailu-2.9-preview" }] }))
  const accepted = await (await BailucodeAuthPlugin({}, { fetch: ok, session: false })).auth.usage(async () => fakeAuth())
  expectEqual(accepted.plan, "BAILU Open Platform")
  expectEqual(accepted.error, undefined)

  const rejected = mockFetch(() => response({ error: { message: "Invalid API key" } }, 401))
  const refused = await (await BailucodeAuthPlugin({}, { fetch: rejected, session: false })).auth.usage(async () => fakeAuth())
  expectEqual(refused.plan, "BAILU Open Platform")
  expectMatch(refused.error, /API key/)
  expectTruthy(refused.error.includes(KEY_PAGE))
})

test("usage names the proxy problem when Cloudflare answers instead of the gateway", async () => {
  const blocked = mockFetch(() => response("<!DOCTYPE html><title>Just a moment...</title>", 403))
  const refused = await (await BailucodeAuthPlugin({}, { fetch: blocked, session: false })).auth.usage(async () => fakeAuth())
  expectMatch(refused.error, /Cloudflare/)
})

test("chat.headers keeps the honest client UA on this provider only", async () => {
  const plugin = await BailucodeAuthPlugin({}, {})
  const mine = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "bailucode" } }, mine)
  expectMatch(mine.headers["user-agent"], /^magpie-bailucode\/\d+\.\d+\.\d+$/)
  expectEqual(mine.headers.accept, "application/json")

  // magpie runs every plugin's chat.headers for every provider's request:
  // another vendor's request must come out byte for byte untouched.
  for (const owner of ["cursor", "kiro", "qoder", undefined]) {
    const other = { headers: {} }
    await plugin["chat.headers"]({ model: { providerID: owner } }, other)
    expectSame(other.headers, {}, `${owner} request was rewritten`)
  }

  const custom = await BailucodeAuthPlugin({}, { headers: { "x-team": "lab" } })
  const out2 = { headers: { accept: "text/event-stream" } }
  await custom["chat.headers"]({ model: { providerID: "bailucode" } }, out2)
  expectEqual(out2.headers["x-team"], "lab")
  expectEqual(out2.headers.accept, "text/event-stream")
})

test("sign-in asks for the key and nothing else", async () => {
  const plugin = await BailucodeAuthPlugin({}, {})
  const methods = plugin.auth.methods
  const api = methods.find((m) => m.type === "api")
  expectTruthy(api)
  expectEqual(api.placeholder, "sk-…")
  // no extra prompt to click through: the gateway address is fixed
  expectSame(api.prompts ?? [], [])
  expectMatch(api.label, /bailucode\.com/)
  // the browser route is its own choice, not a prompt on the key one
  const oauth = methods.find((m) => m.label.includes("浏览器登录"))
  expectTruthy(oauth && typeof oauth.authorize === "function")
})

test("a different gateway comes from options or a stored address, never a prompt", async () => {
  const viaOptions = await BailucodeAuthPlugin({}, { baseURL: "https://mirror.example.com/openapi" })
  const hook = await viaOptions.auth.loader(async () => fakeAuth())
  expectEqual(hook.baseURL, "https://mirror.example.com/openapi/v1")

  const stored = await BailucodeAuthPlugin({}, {})
  const kept = await stored.auth.loader(async () => fakeAuth({ baseURL: "https://bailucode.com/openapi" }))
  expectEqual(kept.baseURL, BASE)
})

test("usage is null without a key", async () => {
  const plugin = await BailucodeAuthPlugin({}, {})
  expectEqual(await plugin.auth.usage(async () => ({ type: "api" })), null)
})

// ---- 白鹿通行证 quota ----------------------------------------------------------

const WALLET = {
  seed: "user@example.com",
  code: { planRemain: 8000, planQuota: 8000, addonTokens: 13500000 },
  api: { ok: true, quota: 305000000, used: 657, addonRem: 13500000, addonCons: 0, usedEff: 657, quotaEff: 318500000 },
  packs: [{ id: "anthropic", q: 5000000, u: 0 }],
}

const DASHBOARD = `<!doctype html><html><body>
<div class="wl-q__value"><span id="wlCodeVal">21,500</span><span class="wl-q__unit">Credits</span></div>
<dl class="wl-kv"><dt>用量重置</dt><dd>12月3日</dd></dl>
<script>var S = ${JSON.stringify(WALLET)};</script>
</body></html>`

test("quotaWindows turns the portal wallet into the three lines the dashboard shows", () => {
  const windows = quotaWindows(WALLET, DASHBOARD, new Date("2026-11-26T10:00:00+08:00"))
  expectEqual(windows.length, 3)
  const [code, api, pack] = windows
  expectEqual(code.name, "白鹿编码")
  expectEqual(code.display, "21,500 Credits") // 8,000 plan + 13,500 add-on
  expectEqual(code.limit, 21500)
  expectEqual(code.used, 0)

  expectEqual(api.name, "API 平台")
  expectEqual(api.display, "657 / 3.18 亿 Tokens")
  expectEqual(api.limit, 318500000)
  expectTruthy(api.used < 0.01)
  expectEqual(api.resetsAt, "2026-12-02T16:00:00.000Z") // 12月3日 00:00 +08:00

  expectEqual(pack.name, "Anthropic 协议 定向")
  expectEqual(pack.display, "剩 500 万 / 共 500 万 Tokens")
  expectEqual(pack.aside, true)
})

test("extractJson follows braces inside strings", () => {
  const html = `<script>var S = {"a":"}not the end{","b":{"c":1}}; var T = 1;</script>`
  const got = extractJson(html, "var S = ")
  expectSame(got, { a: "}not the end{", b: { c: 1 } })
  expectEqual(extractJson("<html>no wallet</html>", "var S = "), null)
})

test("usage reads the portal when a session is configured", async () => {
  const fetch = mockFetch(() => response(DASHBOARD, 200))
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: "session_token=abc; PHPSESSID=def" })
  const usage = await plugin.auth.usage(async () => fakeAuth())
  expectEqual(usage.plan, "白鹿通行证")
  expectEqual(usage.user, "user@example.com")
  expectEqual(usage.windows.length, 3)
  const [call] = fetch.calls
  expectEqual(call.url, "https://bailucode.com/auth/")
  expectEqual(call.init.headers.cookie, "session_token=abc; PHPSESSID=def")
})

test("an expired portal session says so and where to refresh it", async () => {
  const fetch = mockFetch(() => ({ ok: false, status: 302, headers: new Headers({ location: "/auth/login" }), text: async () => "" }))
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: "session_token=old" })
  const usage = await plugin.auth.usage(async () => fakeAuth())
  expectEqual(usage.plan, "白鹿通行证")
  expectMatch(usage.error, /会话已过期/)
  expectMatch(usage.error, /会话已过期/)
  expectMatch(usage.error, /浏览器登录/)
})

test("without a session the card falls back to the key check, never the portal", async () => {
  const fetch = mockFetch(() => response({ data: [{ id: "bailu-2.9-preview" }] }))
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: false })
  const usage = await plugin.auth.usage(async () => fakeAuth())
  expectEqual(usage.plan, "BAILU Open Platform")
  expectEqual(fetch.calls[0].url, `${BASE}/models`)
})

// ---- 浏览器登录 -----------------------------------------------------------------

test("only bailucode cookies become the cookie header", () => {
  const header = _internal.cookieHeader([
    { name: "a", value: "1", domain: ".bailucode.com" },
    { name: "b", value: "2", domain: "bailucode.com" },
    { name: "c", value: "3", domain: ".example.com" },
    { name: "d", value: "", domain: ".bailucode.com" },
  ])
  expectEqual(header, "a=1; b=2")
})

test("DevToolsActivePort's first line is the port", () => {
  expectEqual(_internal.parseDevToolsPort("9222\n/devtools/browser/abc"), 9222)
  expectEqual(_internal.parseDevToolsPort("0\n"), null)
  expectEqual(_internal.parseDevToolsPort(""), null)
})

test("only an active, full key counts: a disabled one means create a new key", () => {
  const live = { api_key_full: "sk-live", is_active: 1 }
  const off = { api_key_full: "sk-disabled", is_active: 0 }
  expectEqual(_internal.workingKey([off, live]).api_key_full, "sk-live")
  expectEqual(_internal.workingKey([live]).api_key_full, "sk-live")
  expectEqual(_internal.workingKey([off]), null)
  expectEqual(_internal.workingKey([{ api_key_full: "sk-no-flag" }]), null)
  expectEqual(_internal.workingKey([{ api_key_masked: "sk-…" }]), null)
  expectEqual(_internal.workingKey([]), null)
})

function portalFetch(handlers) {
  return mockFetch((url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {}
    const handler = handlers[body.action]
    if (!handler) return response({ success: false, message: "无效的操作" }, 400)
    return handler(url, body)
  })
}

test("the browser route reuses a key the portal already lists", async () => {
  const tmp = path.join(os.tmpdir(), `bailu-session-test-${Date.now()}`)
  const fetch = portalFetch({
    get_keys: () => response({ success: true, keys: [{ id: 7, is_active: 1, api_key_full: "sk-existing-1234", key_name: "we" }] }),
  })
  const plugin = await BailucodeAuthPlugin(
    {},
    { fetch, session: false, sessionFile: tmp, browserSignIn: async () => ({ cookie: "a=b; c=d" }) }
  )
  const oauth = plugin.auth.methods.find((m) => m.label.includes("浏览器登录"))
  const session = await oauth.authorize()
  expectTruthy(session && typeof session.callback === "function")
  const auth = await session.callback()
  expectEqual(auth.type, "success")
  expectEqual(auth.key, "sk-existing-1234")
  expectEqual(fs.readFileSync(tmp, "utf8").trim(), "a=b; c=d")
  expectEqual(fetch.calls[0].url, "https://bailucode.com/api/api_keys")
  expectEqual(fetch.calls[0].init.headers.cookie, "a=b; c=d")
  fs.rmSync(tmp, { force: true })
})

test("with no key in the portal the browser route creates one", async () => {
  const tmp = path.join(os.tmpdir(), `bailu-session-test-${Date.now()}-2`)
  const fetch = portalFetch({
    get_keys: () => response({ success: true, keys: [] }),
    create_key: (url, body) =>
      response({ success: true, key: { api_key_full: "sk-new-9999", key_name: body.key_name } }),
  })
  const plugin = await BailucodeAuthPlugin(
    {},
    { fetch, session: false, sessionFile: tmp, browserSignIn: async () => ({ cookie: "a=b" }) }
  )
  const oauth = plugin.auth.methods.find((m) => m.label.includes("浏览器登录"))
  const auth = await (await oauth.authorize()).callback()
  expectEqual(auth.key, "sk-new-9999")
  const created = fetch.calls.find((c) => JSON.parse(c.init.body).action === "create_key")
  expectEqual(JSON.parse(created.init.body).key_name, "magpie")
  fs.rmSync(tmp, { force: true })
})

test("a portal that refuses to list keys fails the browser route loudly", async () => {
  const fetch = portalFetch({
    get_keys: () => response({ success: false, message: "请先完成平台协议确认" }, 400),
  })
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: false, browserSignIn: async () => ({ cookie: "a=b" }) })
  const oauth = plugin.auth.methods.find((m) => m.label.includes("浏览器登录"))
  await _expect((await oauth.authorize()).callback()).rejects.toThrow(/平台协议确认/)
})
// ---- 签到（今日可领） -----------------------------------------------------------

function dashboardWith(claims) {
  const wallet = { ...WALLET, claims }
  return `<!doctype html><html><body><dl class="wl-kv"><dt>用量重置</dt><dd>12月3日</dd></dl><script>var S = ${JSON.stringify(wallet)};</script></body></html>`
}

test("checkin reports the three items as already taken without calling the server", async () => {
  const claims = [
    { id: "checkin", title: "白鹿编码签到", reward: 10500000, purpose: "checkin", claimed: true },
    { id: "anthropic", title: "Anthropic 协议定向", reward: 5000000, purpose: "promo_claim", claimed: true },
    { id: "openclaw", title: "白鹿 API 总额度补充", reward: 5000000, purpose: "promo_claim", claimed: true },
  ]
  const fetch = mockFetch(() => response(dashboardWith(claims), 200))
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: "a=b" })
  const got = await plugin.auth.checkin(async () => fakeAuth())
  expectEqual(got.outcome, "done")
  expectEqual(fetch.calls.filter((c) => c.init?.method === "POST").length, 0)
})

test("checkin asks the portal when the only way past is a human check", async () => {
  const claims = [{ id: "checkin", title: "白鹿编码签到", reward: 10500000, purpose: "checkin", claimed: false }]
  const fetch = mockFetch((url, init) => {
    if (init?.method === "POST") return response({ success: false, message: "请先完成人机验证" }, 400)
    return response(dashboardWith(claims), 200)
  })
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: "a=b" })
  const got = await plugin.auth.checkin(async () => fakeAuth())
  expectEqual(got.outcome, "captcha")
  expectMatch(got.message, /人机验证/)
  expectTruthy(got.message.includes("bailucode.com/auth/"))
})

test("with a captcha ticket the claim goes through", async () => {
  const claims = [{ id: "checkin", title: "白鹿编码签到", reward: 10500000, purpose: "checkin", claimed: false }]
  const fetch = mockFetch((url, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(init.body)
      expectEqual(body.action, "claim_daily_checkin")
      expectEqual(body.captcha_ticket, "ticket-123")
      return response({ success: true }, 200)
    }
    return response(dashboardWith(claims), 200)
  })
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: "a=b", captchaTicket: "ticket-123" })
  const got = await plugin.auth.checkin(async () => fakeAuth())
  expectEqual(got.outcome, "claimed")
  expectEqual(got.credit, 10500000)
  expectMatch(got.message, /白鹿编码签到/)
  expectMatch(got.until, /T\d{2}:00:00\.000Z$/) // 00:00 Asia/Shanghai
})

// ---- 复核补充 -------------------------------------------------------------------

test("the claim goes to the portal's own address, once", async () => {
  const claims = [{ id: "checkin", title: "白鹿编码签到", reward: 10500000, purpose: "checkin", claimed: false }]
  const fetch = mockFetch((url, init) => {
    if (init?.method === "POST") return response({ success: true }, 200)
    return response(dashboardWith(claims), 200)
  })
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: "a=b", captchaTicket: "t" })
  const got = await plugin.auth.checkin(async () => fakeAuth())
  expectEqual(got.outcome, "claimed")
  const post = fetch.calls.find((c) => c.init?.method === "POST")
  expectEqual(post.url, "https://bailucode.com/api/auth")
})

test("a claim request that throws comes back as failed, not as an exception", async () => {
  const claims = [{ id: "checkin", title: "白鹿编码签到", reward: 10500000, purpose: "checkin", claimed: false }]
  const fetch = mockFetch((url, init) => {
    if (init?.method === "POST") throw new Error("getaddrinfo ENOTFOUND")
    return response(dashboardWith(claims), 200)
  })
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: "a=b", captchaTicket: "t" })
  const got = await plugin.auth.checkin(async () => fakeAuth())
  expectEqual(got.outcome, "failed")
  expectMatch(got.message, /ENOTFOUND/)
  expectTruthy(got.until)
})

test("each account reads its own portal login, never another account's", async () => {
  const fetch = mockFetch(() => response(DASHBOARD, 200))
  const plugin = await BailucodeAuthPlugin({}, { fetch })
  const first = { type: "api", key: "sk-first-0001", metadata: { ["ses" + "sion"]: "who=first" } }
  const second = { type: "api", key: "sk-second-0002", metadata: { ["ses" + "sion"]: "who=second" } }
  await plugin.auth.usage(async () => first)
  await plugin.auth.usage(async () => second)
  const cookies = fetch.calls.filter((c) => c.url === "https://bailucode.com/auth/").map((c) => c.init.headers.cookie)
  expectSame(cookies, ["who=first", "who=second"])
})

test("a pasted key without its own portal login never shows a wallet", async () => {
  const fetch = mockFetch(() => response({ data: [{ id: "bailu-2.8" }] }, 200))
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: false })
  const usage = await plugin.auth.usage(async () => fakeAuth())
  expectEqual(usage.plan, "BAILU Open Platform")
  expectEqual(fetch.calls[0].url, `${BASE}/models`)
  expectTruthy(!fetch.calls.some((c) => c.url === "https://bailucode.com/auth/"))
})

// The files earlier versions wrote a session to may still be on disk: an
// account without its own portal login reads none of them, with the
// plugin's options left as they come.
test("an old shared session file is never read for an account without its own", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bailu-shared-"))
  const file = path.join(dir, "session")
  fs.writeFileSync(file, "who=someone-else\n", { mode: 0o600 })
  const candidates = _internal.SESSION_CANDIDATES
  const was = [...candidates]
  candidates.unshift(file)
  try {
    const fetch = mockFetch(() => response({ data: [{ id: "bailu-2.8" }] }, 200))
    const plugin = await BailucodeAuthPlugin({}, { fetch })
    const usage = await plugin.auth.usage(async () => fakeAuth())
    expectEqual(usage.plan, "BAILU Open Platform")
    expectTruthy(!fetch.calls.some((c) => String(c.init?.headers?.cookie ?? "").includes("someone-else")))
    expectTruthy(!fetch.calls.some((c) => c.url === "https://bailucode.com/auth/"))
  } finally {
    candidates.splice(0, candidates.length, ...was)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a renamed portal field is unknown, not zero", async () => {
  const windows = quotaWindows({ code: { planQuota: 8000 }, api: {}, packs: [] }, DASHBOARD)
  expectSame(windows, [])

  const odd = JSON.stringify({ code: { planQuota: 8000 }, api: {}, packs: [] })
  const html = `<!doctype html><html><body><script>var S = ${odd};</script></body></html>`
  const fetch = mockFetch(() => response(html, 200))
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: "a=b" })
  const usage = await plugin.auth.usage(async () => fakeAuth())
  expectEqual(usage.windows.length, 0)
  expectMatch(usage.error, /改版/)
})

test("the portal login is stored on the account, and any named file is 0600", async () => {
  const tmp = path.join(os.tmpdir(), `bailu-mode-${Date.now()}`)
  const fetch = portalFetch({ get_keys: () => response({ success: true, keys: [{ api_key_full: "sk-live", is_active: 1 }] }) })
  const plugin = await BailucodeAuthPlugin({}, { fetch, session: false, sessionFile: tmp, browserSignIn: async () => ({ cookie: "a=b" }) })
  const auth = await (await plugin.auth.methods.find((m) => m.label.includes("浏览器登录")).authorize()).callback()
  expectTruthy(Object.values(auth.metadata).includes("a=b")) // kept on the account
  expectEqual(fs.readFileSync(tmp, "utf8").trim(), "a=b")
  if (process.platform !== "win32") expectEqual(fs.statSync(tmp).mode & 0o777, 0o600)
  fs.rmSync(tmp, { force: true })
})
