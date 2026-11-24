// magpie-plugin-opensquilla-tokenrhythm
//
// TokenRhythm for Magpie. Two sign-ins:
//   * browser  - OpenSquilla's registered OAuth client (opensquilla-desktop),
//                PKCE + loopback, then a managed-key credential becomes the
//                model Bearer. Wallet powers the usage card.
//   * api key  - a TokenRhythm model key pasted by hand (OpenAI-compatible).
//
// The OAuth client id is fixed by TokenRhythm: opensquilla-desktop is the only
// registered integration client today. If TokenRhythm registers a magpie
// client, swap CLIENT_ID in lib/tokenrhythm.mjs and the scopes stay the same.
//
// Shape of this file: everything testable is a pure function at module level
// (value parsing, identity mapping, usage cards, the System One fetch layer);
// TokenRhythmAuthPlugin only wires those pure pieces to magpie's hooks and to
// the network through the injected fetch. lib/text.mjs holds every
// user-facing string in magpie's plugin i18n shape.
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import {
  CLIENT_ID,
  DEFAULT_ORIGIN,
  OAuthError,
  TokenRhythmError,
  endpoints,
  ensureModelKey,
  exchangeCode,
  getAccount,
  getWallet,
  normalizeModelBase,
  normalizeOrigin,
  refreshTokens,
  walletCard,
} from "./lib/tokenrhythm.mjs"
import { startLoopbackLogin } from "./lib/oauth.mjs"
import { bootModels, createCatalog, fetchLiveModels, fetchPublicModels } from "./lib/models.mjs"
import { API_KEY_PROMPT_MESSAGE, API_METHOD, CREATE_KEY_OPTION, LOGIN_INSTRUCTIONS, OAUTH_METHOD } from "./lib/text.mjs"

// ─── constants ────────────────────────────────────────────────────────────────

const PROVIDER_ID = "tokenrhythm"
const NAME = "TokenRhythm (OpenSquilla)"
const NPM = "@ai-sdk/openai-compatible"
const REFRESH_LEAD_MS = 10 * 60 * 1000
const EARLY_MS = 30 * 1000
const DEFAULT_LOGIN_TIMEOUT_MS = 300_000

// TokenRhythm is metered pay-as-you-go: the usage card carries no plan window,
// only the live wallet balance. magpie renders PLAN_LABEL as the billing mode.
const PLAN_LABEL = "Pay as you go"

// TokenRhythm's System One decision model (JEV). It answers at {BASE}/systemone,
// not an AI SDK protocol, so it is declared without an npm client and magpie
// never sends it a chat request; the provider config sets decide: true.
const DECIDE_MODEL = {
  id: "NeoHorse-Jev-4B",
  name: "NeoHorse-Jev-4B (System One)",
  limit: { context: 262144, output: 32768 },
  tool_call: false,
  reasoning: false,
  modalities: { input: ["text"] },
  decides: true,
}
const DECIDE_MODELS = { [DECIDE_MODEL.id]: DECIDE_MODEL }

// The plugin ships TokenRhythm's icon (assets/icon.png, taken from the official
// site) and inlines it as a data URI: provider icons accept https or
// data:image/, and a bundled file survives mirrors and offline machines.
const ICON_URL = new URL("./assets/icon.png", import.meta.url)

// ─── pure value helpers ───────────────────────────────────────────────────────

const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined)

const pos = (v) => {
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

const firstNonEmpty = (...vals) => {
  for (const v of vals) {
    const s = typeof v === "string" ? v.trim() : ""
    if (s) return s
  }
  return ""
}

const SECRETISH = /(Bearer +[A-Za-z0-9._~+/-]{12,}|sk-[A-Za-z0-9-]{8,})/gi

export function cleanDetail(value) {
  return String(value ?? "").replace(SECRETISH, "***")
}

export function fingerprint(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 16)
}

export function normalizeApiKey(value) {
  let s = String(value ?? "").trim()
  if (s.slice(0, 7).toLowerCase() === "bearer ") s = s.slice(7).trim()
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) s = s.slice(1, -1).trim()
  return s
}

