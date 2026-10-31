// OpenCode provider plugin for SenseNova (SenseTime 日日新) Token Plan:
// a SenseNova console account's credit pools, windows and grants, on the
// account's own models.
//
// One sign-in gives both, like workbuddy's: the console account (with its
// password, sealed into a JWE so it never travels in plaintext) holds the
// quota — the pools, their 5-hour and weekly windows, the grants that
// expire — and an API key (sk-…) pasted with it is what the models are
// spoken to with. The console JWT is what reads the pools; the key is what
// serves chat. The two are one account in magpie.
//
// The console JWT lives ~180 minutes, so a refresh token that renews itself
// (Hydra rotates it — every refresh's new refresh token is saved) is the
// whole point of the sign-in.
//
// The provider id is "sensenova-token-plan", NOT "sensenova": that one is
// the user's own custom provider (an sk- key at token.sensenova.cn), and a
// plugin claiming it would take over the models it already serves.

// ---- the platform's endpoints, as the console's own traffic uses them
// They live in ENDPOINTS so a test can point them at a local fake; the
// plugin itself never changes them.
const ENDPOINTS = {
  console: "https://platform.sensenova.cn",
  iam: "https://iam.sensecoreapi.cn",
  token: "https://signin.sensecore.cn/oauth2/token",
  jwks: "https://signin.sensecore.cn/.well-known/jwks.json",
  api: "https://token.sensenova.cn/v1",
}

const CONSOLE = () => ENDPOINTS.console
const IAM_ORIGIN = () => ENDPOINTS.iam
const TOKEN_ENDPOINT = () => ENDPOINTS.token
const JWKS_ENDPOINT = () => ENDPOINTS.jwks
const API_BASE = () => ENDPOINTS.api
const CLIENT_ID = "nova"
const SCOPE = "openid offline offline_access"
const ENC_KEY_ID = "public:hydra.openid.id-token"
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"
const TIMEOUT_MS = 20_000
const MAX_HOPS = 8
const EARLY_MS = 10 * 60 * 1000 // renew this close to a token's end (auth.refresh lead)
const poolUsageUrl = () => CONSOLE() + "/lite/console/v1/tokenplan/pool-usage"

const NPM = "@ai-sdk/openai-compatible"

// ---- small helpers

const str = (o, k) => (typeof o?.[k] === "string" && o[k].trim() ? o[k].trim() : undefined)
const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined)
const num = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return undefined
}
const b64url = (bytes) => Buffer.from(bytes).toString("base64url")

// ---- the crypto: JWE password sealing, PKCE, JWT expiry

// Seal the password into the 5-segment compact JWE the IAM endpoint wants:
// RSA-OAEP (OAEP over SHA-1 — the SHA-256 variants are refused) + A256GCM.
// The protected header's base64url SEGMENT is the AAD (RFC 7516 §5.1), and
// WebCrypto's ciphertext||tag buffer is split into the last two segments.
async function sealPassword(password) {
  const jwksRes = await fetch(JWKS_ENDPOINT(), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!jwksRes.ok) throw new Error(`JWKS endpoint: HTTP ${jwksRes.status}`)
  const keys = (await jwksRes.json())?.keys ?? []
  const key = keys.find((k) => k.kid === ENC_KEY_ID)
  if (!key) throw new Error(`JWKS has no key ${ENC_KEY_ID}`)

  const rsaKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: key.n, e: key.e, alg: "RSA-OAEP", ext: true },
    { name: "RSA-OAEP", hash: "SHA-1" },
    false,
    ["encrypt"],
  )

  const contentKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"])
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", contentKey))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const protectedHeader = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RSA-OAEP", enc: "A256GCM" })))
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(protectedHeader), tagLength: 128 },
      contentKey,
      new TextEncoder().encode(password),
    ),
  )
  const ciphertext = sealed.subarray(0, sealed.length - 16)
  const tag = sealed.subarray(sealed.length - 16)
  const encryptedKey = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsaKey, rawKey)
  return [protectedHeader, b64url(encryptedKey), b64url(iv), b64url(ciphertext), b64url(tag)].join(".")
}

