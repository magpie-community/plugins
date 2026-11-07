import { randomUUID } from "node:crypto"
import { readUsage, signIn, checkin, listModels } from "./lib/session.mjs"

const ID = "ccx"
const NAME = "AutoBits AI Hub"
const API_BASE = "https://ccx.autobits.cc/v1"

export function fingerprint(auth) {
  return auth?.profileId ?? auth?.apiKey ?? auth?.access ?? auth?.key ?? randomUUID()
}

export async function CCXPlugin({ client } = {}, options = {}) {
  const save = async (auth) => {
    await client.auth.set({ path: { id: ID }, body: auth })
    return auth
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[ID] ??= {}
      Object.assign(cfg.provider[ID], { name: NAME, npm: "@ai-sdk/openai-compatible", api: API_BASE, models: cfg.provider[ID].models ?? {} })
    },
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const key = auth?.apiKey ?? auth?.access ?? auth?.key
        if (!key) return provider?.models ?? {}
        const rows = await listModels(key).catch(() => [])
        const out = { ...(provider?.models ?? {}) }
        for (const row of rows) {
          out[row.id] = { name: row.name, api: { id: row.id, npm: "@ai-sdk/openai-compatible", url: API_BASE } }
        }
        return out
      },
    },
    auth: {
      provider: ID,
      methods: [
        {
          type: "api",
          label: "API Key（推荐，可自动签到）",
          prompts: [
            { type: "password", key: "apiKey", message: "AutoBits 的 LLM API Key", placeholder: "sk-...", validate: (v) => String(v ?? "").trim() ? undefined : "请输入 API Key" },
          ],
          async authorize(inputs) {
            const key = String(inputs?.apiKey ?? "").trim()
            if (!key) return { type: "failed", error: "请输入 API Key" }
            const profileId = fingerprint({ apiKey: key })
            const auth = { type: "oauth", access: key, refresh: "", expires: 0, apiKey: key, profileId, accountId: `ccx-${profileId}`, username: "AutoBits 账号" }
            const info = await readUsage(auth, options)
            if (info.user) auth.username = info.user
            return { type: "success", ...auth }
          },
        },
        {
          type: "oauth",
          label: "浏览器登录（没有 API Key 时使用）",
          prompts: [
            { type: "password", key: "apiKey", required: false, message: "可选：API Key（留空时先登录，再在控制台创建）", placeholder: "sk-..." },
          ],
          authorize(inputs) {
            return {
              url: "", opened: true, method: "auto",
              instructions: "会打开 Edge 或 Chrome 的 AutoBits 页面。请手动登录（密码、邮件验证码或通行密钥），完成后窗口会自动关闭。验证码由你完成，软件不会代答。",
              async callback(_code, { signal } = {}) {
                try {
                  const key = String(inputs?.apiKey ?? "").trim()
                  const profileId = fingerprint({ apiKey: key || randomUUID() })
                  const auth = { type: "oauth", access: key, apiKey: key, profileId }
                  const info = await signIn(auth, { ...options, signal })
                  auth.accountId = info.username || `ccx-${profileId}`
                  auth.username = info.username || "AutoBits 账号"
                  return { type: "success", ...auth }
                } catch (e) { return { type: "failed", error: e?.message ?? String(e) } }
              },
            }
          },
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        const key = auth?.apiKey ?? auth?.access ?? auth?.key
        return { baseURL: API_BASE, apiKey: key }
      },
      async usage(getAuth) {
        const auth = await getAuth()
        try { return await readUsage(auth, options) } catch (e) { return { error: e?.message ?? String(e), signIn: "kept" } }
      },
      async checkin(getAuth) {
        const auth = await getAuth()
        try { return await checkin(auth, options) } catch (e) { return { outcome: "failed", message: e?.message ?? String(e) } }
      },
    },
  }
}
