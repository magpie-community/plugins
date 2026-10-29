import { createHash } from "node:crypto"
import { ID, NAME, extractAllKeys, resolveBaseURL, aggregateUsage, discoverAllModels, money } from "./lib/helpers.mjs"
import { accountRequest, readAccount, sessionAuth } from "./lib/account.mjs"
import { browserLogin } from "./lib/login.mjs"

export default async function StringAIPlugin({ client } = {}, options = {}) {
  const catalogs = new Map()
  const identity = (auth) => auth.type === "oauth"
    ? `account:${auth.metadata.userId}`
    : createHash("sha256").update(JSON.stringify(extractAllKeys(auth, options))).digest("hex")

  async function accountKeys(auth) {
    if (auth.type === "oauth") return (await readAccount(auth.access)).keys
    const keys = extractAllKeys(auth, options)
    if (!keys.length) throw new Error("请登录 String AI")
    return keys
  }

  async function catalog(auth, was = {}, reload = false) {
    const id = identity(auth)
    if (!reload && catalogs.has(id)) return catalogs.get(id)
    const keys = await accountKeys(auth)
    const next = await discoverAllModels(resolveBaseURL(auth, options), keys, was)
    catalogs.set(id, next)
    return next
  }

  return {
    auth: {
      provider: ID,
      single: true,
      methods: [
        { type: "oauth", label: "登录 String AI，自动导入全部 API Key", authorize: browserLogin },
        {
          type: "api",
          label: "手动填写 API Key",
          placeholder: "sk-…",
          prompts: [
            { type: "text", key: "claudeKey", message: "Claude 分组 API Key（选填）", placeholder: "sk-…" },
            { type: "text", key: "openaiKey", message: "OpenAI 分组 API Key（选填）", placeholder: "sk-…" },
            { type: "text", key: "domesticKey", message: "国产模型 API Key（选填）", placeholder: "sk-…" },
            { type: "text", key: "otherKey", message: "其他模型 API Key（选填）", placeholder: "sk-…" },
          ],
        },
      ],
      async refresh(auth) {
        const session = await accountRequest("/auth/refresh", { body: { refresh_token: auth.refresh } })
        return sessionAuth(session)
      },
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth) return {}
        if (auth.type === "api" && auth.accountId !== NAME && client?.auth?.set) {
          await client.auth.set({ path: { id: ID }, body: { ...auth, accountId: NAME } })
        }
        const baseURL = resolveBaseURL(auth, options)
        return {
          baseURL,
          apiKey: "string-ai-managed",
          async fetch(input, init) {
            const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
            const base = new URL(baseURL)
            if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname}/`)) {
              throw new Error("String AI 请求地址超出供应商范围")
            }
            const current = await getAuth()
            const body = JSON.parse(init.body)
            const { routes } = await catalog(current)
            const key = routes.get(body.model)
            if (!key) throw new Error(`String AI 未找到模型 ${body.model} 对应的 API Key，请重新获取模型`)
            const headers = new Headers(init.headers)
            headers.set("authorization", `Bearer ${key}`)
            headers.set("x-api-key", key)
            headers.delete("x-goog-api-key")
            return fetch(input, { ...init, headers, redirect: "error" })
          },
        }
      },
      async usage(getAuth) {
        const auth = await getAuth()
        if (!auth) return { error: "请登录 String AI" }
        try {
          if (auth.type === "oauth") {
            const { user, keys } = await readAccount(auth.access)
            const result = await aggregateUsage(resolveBaseURL(auth, options), keys)
            if (typeof user.balance !== "number" || !Number.isFinite(user.balance)) throw new Error("String AI 未返回账号余额")
            return { ...result, user: user.email, balance: money(user.balance) }
          }
          return { user: NAME, ...await aggregateUsage(resolveBaseURL(auth, options), await accountKeys(auth)) }
        } catch (error) {
          return { error: error.message, ...(error.signIn ? { signIn: error.signIn } : {}) }
        }
      },
    },
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        if (!auth) return provider.models
        return (await catalog(auth, provider.models, true)).models
      },
    },
    config(cfg) {
      cfg.provider ??= {}
      const provider = cfg.provider[ID] ??= {}
      provider.name ??= NAME
      provider.npm ??= "@ai-sdk/openai-compatible"
      provider.api ??= resolveBaseURL(undefined, options)
      // 模型由账号动态发现；不把未授权模型作为静态兜底。
      provider.models ??= {}
    },
  }
}
