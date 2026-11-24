// TokenRhythm plugin tests: protocol normalization, managed-key reuse/rotation,
// wallet card mapping, model catalog merge, BYOK authorize, and the OAuth
// loopback callback end-to-end against an injected fetch.
import test from "node:test"
import assert from "node:assert/strict"
import {
  CLIENT_ID,
  SCOPES,
  ensureModelKey,
  getWallet,
  normalizeTokens,
  pkce,
  refreshTokens,
  walletCard,
} from "../lib/tokenrhythm.mjs"
import { mergeRows, normalizeLive, normalizePublic, publicRowsOf } from "../lib/models.mjs"
import { TokenRhythmAuthPlugin, _internal } from "../index.mjs"

const { adaptSystemOneBody, authedFetch, DECIDE_MODEL, localIcon, NAME } = _internal

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
})

const tokenBody = (over = {}) => ({
  access_token: "oauth-access",
  refresh_token: "oauth-refresh",
  expires_in: 3600,
  account_id: "acct-1",
  session_id: "sess-1",
  scope: SCOPES,
  client_id: CLIENT_ID,
  ...over,
})

test("normalizeTokens requires the full scope set and identity", () => {
  const t = normalizeTokens(tokenBody(), { now: 1_000 })
  assert.equal(t.accessToken, "oauth-access")
  assert.equal(t.expiresAt, 1_000 + 3_600_000)
  assert.throws(() => normalizeTokens(tokenBody({ scope: "profile.read" }), { now: 1_000 }), /OAUTH_SCOPE_MISSING/)
  assert.throws(() => normalizeTokens(tokenBody({ account_id: "" }), { now: 1_000 }), /OAUTH_BAD_TOKEN_RESPONSE/)
})

test("refreshTokens keeps account and session identity", async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") })
    return jsonRes(200, tokenBody({ access_token: "oauth-access-2", refresh_token: "oauth-refresh-2" }))
  }
  const t = await refreshTokens({
    origin: "http://127.0.0.1:9",
    refreshToken: "oauth-refresh",
    accountId: "acct-1",
    sessionId: "sess-1",
    fetchImpl,
  })
  assert.equal(t.accessToken, "oauth-access-2")
  assert.equal(t.refreshToken, "oauth-refresh-2")
  assert.match(calls[0].body, /grant_type=refresh_token/)
  await assert.rejects(
    refreshTokens({ origin: "http://127.0.0.1:9", refreshToken: "x", accountId: "other", sessionId: "sess-1", fetchImpl }),
    /ACCOUNT_IDENTITY_MISMATCH/,
  )
})

test("ensureModelKey reuses an active key and rotates when metadata moves", async () => {
  const posts = []
  const fetchImpl = async (url, init) => {
    const u = String(url)
    if (u.endsWith("/managed-key") && (!init || init.method === "GET" || init.method === undefined)) {
      return jsonRes(200, { code: 0, data: { key_id: "key-1", generation: 2, status: "active", account_id: "acct-1" } })
    }
    if (u.endsWith("/managed-key/credential")) {
      posts.push(u)
      return jsonRes(200, { code: 0, data: { secret: "sk-managed", key_id: "key-1", generation: 2, status: "active", account_id: "acct-1" } })
    }
    throw new Error("unexpected " + u)
  }
  const key = await ensureModelKey({
    origin: "http://127.0.0.1:9",
    accessToken: "oauth-access",
    current: { secret: "sk-managed", keyId: "key-1", generation: 2 },
    fetchImpl,
  })
  assert.equal(key.secret, "sk-managed")
  assert.equal(key.rotated, false)
  assert.equal(posts.length, 0)

  const rotated = await ensureModelKey({
    origin: "http://127.0.0.1:9",
    accessToken: "oauth-access",
    current: { secret: "sk-old", keyId: "key-0", generation: 1 },
    fetchImpl,
  })
  assert.equal(rotated.secret, "sk-managed")
  assert.equal(rotated.rotated, true)
  assert.equal(posts.length, 1)
})

