/**
 * 书生·端砚 TokenPlan for OpenCode and magpie.
 *
 * 一个账号两套凭据：
 *   - `uaa-token`（网页控制台登录态）读墨点：余额、5h/7d 窗口、墨点包；
 *   - `TOKENPLAN_API_KEY` 调模型（OpenAI Chat Completions）。
 *
 * 为什么要插件：直接接 API 只回 token usage，不回墨点余额；余额在控制台
 * 的 /api/tokenplan/v1/credits/* 里，需要网页登录态。插件替 magpie 持有
 * 这份登录态，把余额画成账户卡。
 *
 * provider id 是 `intern-inkstone`，不是 `intern` / `sensenova`：那些是别的
 * 产品或用户自己的 custom provider，本插件不与之冲突。
 */

import {
  ENDPOINTS,
  cleanDetail,
  fingerprint,
  normalizeApiKey,
  probeApiKey,
  apiModels,
  publicModels,
  creditsBalance,
  creditPackages,
  usersValidate,
  freeGrant,
} from "./lib/protocol.mjs"
import { bootModels, createCatalog, liveRowsOf, publicRowsOf } from "./lib/models.mjs"
import { cardOf } from "./lib/quota.mjs"
import { ensureKey, pruneKeys } from "./lib/keys.mjs"
import {
  browserCandidates,
  readUaaToken,
  renewSilently,
  signInWithBrowser,
  tokenFresh,
} from "./lib/browser.mjs"

const PROVIDER_ID = "intern-inkstone"
const NPM = "@ai-sdk/openai-compatible"
const NAME = "书生·端砚 "
const EARLY_MS = 10 * 60_000
const QUOTA_TTL_MS = 60_000
const DEFAULT_LOGIN_TIMEOUT_MS = 8 * 60_000

const apiBase = () => ENDPOINTS.api

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
 * 等号只出现在末尾（base64 padding），且不是 `uaa-token` 这种 cookie 名。
 * 整串 cookie 交给 readUaaToken；这条只收单值，防止把别的 cookie 存进来。
 */
