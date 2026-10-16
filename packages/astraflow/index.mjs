import { browserAuthorize, manualAuthorize, refresher, control, LEAD } from "./oauth.mjs"

import { cliAuthorize, cliPrompts } from "./cli.mjs"
import { buildModel, mergeCatalog, catalogMetadata, normalizeThinking } from "./models.mjs"
import { readKeyDetails, allowedModels, summarizeKey, normalizeErrorResponse } from "./limits.mjs"

const ID = "astraflow"
const NPM = "@ai-sdk/openai-compatible"
const PROTOCOLS = {
  chat: { label: "Chat Completions (default)", npm: NPM, path: "/v1/chat/completions" },
  responses: { label: "OpenAI Responses", npm: "@ai-sdk/openai", path: "/v1/responses" },
  anthropic: { label: "Anthropic Messages", npm: "@ai-sdk/anthropic", path: "/v1/messages" },
  gemini: { label: "Google Gemini", npm: "@ai-sdk/google", path: "/v1beta/models" },
}

// The unified endpoints can fail over between regions; the others stay
// in their named region. See AstraFlow's authentication documentation.
const REGIONS = {
  china: { label: "China (unified, recommended)", host: "api.modelverse.cn" },
  global: { label: "Overseas (unified, recommended)", host: "api.umodelverse.ai" },
  wulanchabu: { label: "Wulanchabu", host: "api-cn-wlcb.modelverse.cn" },
  shanghai: { label: "Shanghai 2", host: "api-cn-sh2.modelverse.cn" },
  singapore: { label: "Singapore", host: "api-sg.umodelverse.ai" },
  "los-angeles": { label: "Los Angeles", host: "api-us-ca.umodelverse.ai" },
  frankfurt: { label: "Frankfurt", host: "api-ge-fra.umodelverse.ai" },
}

function credentials(auth, provider) {
  if (!["api", "oauth"].includes(auth?.type)) return null
  const raw = auth.type === "oauth" ? auth.inferenceKey : auth.key
  const key = typeof raw === "string" ? raw.trim() : ""
  if (!key || key.length > 8192 || /\s|[\x00-\x1f\x7f]/.test(key)) throw new Error("AstraFlow: enter a valid ModelVerse API key")
  const region = auth.metadata?.region ?? provider?.options?.region ?? "china"
  if (!Object.hasOwn(REGIONS, region)) throw new Error("AstraFlow: choose a supported region")
  const protocol = auth.metadata?.protocol ?? provider?.options?.protocol ?? "chat"
  if (!Object.hasOwn(PROTOCOLS, protocol)) throw new Error("AstraFlow: choose a supported API protocol")
  return { key, protocol, baseURL: `https://${REGIONS[region].host}/${protocol === "gemini" ? "v1beta" : "v1"}` }
}

// /models currently lists non-chat products too, without modality or
// protocol metadata. Follow the official astraflow-cli's picker filter,
// including newer Wan video models and dedicated search/translation APIs.
// Google's Nano Banana family is image generation even when the ID omits
// "image": https://ai.google.dev/gemini-api/docs/image-generation
const NON_CHAT = /image|nano-banana|seedream|flux|midjourney|stable-diffusion|sdxl|video|sora|kling|wan\d|hailuo|happyhorse|pixverse|vidu|seedance|i2v|t2v|r2v|lip-sync|audio|tts|speech|suno|music|sound|whisper|transcrib|embedding|rerank|ocr|easydoc|batch|moderation|web-search|(?:^|\/)qwen-mt-/i

function chatModel(id) {
  if (typeof id !== "string" || !id.trim() || id !== id.trim()) return false
  if (["__proto__", "constructor", "prototype"].includes(id)) return false
  return !NON_CHAT.test(id) && !/^(?:veo-|bge-|gte-|e5-)/i.test(id.split("/").at(-1))
}

// Optional control-plane enrichment is isolated from inference discovery.
// Restricted accounts can still use their inference key without this API.
async function squareModels(auth) {
  if (auth?.type !== "oauth" || !auth.projectId) return []
  try {
    const data = await control(auth, "ListUFSquareModel", { ProjectId: auth.projectId, Offset: 0, Limit: 1000 })
    const rows = data.SquareModels ?? data.Data ?? data.ModelSet
    return Array.isArray(rows) ? rows : rows && typeof rows === "object" ? Object.values(rows) : []
  } catch { return [] }
}

function safeMessage(value, key) {
  return String(value).split(key).join("[redacted]").slice(0, 500)
}