test("walletCard keeps decimal balances as display strings", () => {
  const card = walletCard({
    wallet: { currency: "CNY", as_of: "2026-01-01T00:00:00Z", balances: { available: "12.340000", recharge: "10", bonus: "0.5", debt: "1.25", frozen: "0" } },
    account: { display_name: "Test User" },
  })
  assert.equal(card.plan, "Pay as you go")
  assert.equal(card.user, "Test User")
  assert.equal(card.balance, "12.34 CNY")
  assert.equal(card.windows[0].name, "Available")
  assert.equal(card.windows[0].display, "12.34 CNY")
  assert.equal(card.signIn, "kept")
  const flat = walletCard({ wallet: { available_balance: "1", currency: "CNY" } })
  assert.equal(flat.balance, "1.00 CNY")
})

test("walletCard renders balances with two decimal places", () => {
  const card = walletCard({ wallet: { currency: "CNY", balances: { available: "186.171994", recharge: "0", bonus: "0", debt: "0", frozen: "0" } } })
  assert.equal(card.balance, "186.17 CNY")
  assert.equal(card.windows[0].display, "186.17 CNY")
})

test("model catalog merges public metadata with the live credential list", () => {
  const publicPayload = {
    code: 0,
    data: [
      { id: "glm-5.1", name: "GLM-5.1", type: "chat", status: "online", contextWindow: 200000, maxOutputTokens: 128000, capabilities: { openai: true, tools: true, reasoning: true, vision: false }, modalities: ["text"], effectiveAvailable: true },
      { id: "kimi-k2.6", name: "Kimi K2.6", type: "chat", status: "online", contextWindow: 256000, maxOutputTokens: 128000, capabilities: { openai: true, tools: true, reasoning: true, vision: true }, modalities: ["text", "image"], effectiveAvailable: true },
      { id: "video-1", name: "Video", type: "video", status: "online", modalities: ["text", "video"], effectiveAvailable: true },
    ],
  }
  const meta = publicRowsOf(publicPayload)
  assert.equal(meta.length, 3)
  const live = [{ id: "glm-5.1", context: 200000, output: 128000 }, { id: "unknown-live", context: 64000, output: 8000 }]
  const rows = mergeRows(meta, live.map(normalizeLive).filter(Boolean), { requireLive: true })
  const ids = rows.map((r) => r.id).sort()
  assert.deepEqual(ids, ["glm-5.1", "unknown-live"])
  const glm = rows.find((r) => r.id === "glm-5.1")
  assert.equal(glm.model.capabilities.toolcall, true)
  assert.equal(glm.model.modalities.input.join(","), "text")
  const unknown = rows.find((r) => r.id === "unknown-live")
  assert.equal(unknown.model.limit.context, 64000)
})

async function fakeTokenRhythmFetch(state) {
  return async (url, init) => {
    const u = String(url)
    state.calls.push({ url: u, method: init?.method ?? "GET", body: String(init?.body ?? "") })
    if (u.endsWith("/api/oauth/token")) {
      const body = String(init?.body ?? "")
      if (body.includes("grant_type=authorization_code")) return jsonRes(200, tokenBody())
      if (body.includes("grant_type=refresh_token")) return jsonRes(200, tokenBody({ access_token: "oauth-access-2", refresh_token: "oauth-refresh-2" }))
      return jsonRes(400, { error: "unsupported_grant_type" })
    }
    if (u.endsWith("/api/v1/integrations/opensquilla/account")) {
      return jsonRes(200, { code: 0, data: { account_id: "acct-1", display_name: "Test User", masked_phone: "138****0000" } })
    }
    if (u.endsWith("/api/v1/integrations/opensquilla/wallet")) {
      return jsonRes(200, { code: 0, data: { currency: "CNY", as_of: "2026-01-01T00:00:00Z", balances: { available: "88.8", recharge: "80", bonus: "8.8", debt: "0", frozen: "0" } } })
    }
    if (u.endsWith("/api/v1/integrations/opensquilla/managed-key") && (init?.method ?? "GET") === "GET") {
      if (state.managedKey === null) return jsonRes(200, { code: 7, error: "MANAGED_KEY_NOT_FOUND", data: null })
      return jsonRes(200, { code: 0, data: { key_id: "key-1", generation: 1, status: "active", account_id: "acct-1" } })
    }
    if (u.endsWith("/api/v1/integrations/opensquilla/managed-key/credential")) {
      state.credentialPosts += 1
      return jsonRes(200, { code: 0, data: { secret: "sk-managed", key_id: "key-1", generation: 1, status: "active", account_id: "acct-1" } })
    }
    if (u.endsWith("/v1/models")) {
      return jsonRes(200, { code: 0, data: [{ id: "glm-5.1" }] })
    }
    return jsonRes(404, { code: 404, error: "not_found" })
  }
}

