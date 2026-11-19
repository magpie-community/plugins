import { getCreditStats, setCreditBalance } from "./canvas-state.mjs"
import { hasCliRunnerForTests, isCliInstalled, runCli } from "./cli.mjs"
import { DEFAULT_CREDIT_CEILING, createMediaFetch } from "./media.mjs"
import { BASE_URL, LIVE_META, NPM_IMAGE, configModels, fetchLiveModels, openCodeModelOf } from "./models.mjs"

const PROVIDER_ID = "dreamina"
const PROVIDER_NAME = "Dreamina (即梦)"
const DREAMINA_ICON =
  "data:image/png;base64,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"
const DEFAULT_PROFILE = "default"
const PROFILE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

const VIP_LEVEL_LABELS = {
  maestro: "大师会员",
  advanced: "高级会员",
  pro: "专业会员",
  standard: "标准会员",
  basic: "基础会员",
}

function formatVipStatus(acct) {
  const isVip = Boolean(acct?.isVip)
  if (!isVip) return "普通用户"
  const rawLevel = typeof acct?.vipLevel === "string" ? acct.vipLevel.trim() : ""
  if (!rawLevel) return "VIP 会员"
  const tierLabel = VIP_LEVEL_LABELS[rawLevel.toLowerCase()] ?? rawLevel
  return `VIP · ${tierLabel}`
}

function parseNonNegNumber(val) {
  if (val === null || val === undefined || typeof val === "boolean") return null
  if (typeof val === "string") {
    const trimmed = val.trim()
    if (!trimmed || !/^\d+(?:\.\d+)?$/.test(trimmed)) return null
    val = Number(trimmed)
  }
  return typeof val === "number" && Number.isFinite(val) && val >= 0 ? val : null
}

function extractLiveBalance(acct) {
  if (!acct || typeof acct !== "object") return null
  for (const key of ["credits", "balance", "remainingCredits", "points"]) {
    const parsed = parseNonNegNumber(acct[key])
    if (parsed !== null) return parsed
  }
  return null
}

function resolveActiveGuardLabel(magpie) {
  const quoteOnly = typeof magpie?.option === "function" && magpie.option(PROVIDER_ID, "quote_only") === true
  if (quoteOnly) return "仅报价预演（不扣点）"
  const guardRaw = typeof magpie?.option === "function" ? magpie.option(PROVIDER_ID, "credit_guard") : undefined
  const guardEnabled = guardRaw === undefined ? true : Boolean(guardRaw)
  if (!guardEnabled) return "无上限保护"
  const envRaw = process.env.DREAMINA_CREDIT_CEILING
  const envVal = envRaw !== undefined && envRaw !== "" ? Number(envRaw) : NaN
  const ceiling = Number.isInteger(envVal) && envVal >= 0 ? envVal : DEFAULT_CREDIT_CEILING
  return `单次上限 ${ceiling} 点`
}

function normalizeProfile(raw) {
  const s = String(raw ?? "").trim()
  if (!s) return DEFAULT_PROFILE
  if (!PROFILE_PATTERN.test(s)) {
    throw new Error("Invalid Dreamina profile name. Use letters, digits, '.', '_', or '-' (max 64 chars).")
  }
  return s
}

function profileOfAuth(auth) {
  const raw = auth?.metadata?.profile ?? auth?.profile ?? DEFAULT_PROFILE
  const s = String(raw ?? "").trim()
  return s && PROFILE_PATTERN.test(s) ? s : DEFAULT_PROFILE
}

function parseExpiresMs(expiresAt) {
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
    return expiresAt < 1e11 ? Math.round(expiresAt * 1000) : Math.round(expiresAt)
  }
  if (typeof expiresAt === "string") {
    const trimmed = expiresAt.trim()
    if (!trimmed) return 0
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed)
      return Number.isFinite(n) && n > 0 ? (n < 1e11 ? Math.round(n * 1000) : Math.round(n)) : 0
    }
    const ms = Date.parse(trimmed)
    return Number.isFinite(ms) && ms > 0 ? ms : 0
  }
  return 0
}

