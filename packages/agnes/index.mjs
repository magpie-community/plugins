import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Local browser sign-in: a private Chrome/Edge profile, read through CDP.
// The API key and console session are both obtained without asking for a password.
const ID = "agnes"
const BASE = "https://apihub.agnes-ai.com/v1"
const PLATFORM = "https://platform-backend.agnes-ai.com/api"
const LOGIN = "https://platform.agnes-ai.com/login?redirect=%2Fsettings%2FapiKeys"
const activeChrome = new Set()
process.once("exit", () => {
  for (const child of activeChrome) {
    try {
      child.kill("SIGKILL")
    } catch {}
  }
})

const MODELS = {
  "agnes-3.0-flash": {
    name: "Agnes 3.0 Flash",
    context: 524288,
    output: 65536,
    image: true,
    reasoning: true,
    cost: { input: 0.05, output: 0.15, cache_read: 0.005 },
  },
  "agnes-2.5-flash": {
    name: "Agnes 2.5 Flash",
    context: 524288,
    output: 65536,
    image: true,
    reasoning: true,
    cost: { input: 0.05, output: 0.15, cache_read: 0.005 },
  },
  "agnes-2.5-pro": {
    name: "Agnes 2.5 Pro",
    context: 1048576,
    output: 65536,
    image: true,
    reasoning: true,
    cost: { input: 0.45, output: 0.9, cache_read: 0.045 },
  },
  "agnes-2.5-pro-beta": {
    name: "Agnes 2.5 Pro Beta",
    context: 1048576,
    output: 65536,
    image: true,
    reasoning: true,
    cost: { input: 0.1, output: 0.3, cache_read: 0.01 },
  },
}

function modelRow(id, runtime = false) {
  const known = MODELS[id]
  const image = known?.image === true
  const reasoning = known?.reasoning ?? false
  const row = {
    ...(runtime ? { id, providerID: ID } : {}),
    name: known?.name ?? id,
    limit: { context: known?.context ?? 0, output: known?.output ?? 0 },
    reasoning,
    tool_call: true,
    modalities: { input: image ? ["text", "image"] : ["text"], output: ["text"] },
    ...(known?.cost ? { cost: known.cost } : {}),
  }
  if (!runtime) return row
  return {
    ...row,
    api: { id, url: BASE, npm: "@ai-sdk/openai-compatible" },
    status: "active",
    headers: {},
    options: {},
    capabilities: {
      temperature: true,
      reasoning,
      attachment: image,
      toolcall: true,
      input: { text: true, image },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    variants: {},
    free: false,
  }
}

const DEPRECATED = new Set(["agnes-2.0-flash", "agnes-2.5-pro-alpha"])
const isTextModel = (id) =>
  !/^agnes-(?:image|video)-/i.test(id) && !DEPRECATED.has(id.toLowerCase())

async function accountModels(fetchImpl, key) {
  return await fetchImpl(`${BASE}/models`, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  })
}

