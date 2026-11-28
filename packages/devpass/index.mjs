import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"

const ID = "devpass"
const BASE = "https://api.llmgateway.io/v1"
const AUTHORIZE = "https://llmgateway.io/connect/cli"
const TOKEN = "https://internal.llmgateway.io/public/cli-auth/token"
const SIGN_IN_TIMEOUT = 5 * 60 * 1000
const BROWSER_SOURCE = "openai-sdk"
const CHAT = "@ai-sdk/openai-compatible"
const RESPONSES = "@ai-sdk/openai"
const MESSAGES = "@ai-sdk/anthropic"
const MODALITIES = ["text", "image", "audio", "video", "pdf"]
const VIRTUAL = new Set(["auto", "custom", "smart", "price"])

const record = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {})
const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : [])

function numberOf(value) {
  if (typeof value === "string" && !value.trim()) return undefined
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function optionalNumber(value) {
  return value === null || value === undefined ? undefined : numberOf(value)
}

function million(value) {
  return Math.round(value * 1e6 * 1e9) / 1e9
}

function timestampOf(value) {
  if (typeof value !== "string" || !value) return ""
  const time = Date.parse(value)
  return Number.isNaN(time) ? "" : new Date(time).toISOString()
}

function active(entry, now = Date.now()) {
  const end = timestampOf(entry?.deactivated_at)
  return !end || Date.parse(end) > now
}

function npmOf(model) {
  const family = String(model?.family ?? "").toLowerCase()
  if (family === "openai") return RESPONSES
  if (family === "anthropic") return MESSAGES
  return CHAT
}

function providersOf(model) {
  return (Array.isArray(model?.providers) ? model.providers : []).filter((provider) => active(provider))
}

function callable(model) {
  if (!model || typeof model.id !== "string" || !model.id || model.id.includes("/")) return false
  if (VIRTUAL.has(model.id) || model.virtual_model_target || String(model.family ?? "").toLowerCase() === "llmgateway") return false
  if (!active(model)) return false
  const output = strings(model.architecture?.output_modalities)
  if (output.some((modality) => modality !== "text")) return false
  const providers = providersOf(model)
  if (Array.isArray(model.providers) && model.providers.length && !providers.length) return false
  if (providers.length) return providers.some((provider) => provider.tools === true)
  return strings(model.supported_parameters).includes("tools")
}

function effortsOf(model) {
  const providers = providersOf(model)
  const levels = providers.length
    ? providers.find((provider) => strings(provider.reasoning_efforts).length)?.reasoning_efforts
    : undefined
  return [...new Set(strings(levels).map((effort) => effort.toLowerCase()))]
}

function costOf(pricing) {
  const source = record(pricing)
  const input = numberOf(source.prompt)
  const output = numberOf(source.completion)
  const cacheRead = numberOf(source.input_cache_read)
  const cacheWrite = numberOf(source.input_cache_write)
  const cost = {
    ...(input !== undefined ? { input: million(input) } : {}),
    ...(output !== undefined ? { output: million(output) } : {}),
    ...(cacheRead !== undefined ? { cache_read: million(cacheRead) } : {}),
    ...(cacheWrite !== undefined ? { cache_write: million(cacheWrite) } : {}),
  }
  return Object.keys(cost).length ? cost : undefined
}

function variantsOf(model, npm) {
  return Object.fromEntries(effortsOf(model).map((effort) => [effort, npm === MESSAGES ? { effort } : { reasoningEffort: effort }]))
}

function runtimeCost(cost) {
  if (!cost) return undefined
  const out = {
    ...(cost.input !== undefined ? { input: cost.input } : {}),
    ...(cost.output !== undefined ? { output: cost.output } : {}),
    cache: {
      ...(cost.cache_read !== undefined ? { read: cost.cache_read } : {}),
      ...(cost.cache_write !== undefined ? { write: cost.cache_write } : {}),
    },
  }
  return Object.keys(out).length > 1 ? out : undefined
}

function serviceTiersOf(model) {
  const tiers = providersOf(model).flatMap((provider) => (Array.isArray(provider.service_tiers) ? provider.service_tiers : []))
  return [...new Set(tiers.map((tier) => tier?.id).filter((id) => typeof id === "string" && id))]
}

function configModel(model) {
  const npm = npmOf(model)
  const input = strings(model.architecture?.input_modalities)
  const image = input.includes("image")
  const variants = variantsOf(model, npm)
  return {
    id: model.id,
    name: model.display_name || model.name || model.id,
    provider: { npm, api: BASE },
    reasoning: Object.keys(variants).length > 0 || providersOf(model).some((provider) => provider.reasoning === true),
    tool_call: true,
    attachment: image,
    modalities: { input: input.length ? input : ["text"], output: ["text"] },
    limit: { context: numberOf(model.context_length) ?? 0, output: numberOf(model.max_output) ?? 0 },
    ...(costOf(model.pricing) ? { cost: costOf(model.pricing) } : {}),
    ...(Object.keys(variants).length ? { variants } : {}),
    release_date: numberOf(model.created) ? new Date(model.created * 1000).toISOString() : "",
  }
}

function runtimeModel(model) {
  const config = configModel(model)
  const image = config.attachment
  const serviceTiers = serviceTiersOf(model)
  return {
    id: model.id,
    providerID: ID,
    name: config.name,
    api: { id: model.id, url: BASE, npm: config.provider.npm },
    status: "active",
    headers: {},
    options: {},
    ...(runtimeCost(config.cost) ? { cost: runtimeCost(config.cost) } : {}),
    limit: config.limit,
    capabilities: {
      temperature: true,
      reasoning: config.reasoning,
      attachment: image,
      toolcall: true,
      input: Object.fromEntries(MODALITIES.map((modality) => [modality, config.modalities.input.includes(modality)])),
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: config.release_date,
    variants: config.variants ?? {},
    ...(serviceTiers.length ? { serviceTiers } : {}),
  }
}

function rowsOf(data) {
  if (!Array.isArray(data) || data.some((model) => !model || typeof model.id !== "string" || !model.id)) throw new Error("DevPass sent an invalid model list")
  return data.filter(callable).map(runtimeModel)
}

function notPremium(rows) {
  return rows
    .filter((model) => {
      const pricing = model.cost ?? {}
      return !(Number(pricing.input) >= 5 || Number(pricing.output) >= 15)
    })
    .map((model) => model.id)
}

function usageOf(data, rows = []) {
  const source = record(data)
  const planCode = typeof source.devPlan === "string" ? source.devPlan.toLowerCase() : "none"
  const plan = { lite: "DevPass Lite", pro: "DevPass Pro", max: "DevPass Max" }[planCode]
  const out = { plan: plan ?? "LLM Gateway · Pay as you go", windows: [] }
  if (typeof source.label === "string" && source.label.trim()) out.user = source.label.trim()
  if (!plan) {
    const used = numberOf(source.usage)
    const limit = optionalNumber(source.limit)
    if (used !== undefined) out.windows.push({ name: "Key usage", aside: true, amount: used, ...(limit !== undefined ? { limit } : {}), unit: "USD", display: `$${used.toFixed(2)}${limit !== undefined ? ` / $${limit.toFixed(2)}` : ""}` })
    return out
  }
  const amountWindow = (name, usedField, limitField, resetField, span, extra = {}) => {
    const used = optionalNumber(source[usedField])
    const limit = optionalNumber(source[limitField])
    if (used === undefined && limit === undefined) return
    const window = {
      name,
      ...(used !== undefined && limit !== undefined && limit > 0 ? { used: (100 * used) / limit } : {}),
      ...(used !== undefined && limit !== undefined ? { amount: used, limit } : {}),
      unit: "USD",
      display: `$${(used ?? 0).toFixed(2)}${limit !== undefined ? ` / $${limit.toFixed(2)}` : ""}`,
      ...(span ? { span } : {}),
      ...extra,
    }
    const reset = timestampOf(source[resetField])
    if (reset) window.resetsAt = reset
    out.windows.push(window)
  }
  amountWindow("Daily allowance", "devPlanDailyCreditsUsed", "devPlanDailyLimit", "devPlanDayResetsAt", 24 * 3600)
  const excluded = rows.length ? notPremium(rows) : []
  amountWindow("Premium weekly", "devPlanPremiumCreditsUsed", "devPlanPremiumWeeklyLimit", "devPlanPremiumWeekResetsAt", 7 * 24 * 3600, { ...(excluded.length ? { notModels: excluded } : {}) })
  amountWindow("Monthly allowance", "devPlanCreditsUsed", "devPlanCreditsLimit", "", 0, { aside: true })
  return out
}

async function api(fetchImpl, key, path) {
  return fetchImpl(BASE + path, {
    headers: { authorization: `Bearer ${key}`, "x-api-key": key, accept: "application/json" },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  })
}

async function readJson(res, what) {
  try {
    return await res.json()
  } catch {
    throw new Error(`DevPass sent no valid ${what}`)
  }
}

function expired(what, status) {
  return Object.assign(new Error(`${what} refused this key (HTTP ${status}); sign in again`), { signIn: "expired" })
}

function callbackPage(ok, title, message) {
  const escape = (value) => String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char])
  return `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><style>body{font:15px system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#222;background:#fafafa}@media(prefers-color-scheme:dark){body{color:#eee;background:#161616}}main{text-align:center;max-width:28rem;padding:1rem}h1{color:${ok ? "#287d4b" : "#b43d36"}}</style><main><h1>${escape(title)}</h1><p>${escape(message)}</p></main>`
}