test("BYOK api method validates the key against /v1/models", async () => {
  const state = { calls: [], credentialPosts: 0, managedKey: null }
  const plugin = await TokenRhythmAuthPlugin({}, { fetch: await fakeTokenRhythmFetch(state), modelBase: "https://tokenrhythm.studio/v1" })
  const api = plugin.auth.methods.find((m) => m.type === "api")
  const ok = await api.authorize({ apiKey: "  Bearer sk-byok  " })
  assert.equal(ok.type, "success")
  assert.equal(ok.key, "sk-byok")
  assert.ok(ok.username.startsWith("tokenrhythm-"))
  assert.equal(ok.accountId, undefined)
  const bad = await api.authorize({ apiKey: "" })
  assert.equal(bad.type, "failed")
})

test("browser sign-in completes the loopback OAuth callback and stores the managed key", async () => {
  const state = { calls: [], credentialPosts: 0, managedKey: null }
  const fetchImpl = await fakeTokenRhythmFetch(state)
  const plugin = await TokenRhythmAuthPlugin({}, { fetch: fetchImpl, origin: "http://127.0.0.1:9", loginTimeoutMs: 15_000 })
  const oauth = plugin.auth.methods.find((m) => m.type === "oauth")
  const started = await oauth.authorize({})
  assert.equal(started.method, "auto")
  assert.match(started.url, /api\/oauth\/authorize/)
  assert.equal(typeof started.callback, "function")
  // magpie shows the authorize link; the user opens it and the browser's
  // redirect lands on the loopback callback. Drive that redirect here.
  const u = new URL(started.url)
  const redirect = u.searchParams.get("redirect_uri")
  const oauthState = u.searchParams.get("state")
  assert.ok(redirect)
  assert.ok(oauthState)
  const pending = started.callback({})
  const res = await fetch(redirect + "?code=fake-code&state=" + encodeURIComponent(oauthState))
  assert.equal(res.status, 200)
  const result = await pending
  assert.equal(result.type, "success")
  assert.equal(result.access, "oauth-access")
  assert.equal(result.refresh, "oauth-refresh")
  assert.equal(result.modelKey, "sk-managed")
  assert.equal(result.keyId, "key-1")
  assert.equal(result.username, "Test User")
  assert.equal(result.accountId, "Test User")
  assert.equal(result.sub, "acct-1")
  assert.equal(state.credentialPosts, 1)
  assert.ok(started.url.includes("client_id=" + CLIENT_ID))
  assert.ok(started.url.includes("code_challenge_method=S256"))
})