function createPlugin({
  fetchImpl = globalThis.fetch,
  openChrome = openChromeSession,
} = {}) {
  async function platform(path, token, { method = "GET" } = {}) {
    let res
    try {
      res = await fetchImpl(`${PLATFORM}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "x-user-language": "en-US",
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      })
    } catch (error) {
      return { error: error?.cause?.code || error?.message || "network error" }
    }
    if (res.status === 401 || res.status === 403) return { lapsed: true }
    if (!res.ok) return { error: `HTTP ${res.status}` }
    let body
    try {
      body = await res.json()
    } catch {
      return { error: "Agnes sent no JSON" }
    }
    if (body?.code === 401 || body?.code === 403) return { lapsed: true }
    if (body?.code === 404) return { missing: true }
    if (body?.code !== 200) return { error: body?.message || `code ${body?.code ?? "unknown"}` }
    return { data: body.data }
  }

  async function usage(getAuth) {
    const auth = await getAuth()
    if (!apiKeyOf(auth)) return {}
    const token = consoleTokenOf(auth)
    if (!token) {
      return {
        plan: "Agnes API",
        windows: [],
        error:
          "Agnes plan usage needs the console token from platform.agnes-ai.com; add one to this account",
        signIn: "kept",
      }
    }
    const profile = keyProfileOf(auth)
    if (profile !== "plan") {
      return await balanceOnlyUsage(
        token,
        profile,
        platform,
        auth.type === "oauth",
      )
    }

    const refused =
      auth.type === "oauth"
        ? "Agnes session was refused; sign in again"
        : "Agnes console token was refused; sign in again and paste a new token"
    const [legacyResult, agentResult] = await Promise.all([
      platform("/user/subscription", token),
      platform("/user/agentplan/subscription", token),
    ])
    if (legacyResult.lapsed || agentResult.lapsed) {
      return {
        plan: "Agnes API",
        windows: [],
        error: refused,
        signIn: "kept",
      }
    }

    let creditsResult = null
    if (agentResult.data) creditsResult = await platform("/user/agentplan/credits", token)
    if (creditsResult?.lapsed) {
      return {
        plan: "Agnes API",
        windows: [],
        error: refused,
        signIn: "kept",
      }
    }

    const legacy = legacyResult.data
    const agent = agentResult.data
    const credits = creditsResult?.data
    const windows = [...legacyWindows(legacy), ...agentWindows(agent, credits)]
    const planNames = [agentPlanName(agent), legacyPlanName(legacy)].filter(Boolean)
    const errors = []
    if (legacyResult.error) errors.push(`Token Plan usage couldn't be read: ${legacyResult.error}`)
    if (agentResult.error) errors.push(`Agent Plan usage couldn't be read: ${agentResult.error}`)
    if (creditsResult?.error) {
      errors.push(`Agent Plan credits couldn't be read: ${creditsResult.error}`)
    }

    return {
      plan: planNames.join(" + ") || "Agnes API",
      ...(vendorTime(agent?.current_period_end ?? legacy?.current_period_end)
        ? { until: vendorTime(agent?.current_period_end ?? legacy?.current_period_end) }
        : {}),
      ...(renewalOf(agent, legacy) ? { renew: renewalOf(agent, legacy) } : {}),
      windows,
      ...(errors.length ? { error: errors.join("; ") } : {}),
      signIn: "kept",
    }
  }

  async function browserAuthorize(profile) {
    const session = await openChrome(LOGIN)
    return {
      url: "",
      instructions:
        "Sign in to Agnes in the Chrome window that just opened. Magpie will finish automatically.",
      method: "auto",
      opened: true,
      callback: async () => {
        try {
          const token = await session.token(5 * 60 * 1000)
          if (!token) {
            return {
              type: "failed",
              error: "Agnes sign-in timed out; start it again",
            }
          }
          const self = await platform("/user/self", token)
          if (self.lapsed) {
            try {
              await session.evaluate('localStorage.removeItem("token")')
            } catch {}
            return {
              type: "failed",
              error: "Agnes session expired; sign in again",
            }
          }
          const key =
            profile === "plan"
              ? await revealApiKey(token, platform)
              : await revealProfileKey(token, profile, platform)
          return {
            type: "success",
            refresh: "",
            access: key,
            expires: 0,
            consoleToken: token,
            accountId: profileLabel(profile),
            source: "browser",
            keyProfile: profile,
          }
        } catch (error) {
          return {
            type: "failed",
            error: String(error?.message ?? error).slice(0, 500),
          }
        } finally {
          await session.close()
        }
      },
    }
  }

  return {
    async config(cfg) {
      cfg.provider ??= {}
      const was = cfg.provider[ID] ?? {}
      cfg.provider[ID] = {
        name: "Agnes",
        npm: "@ai-sdk/openai-compatible",
        api: BASE,
        ...was,
        models: {
          ...Object.fromEntries(Object.keys(MODELS).map((id) => [id, modelRow(id)])),
          ...(was.models ?? {}),
        },
      }
    },

    auth: {
      provider: ID,
      methods: [
        {
          type: "oauth",
          label: "Agnes browser sign-in (plan key)",
          authorize: () => browserAuthorize("plan"),
        },
        {
          type: "oauth",
          label: "Agnes browser sign-in (personal key)",
          authorize: () => browserAuthorize("default"),
        },
        {
          type: "oauth",
          label: "Agnes browser sign-in (enterprise key)",
          authorize: () => browserAuthorize("enterprise"),
        },
        {
          type: "api",
          label: "Agnes API key",
          placeholder: "cpk-…",
          prompts: [
            {
              type: "select",
              key: "keyProfile",
              message: "Key type (which usage card it should show)",
              options: [
                { label: "Plan key (Token/Agent Plan)", value: "plan" },
                { label: "Personal API key", value: "default" },
                { label: "Enterprise API key", value: "enterprise" },
              ],
            },
            {
              type: "text",
              key: "consoleToken",
              message: "Agnes console token (paste to show plan usage; leave empty to skip)",
              placeholder: "localStorage.token after signing in at platform.agnes-ai.com",
            },
          ],
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        const key = apiKeyOf(auth)
        if (!key) return {}
        return { baseURL: BASE, apiKey: key }
      },
      usage,
    },

    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const key = apiKeyOf(auth)
        if (!key) return provider?.models ?? {}
        let res
        try {
          res = await accountModels(fetchImpl, key)
        } catch {
          return provider?.models ?? {}
        }
        if (res.status === 401 || res.status === 403) {
          throw Object.assign(new Error(`Agnes refused this API key (HTTP ${res.status})`), {
            signIn: "expired",
          })
        }
        if (!res.ok) return provider?.models ?? {}
        let body
        try {
          body = await res.json()
        } catch {
          throw new Error("Agnes sent no model list")
        }
        if (
          !Array.isArray(body?.data) ||
          body.data.some((model) => typeof model?.id !== "string" || !model.id)
        ) {
          throw new Error("Agnes sent no model list")
        }
        const ids = [...new Set(body.data.map((model) => model.id).filter(isTextModel))]
        return Object.fromEntries(ids.map((id) => [id, modelRow(id, true)]))
      },
    },
  }
}

export const AgnesPlugin = async () => createPlugin()
export const _internal = {
  createPlugin,
  MODELS,
  BASE,
  PLATFORM,
  modelRow,
  isTextModel,
  legacyWindows,
  agentWindows,
  apiKeyOf,
  keyProfileOf,
  profileLabel,
  consoleTokenOf,
  revealApiKey,
  revealProfileKey,
  balanceText,
  browserArgs,
  browserProfileDir,
  findBrowser,
  cdpEvaluate,
  cdpTarget,
  openChromeSession,
  waitForBrowserToken,
  vendorTime,
}

function apiKeyOf(auth) {
  if (auth?.type === "api" && typeof auth.key === "string") return auth.key.trim()
  if (auth?.type === "oauth" && typeof auth.access === "string") return auth.access.trim()
  return ""
}

function keyProfileOf(auth) {
  const profile = auth?.keyProfile ?? auth?.metadata?.keyProfile
  if (profile === "plan" || profile === "default" || profile === "enterprise") {
    return profile
  }
  const key = apiKeyOf(auth)
  if (/^(?:cpk|apk)-/i.test(key)) return "plan"
  return ""
}

function profileLabel(profile) {
  if (profile === "default") return "Agnes Personal"
  if (profile === "enterprise") return "Agnes Enterprise"
  return "Agnes Plan"
}

function consoleTokenOf(auth) {
  const value = auth?.consoleToken ?? auth?.metadata?.consoleToken
  if (typeof value !== "string") return ""
  return value.trim().replace(/^Bearer\s+/i, "")
}

async function revealApiKey(token, platform) {
  const agent = await platform("/user/agentplan/subscription", token)
  if (agent?.data) {
    const reveal = await platform("/user/agentplan/key/reveal", token, { method: "POST" })
    if (reveal?.data?.key) return reveal.data.key
  }
  const legacy = await platform("/user/subscription/key/reveal", token, { method: "POST" })
  if (legacy?.data?.key) return legacy.data.key
  const agentAgain = await platform("/user/agentplan/key/reveal", token, { method: "POST" })
  if (agentAgain?.data?.key) return agentAgain.data.key
  throw new Error(
    "Agnes reported no plan API key; use the API key sign-in for a free account",
  )
}

async function revealProfileKey(token, profile, platform) {
  const list = await platform(`/token?key_profile=${encodeURIComponent(profile)}`, token)
  const items = Array.isArray(list?.data?.items) ? list.data.items : []
  const active = items.find(
    (item) => item && item.status === 1 && Number.isInteger(item.id),
  )
  if (!active) {
    throw new Error(`Agnes has no active ${profile} API key; create one in the platform first`)
  }
  const revealed = await platform(`/token/${active.id}/key`, token, { method: "POST" })
  if (!revealed?.data?.key) {
    throw new Error(`Agnes could not reveal the ${profile} API key`)
  }
  return revealed.data.key
}

async function balanceOnlyUsage(token, profile, platform, browser) {
  const result = await platform("/user/balance", token)
  if (result.lapsed) {
    return {
      plan: profile === "enterprise" ? "Enterprise API key" : "Personal API key",
      windows: [],
      error: browser
        ? "Agnes session was refused; sign in again"
        : "Agnes console token was refused; sign in again and paste a new token",
      signIn: "kept",
    }
  }
  const balance = balanceText(result.data)
  return {
    plan: profile === "enterprise" ? "Enterprise API key" : "Personal API key",
    ...(balance ? { balance } : {}),
    windows: [],
    ...(result.error ? { error: `Agnes balance couldn't be read: ${result.error}` } : {}),
    signIn: "kept",
  }
}

function browserArgs(profile, port, url) {
  return [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-background-mode",
    "--new-window",
    url,
  ]
}

function browserProfileDir(env = process.env, platform = process.platform) {
  if (env.AGNES_PROFILE) return env.AGNES_PROFILE
  if (platform === "win32") {
    return join(env.LOCALAPPDATA || env.APPDATA || tmpdir(), "magpie", "agnes-browser")
  }
  return join(
    env.XDG_CONFIG_HOME || join(env.HOME || tmpdir(), ".config"),
    "magpie",
    "agnes-browser",
  )
}

function findBrowser(platform = process.platform, env = process.env) {
  if (env.AGNES_BROWSER && existsSync(env.AGNES_BROWSER)) return env.AGNES_BROWSER
  const home = env.HOME || ""
  const candidates =
    platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
          join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ]
      : platform === "win32"
        ? [
            join(env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe"),
            join(env["PROGRAMFILES(X86)"] || "", "Google/Chrome/Application/chrome.exe"),
            join(env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
            join(env.PROGRAMFILES || "", "Microsoft/Edge/Application/msedge.exe"),
            join(env["PROGRAMFILES(X86)"] || "", "Microsoft/Edge/Application/msedge.exe"),
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
            "/usr/bin/microsoft-edge",
          ]
  return candidates.find((path) => path && existsSync(path)) ?? ""
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

async function cdpTarget(port, targetPrefix = "https://platform.agnes-ai.com/") {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(1200),
    })
    if (!res.ok) return null
    const list = await res.json()
    return (
      list.find(
        (target) =>
          target?.type === "page" &&
          typeof target.url === "string" &&
          target.url.startsWith(targetPrefix) &&
          target.webSocketDebuggerUrl,
      ) ?? null
    )
  } catch {
    return null
  }
}

