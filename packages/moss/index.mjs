// MOSS (模思智能, api.mosi.cn) for OpenCode and magpie.
//
// 一个账号两套凭据：
//   - MOSS API key（api.mosi.cn/v1，Bearer）调模型：Nex-N2.6 对话补全；
//   - 控制台会话（platform.mosi.cn 的 cookie）读积分、管 Key。
//
// 为什么要插件：直接接 API 只回 token usage，不回积分余额；余额在控制台的
// /portal-api/maas/credits/usage-summary 里，需要网页登录态。插件替 magpie
// 持有这份登录态（专用浏览器 profile，绝不碰日常浏览器），把余额画成账户卡。
//
// Nex-N2.6 当前限时免费（0 积分）；控制台积分主要用于付费模型与充值。

import {
  ENDPOINTS,
  KEY_LIMIT,
  ProtocolError,
  cleanDetail,
  fingerprint,
  normalizeApiKey,
  probeApiKey,
  apiModels,
  createKey,
  listKeys,
  me as portalMe,
  readConsoleToken,
  usageSummary,
} from "./lib/protocol.mjs"
import { cardOf, COPY, recentSpend } from "./lib/quota.mjs"
import { ensureKey, pruneKeys } from "./lib/keys.mjs"
import {
  readConsoleCookie,
  renewSilently,
  requireBrowser,
  signInWithBrowser,
} from "./lib/browser.mjs"

const ID = "moss"
const NAME = "MOSS"
const NPM = "@ai-sdk/openai-compatible"
const EARLY_MS = 10 * 60_000
const QUOTA_TTL_MS = 60_000
const DEFAULT_LOGIN_TIMEOUT_MS = 8 * 60_000

// Nex-N2.6 and tob-kimi-k3 are the chat families the platform serves; a
// date snapshot fixes Nex's version. The docs' output cap is 131072, default
// 8192 (chat-completions). Context: Nex-N2.6 opened a 256K window
// (nex-agi's 2026-11-12 release note; magpie's live row for this key reads
// 262144 in / 235929 out). tob-kimi-k3 (Kimi K3, tob = to-business) has no
// published context number here and this key is not provisioned for it
// (chat answers 403 forbidden), so its spec stays unknown rather than
// invented — and it is not marked free.
//
// Measured on a live key (2026-11-21): chat completions, SSE streaming,
// tool calls, base64 image input and base64/public-URL video input all
// answer; `thinking: {type: "disabled"}` is refused with 400 ("Nex does not
// support disabling thinking"), so no reasoning level turns thinking off;
// a public media URL works only when MOSS's fetcher can reach it (wikimedia
// and google are refused with `media download failed`), so base64 is the
// reliable form; the request body caps at 8 MiB measured (docs say 10 MiB);
// a key MOSS does not take is refused with 403 `permission_error`
// (code 102111001),
// not 401.
const BOOT_MODELS = {
  "nex-n2.6": {
    name: "Nex-N2.6",
    context: 262144,
    output: 131072,
    reasoning: true,
    tool: true,
    image: true,
    free: true,
  },
  "nex-n2.6-2026-11-05": {
    name: "Nex-N2.6 (2026-11-05)",
    context: 262144,
    output: 131072,
    reasoning: true,
    tool: true,
    image: true,
    free: true,
  },
  "tob-kimi-k3": {
    name: "Kimi K3 (ToB)",
    // No published context number for this id on MOSS; the probe with a
    // self-serve key is refused (403 forbidden), so the spec stays unknown.
    context: 0,
    output: 0,
    reasoning: true,
    tool: true,
    image: false,
  },
}

// A live /v1/models lists every capability the platform sells (TTS, speech
// transcription, image generation, realtime video…), most of which are not
// chat endpoints a gateway can drive. Only ids matching CHAT_MODEL are
// listed as chat models; everything else stays out. A future chat model
// whose id matches nothing here is still listed (spec unknown → text-only,
// output cap 0), so a new model is never silently dropped — and never sent
// what it cannot read (the river rule).
const CHAT_MODEL = /^(nex-|tob-kimi-)/

// Measured multimodal chat ids. Anything else stays text-only.
const IMAGES = new Set(["nex-n2.6", "nex-n2.6-2026-11-05"])