function cliReady() {
  return hasCliRunnerForTests() || isCliInstalled()
}

function cliMissingFailure() {
  return {
    type: "failed",
    error: "dreamina-canvas CLI not found on this machine. Install dreamina-canvas and ensure it is on PATH (or set DREAMINA_CANVAS_BIN).",
  }
}

function isAuthExpiredResult(res) {
  if (!res) return false
  if (res.exitCode === 11) return true
  if (res.ok && res.data?.loggedIn === false) return true
  const cls = String(res.error?.class || "").toLowerCase()
  const action = String(res.error?.requiredAction || "").toLowerCase()
  const code = String(res.error?.code || "").toLowerCase()
  const msg = String(res.error?.message || "")
  return (
    cls === "auth" ||
    action === "reauth" ||
    action === "login" ||
    /auth|unauthenticated|unauthorized|not_logged_in/.test(code) ||
    /not (?:logged|signed) in|unauthenticated|unauthorized|login required|session.*expired|token.*expired/i.test(msg)
  )
}

async function finalizeProfileSignIn(profile, { statusData, initialCredits, directory, signal } = {}) {
  let finalStatus = statusData
  if (!finalStatus) {
    const statusRes = await runCli(profile, ["auth", "status"], { signal, timeoutMs: 15_000, check: false })
    if (!statusRes.ok || !statusRes.data?.loggedIn) {
      return {
        type: "failed",
        error: statusRes.error?.message || `Profile "${profile}" is not signed in to dreamina-canvas.`,
      }
    }
    finalStatus = statusRes.data
  }

  const parsedCredits = parseNonNegNumber(initialCredits)
  if (parsedCredits !== null) {
    await setCreditBalance(profile, { balance: parsedCredits, directory })
  }

  const accountRes = await runCli(profile, ["auth", "account"], { signal, timeoutMs: 15_000, check: false })
  const acct = accountRes?.ok ? accountRes.data : null
  const userId = acct?.userId != null ? String(acct.userId) : ""

  const accountLabel = userId ? `${profile} (${userId})` : profile

  return {
    type: "success",
    access: `dreamina-profile:${profile}`,
    refresh: `dreamina-profile:${profile}`,
    expires: parseExpiresMs(finalStatus?.expiresAt),
    accountId: accountLabel,
    account: accountLabel,
    ...(userId ? { uid: userId } : {}),
    metadata: {
      profile,
      region: typeof finalStatus?.region === "string" && finalStatus.region ? finalStatus.region : "cn",
      isVip: Boolean(acct?.isVip),
      vipLevel: typeof acct?.vipLevel === "string" ? acct.vipLevel : "",
    },
  }
}

const PROFILE_PROMPTS = [
  {
    type: "text",
    key: "profile",
    message: "dreamina-canvas profile name (leave blank for default)",
    messages: {
      zh: "dreamina-canvas profile 名称（留空则使用 default）",
      "zh-TW": "dreamina-canvas profile 名稱（留空則使用 default）",
    },
    placeholder: DEFAULT_PROFILE,
    required: false,
    validate: (value) => {
      const v = String(value ?? "").trim()
      if (!v) return null
      if (!PROFILE_PATTERN.test(v)) {
        return "Profile name must use letters, digits, '.', '_', or '-' (max 64 chars)"
      }
      return null
    },
  },
  {
    type: "text",
    key: "credits",
    message: "Current credit balance (optional, e.g. 1000)",
    messages: {
      zh: "当前即梦点数余额（选填，如 1000；填入后自动按次扣减）",
      "zh-TW": "目前即夢點數餘額（選填，如 1000；填入後自動按次扣減）",
    },
    placeholder: "选填，留空则仅统计已用点数",
    required: false,
    validate: (value) => {
      const v = String(value ?? "").trim()
      if (!v) return null
      if (!/^\d+(?:\.\d+)?$/.test(v) || Number(v) < 0) {
        return "Must be a non-negative number"
      }
      return null
    },
  },
]

