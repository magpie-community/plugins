import { randomUUID } from "node:crypto"
import { readUsage, signIn, checkin, listModels } from "./lib/session.mjs"

const ID = "ccx"
const NAME = "AutoBits AI Hub"
const API_BASE = "https://ccx.autobits.cc/v1"

export function fingerprint(auth) {
  return auth?.profileId ?? auth?.apiKey ?? auth?.access ?? auth?.key ?? randomUUID()
}

export async function CCXPlugin({ client } = {}, options = {}) {
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
          label: "API Key",
          prompts: [
            { type: "password", key: "apiKey", message: "AutoBits 的 LLM API Key", placeholder: "sk-..." },
          ],
          async authorize(inputs) {
            const key = String(inputs?.apiKey ?? "").trim()
            if (!key) return { type: "failed", error: "请输入 API Key" }
            // api 方法的 authorize 返回 key 即可，Magpie 会存成 {type:"api", key}
            return { type: "success", key }
          },
        },
        {
          type: "oauth",
          label: "浏览器登录",
          prompts: [],
          authorize(inputs, { signal } = {}) {
            // 立刻返回。opened: true 告诉 Magpie「插件自己会打开浏览器」，
            // Magpie 就不会再打开一次（两个窗口会冲突）。
            const profileId = fingerprint({ apiKey: randomUUID() })
            return {
              url: "",
              opened: true,
              method: "auto",
              instructions: "登录窗口会自己打开。请在窗口里完成登录（密码、验证码或通行密钥），完成后自动结束。",
              async callback(_code, { signal: cbSignal } = {}) {
                try {
                  const auth = { type: "oauth", profileId }
                  const info = await signIn(auth, { ...options, signal: cbSignal ?? signal })
                  return {
                    type: "success",
                    access: "",
                    refresh: "",
                    expires: 0,
                    apiKey: "",
                    profileId,
                    accountId: info.username || `ccx-${profileId}`,
                    username: info.username || "AutoBits 账号",
                  }
                } catch (e) {
                  return { type: "failed", error: e?.message ?? String(e) }
                }
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