function looksLikeToken(raw) {
  const s = String(raw ?? "").trim()
  if (s.length < 8) return false
  if (/\s|;/.test(s)) return false
  if (/^uaa-token$/i.test(s)) return false
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

export async function InkStoneAuthPlugin({ client, magpie } = {}, options = {}) {
  // The three switches live in the provider editor (auth.options below) and
  // are read at the moment they matter — sign-in reads create/prune, renewal
  // reads keep — so flipping one applies without a re-sign-in. A factory
  // option of the same name is the fallback for hosts and tests without the
  // host's option read.
  const opt = (key, fallback) => {
    try {
      const v = magpie?.option?.(PROVIDER_ID, key)
      if (typeof v === "boolean") return v
    } catch {
      /* older host */
    }
    if (typeof options?.[key] === "boolean") return options[key]
    return fallback
  }
  const createKeyOn = () => opt("create_key", true)
  const pruneOn = () => opt("prune_keys", false)
  const keepSignInOn = () => opt("keep_sign_in", true)
  const loginTimeoutMs = optNum(options.loginTimeoutMs, DEFAULT_LOGIN_TIMEOUT_MS)
  const quotaTtlMs = optNum(options.quotaTtlMs, QUOTA_TTL_MS)
  const browserPath = typeof options.browser === "string" && options.browser.trim() ? options.browser.trim() : undefined

  const log = (level, message) => {
    try {
      // 兼顾 (level, message) 和单参 (message) 两种调用。
      const text = message === undefined ? String(level ?? "") : String(message ?? "")
      const lvl = message === undefined ? "info" : String(level ?? "info")
      client?.app?.log?.({ body: { service: PROVIDER_ID, level: lvl, message: cleanDetail(text) } })
    } catch {
      /* logging is best effort */
    }
  }

  const catalog = createCatalog({
    fetchLive: async (key) => liveRowsOf(await apiModels(key)),
    fetchMeta: async () => publicRowsOf(await publicModels()),
  })

  // Caches are keyed by the credential that answered, never module-global:
  // two accounts must not read each other's credits or model lists.
  const quotaCache = new Map() // uaa token -> { at, value }
  const renewing = new Map() // account -> in-flight renew promise

  const apiKeyOf = (auth) => {
    if (!auth) return ""
    const raw = auth.type === "api" ? (auth.key ?? "") : (auth.apiKey ?? auth.access ?? "")
    return normalizeApiKey(raw)
  }
  const uaaTokenOf = (auth) => String(auth?.uaaToken ?? auth?.uaa_token ?? auth?.consoleToken ?? "").trim()
  const usernameOf = (auth) => String(auth?.username ?? auth?.accountId ?? auth?.email ?? "").trim()

  const save = async (auth) => {
    if (typeof client?.auth?.set !== "function") return false
    try {
      await client.auth.set({ path: { id: PROVIDER_ID }, body: auth })
      return true
    } catch {
      return false
    }
  }

  /** 静默续期（单飞，按账号分桶）：保留的 SSO 会话还在，就换一张新的 uaa-token。 */
  const renew = async (auth) => {
    if (!keepSignInOn()) return ""
    // 桶键用凭据指纹而不是显示名：两个账号可能同名，凭据不会。
    const bucket = fingerprint(apiKeyOf(auth) || uaaTokenOf(auth) || JSON.stringify(auth))
    const inflight = renewing.get(bucket)
    if (inflight) return inflight
    const flight = (async () => {
      try {
        const token = await renewSilently({ browserPath, log })
        if (!token) return ""
        // 同一个 profile 可能同时开着另一个账号的会话：续期回来的 token 不属于
        // 本页的账号，再存回去就会串号，先核对一遍再决定。
        const expecting = firstNonEmpty(usernameOf(auth))
        if (expecting) {
          const holder = await usersValidate(token).catch(() => null)
          const holderName = firstNonEmpty(
            holder?.data?.name, holder?.data?.username, holder?.data?.nickname, holder?.data?.phone, holder?.data?.email,
          )
          if (holderName && holderName !== expecting) {
            log("warn", "inkstone: the renewed session belongs to a different account, skipping")
            return ""
          }
        }
        auth.uaaToken = token
        await save(auth)
        return token
      } finally {
        renewing.delete(bucket)
      }
    })()
    renewing.set(bucket, flight)
    return flight
  }

  const ensureFreshToken = async (auth) => {
    const token = uaaTokenOf(auth)
    if (!token) return ""
    if (tokenFresh(token, EARLY_MS)) return token
    log("info", "inkstone: console token is near expiry; renewing silently")
    return (await renew(auth)) || token
  }

  const readQuota = async (getAuth, auth, depth = 0) => {
    let token = await ensureFreshToken(auth)
    if (!token) {
      return {
        plan: "墨点计划 (Token Plan)",
        windows: [],
        error: "Sign in through the browser (or paste a console uaa-token) to see ink credits.",
        signIn: "kept",
      }
    }

    const cached = quotaCache.get(token)
    if (cached && Date.now() - cached.at < quotaTtlMs) return cached.value

    const [balanceRes, packagesRes, userRes] = await Promise.allSettled([
      creditsBalance(token),
      creditPackages(token, { query: { status: "all", page: 1, page_size: 50 } }),
      usersValidate(token),
    ])

    if (balanceRes.status === "rejected") {
      const status = balanceRes.reason?.status
      if (status === 403) {
        return {
          plan: "墨点计划 (Token Plan)",
          windows: [],
          error: "TokenPlan account disabled in the console",
          signIn: "kept",
        }
      }
      if (status === 401) {
        // 整次额度读取只允许一次续期重试：同一枚过期 token 反复续期没有意义。
        if (depth < 1) {
          const fresh = await getAuth()
          const next = uaaTokenOf(fresh)
          if (next && next !== token) return await readQuota(getAuth, fresh, depth + 1)
          const renewed = await renew(auth)
          if (renewed && renewed !== token) return await readQuota(getAuth, { ...auth, uaaToken: renewed }, depth + 1)
        }
        return {
          plan: "墨点计划 (Token Plan)",
          windows: [],
          error: "console session expired; sign in again to see ink credits",
          signIn: "kept",
        }
      }
      return {
        plan: "墨点计划 (Token Plan)",
        windows: [],
        error: cleanDetail(`credit balance: ${balanceRes.reason?.message ?? balanceRes.reason}`),
        signIn: "kept",
      }
    }

    const balance = balanceRes.value?.data ?? {}
    const packages = packagesRes.status === "fulfilled" ? packagesRes.value?.data : null
    const userData = userRes.status === "fulfilled" ? userRes.value?.data : null
    const errors = []
    if (packagesRes.status === "rejected")
      errors.push(`credit packs: ${cleanDetail(packagesRes.reason?.message ?? packagesRes.reason)}`)
    if (userRes.status === "rejected") errors.push(`account: ${cleanDetail(userRes.reason?.message ?? userRes.reason)}`)

    const user = maskUser(firstNonEmpty(userData?.phone, userData?.name, userData?.username, userData?.nickname, usernameOf(auth)))
    const value = cardOf({ balance, packages, user, errors })
    // 包读取失败但余额成功：余额本身仍是真数据，只把包明细的错误挂上。
    quotaCache.set(token, { at: Date.now(), value })
    if (quotaCache.size > 8) quotaCache.clear()
    return value
  }

  const declareModels = () => {
    const declared = {}
    for (const [id, m] of Object.entries(bootModels())) declared[id] = m
    return declared
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const p = (cfg.provider[PROVIDER_ID] ??= {})
      p.name ??= NAME
      p.npm ??= NPM
      p.api ??= apiBase()
      p.models = { ...declareModels(), ...(p.models ?? {}) }
    },

    provider: {
      id: PROVIDER_ID,

      async models(provider, { auth } = {}) {
        const declared =
          provider?.models && Object.keys(provider.models).length > 0 ? provider.models : declareModels()
        if (!auth) return declared
        const key = apiKeyOf(auth)
        if (!key) return {}
        try {
          const rows = await catalog.forKey(key)
          if (!rows.length) return {}
          return Object.fromEntries(rows.map((r) => [r.id, r.model]))
        } catch (e) {
          // A refused key calls nothing; a failed read keeps the known set.
          if (e?.refused || e?.status === 401 || e?.status === 403) return {}
          log("warn", `inkstone: keeping the declared models (${e?.message ?? e})`)
          return declared
        }
      },
    },

    auth: {
      provider: PROVIDER_ID,

      options: [
        {
          key: "create_key",
          label: "Create an API key on browser sign-in",
          description:
            "After a browser sign-in, create a TokenPlan API key on the account if none was pasted. The plaintext is shown once, so the plugin keeps it. (Key limit: 10 per account).",
          labels: {
            zh: "浏览器登录后创建 API Key",
            "zh-TW": "瀏覽器登入後建立 API Key",
            ja: "ブラウザーサインイン後にAPIキーを作成",
            de: "Nach dem Browser-Login ein API-Key erstellen",
          },
          descriptions: {
            zh: "浏览器登录时若输入框留空，就为账号新建一把 TokenPlan API Key（不检查本机已有；上限 10 把）。明文只显示一次，插件会保存它。",
            "zh-TW": "瀏覽器登入時若輸入框留空，就為帳號建立一把 TokenPlan API Key（不檢查本機已有；上限 10 把）。明文只顯示一次，外掛會保存它。",
            ja: "ブラウザーサインイン時に入力欄が空なら、アカウントに新しいTokenPlan APIキーを作成します（上限10個）。平文は一度だけ表示されるため保存します。",
            de: "Wird beim Browser-Login kein Key eingefügt, wird ein neuer TokenPlan-API-Key für das Konto erstellt (Limit: 10). Der Klartext wird nur einmal angezeigt und gespeichert.",
          },
          default: true,
        },
        {
          key: "prune_keys",
          label: "Prune old inkstone API keys",
          description:
            "Keep the newest two ink-<host>-<account>-* keys and delete older ones on this machine. Manual keys, and keys whose creation time cannot be read, are never deleted.",
          labels: {
            zh: "清理旧的端砚 API Key",
            "zh-TW": "清理舊的端硯 API Key",
            ja: "古いInkStone APIキーを整理",
            de: "Alte InkStone-API-Keys entfernen",
          },
          descriptions: {
            zh: "保留本机最新的两个 ink-<host>-<account>-* 密钥，删除更早的。手动创建的、或无法读取创建时间的密钥绝不删除。",
            "zh-TW": "保留本機最新的兩個 ink-<host>-<account>-* 金鑰，刪除較舊的。手動建立的或無法讀取建立時間的金鑰絕不刪除。",
            ja: "このマシン上の最新2つの ink-<host>-<account>-* キーだけを残し、古いものを削除します。手動で作成したキーと作成時刻を読み取れないキーは削除しません。",
            de: "Behält die zwei neuesten ink-<host>-<account>-* Keys und löscht ältere. Manuelle Keys und Keys ohne lesbare Erstellungszeit werden nie gelöscht.",
          },
          confirm:
            "Old ink-<host>-<account>-* keys on this machine will be deleted; manual keys are kept.",
          confirms: {
            zh: "将删除本机旧的 ink-<host>-<account>-* 密钥；手动创建的密钥会保留。",
            "zh-TW": "將刪除本機舊的 ink-<host>-<account>-* 金鑰；手動建立的金鑰會保留。",
            ja: "このマシン上の古い ink-<host>-<account>-* キーを削除します。手動で作成したキーは残します。",
            de: "Alte ink-<host>-<account>-* Keys werden gelöscht; manuell erstellte Keys bleiben erhalten.",
          },
        },
        {
          key: "keep_sign_in",
          label: "Keep a browser profile for silent renewal",
          description:
            "Keep a dedicated browser profile with the console session, so an about-to-expire uaa-token is renewed headlessly. Off: a one-off profile is deleted after each login and an expired token needs a manual sign-in.",
          labels: {
            zh: "保留浏览器配置用于静默续期",
            "zh-TW": "保留瀏覽器設定用於靜默續期",
            ja: "サイレント更新用にブラウザープロファイルを保持",
            de: "Browser-Profil für stilles Erneuern behalten",
          },
          descriptions: {
            zh: "保留包含控制台会话的专用浏览器配置，以便 uaa-token 即将过期时无头续期。关闭后，每次登录后删除一次性配置，过期 token 需手动重新登录。",
            "zh-TW": "保留包含控制台工作階段的專用瀏覽器設定，以便 uaa-token 即將過期時無痕續期。關閉後，每次登入後刪除一次性的設定，過期 token 需手動重新登入。",
            ja: "コンソールセッションを保存した専用ブラウザープロファイルを保持し、uaa-token の期限直前にヘッドレスで更新します。無効にすると、ログインごとに一時プロファイルを削除し、期限切れトークンは手動で再サインインが必要です。",
            de: "Behält ein eigenes Browser-Profil mit der Konsolen-Session, damit ein bald ablaufender uaa-token headless erneuert wird. Aus: einmaliges Profil wird nach jeder Anmeldung gelöscht; ein abgelaufener Token erfordert eine manuelle Anmeldung.",
          },
          default: true,
        },
      ],

      methods: [
        {
          type: "oauth",
          label: "Browser sign-in (ink credits + creates an API key)",
           /**
            * 插件专用 profile 的窗口；插件实时读会话并自己关窗。
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
            const pasted = normalizeApiKey(inputs?.apiKey)
            if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
              return {
                type: "failed",
                error: "no display for the browser sign-in; use the API key sign-in on this machine",
              }
            }
            try {
              browserCandidates(browserPath)
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
                  ? "A browser window opens on the InkStone console. Sign in there (password, SMS or QR code); the plugin reads the completed sign-in by itself and closes the window. You do not need to close it. After the sign-in the plugin creates an ink-* API key on your account (leave the prompt empty; paste an existing key or turn off \"Create an API key on browser sign-in\" to skip) — the plaintext is shown once, and the plugin keeps it for you."
                  : "A browser window opens on the InkStone console. Sign in there (password, SMS or QR code), then close that window yourself; the plugin then reads the session from the profile and finishes. After the sign-in the plugin creates an ink-* API key on your account (leave the prompt empty; paste an existing key or turn off \"Create an API key on browser sign-in\" to skip) — the plaintext is shown once, and the plugin keeps it for you.",
              method: "auto",
              async callback(_code, { signal } = {}) {
                let token = ""
                try {
                  token = await signInWithBrowser({
                    browserPath,
                    keepSignIn: keepSignInOn(),
                    timeoutMs: loginTimeoutMs,
                    signal,
                    log,
                  })
                } catch (e) {
                  if (e?.cancelled) return { type: "failed", error: "the sign-in was cancelled" }
                  return { type: "failed", error: cleanDetail(`InkStone sign-in: ${e?.message ?? e}`) }
                }
                try {
                  const user = await usersValidate(token).catch(() => null)
                  const data = user?.data ?? {}
                  const username = firstNonEmpty(data.name, data.username, data.nickname, data.phone, data.email)
                  // 如果账号段读不出，拿 token 的指纹兜底：保证两账号前缀永远不撞。
                  const accountIdent = username || `anon-${fingerprint(token).slice(0, 8)}`
                  const apiKey = await ensureKey(token, accountIdent, {
                    apiKey: pasted,
                    create: createKeyOn(),
                    prune: pruneOn(),
                    log,
                  })
                  return {
                    type: "success",
                    access: apiKey,
                    refresh: "",
                    expires: 0,
                    apiKey,
                    uaaToken: token,
                    accountId: username || `inkstone-${fingerprint(apiKey)}`,
                    username,
                    source: "browser",
                  }
                } catch (e) {
                  return { type: "failed", error: cleanDetail(`InkStone sign-in: ${e?.message ?? e}`) }
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "API key only (models, no ink-credit card)",
          prompts: [
            {
              type: "password",
              key: "apiKey",
              message: "TokenPlan API key (console → 科研模型 → API Key)",
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
              log("warn", `inkstone: API key probe did not finish (${e?.message ?? e})`)
            }
            return {
              type: "success",
              key,
              accountId: `inkstone-${fingerprint(key)}`,
              source: "api",
            }
          },
        },
        {
          type: "api",
          label: "API key + console token (models + ink-credit card)",
          prompts: [
            {
              type: "password",
              key: "apiKey",
              message: "TokenPlan API key",
              placeholder: "sk-...",
              validate: (v) => (normalizeApiKey(v) ? undefined : "API key is required"),
            },
            {
              type: "password",
              key: "uaaToken",
              message: "Console uaa-token (paste just the token value, or the full \"uaa-token=…\" cookie entry)",
              validate: (v) => (String(v ?? "").trim() ? undefined : "console token is required"),
            },
          ],
          async authorize(inputs) {
            const key = normalizeApiKey(inputs?.apiKey)
            // 用户可能粘贴整串 document.cookie，也可能只粘 token 本身：
            // 前者取 uaa-token 的值；后者必须是看起来像 token 的单个裸值。
            // 其余（含别的 cookie 但没有 uaa-token）一律拒绝，绝不整串存进凭据库。
            const raw = String(inputs?.uaaToken ?? "").trim()
            const bare = looksLikeToken(raw) ? raw : ""
            const token = readUaaToken(raw) || bare
            if (!key) return { type: "failed", error: "API key is required" }
            if (!token) {
              return {
                type: "failed",
                error: 'could not read a uaa-token from that string — paste just the token value or the full "uaa-token=…" cookie entry',
              }
            }
            try {
              await probeApiKey(key)
            } catch (e) {
              if (e?.status === 401 || e?.status === 403) return { type: "failed", error: cleanDetail(e.message) }
              log("warn", `inkstone: API key probe did not finish (${e?.message ?? e})`)
            }
            try {
              const user = await usersValidate(token)
              const data = user?.data ?? {}
              return {
                type: "success",
                key,
                uaaToken: token,
                accountId: firstNonEmpty(data.name, data.username, data.nickname, data.phone, data.email, `inkstone-${fingerprint(key)}`),
                username: firstNonEmpty(data.name, data.username),
                source: "manual",
              }
            } catch (e) {
              return { type: "failed", error: cleanDetail(`console token: ${e?.message ?? e}`) }
            }
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth()
        const key = apiKeyOf(auth)
        if (!key) return {}
        return { baseURL: apiBase(), apiKey: key }
      },

      /**
       * 控制台首页会自动POST这个接口领月免费墨点（幂等）。
       * 交给 magpie 的 checkin 钩子：是否每天执行由用户在设置里开启，
       * 插件不再抢着替用户领、也不再四处轮询；需要重试交给 magpie。
       */
      async checkin(getAuth) {
        const auth = await getAuth?.()
        if (!auth) return { outcome: "failed", message: "sign in again" }
        const token = await ensureFreshToken(auth)
        if (!token) return { outcome: "failed", message: "sign in again" }
        try {
          const res = await freeGrant(token)
          // 控制台前端明确检查 has_received：为 true 表示已领到。
          if (res?.data?.has_received === false) {
            return { outcome: "failed", message: "free credits are not yet available" }
          }
          return { outcome: "done" }
        } catch (e) {
          // -15900: 未绑定手机号。
          if (e?.code === -15900) {
            return { outcome: "ineligible", message: "Bind a phone number in the InkStone console to claim free credits." }
          }
          // 401/403 让 error 带上 signIn，供 magpie 标记需要重新登录。
          const status = e?.status
          if (status === 401 || status === 403) {
            throw Object.assign(new Error("console session expired; sign in again"), { signIn: "expired" })
          }
          return { outcome: "failed", message: cleanDetail(e?.message ?? e) }
        }
      },

      async usage(getAuth) {
        const auth = await getAuth()
        if (!auth) return { error: "not signed in" }
        return await readQuota(getAuth, auth)
      },
    },
  }
}

/** Tests point ENDPOINTS at a local fake and replace the browser. */
export const _internal = {
  ENDPOINTS,
  PROVIDER_ID,
  NPM,
}