export const DreaminaAuthPlugin = async (input = {}) => {
  const directory = input?.directory || process.cwd()
  const magpie = input?.magpie

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const existing = cfg.provider[PROVIDER_ID] ?? {}
      cfg.provider[PROVIDER_ID] = {
        ...existing,
        id: PROVIDER_ID,
        name: existing.name ?? PROVIDER_NAME,
        npm: existing.npm ?? NPM_IMAGE,
        api: existing.api ?? BASE_URL,
        models: { ...configModels(), ...(existing.models ?? {}) },
      }
    },
    auth: {
      provider: PROVIDER_ID,
      icon: DREAMINA_ICON,
      maxConcurrency: 4,
      cli: {
        name: "Dreamina Canvas CLI (dreamina-canvas)",
        manual: "Install dreamina-canvas locally and ensure it is on PATH (or set DREAMINA_CANVAS_BIN).",
        installed: async () => isCliInstalled(),
        install: async () => {
          if (isCliInstalled()) return
          throw new Error("dreamina-canvas is not installed automatically. Install dreamina-canvas locally and ensure it is on PATH (or set DREAMINA_CANVAS_BIN).")
        },
      },
      options: [
        {
          key: "quote_only",
          label: "Quote only",
          labels: { zh: "仅报价（不扣积分）", "zh-TW": "僅報價（不扣積分）" },
          description: "Quote credits only without running generation.",
          descriptions: {
            zh: "只询价并返回预估点数，不执行生成",
            "zh-TW": "只詢價並回傳預估點數，不執行生成",
          },
          default: false,
        },
        {
          key: "credit_guard",
          label: "200-credit ceiling",
          labels: { zh: "单次 200 点上限保护", "zh-TW": "單次 200 點上限保護" },
          description: "Block runs quoted above 200 credits.",
          descriptions: {
            zh: "单次报价超过 200 点时自动拦截",
            "zh-TW": "單次報價超過 200 點時自動攔截",
          },
          default: true,
        },
      ],
      methods: [
        {
          type: "oauth",
          label: "Use existing dreamina-canvas CLI profile",
          labels: {
            zh: "使用本机已有 dreamina-canvas 登录配置",
            "zh-TW": "使用本機已有 dreamina-canvas 登入設定",
          },
          prompts: PROFILE_PROMPTS,
          authorize: async (inputs = {}, opts = {}) => {
            if (!cliReady()) return cliMissingFailure()
            let profile
            try {
              profile = normalizeProfile(inputs?.profile)
            } catch (err) {
              return { type: "failed", error: err.message }
            }

            const statusRes = await runCli(profile, ["auth", "status"], {
              signal: opts?.signal,
              timeoutMs: 15_000,
              check: false,
            })
            if (!statusRes.ok || !statusRes.data?.loggedIn) {
              return {
                type: "failed",
                error:
                  statusRes.error?.message ||
                  `dreamina-canvas profile "${profile}" is not signed in. Use browser sign-in or run \`dreamina-canvas --profile ${profile} auth login\`.`,
              }
            }

            return {
              url: "",
              instructions: "",
              method: "auto",
              callback: async (_code, cbOpts = {}) =>
                finalizeProfileSignIn(profile, {
                  statusData: statusRes.data,
                  initialCredits: inputs?.credits,
                  directory,
                  signal: cbOpts?.signal ?? opts?.signal,
                }),
            }
          },
        },
        {
          type: "oauth",
          label: "Sign in with Dreamina (browser)",
          labels: {
            zh: "使用即梦浏览器登录",
            "zh-TW": "使用即夢瀏覽器登入",
          },
          prompts: PROFILE_PROMPTS,
          authorize: async (inputs = {}, opts = {}) => {
            if (!cliReady()) return cliMissingFailure()
            let profile
            try {
              profile = normalizeProfile(inputs?.profile)
            } catch (err) {
              return { type: "failed", error: err.message }
            }

            const loginRes = await runCli(profile, ["auth", "login"], {
              signal: opts?.signal,
              timeoutMs: 30_000,
              check: false,
            })
            if (!loginRes.ok) {
              return {
                type: "failed",
                error: loginRes.error?.message || "Failed to start Dreamina browser sign-in.",
              }
            }

            const data = loginRes.data ?? {}
            if (data.state?.loggedIn === true && !data.challenge?.deviceCode) {
              return {
                url: "",
                instructions: "",
                method: "auto",
                callback: async (_code, cbOpts = {}) =>
                  finalizeProfileSignIn(profile, {
                    statusData: { ...data, ...data.state },
                    initialCredits: inputs?.credits,
                    directory,
                    signal: cbOpts?.signal ?? opts?.signal,
                  }),
              }
            }

            const challenge = data.challenge
            if (!challenge?.deviceCode) {
              return {
                type: "failed",
                error: "dreamina-canvas auth login did not return a deviceCode challenge.",
              }
            }

            const url = challenge.verificationUriComplete || challenge.verificationUri || ""
            const instructions = challenge.userCode
              ? `Open the link in your browser to sign in to Dreamina (user code: ${challenge.userCode}).`
              : "Open the link in your browser to sign in to Dreamina."

            return {
              url,
              instructions,
              method: "auto",
              callback: async (_code, cbOpts = {}) => {
                const waitSignal =
                  opts?.signal && cbOpts?.signal
                    ? AbortSignal.any([opts.signal, cbOpts.signal])
                    : cbOpts?.signal ?? opts?.signal
                const waitRes = await runCli(
                  profile,
                  ["auth", "wait", "--device-code", challenge.deviceCode, "--timeout", "10m"],
                  { signal: waitSignal, timeoutMs: 610_000, check: false },
                )
                if (!waitRes.ok || !waitRes.data?.state?.loggedIn) {
                  return {
                    type: "failed",
                    error: waitRes.error?.message || "Dreamina browser sign-in did not complete.",
                  }
                }
                return finalizeProfileSignIn(profile, {
                  statusData: { ...waitRes.data, ...waitRes.data.state },
                  initialCredits: inputs?.credits,
                  directory,
                  signal: waitSignal,
                })
              },
            }
          },
        },
      ],
      refresh: async (auth) => {
        if (!cliReady()) {
          throw new Error("dreamina-canvas CLI not found on this machine.")
        }
        const profile = profileOfAuth(auth)
        const res = await runCli(profile, ["auth", "refresh"], {
          timeoutMs: 30_000,
          check: false,
        })
        if (res.ok && res.data?.loggedIn) {
          return {
            access: `dreamina-profile:${profile}`,
            refresh: `dreamina-profile:${profile}`,
            expires: parseExpiresMs(res.data.expiresAt),
            metadata: {
              ...(auth?.metadata ?? {}),
              profile,
              region: typeof res.data.region === "string" && res.data.region ? res.data.region : auth?.metadata?.region || "cn",
            },
          }
        }
        if (isAuthExpiredResult(res)) {
          throw Object.assign(
            new Error(res.error?.message || `Dreamina profile "${profile}" session expired; sign in again.`),
            { signIn: "expired" },
          )
        }
        throw new Error(res.error?.message || "Failed to refresh Dreamina session.")
      },
      usage: async (getAuth, _provider, opts = {}) => {
        if (!cliReady()) {
          return { error: "dreamina-canvas CLI not found on this machine.", signIn: "kept" }
        }
        const auth = await getAuth()
        const profile = profileOfAuth(auth)
        const statusRes = await runCli(profile, ["auth", "status"], {
          signal: opts?.signal,
          timeoutMs: 15_000,
          check: false,
        })
        if (!statusRes.ok || !statusRes.data?.loggedIn) {
          return {
            error: statusRes.error?.message || `Profile "${profile}" is not signed in to Dreamina.`,
            signIn: "expired",
          }
        }
        const accountRes = await runCli(profile, ["auth", "account"], {
          signal: opts?.signal,
          timeoutMs: 15_000,
          check: false,
        })
        const acct = accountRes?.ok
          ? accountRes.data
          : auth?.metadata && ("isVip" in auth.metadata || "vipLevel" in auth.metadata)
            ? { isVip: Boolean(auth.metadata.isVip), vipLevel: auth.metadata.vipLevel || "" }
            : null
        const plan = formatVipStatus(acct)
        const user = acct?.userId != null ? `${profile} (${acct.userId})` : profile
        const stats = await getCreditStats(profile, { directory }).catch(() => ({
          todayCredits: 0,
          totalCredits: 0,
          lastQuotedCredits: null,
          lastSpentCredits: null,
          runCount: 0,
          configuredBalance: null,
          spentSinceBalanceSet: 0,
          remainingCredits: null,
        }))
        const liveBalance = extractLiveBalance(acct)
        const envBalance = parseNonNegNumber(process.env.DREAMINA_CREDITS_BALANCE)
        const configuredBalance = parseNonNegNumber(stats.configuredBalance)
        const fallbackBalance = envBalance ?? configuredBalance

        if (liveBalance !== null) {
          return {
            plan,
            user,
            balance: `剩余 ${liveBalance} 点`,
            windows: [
              {
                name: "会员点数",
                display: `剩余 ${liveBalance} 点 · 今日已用 ${stats.todayCredits} 点`,
                aside: true,
              },
            ],
            signIn: "kept",
          }
        }

        if (fallbackBalance !== null && fallbackBalance > 0) {
          const totalBalance = fallbackBalance
          const used = envBalance !== null ? stats.todayCredits : (stats.spentSinceBalanceSet ?? 0)
          const remaining = Math.max(0, totalBalance - used)
          const usedPct = Math.min(100, Math.round((used / totalBalance) * 1000) / 10)
          return {
            plan,
            user,
            balance: `剩余 ${remaining} 点`,
            windows: [
              {
                name: "会员点数",
                used: usedPct,
                amount: used,
                limit: totalBalance,
                unit: "credits",
                display: `剩余 ${remaining} / ${totalBalance} 点 · 今日已用 ${stats.todayCredits} 点`,
                aside: true,
              },
            ],
            signIn: "kept",
          }
        }

        const guardLabel = resolveActiveGuardLabel(magpie)
        return {
          plan,
          user,
          windows: [
            {
              name: "今日点数",
              display:
                stats.totalCredits > 0
                  ? `已用 ${stats.todayCredits} 点 · 累计 ${stats.totalCredits} 点（${guardLabel}）`
                  : `已用 0 点 · ${guardLabel}`,
              aside: true,
            },
          ],
          signIn: "kept",
        }
      },
      loader: async (getAuth) => {
        const auth = await getAuth()
        const initialProfile = profileOfAuth(auth)
        return {
          baseURL: BASE_URL,
          apiKey: "dreamina-local",
          fetch: createMediaFetch({
            profile: initialProfile,
            getProfile: async () => profileOfAuth(await getAuth()),
            directory,
            getOption: (key) => (typeof magpie?.option === "function" ? magpie.option(PROVIDER_ID, key) : undefined),
          }),
        }
      },
    },
    provider: {
      id: PROVIDER_ID,
      npm: NPM_IMAGE,
      models: async (_given, ctx) => {
        const profile = profileOfAuth(ctx?.auth)
        const specs = await fetchLiveModels(profile, { signal: ctx?.signal })
        const out = {}
        for (const [id, spec] of Object.entries(specs)) {
          out[id] = openCodeModelOf(PROVIDER_ID, spec)
        }
        if (specs?.[LIVE_META]?.fellBack) {
          out[Symbol.for("magpie.fellBack")] = true
        }
        return out
      },
    },
  }
}

export default { id: PROVIDER_ID, server: DreaminaAuthPlugin }
