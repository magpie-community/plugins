import {
  ID,
  GATEWAY_BASE,
  SUCCESS,
  text,
  upstreamMessage,
  sessionOf,
  tokenJSON,
  modelsFor,
  points,
  rewriteDeepseekImages,
  parseSessionInput,
} from "./core.mjs"

export const Loomy = async () => ({
  config: async (cfg) => {
    cfg.provider = cfg.provider ?? {}
    cfg.provider[ID] = {
      name: "Loomy",
      npm: "@ai-sdk/openai-compatible",
      api: `${GATEWAY_BASE}/api/v1`,
      // Replaced by Loomy's live catalog once an account is signed in.
      models: {
        "DeepSeek-V4.1-Flash": {
          name: "DeepSeek V4.1 Flash",
          limit: { context: 1048576, output: 384000 },
        },
      },
    }
  },
  auth: {
    provider: ID,
    options: [
      {
        key: "checkin",
        label: "Daily points",
        description: "Refresh Loomy's daily gift points with its first-login endpoint.",
        default: false,
      },
    ],
    methods: [{
      type: "oauth",
      label: "Paste Loomy login",
      prompts: [{
        type: "text",
        key: "login",
        message: "Loomy session or exported login JSON",
        validate: (v) => { try { parseSessionInput(v); return undefined } catch (e) { return e.message } },
      }],
      authorize: async (inputs) => ({
        url: "",
        instructions: "",
        method: "auto",
        callback: async () => ({ ...parseSessionInput(inputs.login), type: "success" }),
      }),
    }],
    loader: async (getAuth) => ({
      apiKey: "loomy",
      baseURL: `${GATEWAY_BASE}/api/v1`,
      async fetch(url, init) {
        const auth = await getAuth()
        const headers = new Headers(init?.headers)
        headers.set("token", sessionOf(auth))
        headers.set("Authorization", `Bearer ${sessionOf(auth)}`)
        if (text(new URL(String(url)).searchParams.get("model")).toLowerCase().includes("deepseek") && typeof init?.body === "string") {
          try {
            const rewritten = rewriteDeepseekImages(JSON.parse(init.body))
            init = { ...init, body: JSON.stringify(rewritten), headers }
          } catch { init = { ...init, headers } }
        } else init = { ...init, headers }
        const response = await fetch(url, init)
        if (response.status === 401 || response.status === 403) {
          throw Object.assign(new Error("Loomy sign-in expired: sign in again"), { signIn: "expired" })
        }
        return response
      },
    }),
    models: async (_provider, input = {}) => modelsFor(input.auth),
    usage: async (getAuth) => points(sessionOf(await getAuth())),
    checkin: async (getAuth) => {
      const auth = await getAuth()
      let payload
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          payload = await tokenJSON("/api/v1/points/first-login", sessionOf(auth), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }, "Loomy's daily points", 45_000)
          break
        } catch (e) {
          const transient = /timed out|timeout|fetch failed|ECONN|network/i.test(e?.message || "")
          if (!transient || attempt === 1) throw e
        }
      }
      if (text(payload?.code) !== SUCCESS) {
        return { outcome: "failed", message: upstreamMessage(payload) || `Loomy answered ${text(payload?.code) || "without a code"}` }
      }
      const current = payload?.data?.dailyBalance ?? payload?.data?.data?.dailyBalance
      return { outcome: "claimed", message: current == null ? "Daily gift points refreshed" : `Daily gift points refreshed (${current})` }
    },
  },
  provider: {
    id: ID,
    models: async (_provider, input = {}) => modelsFor(input.auth),
  },
})