function cdpEvaluate(
  webSocketUrl,
  expression,
  timeout = 3000,
  WebSocketImpl = globalThis.WebSocket,
) {
  return new Promise((resolve, reject) => {
    let ws
    try {
      ws = new WebSocketImpl(webSocketUrl)
    } catch (error) {
      reject(error)
      return
    }
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {}
      reject(new Error("CDP timed out"))
    }, timeout)
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true },
        }),
      )
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error("CDP connection failed"))
    }
    ws.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id !== 1) return
      clearTimeout(timer)
      try {
        ws.close()
      } catch {}
      if (message.error) {
        reject(new Error(message.error.message || "CDP evaluation failed"))
        return
      }
      if (message.result?.exceptionDetails) {
        const details = message.result.exceptionDetails
        const text =
          details.exception?.description ||
          details.exception?.value ||
          details.text ||
          "CDP evaluation failed"
        reject(Object.assign(new Error(String(text)), { fatal: true }))
        return
      }
      resolve(message.result?.result?.value)
    }
  })
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs)
    child.once("exit", () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

// Chrome can report a transient SecurityError while the login page is loading.
async function waitForBrowserToken(
  evaluate,
  timeoutMs,
  { isActive = () => true, pollMs = 750, fatalGraceMs = 4000 } = {},
) {
  const deadline = Date.now() + timeoutMs
  let lastFatalText = ""
  let fatalSince = 0
  while (Date.now() < deadline && isActive()) {
    try {
      const value = await evaluate('localStorage.getItem("token")')
      if (typeof value === "string" && value.trim()) return value.trim()
      lastFatalText = ""
      fatalSince = 0
    } catch (error) {
      if (error?.fatal) {
        const text = String(error.message ?? error)
        const now = Date.now()
        if (text !== lastFatalText) {
          lastFatalText = text
          fatalSince = now
        } else if (now - fatalSince >= fatalGraceMs) {
          throw error
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  if (lastFatalText) throw new Error(lastFatalText)
  return ""
}

async function openChromeSession(
  url,
  {
    targetPrefix = "https://platform.agnes-ai.com/",
    profileDir = browserProfileDir(),
  } = {},
) {
  const browser = findBrowser()
  if (!browser) {
    throw new Error(
      "Chrome or Edge was not found; set AGNES_BROWSER or use the API key sign-in",
    )
  }
  const port = await freePort()
  const profile = profileDir
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  try {
    chmodSync(profile, 0o700)
  } catch {}
  const child = spawn(browser, browserArgs(profile, port, url), {
    stdio: "ignore",
    detached: false,
  })
  activeChrome.add(child)
  let closed = false
  let exited = false
  let spawnError = ""
  child.once("error", (error) => {
    spawnError = String(error?.message ?? error)
    exited = true
  })
  child.once("exit", () => {
    exited = true
  })
  let closing = null
  const session = {
    profilePath: profile,
    close,
    evaluate,
    async token(timeoutMs) {
      const token = await waitForBrowserToken(evaluate, timeoutMs, {
        isActive: () => !closed && !exited,
      })
      if (spawnError) throw new Error(`Chrome failed to start: ${spawnError}`)
      return token
    },
  }
  async function evaluate(expression) {
    const target = await cdpTarget(port, targetPrefix)
    if (!target?.webSocketDebuggerUrl) return null
    return await cdpEvaluate(target.webSocketDebuggerUrl, expression)
  }
  function close() {
    if (closing) return closing
    closed = true
    closing = (async () => {
      activeChrome.delete(child)
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGTERM")
        } catch {}
        await waitForExit(child, 2000)
      }
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL")
        } catch {}
        await waitForExit(child, 1000)
      }
    })()
    return closing
  }
  return session
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function usedPercent(used, limit, given) {
  if (typeof given === "number" && Number.isFinite(given)) return given
  if (used === null || !limit || limit <= 0) return null
  return Math.max(0, (used / limit) * 100)
}

function amountText(value) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 })
}