function row(id, spec = {}) {
  const image = IMAGES.has(id) || spec.image === true
  return {
    id,
    name: spec.name ?? id,
    limit: { context: spec.context ?? 0, output: spec.output ?? 0 },
    reasoning: spec.reasoning ?? false,
    tool_call: spec.tool ?? false,
    modalities: { input: image ? ["text", "image"] : ["text"], output: ["text"] },
    capabilities: {
      reasoning: spec.reasoning ?? false,
      toolcall: spec.tool ?? false,
      attachment: image,
      input: { text: true, image },
      output: { text: true },
    },
    // `free: true` is the row flag magpie's model picker renders as the free
    // badge (same convention as astudio/catpaw); cost 0/0 additionally stops
    // magpie from billing the time-limited-free price.
    ...(spec.free ? { free: true, cost: { input: 0, output: 0 } } : {}),
  }
}

function rowsFor(ids) {
  const out = {}
  for (const id of ids) {
    if (typeof id !== "string" || !id) continue
    if (!CHAT_MODEL.test(id)) continue
    out[id] = row(id, BOOT_MODELS[id] ?? { name: id })
  }
  return out
}

// accountModels lists the model ids a key can use. MOSS answers
// {"object":"list","data":[{"id":…}]} like every OpenAI-compatible server.
async function accountModels(fetchImpl, key) {
  return await fetchImpl(`${ENDPOINTS.api}/models`, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  })
}

const optNum = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback)

/** 第一个非空候选（trim 后）：`??` 会放过空串，这里不会。 */
function firstNonEmpty(...values) {
  for (const v of values) {
    const s = String(v ?? "").trim()
    if (s) return s
  }
  return ""
}

/**
 * 粘贴框里的"裸 token"是否看起来像 token：不含空白/分号、长度 ≥ 8、
 * 等号只出现在末尾（base64 padding），且不是 cookie 名本身。
 * 整串 cookie 交给 readConsoleToken；这条只收单值，防止把别的 cookie 存进来。
 */
function looksLikeToken(raw) {
  const s = String(raw ?? "").trim()
  if (s.length < 8) return false
  if (/\s|;/.test(s)) return false
  if (/moss_studio/i.test(s)) return false
  // "a=b" 是 cookie 形态；"abc==" 是 base64 padding，允许。
  if (/=[^=]/.test(s)) return false
  return true
}

function maskUser(value) {
  const s = String(value ?? "").trim()
  if (!s) return ""
  if (/^\d{11}$/.test(s)) return `${s.slice(0, 3)}****${s.slice(-4)}`
  if (/^[^@\s]+@[^@\s]+$/.test(s)) {
    const [local, domain] = s.split("@")
    return `${local.slice(0, 1)}***@${domain}`
  }
  return s
}

function accountIdentOf(who, fallback) {
  const name = firstNonEmpty(who?.Username, who?.username, who?.email, who?.phone_number)
  return name || fallback
}

