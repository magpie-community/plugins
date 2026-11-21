// Clixad provider plugin for magpie.
//
// Clixad (https://clixad.onrender.com) speaks the OpenAI chat-completions
// API at /v1, authenticates with a long-lived Bearer token (adg_…), and
// reports its model catalog at /v1/models plus free-tier usage and the
// credit balance at /v1/wallet. This plugin reuses those endpoints as they
// are; it changes no Clixad files.

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const PROVIDER = "clixad"
const PROVIDER_NAME = "Clixad"
const DEFAULT_BASE = "https://clixad.onrender.com/v1"
const CLI_CONFIG = join(homedir(), ".clixad", "config.json")

// Static catalog: what magpie shows before anyone signs in. provider.models
// refreshes it from /v1/models once an account is signed in.
const STATIC_MODELS = {
  "gpt-5-nano": { name: "GPT-5 Nano", context: 400000, efforts: ["minimal", "low", "medium", "high"] },
  "gpt-6-luna": { name: "GPT-6 Luna", context: 78000, efforts: ["off", "low", "medium", "high", "xhigh", "max"] },
  "claude-haiku-5.5": { name: "Claude Haiku 5.5", context: 24000, efforts: ["off", "low", "medium", "high", "xhigh", "max"] },
  "glm-5.3-flash": { name: "GLM 5.3 Flash", context: 1048576, efforts: ["low", "high", "max"] },
  "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", context: 1048576, efforts: ["off", "low", "high", "max"] },
  "gemini-3.5-flash-lite": { name: "Gemini 3.5 Flash-Lite", context: 1048576, efforts: ["minimal", "low", "medium", "high"] },
  "kimi-k2.5": { name: "Kimi K2.5", context: 262144, efforts: ["off"] },
  "gemini-3.8-flash": { name: "Gemini 3.8 Flash", context: 1048576, efforts: ["low", "medium", "high"] },
  "kimi-k2.7-code": { name: "Kimi K2.7 Code", context: 262144 },
  "gemini-4-hydrogen": { name: "Gemini 4 Hydrogen", context: 1048576, efforts: ["low", "medium", "high", "xhigh"] },
  "claude-sonnet-5.5": { name: "Claude Sonnet 5.5", context: 1000000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "gpt-6-sol": { name: "GPT-6 Sol", context: 78000, efforts: ["off", "low", "medium", "high", "xhigh", "max"] },
  "kimi-k3": { name: "Kimi K3", context: 1048576, efforts: ["off", "low", "high", "max"] },
  "claude-opus-5.5": { name: "Claude Opus 5.5", context: 1000000, efforts: ["low", "medium", "high", "xhigh", "max"] },
  "claude-fable-5.2": { name: "Claude Fable 5.2", context: 1000000, efforts: ["low", "medium", "high", "xhigh", "max"] },
}

function readCliConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CLI_CONFIG, "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed
  } catch {}
  return null
}

function variantsOf(efforts) {
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined
  return Object.fromEntries(efforts.map((name) => [name, {}]))
}

function modelOf(base, m) {
  return {
    ...base,
    id: m.id,
    name: m.name ?? m.label ?? m.id,
    limit: { ...(base?.limit ?? {}), context: m.context ?? m.context_window ?? base?.limit?.context },
    ...(m.free === true ? { free: true } : {}),
    ...(variantsOf(m.efforts) ? { variants: variantsOf(m.efforts) } : {}),
  }
}

function staticModelTable() {
  const free = new Set([
    "gpt-5-nano", "gpt-6-luna", "claude-haiku-5.5", "glm-5.3-flash",
    "deepseek-v4.1-flash", "gemini-3.5-flash-lite", "kimi-k2.5", "gemini-3.8-flash",
  ])
  return Object.fromEntries(Object.entries(STATIC_MODELS).map(([id, m]) => [
    id,
    modelOf({ tool_call: true }, { ...m, id, free: free.has(id) }),
  ]))
}

async function gatewayJson(base, path, token, signal) {
  const res = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    ...signal ? { signal } : {},
  })
  if (res.status === 401 || res.status === 403) throw new Error(`Clixad rejected the token (HTTP ${res.status})`)
  if (!res.ok) throw new Error(`Clixad answered HTTP ${res.status}`)
  return await res.json()
}

// The CLI's tokenGateway (and the web URL) point at the site root without
// /v1; the API lives under /v1 (verified: /models 404s, /v1/models 200).
function normalizeBase(raw) {
  let base = String(raw ?? "").trim().replace(/\/+$/, "")
  if (!base) base = DEFAULT_BASE
  if (!/\/v1$/.test(base)) base = `${base}/v1`
  return base
}

// /v1/wallet answers the balance in credits and free_tier {daily_credits,
// extra_credits, credits_left}. Turn that into magpie's usage shape: one
// window for the free tier and the wallet as its own balance line.
function usageOf(w) {
  const free = w?.free_tier
  const daily = Number(free?.daily_credits)
  const extra = Number(free?.extra_credits) || 0
  const left = free?.credits_left === undefined ? undefined : Number(free.credits_left)
  const windows = []
  if (Number.isFinite(daily) && daily > 0) {
    const limit = daily + extra
    const used = Number.isFinite(left) ? Math.max(0, limit - left) : undefined
    windows.push({
      name: "今日免费额度",
      ...(used === undefined ? {} : { used: Math.round((used / limit) * 100) }),
      resetsAt: nextUtcMidnight(),
      span: 86400,
      display: used === undefined ? `${limit} credits/day` : `${Math.round(used)} / ${limit} credits`,
      ...(used === undefined ? {} : { amount: Math.round(used), limit, unit: "credits" }),
      models: Array.isArray(free?.models) ? free.models : [],
    })
  }
  return {
    plan: "Free + credits",
    user: typeof w?.user === "string" ? w.user : undefined,
    balance: Number.isFinite(Number(w?.balance)) ? `${Number(w.balance).toLocaleString("en-US")} credits` : undefined,
    windows,
  }
}