async function modelPage(cred, pageToken) {
  const url = new URL(cred.baseURL + "/models")
  if (pageToken) url.searchParams.set("pageToken", pageToken)
  let response
  try {
    response = await fetch(url.href, {
      headers: { Authorization: `Bearer ${cred.key}`, Accept: "application/json",
        ...(cred.protocol === "gemini" ? { "x-goog-api-key": cred.key } : {}) },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    })
  } catch (e) {
    throw new Error(`AstraFlow: couldn't list models: ${safeMessage(e?.message ?? e, cred.key)}`)
  }
  if (!response.ok) {
    let reason = ""
    try {
      const body = await response.json()
      reason = body?.error?.message ?? body?.message ?? ""
    } catch {}
    const e = new Error(`AstraFlow: model list HTTP ${response.status}${reason ? ": " + safeMessage(reason, cred.key) : ""}`)
    if (response.status === 401) e.signIn = "expired"
    throw e
  }
  let body
  try {
    body = await response.json()
  } catch {
    throw new Error("AstraFlow: model list isn't valid JSON")
  }
  const rows = cred.protocol === "gemini" ? body?.models : body?.data
  if (!Array.isArray(rows)) throw new Error("AstraFlow: model list has no data array")
  return { rows, next: cred.protocol === "gemini" ? body.nextPageToken : undefined }
}