function createPlugin(...args) {
  // Hosts call the plugin as fn(ctx) with everything in one object; tests and
  // older hosts pass (ctx, options). Accept both: the second argument, when
  // present, carries the plugin options (browser, timeouts, test hooks).
  const { client, magpie, fetchImpl = globalThis.fetch, ...ctxRest } = args[0] ?? {}
  const options = { ...ctxRest, ...(args[1] ?? {}) }
  // The three switches live in the provider editor (auth.options below) and
  // are read at the moment they matter. A factory option of the same name is
  // the fallback for hosts and tests without the host's option read.
  const opt = (key, fallback) => {
    try {
      const v = magpie?.option?.(ID, key)
      if (typeof v === "boolean") return v
    } catch {
      /* older host */
    }
    if (typeof options?.[key] === "boolean") return options[key]
    return fallback
  }
  const loginTimeoutMs = optNum(options.loginTimeoutMs, DEFAULT_LOGIN_TIMEOUT_MS)
  // an injection point for tests (the fake browser has no window title to
  // poll): hosts never pass it, so the real window-title wait always runs
  const waitForLogin = typeof options.waitForLogin === "function" ? options.waitForLogin : undefined
  const quotaTtlMs = optNum(options.quotaTtlMs, QUOTA_TTL_MS)
  const browserPath = typeof options.browser === "string" && options.browser.trim() ? options.browser.trim() : undefined
  // test hook: the browsers this machine has, in place of the real lookup
  const browserList = typeof options.browserCandidates === "function" ? options.browserCandidates : undefined

  const log = (level, message) => {
    try {
      // 兼容 (level, message) 与单参 (message) 两种调用。
      const text = message === undefined ? String(level ?? "") : String(message ?? "")
      const lvl = message === undefined ? "info" : String(level ?? "info")
      client?.app?.log?.({ body: { service: ID, level: lvl, message: cleanDetail(text) } })
    } catch {
      /* logging is best effort */
    }
  }

  // Caches are keyed by the credential that answered, never module-global:
  // two accounts must not read each other's credits or model lists.
  const quotaCache = new Map() // console token -> { at, value }
  const renewing = new Map() // account -> in-flight renew promise

  const apiKeyOf = (auth) => {
    if (!auth) return ""
    const raw = auth.type === "api" ? (auth.key ?? "") : (auth.apiKey ?? auth.access ?? "")
    return normalizeApiKey(raw)
  }
  // The browser sign-in is saved as an oauth entry with the token at the top
  // level. magpie saves an "api" method's answers under metadata instead:
  // {type: "api", key, metadata: {apiKey, consoleToken}} (host.js save()).
  const TOKEN_FIELDS = ["consoleToken", "console_token", "sessionToken", "mossToken"]
  const tokenField = (o) => TOKEN_FIELDS.find((k) => typeof o?.[k] === "string" && o[k].trim())
  const consoleTokenOf = (auth) => {
    const top = tokenField(auth)
    if (top) return auth[top].trim()
    const md = tokenField(auth?.metadata)
    return md ? auth.metadata[md].trim() : ""
  }
  /** A renewed token goes where the entry kept its token, so the entry keeps its shape. */
  const putToken = (auth, token) => {
    if (!tokenField(auth) && tokenField(auth?.metadata)) auth.metadata[tokenField(auth.metadata)] = token
    else auth[tokenField(auth) ?? "consoleToken"] = token
    return auth
  }
  const usernameOf = (auth) =>
    String(firstNonEmpty(auth?.username, auth?.accountId, auth?.email, auth?.metadata?.username, auth?.metadata?.accountId) ?? "").trim()

  const save = async (auth) => {
    if (typeof client?.auth?.set !== "function") return false
    try {
      await client.auth.set({ path: { id: ID }, body: auth })
      return true
    } catch {
      return false
    }
  }

  /** 静默续期（单飞，按账号分桶）：保留的 SSO 会话还在，就换一张会话。 */
  const renew = async (auth) => {
    if (!opt("keep_sign_in", true)) return ""
    // 桶键用凭据指纹而不是显示名：两个账号可能同名，凭据不会。
    const bucket = fingerprint(apiKeyOf(auth) || consoleTokenOf(auth) || JSON.stringify(auth))
    const inflight = renewing.get(bucket)
    if (inflight) return inflight
    const flight = (async () => {
      try {
        const token = await renewSilently({ browserPath, log })
        if (!token) return ""
        // 同一个 profile 可能同时开着另一个账号的会话：续期回来的 token 不
        // 属于本页的账号，再存回去就会串号，先核对一遍再决定。
        const expecting = firstNonEmpty(usernameOf(auth))
        if (expecting) {
          const who = await portalMe(token).catch(() => null)
          const holderName = firstNonEmpty(who?.Username, who?.username, who?.email, who?.phone_number)
          if (holderName && holderName !== expecting) {
            log("warn", "moss: the renewed session belongs to a different account, skipping")
            return ""
          }
        }
        putToken(auth, token)
        await save(auth)
        return token
      } finally {
        renewing.delete(bucket)
      }
    })()
    renewing.set(bucket, flight)
    return flight
  }

  async function readSummary(token) {
    const data = await usageSummary(token)
    // usage-summary 的应答里没有会话本身；把实际应答用的 token 带回去，
    // 后续的 me/transactions 用同一份凭据。
    return { data, __token: token }
  }

  function summaryError(e) {
    const status = e?.status
    if (status === 401 || status === 403) {
      return {
        plan: COPY.plan,
        windows: [],
        error: "console session expired; sign in again to see credits",
        signIn: "kept",
      }
    }
    return {
      plan: COPY.plan,
      windows: [],
      error: cleanDetail(`usage summary: ${e?.message ?? e}`),
      signIn: "kept",
    }
  }

  /** The key-only card: probe /v1/models so "unreachable" stays a network fact. */
  async function keyCard(key) {
    if (!key) return { error: "not signed in" }
    let res
    try {
      res = await accountModels(fetchImpl, key)
    } catch (error) {
      return { error: `MOSS unreachable: ${error?.cause?.code || error?.message || "network error"}`, windows: [] }
    }
    if (res.status === 401 || res.status === 403) {
      return { error: `MOSS refused this key (HTTP ${res.status}); sign in again`, signIn: "expired", windows: [] }
    }
    if (!res.ok) return { error: `MOSS answered HTTP ${res.status}`, windows: [] }
    return {
      plan: "MOSS API",
      windows: [],
      error: "Sign in through the browser (or paste a console session token) to see credits.",
      signIn: "kept",
    }
  }

  /** The credit card, from the console session. */
  async function creditCard(getAuth, auth, token) {
    const cached = quotaCache.get(token)
    if (cached && Date.now() - cached.at < quotaTtlMs) return cached.value

    // 401/403 先试静默续期（保活的 SSO 会话还在就能救回来），整次读取只试一次。
    let summary
    try {
      summary = await readSummary(token)
    } catch (e) {
      const status = e?.status
      if ((status === 401 || status === 403) && !renewing.size) {
        const renewed = await renew(auth)
        if (renewed && renewed !== token) {
          try {
            summary = await readSummary(renewed)
          } catch (e2) {
            return summaryError(e2)
          }
        } else {
          return summaryError(e)
        }
      } else {
        return summaryError(e)
      }
    }

    const who = await portalMe(summary.__token).catch(() => null)
    const user = maskUser(firstNonEmpty(who?.Username, who?.username, who?.email, who?.phone_number, usernameOf(auth)))
    const spend = await recentSpend(summary.__token, { log })
    const value = cardOf({ summary: summary.data, user, spendRow: spend })
    quotaCache.set(token, { at: Date.now(), value })
    if (quotaCache.size > 8) quotaCache.clear()
    return value
  }

  /**
   * 两个浏览器登录方式共用的 authorize：display 与候选浏览器的预检、
   * 开窗指令、回调里的建 Key。差别只在粘贴的 Key（零提示方式为空）。
   */
  const browserAuthorize = (pasted) => {
    if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      return {
        type: "failed",
        error:
          'The browser sign-in needs a display, and this machine has none. Sign in with "API key only", or with "API key + console token" to also get the credit card.',
      }
    }
    try {
      // an empty list fails here, before the host is told a window opened
      requireBrowser(browserPath, browserList ? { candidates: browserList } : undefined)
    } catch (e) {
      return { type: "failed", error: cleanDetail(e?.message ?? e) }
    }
    // The browser work runs in the callback: the host's authorize call
    // has a short deadline, while a sign-in can take minutes.
    return {
      url: "",
      opened: true,
      instructions:
        process.platform === "win32"
          ? "A browser window opens on the MOSS console (platform.mosi.cn). Sign in there; the plugin reads the completed sign-in by itself and closes the window. You do not need to close it. After the sign-in the plugin creates a moss-* API key on your account — the plaintext is shown once, and the plugin keeps it for you."
          : "A browser window opens on the MOSS console (platform.mosi.cn). Sign in there; the plugin watches the profile's cookie store and closes the window itself within about half a minute of the console session landing (Chrome writes cookies to disk on a timer) — you can leave the window open. After the sign-in the plugin creates a moss-* API key on your account — the plaintext is shown once, and the plugin keeps it for you.",
      method: "auto",
      async callback(_code, { signal } = {}) {
        let token = ""
        try {
          token = await signInWithBrowser({
            browserPath,
            keepSignIn: opt("keep_sign_in", true),
            timeoutMs: loginTimeoutMs,
            waitForLogin,
            signal,
            log,
          })
        } catch (e) {
          if (e?.cancelled) return { type: "failed", error: "the sign-in was cancelled" }
          return { type: "failed", error: cleanDetail(`MOSS sign-in: ${e?.message ?? e}`) }
        }
        try {
          const who = await portalMe(token).catch(() => null)
          const username = firstNonEmpty(who?.Username, who?.username, who?.email, who?.phone_number)
          // 如果账号段读不出，拿 token 的指纹兜底：保证两账号前缀永远不撞。
          const accountIdent = username || `anon-${fingerprint(token).slice(0, 8)}`
          const apiKey = await ensureKey(token, accountIdent, {
            apiKey: pasted,
            create: opt("create_key", true),
            prune: opt("prune_keys", true),
            log,
          })
          return {
            type: "success",
            access: apiKey,
            refresh: "",
            expires: 0,
            apiKey,
            consoleToken: token,
            accountId: username || `moss-${fingerprint(apiKey)}`,
            username: username || undefined,
            source: "browser",
          }
        } catch (e) {
          return { type: "failed", error: cleanDetail(`MOSS sign-in: ${e?.message ?? e}`) }
        }
      },
    }
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      // `??=` keeps a provider the user configured in plugins.json.
      cfg.provider[ID] ??= {
        name: NAME,
        npm: NPM, // chat completions
        api: ENDPOINTS.api,
        models: rowsFor(Object.keys(BOOT_MODELS)),
      }
    },

    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        // Both credential shapes carry an API key: an "api" method keeps it
        // in auth.key, a browser sign-in (oauth) keeps it at the top level.
        // A browser sign-in with key creation off has no key and keeps the
        // boot rows.
        const key = apiKeyOf(auth)
        if (!key) return provider.models
        let res
        try {
          res = await accountModels(fetchImpl, key)
        } catch {
          // A network failure keeps the previous list, like a non-2xx answer.
          return provider.models
        }
        if (res.status === 401 || res.status === 403) {
          throw Object.assign(new Error(`MOSS refused this key (HTTP ${res.status}); sign in again`), { signIn: "expired" })
        }
        if (!res.ok) return provider.models
        let body
        try {
          body = await res.json()
        } catch {
          throw new Error("MOSS sent no model list")
        }
        // A malformed answer keeps the previous list (the host marks it a
        // fallback); an empty one is the account's list, as its key has no
        // models, and replaces the bootstrap rows the way a live catalog does.
        if (!Array.isArray(body?.data) || body.data.some((m) => typeof m?.id !== "string" || !m.id)) {
          throw new Error("MOSS sent no model list")
        }
        return rowsFor(body.data.map((m) => m.id))
      },
    },

    auth: {
      provider: ID,

      options: [
        {
          key: "create_key",
          label: "Create an API key on browser sign-in",
          description:
            "After a browser sign-in, create a MOSS API key on the account if none was pasted. The plaintext is shown once, so the plugin keeps it. (Key limit: 50 per account).",
          labels: {
            zh: "浏览器登录后创建 API Key",
            "zh-TW": "瀏覽器登入後建立 API Key",
            ja: "ブラウザーサインイン後にAPIキーを作成",
            de: "Nach dem Browser-Login ein API-Key erstellen",
          },
          descriptions: {
            zh: "浏览器登录时若输入框留空，就为账号新建一把 MOSS API Key（上限 50 把）。明文只显示一次，插件会保存它。",
            "zh-TW": "瀏覽器登入時若輸入框留空，就為帳號建立一把 MOSS API Key（上限 50 把）。明文只顯示一次，外掛會保存它。",
            ja: "ブラウザーサインイン時に入力欄が空なら、アカウントに新しいMOSS APIキーを作成します（上限50個）。平文は一度だけ表示されるため保存します。",
            de: "Wird beim Browser-Login kein Key eingefügt, wird ein neuer MOSS-API-Key für das Konto erstellt (Limit: 50). Der Klartext wird nur einmal angezeigt und gespeichert.",
          },
          default: true,
        },
        {
          key: "prune_keys",
          label: "Prune old MOSS API keys",
          description:
            "Keep the newest two moss-<host>-<account>-* keys and delete older ones on this machine. The key created on this sign-in is always kept; manual keys, and keys whose creation time cannot be read, are never deleted.",
          labels: {
            zh: "清理旧的 MOSS API Key",
            "zh-TW": "清理舊的 MOSS API Key",
            ja: "古いMOSS APIキーを整理",
            de: "Alte MOSS-API-Keys entfernen",
          },
          descriptions: {
            zh: "保留本机最新的两个 moss-<host>-<account>-* 密钥，删除更早的。本次登录创建的密钥始终保留；手动创建的、或无法读取创建时间的密钥绝不删除。",
            "zh-TW": "保留本機最新的兩個 moss-<host>-<account>-* 金鑰，刪除較舊的。本次登入建立的金鑰始終保留；手動建立的、或無法讀取建立時間的金鑰絕不刪除。",
            ja: "このマシン上の最新2つの moss-<host>-<account>-* キーだけを残し、古いものを削除します。今回のサインインで作成したキーは必ず残ります。手動で作成したキーと作成時刻を読み取れないキーは削除しません。",
            de: "Behält die zwei neuesten moss-<host>-<account>-* Keys und löscht ältere. Der bei dieser Anmeldung erstellte Key bleibt immer erhalten; manuelle Keys und Keys ohne lesbare Erstellungszeit werden nie gelöscht.",
          },
          confirm:
            "Old moss-<host>-<account>-* keys on this machine will be deleted; manual keys, unreadable keys and the key from this sign-in are kept.",
          confirms: {
            zh: "将删除本机旧的 moss-<host>-<account>-* 密钥；手动创建的密钥和本次登录创建的密钥会保留。",
            "zh-TW": "將刪除本機舊的 moss-<host>-<account>-* 金鑰；手動建立的金鑰和本次登入建立的金鑰會保留。",
            ja: "このマシン上の古い moss-<host>-<account>-* キーを削除します。手動で作成したキーと今回のサインインで作成したキーは残します。",
            de: "Alte moss-<host>-<account>-* Keys werden gelöscht; manuell erstellte Keys und der bei dieser Anmeldung erstellte Key bleiben erhalten.",
          },
          default: true,
        },
        {
          key: "keep_sign_in",
          label: "Keep a browser profile for silent renewal",
          description:
            "Keep a dedicated browser profile with the console session, so an about-to-expire session is renewed headlessly. Off: a one-off profile is deleted after each login and an expired session needs a manual sign-in.",
          labels: {
            zh: "保留浏览器配置用于静默续期",
            "zh-TW": "保留瀏覽器設定用於靜默續期",
            ja: "サイレント更新用にブラウザープロファイルを保持",
            de: "Browser-Profil für stilles Erneuern behalten",
          },
          descriptions: {
            zh: "保留包含控制台会话的专用浏览器配置，以便会话即将过期时无头续期。关闭后，每次登录后删除一次性配置，过期会话需手动重新登录。",
            "zh-TW": "保留包含控制台工作階段的專用瀏覽器設定，以便會話即將過期時無痕續期。關閉後，每次登入後刪除一次性的設定，過期會話需手動重新登入。",
            ja: "コンソールセッションを保存した専用ブラウザープロファイルを保持し、セッションの期限直前にヘッドレスで更新します。無効にすると、ログインごとに一時プロファイルを削除し、期限切れセッションは手動で再サインインが必要です。",
            de: "Behält ein eigenes Browser-Profil mit der Konsolen-Session, damit eine bald ablaufende Session headless erneuert wird. Aus: einmaliges Profil wird nach jeder Anmeldung gelöscht; eine abgelaufene Session erfordert eine manuelle Anmeldung.",
          },
          default: true,
        },
      ],

      methods: [
        {
          type: "oauth",
          label: "Browser sign-in (credit card + creates an API key)",
          /**
           * 零提示：点一下直接开窗，登录后自动建 moss-* Key。与 inkstone、
           * sensenova 的浏览器登录同款——生态惯例是浏览器登录不问问题。
           */
          authorize() {
            return browserAuthorize("")
          },
        },
        {
          type: "oauth",
          label: "Browser sign-in + reuse an existing API key",
          /**
           * 浏览器登录前可粘贴已有 Key（留空则自动新建）。唯一一个先问
           * 一句再开窗的浏览器方式；不想被问就用上一个。
           */
          prompts: [
            {
              type: "password",
              key: "apiKey",
              required: false, // empty means "create one after the browser sign-in"
              message: "Leave empty to sign in in a browser (paste an existing key to reuse it)",
              placeholder: "sk-...",
              validate: (v) => {
                const s = String(v ?? "").trim()
                return s === "" || s.startsWith("sk-") ? undefined : "the key starts with sk-"
              },
            },
          ],
          authorize(inputs) {
            return browserAuthorize(normalizeApiKey(inputs?.apiKey))
          },
        },
        {
          type: "api",
          label: "API key only (models, no credit card)",
          prompts: [
            {
              type: "password",
              key: "apiKey",
              message: "MOSS API key (console → API Keys)",
              placeholder: "sk-...",
              validate: (v) => (normalizeApiKey(v) ? undefined : "API key is required"),
            },
          ],
          async authorize(inputs) {
            const key = normalizeApiKey(inputs?.apiKey)
            if (!key) return { type: "failed", error: "API key is required" }
            try {
              await probeApiKey(key)
            } catch (e) {
              if (e?.status === 401 || e?.status === 403) return { type: "failed", error: cleanDetail(e.message) }
              log("warn", `moss: API key probe did not finish (${e?.message ?? e})`)
            }
            return {
              type: "success",
              key,
              accountId: `moss-${fingerprint(key)}`,
              source: "api",
            }
          },
        },
        {
          type: "api",
          label: "API key + console token (models + credit card)",
          prompts: [
            {
              type: "password",
              key: "apiKey",
              message: "MOSS API key",
              placeholder: "sk-...",
              validate: (v) => (normalizeApiKey(v) ? undefined : "API key is required"),
            },
            {
              type: "password",
              key: "consoleToken",
              message:
                'Console session token (paste just the token value, or the full "moss_studio_prod_access_token=…" cookie entry)',
              validate: (v) => (String(v ?? "").trim() ? undefined : "console token is required"),
            },
          ],
          async authorize(inputs) {
            const key = normalizeApiKey(inputs?.apiKey)
            // 用户可能粘贴整串 document.cookie，也可能只粘 token 本身：
            // 前者取 moss_studio_prod_access_token 的值；后者必须是看起来像
            // token 的单个裸值。其余（含别的 cookie 但没有会话名）一律拒绝，
            // 绝不整串存进凭据库。
            const raw = String(inputs?.consoleToken ?? "").trim()
            const bare = looksLikeToken(raw) ? raw : ""
            const token = readConsoleToken(raw) || bare
            if (!key) return { type: "failed", error: "API key is required" }
            if (!token) {
              return {
                type: "failed",
                error:
                  'could not read a console session token from that string — paste just the token value or the full "moss_studio_prod_access_token=…" cookie entry',
              }
            }
            try {
              await probeApiKey(key)
            } catch (e) {
              if (e?.status === 401 || e?.status === 403) return { type: "failed", error: cleanDetail(e.message) }
              log("warn", `moss: API key probe did not finish (${e?.message ?? e})`)
            }
            try {
              const who = await portalMe(token)
              const accountIdent = accountIdentOf(who, `moss-${fingerprint(key)}`)
              const username = firstNonEmpty(who?.Username, who?.username)
              return {
                type: "success",
                key,
                consoleToken: token,
                accountId: accountIdent,
                username: username || undefined,
                source: "manual",
                // magpie keeps an api method's answers as metadata, and this
                // metadata over them: the token read out of the paste, never
                // the whole pasted cookie string (inkstone #826).
                metadata: { apiKey: key, consoleToken: token, accountId: accountIdent, username, source: "manual" },
              }
            } catch (e) {
              return { type: "failed", error: cleanDetail(`console token: ${e?.message ?? e}`) }
            }
          },
        },
      ],

      // magpie sends `Authorization: Bearer <apiKey>` for
      // @ai-sdk/openai-compatible; the host applies the account's proxy to
      // every request.
      async loader(getAuth) {
        const auth = await getAuth()
        const key = apiKeyOf(auth)
        if (!key) return {}
        return { baseURL: ENDPOINTS.api, apiKey: key }
      },

      /**
       * The account card. With a console session (browser sign-in or a pasted
       * token) it is the credit balance plus, when it reads, the recent
       * credit movement; a key-only account gets its key probed and an honest
       * note that credits need a browser sign-in.
       */
      async usage(getAuth) {
        const auth = await getAuth()
        if (!auth) return { error: "not signed in" }
        const token = consoleTokenOf(auth)
        if (!token) return keyCard(apiKeyOf(auth))
        return creditCard(getAuth, auth, token)
      },
    },
  }
}

// The plugin is the only exported function; magpie calls every exported
// function as a plugin, so tests reach the internals through this object.
export const MossPlugin = async (...args) => createPlugin(...args)
export const _internal = {
  createPlugin,
  row,
  rowsFor,
  accountModels,
  BOOT_MODELS,
  IMAGES,
  ID,
  NAME,
  NPM,
  ENDPOINTS,
  KEY_LIMIT,
  ProtocolError,
}