const pkce = async () => {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)))
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
  return { verifier, challenge }
}

// ---- the redirect walk (cookies kept per host; fetch can't do this itself)

// The domains the walk may visit. It carries Hydra session and CSRF cookies,
// so a hop found in a page body to some other domain must not be taken. The
// hosts the endpoints are set to are allowed too, which is how a test running
// the whole flow against a local fake gets through.
const SENSENOVA_HOSTS = [/(^|\.)sensenova\.cn$/, /(^|\.)sensecore\.cn$/, /(^|\.)sensecoreapi\.cn$/]

function allowedHost(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (Object.values(ENDPOINTS).some((e) => { try { return new URL(e).host === u.host } catch { return false } })) return true
  return SENSENOVA_HOSTS.some((re) => re.test(u.hostname))
}

// cookies keyed by host: one that set a cookie is the only one it goes back to
function newJar() {
  return new Map()
}

const hostOf = (url) => {
  try {
    return new URL(url).host
  } catch {
    return ""
  }
}

function cookieHeader(jar, url) {
  const own = jar.get(hostOf(url))
  return own && own.size ? [...own.entries()].map(([n, v]) => `${n}=${v}`).join("; ") : ""
}

function collectCookies(response, jar, url) {
  const host = hostOf(url)
  if (!host) return
  const raw = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : []
  let own = jar.get(host)
  if (!own) jar.set(host, (own = new Map()))
  for (const line of raw) {
    const [pair = ""] = line.split(";")
    const i = pair.indexOf("=")
    if (i > 0) own.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim())
  }
}