function loopback(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler)
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("DevPass could not open its sign-in callback"))
        return
      }
      server.unref()
      resolve({ url: `http://127.0.0.1:${address.port}/callback`, close: () => server.close() })
    })
  })
}

async function exchangeBrowserCode(fetchImpl, code, verifier) {
  const res = await fetchImpl(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier }),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body?.error_description || `DevPass browser sign-in failed (HTTP ${res.status})`)
  if (typeof body?.api_key !== "string" || !body.api_key) throw new Error("DevPass returned no API key after browser sign-in")
  return { type: "success", provider: ID, key: body.api_key, metadata: { name: "Magpie (browser)" } }
}

async function browserSignIn(fetchImpl = globalThis.fetch, listen = loopback, signInTimeout = SIGN_IN_TIMEOUT) {
  const verifier = randomBytes(32).toString("base64url")
  const state = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  let over = false
  let settle
  const done = new Promise((resolve) => (settle = resolve))
  const finish = (result) => {
    if (over) return
    over = true
    settle(result)
  }
  const listener = await listen(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if (req.method !== "GET" || url.pathname !== "/callback") return res.writeHead(404).end("Not found")
    const html = (status, ok, title, message) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      res.end(callbackPage(ok, title, message))
    }
    if (over) return html(409, false, "Sign-in already finished", "Start DevPass sign-in again in Magpie.")
    const code = url.searchParams.get("code")
    const error = url.searchParams.get("error_description") || url.searchParams.get("error")
    if (url.searchParams.get("state") !== state || error || !code) {
      const message = error || (url.searchParams.get("state") !== state ? "The authorization response does not match this sign-in." : "The authorization response has no code.")
      finish({ type: "failed", error: message })
      return html(400, false, "DevPass sign-in failed", message)
    }
    try {
      const result = await exchangeBrowserCode(fetchImpl, code, verifier)
      finish(result)
      html(200, true, "DevPass is connected", "Return to Magpie. You can close this tab.")
    } catch (error) {
      const message = error?.message ?? String(error)
      finish({ type: "failed", error: message })
      html(400, false, "DevPass sign-in failed", message)
    }
  })
  const timer = setTimeout(() => finish({ type: "failed", error: "DevPass browser sign-in timed out. Please try again." }), signInTimeout)
  timer.unref?.()
  done.then(() => {
    clearTimeout(timer)
    setTimeout(listener.close, 1000).unref?.()
  })
  const query = new URLSearchParams({
    callback: listener.url,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    source: BROWSER_SOURCE,
    org: "devpass",
    name: "Magpie",
  })
  return {
    url: `${AUTHORIZE}?${query}`,
    instructions: "Sign in to DevPass in the browser and approve the Magpie connection. The browser will create a DevPass API key for Magpie.",
    method: "auto",
    callback: () => done,
  }
}