function balanceText(data) {
  if (!data || typeof data !== "object") return ""
  const minor = number(data.available_total_minor) ?? number(data.total_minor)
  if (minor === null) return ""
  const currency = typeof data.currency === "string" && data.currency.trim()
    ? data.currency.trim().toUpperCase()
    : "USD"
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(minor / 100)
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`
  }
}

function windowOf({ name, used, limit, unit, reset, display, aside }) {
  const amount = used === null ? 0 : Math.max(0, used)
  const total = limit === null ? 0 : Math.max(0, limit)
  return {
    name,
    ...(used === null ? { used: null } : { used: usedPercent(amount, total) }),
    ...(reset ? { resetsAt: reset } : {}),
    ...(display ? { display } : {}),
    amount,
    limit: total,
    unit,
    ...(aside ? { aside: true } : {}),
  }
}

function legacyWindows(data) {
  const usage = data?.usage
  if (!usage || typeof usage !== "object") return []
  const definitions = [
    ["text_generation", "windowed", "Text · 5 hours", "requests", false],
    ["text_generation", "weekly", "Text · weekly", "requests", false],
    ["image_generation", "daily", "Images · daily", "images", true],
    ["video_generation", "daily", "Video seconds · daily", "seconds", true],
  ]
  const out = []
  for (const [kind, period, name, unit, aside] of definitions) {
    const raw = usage[kind]?.[period]
    if (!raw || typeof raw !== "object") continue
    const used = number(raw.used)
    const limit = number(raw.limit)
    const amount = used ?? 0
    const total = limit ?? 0
    out.push({
      ...windowOf({
        name,
        used,
        limit,
        unit,
        reset: vendorTime(raw.reset_at),
        aside,
        display:
          used !== null && limit !== null
            ? `${amountText(amount)} / ${amountText(total)} ${unit}`
            : "",
      }),
      used: usedPercent(amount, total, raw.usage_pct),
    })
  }
  return out
}

function agentWindows(subscription, credits) {
  if (!subscription || !credits || typeof credits !== "object") return []
  const out = []
  const quota =
    number(credits.plan_quota_credits) ?? number(subscription.monthly_credits)
  const planBalance = number(credits.plan_balance_credits)
  if (quota !== null && quota > 0) {
    const used = planBalance === null ? 0 : Math.max(0, quota - planBalance)
    out.push({
      name: "Monthly credits",
      used: usedPercent(used, quota),
      resetsAt: vendorTime(subscription.current_period_end),
      display: `${amountText(used)} / ${amountText(quota)} credits`,
      amount: used,
      limit: quota,
      unit: "credits",
    })
  }
  const windowUsed = number(credits.window_used_credits)
  const windowLimit = number(credits.window_limit_credits)
  if (windowUsed !== null && windowLimit !== null && windowLimit > 0) {
    out.push({
      name: "5-hour window",
      used: usedPercent(windowUsed, windowLimit),
      display: `${amountText(windowUsed)} / ${amountText(windowLimit)} credits`,
      amount: windowUsed,
      limit: windowLimit,
      unit: "credits",
    })
  }
  const pack = number(credits.pack_balance_credits)
  if (pack !== null) {
    out.push({
      name: "Purchased credits",
      balance: Math.max(0, pack),
      display: `${amountText(pack)} credits`,
      unit: "credits",
      aside: true,
    })
  }
  return out
}

function legacyPlanName(data) {
  const name = typeof data?.plan_name === "string" ? data.plan_name.trim() : ""
  return name ? `${name} (Token Plan)` : ""
}

function agentPlanName(data) {
  const name =
    (typeof data?.tier_name === "string" && data.tier_name.trim()) ||
    (typeof data?.tier_code === "string" && data.tier_code.trim()) ||
    ""
  return name ? `${name} (Agent Plan)` : ""
}

function renewalOf(agent, legacy) {
  if (agent) {
    if (agent.auto_renew === true) return "auto"
    if (agent.auto_renew === false) return "off"
  }
  if (legacy) return legacy.cancel_renewal_at ? "off" : "auto"
  return ""
}

function vendorTime(value) {
  if (typeof value !== "string" || !value.trim()) return ""
  let text = value.trim()
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) text += "Z"
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? "" : date.toISOString()
}