/** Plugin-option truthiness: absent falls back, and the usual off spellings count as off. */
const isEnabled = (v, fallback = true) => {
  const raw = v === undefined ? fallback : v
  return !(raw === false || raw === "false" || raw === "0" || raw === "no")
}

/** Does this error say the credentials were refused at the auth layer? */
const isAuthRejection = (e) => e?.status === 401 || e?.status === 403 || e?.httpStatus === 401 || e?.httpStatus === 403

// ─── pure model helpers ───────────────────────────────────────────────────────

/** Keep every model the caller lists and guarantee the System One model is visible. */
const withDecide = (models) => ({ ...models, ...DECIDE_MODELS })

// ─── pure System One fetch layer ──────────────────────────────────────────────

/**
 * magpie's System One body passes through as-is except for one rule:
 * TokenRhythm rejects choice criteria whose description is null or ""
 * (HTTP 422), so an empty description becomes the option key itself.
 */
export function adaptSystemOneBody(body) {
  if (typeof body !== "string") return body
  let parsed
  try { parsed = JSON.parse(body) } catch { return body }
  if (!parsed || typeof parsed !== "object") return body
  const rows = Array.isArray(parsed.criteria) ? parsed.criteria : Array.isArray(parsed) ? parsed : null
  if (!rows) return body
  const fill = (row) =>
    row && typeof row === "object" && (row.description === null || row.description === "")
      ? { ...row, description: String(row.key ?? row.id ?? row.name ?? "option") }
      : row
  const fixed = rows.map(fill)
  const changed = fixed.some((row, i) => row !== rows[i])
  if (!changed) return body
  if (Array.isArray(parsed)) return JSON.stringify(fixed)
  return JSON.stringify({ ...parsed, criteria: fixed })
}

/**
 * Fetch wrapper handed to the AI SDK client: makes sure the managed/API key
 * rides along as the Bearer header and rewrites System One bodies for
 * TokenRhythm's empty-description rule. Everything else passes through.
 */
export function authedFetch(key, fetchImpl) {
  const impl = fetchImpl ?? ((url, init = {}) => fetch(url, init))
  const isSystemOnePath = (input) => String(input).includes("/systemone")
  return async (url, init = {}) => {
    const headers = new Headers(init.headers ?? {})
    if (key && !headers.has("authorization")) headers.set("authorization", "Bearer " + key)
    const body = init.body != null && isSystemOnePath(url) && typeof init.body === "string" ? adaptSystemOneBody(init.body) : init.body
    return impl(url, { ...init, headers, body })
  }
}

// ─── pure icon ────────────────────────────────────────────────────────────────

export async function localIcon(rel = ICON_URL) {
  try {
    const buf = await readFile(rel)
    return "data:image/png;base64," + buf.toString("base64")
  } catch {
    return undefined
  }
}

// ─── pure identity mapping ────────────────────────────────────────────────────

class SignInExpired extends Error {
  constructor() {
    super("this TokenRhythm account is signed out; sign in again")
    this.name = "SignInExpired"
    this.signIn = "expired"
  }
}

const signedOut = (e) =>
  (e instanceof OAuthError && e.code === "invalid_grant" && (e.httpStatus === 400 || e.status === 400)) ||
  (e instanceof TokenRhythmError && (e.code === "ACCOUNT_HTTP_401" || e.code === "OAUTH_HTTP_401"))

/** Map credential-class failures onto SignInExpired; leave everything else untouched. */
const asSignInExpired = (e) => (signedOut(e) ? new SignInExpired() : e)

const byokIdentity = (key) => "tokenrhythm-" + fingerprint(key).slice(0, 12)

/**
 * The one place an oauth auth object is built from a token response.
 *   sub/sid           - the account's stable ids (follow the user account);
 *                       used internally for the refresh identity check and
 *                       never shown by magpie.
 *   accountId/username - what magpie displays ("signed in as ..."); live,
 *                       tracking the account's current display_name.
 * prev's extra fields (modelKey, generation, custom keys) are kept.
 */