test("auth.refresh rotates OAuth tokens and keeps custom fields", async () => {
  const state = { calls: [], credentialPosts: 0, managedKey: null }
  const plugin = await TokenRhythmAuthPlugin({}, { fetch: await fakeTokenRhythmFetch(state), origin: "http://127.0.0.1:9" })
  const auth = {
    type: "oauth",
    access: "oauth-access",
    refresh: "oauth-refresh",
    expires: Date.now() - 1000,
    sub: "acct-1",
    sid: "sess-1",
    username: "Old Name",
    modelKey: "sk-managed",
    keyId: "key-1",
    generation: 1,
    source: "browser",
  }
  const next = await plugin.auth.refresh(auth)
  assert.equal(next.access, "oauth-access-2")
  assert.equal(next.refresh, "oauth-refresh-2")
  assert.equal(next.modelKey, "sk-managed")
  assert.equal(next.sub, "acct-1")
  assert.equal(next.sid, "sess-1")
  assert.equal(next.accountId, "Test User")
  assert.equal(next.username, "Test User")
})

test("loader returns the model base and managed key for oauth, pasted key for api", async () => {
  const plugin = await TokenRhythmAuthPlugin({}, { modelBase: "https://tokenrhythm.studio/v1" })
  const oauthAuth = { type: "oauth", access: "oauth-access", modelKey: "sk-managed" }
  const apiAuth = { type: "api", key: "sk-byok" }
  for (const [auth, key] of [[oauthAuth, "sk-managed"], [apiAuth, "sk-byok"]]) {
    const loaded = await plugin.auth.loader(async () => auth)
    assert.equal(loaded.baseURL, "https://tokenrhythm.studio/v1")
    assert.equal(loaded.apiKey, key)
    assert.equal(typeof loaded.fetch, "function")
  }
  assert.deepEqual(await plugin.auth.loader(async () => ({ type: "oauth", access: "oauth-access" })), {})
})

test("usage maps the wallet for oauth and explains api-only keys", async () => {
  const state = { calls: [], credentialPosts: 0, managedKey: null }
  const plugin = await TokenRhythmAuthPlugin({}, { fetch: await fakeTokenRhythmFetch(state), origin: "http://127.0.0.1:9" })
  const oauthAuth = { type: "oauth", access: "oauth-access", refresh: "", expires: Date.now() + 60_000, sub: "acct-1", sid: "sess-1" }
  const card = await plugin.auth.usage(async () => oauthAuth)
  assert.equal(card.plan, "Pay as you go")
  assert.equal(card.balance, "88.80 CNY")
  assert.equal(card.user, "Test User")
  const apiCard = await plugin.auth.usage(async () => ({ type: "api", key: "sk-byok" }))
  assert.match(apiCard.error, /browser sign-in/)
})

test("pkce produces a verifiable S256 challenge", () => {
  const { state, verifier, challenge } = pkce()
  assert.ok(state.length > 20)
  assert.ok(verifier.length > 20)
  assert.match(challenge, /^[A-Za-z0-9_-]+$/)
})

test("internal helpers are exported for diagnostics", () => {
  assert.equal(_internal.PROVIDER_ID, "tokenrhythm")
  assert.equal(_internal.CLIENT_ID, CLIENT_ID)
  assert.equal(_internal.normalizeApiKey(" Bearer sk-x "), "sk-x")
  assert.equal(NAME, "TokenRhythm (OpenSquilla)")
})

test("System One bodies: empty choice descriptions become the option key", () => {
  const body = JSON.stringify({ model: "NeoHorse-Jev-4B", criteria: [{ key: "fast", description: null }, { key: "cheap", description: "省钱" }] })
  const out = JSON.parse(adaptSystemOneBody(body))
  assert.equal(out.criteria[0].description, "fast")
  assert.equal(out.criteria[1].description, "省钱")
  const clean = JSON.stringify({ criteria: [{ key: "a", description: "ok" }] })
  assert.equal(adaptSystemOneBody(clean), clean)
  assert.equal(adaptSystemOneBody("not-json"), "not-json")
})