async function httpGet(url, jar) {
  if (!allowedHost(url)) throw new Error(`refusing to visit ${url}: outside the SenseNova hosts`)
  const headers = { "user-agent": UA, accept: "*/*" }
  const cookie = cookieHeader(jar, url)
  if (cookie) headers.cookie = cookie
  return fetch(url, { redirect: "manual", headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
}

// Some transitions are rendered client-side: scan a 200 body for the next hop.
// Only a hop to an allowed host is taken, so a page that points elsewhere
// can't pull the walk (and the cookies it holds) off-site.
function nextFromBody(body, wanted) {
  if (!body) return ""
  const found = []
  for (const m of body.matchAll(/https?:\/\/[^"'\s<>]+[?&][^"'\s<>]*/g)) found.push(m[0])
  const meta = /<meta[^>]+http-equiv=["']refresh["'][^>]+url=["']([^"']+)/i.exec(body)
  if (meta) found.push(meta[1])
  for (const p of [
    /window\.location\.replace\(["']([^"']+)["']/,
    /window\.location\.href\s*=\s*["']([^"']+)["']/,
    /location\.href\s*=\s*["']([^"']+)["']/,
  ]) {
    const f = p.exec(body)
    if (f) found.push(f[1])
  }
  for (const u of found) if (allowedHost(u) && wanted.test(u)) return u
  return ""
}

async function followUntil(start, wanted, jar) {
  let location = start
  for (let hop = 0; hop < MAX_HOPS && location; hop++) {
    if (wanted.test(location)) return location
    const res = await httpGet(location, jar)
    collectCookies(res, jar, location)
    const next = res.headers.get("location") ?? ""
    location = next !== "" ? next : nextFromBody(await res.text(), wanted)
    if (location && !wanted.test(location) && !allowedHost(location))
      throw new Error(`the sign-in walk left the SenseNova hosts for ${location}`)
  }
  return wanted.test(location) ? location : ""
}

const paramOf = (url, name) => {
  try {
    return new URL(url).searchParams.get(name) ?? ""
  } catch {
    return ""
  }
}

// ---- the login flow and the refresh

async function refreshToken(refresh) {
  const res = await fetch(TOKEN_ENDPOINT(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA, accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: CLIENT_ID,
      scope: SCOPE,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.access_token) {
    // only invalid_grant means the refresh token itself is dead; any other
    // 400 says nothing about it and must not purge a healthy pair
    const dead = res.status === 400 && body.error === "invalid_grant"
    throw Object.assign(
      new Error(`refresh rejected (HTTP ${res.status}): ${body.error_description ?? body.error ?? ""}`),
      // the host only marks an account signed-out on an error that says so
      // (host.js: e?.signIn === "expired"); without it a dead token is
      // retried every RENEW_RETRY (30 s) and never shown as needing a sign-in
      { dead, ...(dead ? { signIn: "expired" } : {}) },
    )
  }
  return {
    access: body.access_token,
    refresh: body.refresh_token ?? refresh,
    expires: Date.now() + (Number(body.expires_in) || 10800) * 1000,
  }
}

async function passwordLogin(username, password) {
  const user = String(username ?? "").trim()
  const secret = String(password ?? "")
  if (!user || !secret.trim()) throw new Error("username and password are required")

  const jar = newJar()
  const { verifier, challenge } = await pkce()
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)))

  // step 1 — start the OIDC walk on the console origin (the CSRF cookie is
  // bound to this host; starting anywhere else kills the flow)
  const authUrl =
    CONSOLE() +
    "/oauth2/auth?" +
    new URLSearchParams({
      client_id: CLIENT_ID,
      code_challenge: challenge,
      code_challenge_method: "S256",
      redirect_uri: CONSOLE(),
      response_type: "code",
      scope: SCOPE,
      state: nonce,
    }).toString()
  const first = await httpGet(authUrl, jar)
  collectCookies(first, jar, authUrl)
  const challengeUrl = await followUntil(first.headers.get("location") ?? authUrl, /[?&]login_challenge=/, jar)
  const loginChallenge = paramOf(challengeUrl, "login_challenge")
  if (!loginChallenge) throw new Error("could not obtain a login challenge from the authorization endpoint")

  // step 2 — seal the password and sign in at IAM
  const encrypted = await sealPassword(secret)
  const iamRes = await fetch(`${IAM_ORIGIN()}/iam/authn/v1/auth/nova/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": UA,
      accept: "application/json",
      origin: CONSOLE(),
      referer: CONSOLE() + "/",
      cookie: cookieHeader(jar),
    },
    body: JSON.stringify({ username: user, password: encrypted, challenge: loginChallenge, is_encrypt: true }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const iamBody = await iamRes.json().catch(() => ({}))
  const redirect = iamBody?.redirect ?? ""
  if (!iamRes.ok || !redirect) {
    // the real reason lives in details[].reason, not the top-level message
    const reason =
      iamBody?.details?.find?.((d) => d?.reason)?.reason ?? iamBody?.message ?? `HTTP ${iamRes.status}`
    throw Object.assign(new Error(`login refused: ${reason}`), {
      // time-based refusals carry a window; credential ones never retry
      kind: /locked|disabled|tooMany|rateLimit|tooManyRequests/i.test(String(reason)) ? "retryable" : "credential",
    })
  }

  // step 3 — walk the callback for the code (state must round-trip)
  const codeUrl = await followUntil(redirect, /[?&]code=/, jar)
  const code = paramOf(codeUrl, "code")
  if (!code) throw new Error("callback ended without an authorization code")
  if (paramOf(codeUrl, "state") !== nonce) throw new Error("callback state did not match the issued nonce")

  // step 4 — exchange code + verifier for the token pair
  const tokenRes = await fetch(TOKEN_ENDPOINT(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA, accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: CONSOLE(),
      scope: SCOPE,
    }).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const tokenBody = await tokenRes.json().catch(() => ({}))
  if (!tokenRes.ok || !tokenBody.access_token)
    throw new Error(`token exchange failed: ${tokenBody.error_description ?? tokenBody.error ?? `HTTP ${tokenRes.status}`}`)
  return {
    access: tokenBody.access_token,
    refresh: tokenBody.refresh_token ?? "",
    expires: Date.now() + (Number(tokenBody.expires_in) || 10800) * 1000,
  }
}

// ---- the model catalogue (an API key's models)

// Reasoning effort levels each model takes. There is no public page listing
// them: these are the levels a free Token Plan account's own requests were
// answered with, and the ones it answers 400 to. `reasoning_effort` is the
// field the OpenAI-compatible request carries; `none` is thinking off. Only
// the levels a model truly takes are listed — glm-5.2 takes `max`, the
// flash-lite and v4-flash don't. testdata/models.json holds the catalogue
// these were read against.
const EFFORTS = {
  "glm-5.2": ["none", "low", "medium", "high", "xhigh", "max"],
  "deepseek-v4-flash": ["none", "low", "high", "xhigh"],
  "deepseek-flash": ["none", "low", "high", "xhigh"],
  "kimi-k3": ["none", "low", "high", "xhigh"],
  "sensenova-6.8-flash-lite": ["none", "low", "high"],
}

// the models the plan ships, as magpie's provider starts with: the same ids
// the catalogue serves, with the limits the platform declared when this was
// written and the reasoning levels each takes. The API key's account
// refreshes them with the live catalogue (provider.models below); the
// plan's pools filter that list to what the key can call.
const BOOT_MODELS = {
  "glm-5.2": { name: "glm-5.2", context: 1048576, output: 131072 },
  "deepseek-v4-flash": { name: "deepseek-v4-flash", context: 1048576, output: 65536 },
  "deepseek-flash": { name: "deepseek-flash", context: 1048576, output: 65536 },
  "sensenova-6.8-flash-lite": { name: "sensenova-6.8-flash-lite", context: 262144, output: 65536 },
  "kimi-k3": { name: "kimi-k3", context: 1048576, output: 65536 },
}

// What the plan covers is read from the account's own pools each time its
// models are listed (provider.models below) and never kept in a module
// global: a global would be shared between accounts (two SenseNova accounts
// on different plans would filter each other's lists) and would be cold in a
// fresh host process, where it would list a model the vendor answers 403 to.

// The catalogue the platform serves: free, read-only, and it costs no
// inference allowance. Its own fields are the authority on a model's
// context window and output limit.
async function apiModels(key) {
  const res = await fetch(API_BASE() + "/models", {
    headers: { authorization: "Bearer " + key, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (res.status === 401 || res.status === 403) throw new Error(`SenseNova refused the API key (HTTP ${res.status})`)
  if (!res.ok) throw new Error(`model catalogue: HTTP ${res.status}`)
  const body = await res.json().catch(() => ({}))
  const data = Array.isArray(body?.data) ? body.data : []
  return data.map((m) => ({
    id: str(m, "id") ?? "",
    name: str(m, "name") ?? str(m, "id") ?? "",
    context: num(m?.context_length) ?? 0,
    output: num(m?.max_output_length) ?? 0,
    // a model that takes images in, and one that draws them out
    image: Array.isArray(m?.input_modalities) && m.input_modalities.includes("image"),
    draws: Array.isArray(m?.output_modalities) && m.output_modalities.includes("image"),
    reasoning: Array.isArray(m?.supported_features) && m.supported_features.includes("reasoning"),
  })).filter((m) => m.id)
}

// a model as OpenCode's provider lists it: id, name, limits, what it can do
// and the reasoning effort levels it takes. The API it is spoken on comes
// from the provider's own npm and api (the config hook below), so a model
// says nothing about where it goes.
function modelOf(m, provider) {
  const image = m.image === true
  const efforts = EFFORTS[m.id]
  return {
    id: m.id,
    name: m.name || m.id,
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    reasoning: m.reasoning !== false,
    tool_call: true,
    modalities: { input: image ? ["text", "image"] : ["text"], output: ["text"] },
    capabilities: {
      reasoning: m.reasoning !== false,
      toolcall: true,
      attachment: image,
      input: { text: true, image },
      output: { text: true },
    },
    // the effort levels this model takes, each a variant: the gateway sends
    // one as `reasoning_effort`, `none` is thinking off. A model that takes
    // none is the family's, listed at its own name; one that does not has
    // no variants.
    ...(efforts && efforts.length ? { variants: Object.fromEntries(efforts.map((e) => [e, { reasoningEffort: e }])) } : {}),
  }
}

// ---- the pool usage (the console's data source)

// pools → the card's windows and balance. The console returns its numbers
// as strings: limit/used/remaining per window, reset_at as epoch seconds.
//
// The GUI draws only an account's first two windows as meters and puts the
// rest in the row's tooltip, so each window says which models its pool covers
// — the host keeps that field (`ids(w?.models)`) and the GUI groups windows by
// it, which gives every pool its own meters instead of one pool's meters with
// the rest hidden. The grants — a balance that expires, not a window that gets
// spent — go to `balance`, which the GUI draws as its own chip beside them.
function usageOf(pools) {
  const round = (n) => Math.round(n * 100) / 100
  const windows = []
  let grants = ""
  const ordered = [...(Array.isArray(pools) ? pools : [])].sort(
    (a, b) => (a?.pool_type === "default" ? -1 : 1) - (b?.pool_type === "default" ? -1 : 1),
  )
  for (const pool of ordered) {
    const poolName = str(pool, "name") ?? "pool"
    // the models this pool covers: the GUI groups a window by them, so the
    // Flash-Lite pool's windows hang under the flash-lite models instead of
    // vanishing into the account's first-two-meters row
    const models = (Array.isArray(pool?.model_ids) ? pool.model_ids : []).filter((x) => typeof x === "string" && x)
    for (const [key, label, span] of [
      ["window_5h", "5 hours", 5 * 3600],
      ["window_7d", "7 days", 7 * 86400],
    ]) {
      const w = obj(pool?.[key])
      if (!w) continue
      const limit = num(w.limit)
      if (limit === undefined || limit <= 0) continue
      const used = num(w.used) ?? 0
      const resetAt = num(w.reset_at)
      windows.push({
        name: `${poolName} · ${label}`,
        used: Math.max(0, Math.min(100, (100 * used) / limit)),
        display: `${round(used)} / ${round(limit)}`,
        amount: round(used),
        limit: round(limit),
        unit: "credits",
        span,
        ...(models.length ? { models } : {}),
        ...(resetAt && resetAt > 0 ? { resetsAt: new Date(resetAt * 1000).toISOString() } : {}),
      })
    }
    const grant = num(pool?.grant_balance)
    if (grant !== undefined && grant > 0) {
      const expiry = num(pool?.nearest_grant_expiry)
      grants = `${round(grant)} credits granted${expiry && expiry > 0 ? " · expires " + new Date(expiry * 1000).toISOString().slice(0, 10) : ""}`
    }
  }
  return { windows, ...(grants ? { balance: grants } : {}) }
}

async function poolUsage(access) {
  if (!access) throw new Error("no console token to read the plan with")
  const res = await fetch(poolUsageUrl(), {
    headers: { authorization: "Bearer " + access, accept: "application/json", "user-agent": UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (res.status === 401 || res.status === 403)
    throw Object.assign(new Error(`console refused the token (HTTP ${res.status})`), { status: res.status })
  if (!res.ok) throw new Error(`pool-usage: HTTP ${res.status}`)
  const body = await res.json().catch(() => ({}))
  const plan = obj(body?.plan)
  const pools = Array.isArray(body?.pools) ? body.pools : []
  const ids = pools.flatMap((p) => (Array.isArray(p?.model_ids) ? p.model_ids : [])).filter((x) => typeof x === "string" && x)
  return {
    plan: str(plan, "name") ?? str(plan, "id") ?? "SenseNova",
    // the ids this account's plan covers: provider.models lists against these
    models: ids,
    ...usageOf(pools),
  }
}

// ---- the plugin

// The provider id magpie files this plugin's card under.
const PROVIDER_ID = "sensenova-token-plan"

function makePlugin() {
  return async ({ client }) => {
    // magpie saves what refresh gives; used by the login method and renewals.
    // The API key is kept beside the access/refresh tokens as `apiKey`, the
    // way minimax keeps `realUserID` — not its own account, part of this one.
    const save = async (a) => {
      if (typeof client?.auth?.set !== "function") return false
      try {
        await client.auth.set({ path: { id: PROVIDER_ID }, body: a })
        return true
      } catch {
        return false
      }
    }

    // the account's API key, wherever it is stored (the account's `apiKey`)
    const apiKeyOf = (auth) => auth?.apiKey

    return {
      // magpie's provider config: the name, the AI SDK package and the
      // endpoint the requests go to, with the models the provider starts
      // with (the account's own catalogue replaces them once it answers).
      config: async (cfg) => {
        cfg.provider ??= {}
        // `??=` keeps a provider the user configured in plugins.json
        cfg.provider[PROVIDER_ID] ??= {
          name: "SenseNova",
          npm: NPM, // chat completions
          api: API_BASE(),
          models: Object.fromEntries(
            Object.entries(BOOT_MODELS).map(([id, m]) => [
              id,
              modelOf({ id, name: m.name, context: m.context, output: m.output, image: false, draws: false, reasoning: true }, undefined),
            ]),
          ),
        }
      },
      // magpie's provider hook: the id and the model list. The models come
      // from the API key's catalogue; a model outside the plan's pools, or
      // one that draws (a chat endpoint answers 404 to it), stays unlisted.
      provider: {
        id: PROVIDER_ID,
        // The account's models: what its own plan covers, ∩ what its key
        // serves, ∩ what a chat endpoint answers (a drawing model 404s there).
        // Both reads are this account's and both happen here, so a cold host
        // lists the same set a warm one does. Either read failing gives the
        // bootstrap list back — every id in which the plan does cover — rather
        // than a raw catalogue that would carry deepseek-v4.1-flash, which the
        // vendor refuses with 403.
        async models(provider, { auth }) {
          const key = apiKeyOf(auth)
          // no key: this account can call nothing, so it advertises nothing
          if (!key) return {}
          let plan
          try {
            plan = await poolUsage(auth?.access)
          } catch {
            return provider.models
          }
          const covered = new Set(plan.models)
          if (!covered.size) return provider.models
          let list
          try {
            list = await apiModels(key)
          } catch {
            return provider.models
          }
          const models = list.filter((m) => !m.draws && covered.has(m.id))
          if (!models.length) return provider.models
          return Object.fromEntries(models.map((m) => [m.id, modelOf(m, provider)]))
        },
      },
      auth: {
        // which provider this sign-in belongs to: magpie files the card and
        // the account under it (host.js reads auth.provider, not the hook's
        // own provider field)
        provider: PROVIDER_ID,
        // the host reads the lead off auth (leadOf(a), with a = auth), not off
        // the hooks object: where it sits decides whether magpie renews this
        // far ahead of the token's end or at its own default of 5 minutes
        refreshLead: EARLY_MS,
        // magpie renews ahead of the token's end, once per account
        async refresh(auth) {
          if (auth?.type !== "oauth" || !auth.access || !auth.refresh) return undefined
          try {
            return await refreshToken(auth.refresh)
          } catch (e) {
            // a dead token goes back as it came: it carries signIn "expired",
            // which is how the account is marked as needing a new sign-in
            if (e?.dead) throw e
            return undefined
          }
        },
        // the chat loader: an account with an API key serves the models
        // (OpenAI-compatible at token.sensenova.cn/v1). magpie sends
        // `Authorization: Bearer <apiKey>` for @ai-sdk/openai-compatible
        // itself, so no custom fetch is needed — the key (kept on the
        // account as `apiKey`) goes in as the apiKey the loader returns.
        async loader(getAuth) {
          const auth = await getAuth()
          const key = apiKeyOf(auth)
          if (!key) return {}
          return { baseURL: API_BASE(), apiKey: key }
        },
        // the account's credit pools (the console JWT, not the API key).
        // Renewal is the host's job: it renews through auth.refresh, this far
        // ahead of the token's end, before usage runs. So usage reads with the
        // token in hand and renews only when the console refuses it with a 401
        // — a second standing renewal path here would spend one refresh token
        // twice, and Hydra rotates it, so the second spend is refused.
        async usage(getAuth) {
          const auth = await getAuth()
          if (auth?.type !== "oauth" || !auth.access) return { error: "not signed in" }
          const card = (u, signIn) => ({
            plan: u.plan,
            ...(u.balance ? { balance: u.balance } : {}),
            windows: u.windows,
            user: auth.accountId ?? auth.email ?? "sensenova",
            signIn,
          })
          try {
            return card(await poolUsage(auth.access), "kept")
          } catch (e) {
            if (e?.status !== 401) return { error: e?.message ?? String(e), signIn: "kept" }
          }
          // refused with a token believed good: renew once, read once more
          if (!auth.refresh) return { error: "no refresh token; sign in again", signIn: "expired" }
          try {
            const t = await refreshToken(auth.refresh)
            // the API key rides through: the JWT changes, the key doesn't
            await save({ ...auth, ...t })
            return card(await poolUsage(t.access), "renewed")
          } catch (e) {
            const why = e?.message ?? String(e)
            // a dead refresh token ends the sign-in: say what to do as well as
            // what the vendor answered
            if (e?.dead) return { error: `${why}; sign in again`, signIn: "expired" }
            return { error: why, signIn: "kept" }
          }
        },
        methods: [
          {
            // one sign-in: the console account (its password, sealed to a
            // JWE) for the quota, and the API key pasted with it for the
            // models. The key is optional — without it the card still shows
            // the quota, only no models — but with it the account serves
            // chat too, the way workbuddy's one account does both.
            type: "oauth",
            label: "Sign in with SenseNova account",
            prompts: [
              {
                type: "input",
                key: "username",
                message: "Your SenseNova console account (platform.sensenova.cn)",
                validate: (v) => (String(v ?? "").trim() ? undefined : "account is required"),
              },
              {
                type: "password",
                key: "password",
                message: "Your SenseNova console password (sealed to JWE before it leaves this machine)",
                validate: (v) => (String(v ?? "").trim() ? undefined : "password is required"),
              },
              {
                type: "password",
                key: "apiKey",
                message: "Your SenseNova API key (sk-…, optional, for the models)",
                placeholder: "sk-...",
                validate: (v) => {
                  const s = String(v ?? "").trim()
                  return s === "" || s.startsWith("sk-") ? undefined : "the key starts with sk-"
                },
              },
            ],
            authorize: (inputs) => {
              const username = String(inputs?.username ?? "").trim()
              const password = String(inputs?.password ?? "")
              const apiKey = String(inputs?.apiKey ?? "").trim()
              if (!username || !password) throw new Error("enter your SenseNova account and password")
              return {
                // no page to open: the sign-in runs in the background from the
                // prompts, as loomy and the other prompt sign-ins do it. A url
                // here would have magpie open the console for nothing.
                url: "",
                instructions: "Signs in to the SenseNova console with your account; the password is sealed (JWE) and never stored.",
                method: "auto",
                async callback() {
                  try {
                    const t = await passwordLogin(username, password)
                    return {
                      type: "success",
                      access: t.access,
                      refresh: t.refresh,
                      expires: t.expires,
                      accountId: username,
                      uid: username,
                      // the API key rides along on the account: magpie keeps
                      // every field the result carries
                      ...(apiKey ? { apiKey } : {}),
                    }
                  } catch (e) {
                    return { type: "failed", error: `SenseNova sign-in: ${e?.message ?? e}` }
                  }
                },
              }
            },
          },
        ],
      },
    }
  }
}

export const SenseNovaAuthPlugin = makePlugin()
export default SenseNovaAuthPlugin

// for tests
export const _internal = {
  sealPassword,
  pkce,
  passwordLogin,
  refreshToken,
  usageOf,
  poolUsage,
  apiModels,
  modelOf,
  ENDPOINTS,
  EFFORTS,
  BOOT_MODELS,
  EARLY_MS,
}