export function oauthAuthFrom({ tokens, account, source = "browser", prev = {}, key = null } = {}) {
  const username = firstNonEmpty(account?.display_name, account?.masked_phone, prev?.username) || tokens.accountId
  return {
    ...prev,
    type: "oauth",
    access: tokens.accessToken,
    refresh: tokens.refreshToken,
    expires: tokens.expiresAt,
    sub: tokens.accountId,
    sid: tokens.sessionId,
    accountId: username,
    username,
    ...(key && key.secret ? { modelKey: key.secret, keyId: key.keyId, generation: key.generation } : {}),
    source: source ?? prev.source ?? "browser",
  }
}

// The model Bearer is the managed-key secret (oauth) or the pasted key (api).
// auth.access on an oauth entry is the OAuth access token, never the model key.
const pickModelKey = (auth) => {
  if (!auth) return ""
  const raw = auth.type === "api" ? (auth.key ?? auth.apiKey ?? auth.access ?? "") : (auth.modelKey ?? auth.apiKey ?? auth.key ?? "")
  return normalizeApiKey(raw)
}

const pickOAuthAccess = (auth) => {
  if (auth?.type !== "oauth") return ""
  return text(auth.access) ?? text(auth.oauthAccess) ?? ""
}

// ─── pure usage cards ─────────────────────────────────────────────────────────

const byokUsageCard = () => ({
  plan: PLAN_LABEL,
  balance: "",
  windows: [{ name: "API key", display: "Model calls only", aside: true }],
  error: "Balance requires the browser sign-in; this API key only covers model calls.",
  signIn: "kept",
})

const usageErrorCard = (message) => ({
  plan: PLAN_LABEL,
  balance: "",
  windows: [],
  error: cleanDetail(message),
  signIn: "kept",
})

function abortPromise(signal) {
  return new Promise((_, reject) => {
    if (!signal) return
    if (signal.aborted) {
      reject(new TokenRhythmError("sign-in cancelled", { code: "OAUTH_CANCELLED", cancelled: true }))
      return
    }
    signal.addEventListener("abort", () => reject(new TokenRhythmError("sign-in cancelled", { code: "OAUTH_CANCELLED", cancelled: true })), { once: true })
  })
}

// ─── plugin factory ───────────────────────────────────────────────────────────