test("authedFetch adds the Bearer header and adapts only System One bodies", async () => {
  const impl = async (url, init) => ({
    url: String(url),
    authorization: new Headers(init.headers).get("authorization"),
    body: init.body,
  })
  const f = authedFetch("sk-test", impl)
  const chat = await f("https://tokenrhythm.studio/v1/chat/completions", { headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1 }) })
  assert.equal(chat.authorization, "Bearer sk-test")
  assert.equal(chat.body, '{"a":1}')
  const sysOne = await f("https://tokenrhythm.studio/v1/systemone", { body: JSON.stringify({ criteria: [{ key: "fast", description: null }] }) })
  assert.equal(JSON.parse(sysOne.body).criteria[0].description, "fast")
  const explicit = await f("https://tokenrhythm.studio/v1/systemone", { headers: { authorization: "Bearer mine" }, body: "{}" })
  assert.equal(explicit.authorization, "Bearer mine")
})

test("provider config declares decide/System One, icon, and the display name", async () => {
  const plugin = await TokenRhythmAuthPlugin({}, {})
  const cfg = { provider: {} }
  await plugin.config(cfg)
  const p = cfg.provider.tokenrhythm
  assert.equal(p.name, "TokenRhythm (OpenSquilla)")
  assert.equal(p.decide, true)
  assert.equal(p.models["NeoHorse-Jev-4B"].decides, true)
  assert.match(p.icon, /^data:image\/png;base64,/)
  assert.equal(DECIDE_MODEL.id, "NeoHorse-Jev-4B")
})

test("provider.models keeps the System One decide model visible", async () => {
  const plugin = await TokenRhythmAuthPlugin({}, {})
  const models = await plugin.provider.models({}, {})
  assert.equal(models["NeoHorse-Jev-4B"].decides, true)
})

test("localIcon inlines the bundled official icon as a data URI", async () => {
  const icon = await localIcon()
  assert.match(icon, /^data:image\/png;base64,/)
})



test("login method labels are bilingual", async () => {
  const plugin = await TokenRhythmAuthPlugin({}, {})
  const browser = plugin.auth.methods.find((m) => m.type === "oauth")
  assert.equal(browser.label, "Browser sign-in (managed model key + balance)")
  assert.equal(browser.labels && browser.labels.zh, "浏览器登录（托管密钥 + 余额）")
  const api = plugin.auth.methods.find((m) => m.type === "api")
  assert.equal(api.labels && api.labels.zh, "仅 API 密钥（模型可用，无余额卡片）")
  const opt = plugin.auth.options.find((o) => o.key === "create_key")
  assert.equal(opt.labels && opt.labels.zh, "浏览器登录后自动创建托管模型 Key")
  assert.ok(opt.descriptions && opt.descriptions.zh)
})

test("apiRequest rejects envelope errors and missing data", async () => {
  await assert.rejects(
    getWallet({ origin: "http://127.0.0.1:9", accessToken: "t", fetchImpl: async () => jsonRes(200, { code: 7, error: "WALLET_UNAVAILABLE" }) }),
    /WALLET_UNAVAILABLE/,
  )
  await assert.rejects(
    getWallet({ origin: "http://127.0.0.1:9", accessToken: "t", fetchImpl: async () => jsonRes(200, { code: 0 }) }),
    /ACCOUNT_BAD_RESPONSE/,
  )
})

test("auth.refresh and usage surface SignInExpired on invalid_grant", async () => {
  const plugin = await TokenRhythmAuthPlugin({}, {
    origin: "http://127.0.0.1:9",
    fetch: async (url) => {
      const u = String(url)
      if (u.endsWith("/api/oauth/token")) return jsonRes(400, { error: "invalid_grant" })
      return jsonRes(404, { code: 404, error: "not_found" })
    },
  })
  const auth = { type: "oauth", access: "a", refresh: "r", expires: Date.now() - 1000, sub: "acct-1", sid: "sess-1", username: "Old Name" }
  await assert.rejects(plugin.auth.refresh(auth), (e) => e.name === "SignInExpired" && e.signIn === "expired")
  await assert.rejects(plugin.auth.usage(async () => auth), (e) => e.name === "SignInExpired")
})