async function listModels(cred, details, catalog = []) {
  const entries = new Map()
  const granted = allowedModels(details)
  const seen = new Set()
  let pageToken
  do {
    const { rows, next } = await modelPage(cred, pageToken)
    for (const row of rows) {
      const id = cred.protocol === "gemini" ? row?.baseModelId || (typeof row?.name === "string" ? row.name.replace(/^models\//, "") : undefined) : row?.id
      const actions = row?.supportedActions ?? row?.supportedGenerationMethods
      if (cred.protocol === "gemini" && (!Array.isArray(actions) || !actions.includes("generateContent"))) continue
      if (chatModel(id) && (!granted || granted.has(id))) {
        const enriched = mergeCatalog({ ...row, id }, catalog)
        const metadata = catalogMetadata(enriched)
        if (metadata.protocols?.[cred.protocol] === false) continue
        const m = buildModel(enriched, cred.baseURL, cred.protocol)
        m.astraflow = metadata
        entries.set(m.id, m)
      }
    }
    if (next === undefined || next === null || next === "") break
    if (typeof next !== "string" || next.length > 8192 || seen.has(next) || seen.size >= 100) {
      throw new Error("AstraFlow: model list has invalid or excessive pagination")
    }
    seen.add(next)
    pageToken = next
  } while (true)
  if (!entries.size) throw new Error("AstraFlow: model list has no conversational models")
  return Object.fromEntries(entries)
}

function geminiPath(path) {
  if (path === "/v1beta/models") return true
  const match = /^\/v1beta\/models\/(.+):(?:generateContent|streamGenerateContent)$/.exec(path)
  if (!match) return false
  try {
    // ModelVerse may namespace model IDs (vendor/model). Accept literal or
    // URL-encoded slashes, while keeping the action and resource restricted.
    return decodeURIComponent(match[1]).split("/").every((part) => /^[\w-][\w.-]*$/.test(part))
  } catch { return false }
}

const regionPrompt = {
  type: "select", key: "region", message: "Which AstraFlow endpoint should this key use?",
  options: Object.entries(REGIONS).map(([value, r]) => ({ value, label: r.label, hint: r.host })),
}
const protocolPrompt = {
  type: "select", key: "protocol", message: "Which upstream API protocol should this account use?",
  options: Object.entries(PROTOCOLS).map(([value, p]) => ({ value, label: p.label })),
}
const issuerPrompt = {
  type: "select", key: "issuer", message: "Where is your UCloud account registered? (Independent of inference region.)",
  options: [{ value: "ucloud", label: "UCloud China" }, { value: "ucloud-global", label: "UCloud Global" }],
}
async function authorize(method, inputs) {
  // Reject malformed endpoint choices before allocating a callback server.
  credentials({ type: "api", key: "validation", metadata: inputs })
  return method(inputs)
}

export async function AstraFlowPlugin({ client } = {}) {
  const { refresh, fresh } = refresher(client)
  return {
    config: async (config) => {
      config.provider ??= {}
      const was = config.provider[ID] ?? {}
      config.provider[ID] = {
        name: "AstraFlow",
        npm: NPM,
        api: "https://api.modelverse.cn/v1",
        ...was,
        // A bootstrap entry makes the unsigned provider visible to hosts
        // that require a configured model. Every successful signed-in list
        // replaces it, including when this model has since been retired.
        models: { "deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash" }, ...(was.models ?? {}) },
      }
    },
    auth: {
      provider: ID,
      refreshLead: LEAD,
      refresh,
      methods: [{
        type: "api",
        label: "AstraFlow / ModelVerse API key",
        prompts: [regionPrompt, protocolPrompt],
      }, {
        type: "oauth", label: "UCloud OAuth2 (browser, select project and key)",
        prompts: [regionPrompt, protocolPrompt, issuerPrompt],
        authorize: (inputs = {}) => authorize(browserAuthorize, inputs),
      }, {
        type: "oauth", label: "UCloud OAuth2 (manual callback / remote host)",
        prompts: [regionPrompt, protocolPrompt, issuerPrompt,
          { type: "text", key: "projectId", message: "Project ID (blank uses UCloud's default project)" },
          { type: "select", key: "keyMode", message: "Use an existing key, or explicitly create a new key with access to all ModelVerse models?",
            options: [{ value: "existing", label: "Existing API key" }, { value: "create", label: "Create a new API key (all ModelVerse models)" }] },
          { type: "text", key: "keyId", message: "Existing API key ID (blank only works if exactly one key is available)", condition: (inputs) => inputs.keyMode === "existing" },
          { type: "text", key: "keyName", message: "New API key name", condition: (inputs) => inputs.keyMode === "create", validate: (v) => v.trim() && v.trim().length <= 64 ? undefined : "Enter a name of 1–64 characters" },
        ],
        authorize: (inputs = {}) => authorize(manualAuthorize, inputs),
      }, {
        type: "oauth", label: "AstraFlow CLI configuration (read-only import)",
        prompts: cliPrompts, authorize: cliAuthorize,
      }],
      async loader(getAuth, provider) {
        const cred = credentials(await fresh(getAuth), provider)
        if (!cred) return {}
        return {
          baseURL: cred.baseURL,
          apiKey: cred.key,
          async fetch(input, init) {
            const active = await fresh(getAuth)
            const current = credentials(active, provider)
            if (!current) throw new Error("AstraFlow: not signed in")
            const request = new Request(input, init)
            const url = new URL(request.url)
            const base = new URL(current.baseURL)
            // Never forward the account's key to a caller-supplied host or
            // follow a redirect. Only the APIs this plugin declares run.
            const pathAllowed = current.protocol === "gemini"
              ? geminiPath(url.pathname)
              : [PROTOCOLS[current.protocol].path, "/v1/models"].includes(url.pathname)
            if (url.origin !== base.origin || !pathAllowed) {
              throw new Error("AstraFlow: request is outside the selected endpoint")
            }
            const headers = new Headers(request.headers)
            headers.set("Authorization", `Bearer ${current.key}`)
            headers.delete("x-api-key")
            headers.delete("x-goog-api-key")
            if (current.protocol === "gemini") headers.set("x-goog-api-key", current.key)
            if (current.protocol === "anthropic") {
              headers.set("x-api-key", current.key)
              if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01")
            }
            headers.delete("host")
            headers.delete("content-length")
            // Google clients can carry a key in the URL. Keep one source of
            // authentication, freshly read from this account, in headers.
            if (current.protocol === "gemini") url.searchParams.delete("key")
            let normalizedBody
            if (current.protocol === "chat" && request.method === "POST") {
              try {
                const body = await request.clone().json()
                const normalized = normalizeThinking(body)
                if (normalized !== body) normalizedBody = JSON.stringify(normalized)
              } catch {}
            }
            const outgoing = new Request(url, new Request(request, { headers, redirect: "error",
              ...(normalizedBody !== undefined ? { body: normalizedBody } : {}),
            }))
            const response = await fetch(outgoing)
            return normalizeErrorResponse(response, [current.key, active.access, active.refresh])
          },
        }
      },
      async usage(getAuth) {
        let auth
        try {
          auth = await fresh(getAuth)
          const cred = credentials(auth)
          if (!cred) return { error: "AstraFlow: not signed in" }
          const user = auth.accountId || `ModelVerse key …${cred.key.slice(-4)}`
          if (auth.type === "api") return { user, plan: "ModelVerse API key", windows: [], signIn: "kept" }
          const [balance, details] = await Promise.all([
            control(auth, "GetBalance").then((data) => ({ data }), (error) => ({ error })),
            readKeyDetails(auth, control),
          ])
          const key = summarizeKey(details)
          if (balance.error) return { user, plan: key.label || `ModelVerse / ${auth.projectName || auth.projectId}`, windows: key.windows,
            error: balance.error.message, signIn: balance.error.signIn || "kept" }
          const data = balance.data
          const info = data.AccountInfo ?? data
          const amount = info.AmountAvailable ?? info.Amount
          // UCloud's schema has no currency field and no ModelVerse quota.
          // Keep the account currency; don't fabricate a USD conversion.
          const plan = `ModelVerse / ${auth.projectName || auth.projectId}${key.label ? "; " + key.label : ""}`
          if (!["number", "string"].includes(typeof amount) || String(amount).trim() === "" || !Number.isFinite(Number(amount))) {
            return { user, plan, windows: key.windows, error: "AstraFlow: UCloud returned no account balance", signIn: "kept" }
          }
          return { user, plan, balance: `${amount} (UCloud account currency)`, windows: key.windows, signIn: "kept" }
        } catch (e) {
          return { ...(auth?.accountId ? { user: auth.accountId } : {}), error: e.message, signIn: e.signIn || "kept" }
        }
      },
    },
    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        // This hook receives a snapshot, not a live getAuth. Magpie owns its
        // proactive renewal; never persist a stale snapshot over a new login.
        // Inference listing uses the selected API key independently of OAuth.
        const active = auth
        const cred = credentials(active, provider)
        if (!cred) return provider?.models ?? {}
        // No static fallback or cross-account cache: host refreshes replace
        // the list, and failures are reported for the host to retain its own.
        const [details, catalog] = await Promise.all([readKeyDetails(active, control), squareModels(active)])
        return listModels(cred, details, catalog)
      },
    },
  }
}

// for tests
export const _internal = { REGIONS, PROTOCOLS, chatModel }