export async function TokenRhythmAuthPlugin({ client, magpie } = {}, options = {}) {
  // The immutable environment every handler reads: parsed options, endpoints
  // and the injected fetch. Nothing here mutates after this point.
  const origin = normalizeOrigin(options.origin ?? options.baseURL ?? DEFAULT_ORIGIN)
  const modelBase = normalizeModelBase(options.modelBase ?? options.model_base, origin)
  const env = Object.freeze({
    client,
    origin,
    modelBase,
    fetchImpl: typeof options.fetch === "function" ? options.fetch : undefined,
    timeoutMs: pos(options.timeoutMs ?? options.timeout_ms) ?? 20_000,
    loginTimeoutMs: pos(options.loginTimeoutMs ?? options.login_timeout_ms) ?? DEFAULT_LOGIN_TIMEOUT_MS,
    createKey: isEnabled(options.create_key ?? options.createKey),
    options,
  })
  const ep = endpoints(env.origin)
  const { fetchImpl, timeoutMs } = env

  const log = (level, message) => {
    try {
      const lvl = message === undefined ? "info" : String(level ?? "info")
      const msg = message === undefined ? String(level ?? "") : String(message ?? "")
      client?.app?.log?.({ body: { service: PROVIDER_ID, level: lvl, message: cleanDetail(msg) } })
    } catch {
      /* logging is best effort */
    }
  }

  const catalog = createCatalog({
    fetchLive: (key) => fetchLiveModels({ baseURL: modelBase, apiKey: key, fetchImpl, timeoutMs }),
    fetchMeta: () => fetchPublicModels({ url: ep.publicModels, fetchImpl, timeoutMs }),
  })

  const saveAuth = async (auth) => {
    if (typeof client?.auth?.set !== "function") return false
    try {
      await client.auth.set({ path: { id: PROVIDER_ID }, body: auth })
      return true
    } catch {
      return false
    }
  }

  const accountFor = async (access) =>
    getAccount({ origin, accessToken: access, fetchImpl, timeoutMs }).catch(() => null)

  /** One OAuth token round-trip: refresh, re-read the profile, rebuild the auth object. */
  const refreshOAuth = async (auth) => {
    const tokens = await refreshTokens({
      origin,
      refreshToken: auth.refresh,
      accountId: auth.sub,
      sessionId: auth.sid,
      fetchImpl,
      timeoutMs,
    })
    const account = await accountFor(tokens.accessToken)
    const next = oauthAuthFrom({ tokens, account, source: auth.source ?? "browser", prev: auth })
    await saveAuth(next)
    return next
  }

  const freshAccess = async (auth) => {
    const access = pickOAuthAccess(auth)
    if (!access) throw new SignInExpired()
    const expires = pos(auth.expires) ?? 0
    if (expires && Date.now() < expires - EARLY_MS) return access
    if (!auth.refresh) {
      if (expires && Date.now() < expires) return access
      throw new SignInExpired()
    }
    try {
      const next = await refreshOAuth(auth)
      return pickOAuthAccess(next)
    } catch (e) {
      if (signedOut(e)) throw new SignInExpired()
      if (expires && Date.now() < expires) return access
      throw Object.assign(new Error("TokenRhythm token refresh: " + (e?.message ?? e)), { signIn: "kept" })
    }
  }

  /** Keep-alive identity check (mirrors OpenSquilla's verify loop). */
  const assertSameAccount = (auth, account) => {
    if (account?.account_id && auth?.sub && account.account_id !== auth.sub) throw new SignInExpired()
  }

  /** The wallet plus the live profile, as magpie's usage card. */
  const walletFor = async (auth, access) => {
    const account = await accountFor(access)
    assertSameAccount(auth, account)
    const wallet = await getWallet({ origin, accessToken: access, fetchImpl, timeoutMs })
    return walletCard({ wallet, account })
  }

  /**
   * Keep-alive (mirrors OpenSquilla's 60s verify loop): re-obtain or rotate
   * the managed model key on every balance probe so a server-side rotation
   * never leaves the plugin with a dead Bearer. Returns the auth to persist.
   */
  const rotateManagedKey = async (auth, access) => {
    if (!auth.sub || !env.createKey) return auth
    const key = await ensureModelKey({ origin, accessToken: access, fetchImpl, timeoutMs }).catch(() => null)
    if (!key?.secret || key.secret === auth.modelKey) return auth
    const next = {
      ...auth,
      modelKey: key.secret,
      ...(key.keyId ? { keyId: key.keyId } : {}),
      ...(key.generation ? { generation: key.generation } : {}),
    }
    await saveAuth(next)
    return next
  }

  /** Browser sign-in: magpie shows the authorize link; the callback finishes alone. */
  const browserAuthorize = async () => {
    let login
    try {
      login = await startLoopbackLogin({ origin, timeoutMs: env.loginTimeoutMs })
    } catch (e) {
      return { type: "failed", error: cleanDetail("TokenRhythm sign-in: " + (e?.message ?? e)) }
    }
    return {
      url: login.url,
      instructions: LOGIN_INSTRUCTIONS,
      method: "auto",
      callback: async ({ signal } = {}) => {
        try {
          const { code } = await Promise.race([login.promise, abortPromise(signal)])
          const tokens = await exchangeCode({
            origin,
            code,
            redirectUri: login.redirectUri,
            verifier: login.verifier,
            fetchImpl,
            timeoutMs,
          })
          const account = await accountFor(tokens.accessToken)
          let key = null
          if (env.createKey) {
            key = await ensureModelKey({ origin, accessToken: tokens.accessToken, fetchImpl, timeoutMs })
          }
          // The authorize result is type "success"; the stored auth it becomes
          // is type "oauth" — oauthAuthFrom builds the latter.
          const auth = oauthAuthFrom({ tokens, account, source: "browser", key })
          return { ...auth, type: "success" }
        } catch (e) {
          if (e?.cancelled) return { type: "failed", error: "the sign-in was cancelled" }
          return { type: "failed", error: cleanDetail("TokenRhythm sign-in: " + (e?.message ?? e)) }
        } finally {
          login.close()
        }
      },
    }
  }

  /** BYOK sign-in: validate the pasted key against the live model catalog. */
  const apiKeyAuthorize = async (inputs) => {
    const key = normalizeApiKey(inputs?.apiKey)
    if (!key) return { type: "failed", error: "API key is required" }
    try {
      await fetchLiveModels({ baseURL: modelBase, apiKey: key, fetchImpl, timeoutMs })
    } catch (e) {
      if (isAuthRejection(e)) return { type: "failed", error: "TokenRhythm rejected this API key" }
      return { type: "failed", error: cleanDetail("TokenRhythm key check: " + (e?.message ?? e)) }
    }
    return {
      type: "success",
      key,
      access: key,
      apiKey: key,
      username: byokIdentity(key),
      source: "byok",
    }
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const p = (cfg.provider[PROVIDER_ID] ??= {})
      p.name ??= NAME
      p.npm ??= NPM
      p.api ??= modelBase
      // TokenRhythm serves magpie's System One classifier at {BASE}/systemone.
      p.decide ??= true
      p.icon ??= (await localIcon()) || undefined
      p.models = { ...bootModels(), ...DECIDE_MODELS, ...(p.models ?? {}) }
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider, { auth } = {}) {
        const declared = provider?.models && Object.keys(provider.models).length > 0 ? provider.models : bootModels()
        if (!auth) return withDecide(declared)
        const key = pickModelKey(auth)
        if (!key) return {}
        try {
          const models = await catalog.modelsObject(key)
          if (!Object.keys(models).length) return { ...DECIDE_MODELS }
          return withDecide(models)
        } catch (e) {
          if (isAuthRejection(e)) return {}
          log("warn", "tokenrhythm: keeping the declared models (" + (e?.message ?? e) + ")")
          return Object.defineProperty(withDecide(declared), Symbol.for("magpie.fellBack"), { value: true })
        }
      },
    },

    auth: {
      provider: PROVIDER_ID,
      refreshLead: REFRESH_LEAD_MS,
      rotating: true,
      icon: await localIcon(),
      options: [CREATE_KEY_OPTION],
      methods: [
        {
          ...OAUTH_METHOD,
          authorize: browserAuthorize,
        },
        {
          ...API_METHOD,
          prompts: [
            {
              type: "password",
              key: "apiKey",
              message: API_KEY_PROMPT_MESSAGE,
              placeholder: "sk-...",
              validate: (v) => (normalizeApiKey(v) ? undefined : "API key is required"),
            },
          ],
          authorize: apiKeyAuthorize,
        },
      ],
      async refresh(auth) {
        if (auth?.type !== "oauth" || !auth.refresh) return undefined
        try {
          return await refreshOAuth(auth)
        } catch (e) {
          throw asSignInExpired(e)
        }
      },
      async loader(getAuth) {
        const auth = await getAuth()
        const key = pickModelKey(auth)
        if (!key) return {}
        return { baseURL: modelBase, apiKey: key, fetch: authedFetch(key, fetchImpl) }
      },
      async usage(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "oauth") return byokUsageCard()
        try {
          const access = await freshAccess(auth)
          const kept = await rotateManagedKey(auth, access)
          return await walletFor(kept, access)
        } catch (e) {
          if (e instanceof SignInExpired) throw e
          if (signedOut(e)) throw new SignInExpired()
          return usageErrorCard("TokenRhythm balance: " + (e?.message ?? e))
        }
      },
    },
  }
}

// Test/diagnostic surface; not part of the package entry (opencode.mjs exports
// only the plugin function).
export const _internal = {
  PROVIDER_ID,
  NAME,
  NPM,
  CLIENT_ID,
  DECIDE_MODEL,
  DECIDE_MODELS,
  adaptSystemOneBody,
  authedFetch,
  byokUsageCard,
  cleanDetail,
  fingerprint,
  isEnabled,
  isAuthRejection,
  localIcon,
  normalizeApiKey,
  oauthAuthFrom,
  pickModelKey,
  pickOAuthAccess,
  usageErrorCard,
  withDecide,
}