function nextUtcMidnight() {
  const now = new Date()
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0)
  return new Date(next).toISOString()
}

function cleanedToken(raw) {
  const token = String(raw ?? "").trim().replace(/^Bearer\s+/i, "").replace(/^["']|["']$/g, "")
  if (!token) throw new Error("请输入 Clixad token（adg_ 开头）")
  return token
}

function cliImportMethod() {
  return {
    type: "oauth",
    label: "从本机 Clixad CLI 导入（需已 `clixad login`）",
    async authorize() {
      const cli = readCliConfig()
      const hasToken = typeof cli?.token === "string" && cli.token.trim() !== ""
      return {
        url: "",
        opened: true,
        method: "auto",
        instructions: hasToken
          ? "正在读取 ~/.clixad/config.json 并校验 token…"
          : "没找到已登录的 ~/.clixad/config.json。请先运行 `clixad login`，或改用「粘贴 Clixad token」。",
        async callback() {
          if (!hasToken) return { type: "failed", error: "本机没有已登录的 Clixad CLI。请先运行 `clixad login`，或改用粘贴 token。" }
          const base = normalizeBase(cli.gatewayUrl ?? cli.tokenGateway)
          // /v1/models is public (answers 200 without a token), so it can't
          // validate anything; /v1/wallet 401s on a bad token.
          await gatewayJson(base, "/wallet", cli.token).catch((e) => {
            throw new Error(`读取到的 Clixad 登录不可用：${e?.message ?? e}`)
          })
          return {
            type: "success",
            key: cli.token,
            ...(cli.login || cli.email ? { accountId: cli.login || cli.email } : {}),
            metadata: {
              gatewayUrl: base,
              email: cli.email ?? "",
              login: cli.login ?? "",
              userId: cli.userId ?? "",
            },
          }
        },
      }
    },
  }
}

function pastedTokenMethod() {
  return {
    type: "oauth",
    label: "粘贴 Clixad token（adg_…）",
    async authorize() {
      return {
        url: "",
        method: "code",
        instructions: "粘贴 ~/.clixad/config.json 里的 token 字段（adg_ 开头）；确认前会用 /v1/wallet 校验一次。",
        async callback(input) {
          try {
            const token = cleanedToken(input)
            // /v1/models is public and can't validate a token; /v1/wallet can.
            await gatewayJson(DEFAULT_BASE, "/wallet", token)
            return {
              type: "success",
              key: token,
              accountId: "Clixad token",
              metadata: { gatewayUrl: DEFAULT_BASE },
            }
          } catch (e) {
            return { type: "failed", error: e?.message ?? String(e) }
          }
        },
      }
    },
  }
}

export const ClixadAuthPlugin = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: PROVIDER_NAME,
      npm: "@ai-sdk/openai-compatible",
      api: DEFAULT_BASE,
      models: staticModelTable(),
    }
  },

  auth: {
    provider: PROVIDER,
    methods: [cliImportMethod(), pastedTokenMethod()],
    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "oauth" && auth?.type !== "api") return {}
      const key = auth.key ?? auth.access
      if (!key) return {}
      const base = normalizeBase(auth.metadata?.gatewayUrl ?? DEFAULT_BASE)
      return {
        baseURL: base,
        async fetch(input, init) {
          const headers = new Headers(init?.headers)
          headers.set("authorization", `Bearer ${key}`)
          return await fetch(input, { ...init, headers })
        },
      }
    },
    async usage(getAuth) {
      try {
        const auth = await getAuth()
        const key = auth?.key ?? auth?.access
        if (!key) return { error: "not signed in", windows: [] }
        const base = normalizeBase(auth.metadata?.gatewayUrl ?? DEFAULT_BASE)
        const w = await gatewayJson(base, "/wallet", key)
        return usageOf(w)
      } catch (e) {
        return { error: e?.message ?? String(e), windows: [] }
      }
    },
  },

  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      const key = auth?.key ?? auth?.access
      if (!key) return provider.models
      try {
        const base = normalizeBase(auth.metadata?.gatewayUrl ?? DEFAULT_BASE)
        const data = await gatewayJson(base, "/models", key)
        const list = Array.isArray(data?.data) ? data.data : []
        if (list.length === 0) return provider.models
        const table = {}
        for (const m of list) {
          if (typeof m?.id !== "string" || !m.id) continue
          const baseModel = provider.models[m.id] ?? { tool_call: true, limit: {} }
          table[m.id] = modelOf(baseModel, m)
        }
        return table
      } catch {
        return provider.models
      }
    },
  },
})

export const _internal = {
  PROVIDER,
  DEFAULT_BASE,
  STATIC_MODELS,
  staticModelTable,
  usageOf,
  modelOf,
  nextUtcMidnight,
  readCliConfig,
  normalizeBase,
}