function createPlugin({ fetchImpl = globalThis.fetch, base = BASE, listen = loopback } = {}) {
  let latestRows = []
  const accountKey = async (getAuth) => {
    const auth = await getAuth()
    return auth?.type === "api" && typeof auth.key === "string" && auth.key ? auth.key : ""
  }
  const request = async (key, path) => api(fetchImpl, key, path)
  return {
    config: async (config) => {
      config.provider ??= {}
      config.provider[ID] ??= { name: "DevPass", npm: CHAT, api: BASE, models: {} }
    },
    auth: {
      provider: ID,
      methods: [
        { type: "oauth", label: "DevPass (browser)", authorize: () => browserSignIn(fetchImpl, listen) },
        { type: "api", label: "DevPass or LLM Gateway API key", placeholder: "llmgtwy_…" },
      ],
      async loader(getAuth) {
        const initialKey = await accountKey(getAuth)
        if (!initialKey) return {}
        return {
          baseURL: base,
          apiKey: initialKey,
          async fetch(input, init = {}) {
            const key = await accountKey(getAuth)
            if (!key) return Response.json({ error: { message: "DevPass is not signed in", type: "authentication_error" } }, { status: 401 })
            const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined))
            const signal = init.signal ?? (input instanceof Request ? input.signal : undefined)
            const method = init.method ?? (input instanceof Request ? input.method : "POST")
            const body = init.body ?? (input instanceof Request && method !== "GET" && method !== "HEAD" ? await input.clone().text() : undefined)
            headers.set("authorization", `Bearer ${key}`)
            headers.set("x-api-key", key)
            if (!headers.has("x-source")) headers.set("x-source", "usemagpie.ai")
            headers.delete("content-length")
            headers.delete("host")
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
            const res = await fetchImpl(url, { ...init, method, ...(body !== undefined ? { body } : {}), headers, signal })
            const out = new Headers(res.headers)
            out.set("X-Magpie-Sign-In", res.status === 401 ? "expired" : res.ok ? "renewed" : "kept")
            out.delete("content-length")
            out.delete("content-encoding")
            return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out })
          },
        }
      },
      async usage(getAuth) {
        const key = await accountKey(getAuth)
        if (!key) return {}
        let res
        try {
          res = await request(key, "/key")
        } catch (error) {
          return { error: `DevPass is unreachable: ${error?.message ?? error}`, windows: [] }
        }
        if (res.status === 401) return { error: "DevPass refused this key; sign in again", signIn: "expired", windows: [] }
        if (!res.ok) return { error: `DevPass answered HTTP ${res.status}`, signIn: "kept", windows: [] }
        let body
        try {
          body = await readJson(res, "key status")
        } catch (error) {
          return { error: error.message, signIn: "kept", windows: [] }
        }
        return { ...usageOf(body?.data, latestRows), signIn: "kept" }
      },
    },
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const key = auth?.type === "api" && typeof auth.key === "string" ? auth.key : ""
        if (!key) return provider.models
        let res
        try {
          res = await request(key, "/models?exclude_deprecated=true")
        } catch {
          return provider.models
        }
        if (res.status === 401) throw expired("DevPass", res.status)
        if (!res.ok) return provider.models
        const body = await readJson(res, "model list")
        latestRows = rowsOf(body?.data)
        return Object.fromEntries(latestRows.map((model) => [model.id, model]))
      },
    },
  }
}

export const DevPassPlugin = async () => createPlugin()
export const _internal = { createPlugin, active, npmOf, callable, effortsOf, costOf, variantsOf, serviceTiersOf, configModel, runtimeModel, rowsOf, notPremium, usageOf, api, browserSignIn, exchangeBrowserCode, BASE, AUTHORIZE, TOKEN, BROWSER_SOURCE, CHAT, RESPONSES, MESSAGES }
