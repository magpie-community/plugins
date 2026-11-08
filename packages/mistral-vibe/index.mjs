// Magpie provider plugin for a Mistral Vibe plan.
//
// It replaces mistral-gateway (Classic298/mistral-gateway) inside magpie: the
// Vibe key signs in as a provider, the gateway's request/reply fixes live in
// the provider's fetch, and the plan's monthly Vibe Code allowance is read
// through magpie's usage hook — the card on the Usage page, `magpie quota`,
// the quota alert and GET /v1/magpie/quotas all show it.
//
// One provider, one model list. Its models are offered on both wallets:
// the bare id spends the Vibe budget, `<id>--api` spends the API budget. Both
// keys live in the one sign-in (`vibe=…;api=…`), so the fetch can pick by the
// model id; magpie's account selection is not involved.

import { CONSOLE_ROOT, NPM, PROVIDER_ID, V1 } from "./src/constants.mjs"
import { sendChat } from "./src/provider.mjs"
import { readQuota } from "./src/quota.mjs"

// Ids that end this way are the API-budget variant of the model before it.
export const API_SUFFIX = "--api"

// modelOf is a live /v1/models or catalog entry in the shape magpie's
// provider hook wants.
function modelOf(m, provider, efforts = []) {
  const caps = m?.capabilities ?? {}
  const context = Number(m?.max_context_length) || 0
  return {
    id: m.id,
    providerID: provider.id,
    name: m.label || m.name || m.id,
    api: { id: m.id, url: V1, npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context, output: 0 },
    capabilities: {
      temperature: true,
      reasoning: efforts.length > 0 || !!caps.reasoning,
      attachment: !!caps.vision,
      toolcall: caps.function_calling !== false,
      input: { text: true, image: !!caps.vision, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    // A model's reasoning levels, as the catalog names them.
    variants: Object.fromEntries(efforts.map((level) => [level, { reasoningEffort: level }])),
  }
}

// parseKeys reads the one sign-in into its keys. Accepted forms:
//   "mstr…"                         the Vibe key alone
//   "vibe=mstr…;api=mst…"           both, in one line
//   {"vibe":"mstr…","api":"mst…"}   the same as JSON
//   "mstr…;mst…"                    both, bare, in that order
export function parseKeys(raw) {
  const text = String(raw ?? "").trim()
  if (!text) return {}
  // A Mistral key is ~45 characters; anything this short is a placeholder
  // (a failed read wrote "None" once) and must not become a credential.
  const clean = (value) => {
    const trimmed = typeof value === "string" ? value.trim() : ""
    return trimmed.length >= 16 ? trimmed : undefined
  }
  const keys = {}
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text)
      for (const name of ["vibe", "api"]) {
        const value = clean(parsed?.[name])
        if (value) keys[name] = value
      }
      if (keys.vibe || keys.api) return keys
    } catch {}
  }
  const parts = text.split(/[;\n]+/).map((part) => part.trim()).filter(Boolean)
  for (const part of parts) {
    const pair = /^(vibe|api)\s*=\s*(.+)$/i.exec(part)
    if (pair) {
      const value = clean(pair[2])
      if (value) keys[pair[1].toLowerCase()] = value
    }
  }
  if (keys.vibe || keys.api) return keys
  const bare = parts.filter((part) => !part.includes("=")).map(clean).filter(Boolean)
  if (bare[0]) keys.vibe = bare[0]
  if (bare[1]) keys.api = bare[1]
  return keys
}

// isChat keeps the chat models; /v1/models lists embeddings, OCR, TTS and
// transcription too.
function isChat(m) {
  return !!m?.id && m.capabilities?.completion_chat === true
}

function representative(ids, byId) {
  const score = (id) => {
    const m = byId.get(id)
    return (id === m.billing_model_name ? 8 : 0) + (id === m.name ? 4 : 0) + (id.endsWith("-latest") ? 2 : 0)
  }
  return [...ids].sort((a, b) => score(b) - score(a) || a.length - b.length || a.localeCompare(b))[0]
}

// listed dedupes /v1/models: chats only, one id per family (billing_model_name
// and the aliases links name the family).
export function listed(data) {
  const chat = (Array.isArray(data) ? data : []).filter(isChat)
  const byId = new Map(chat.map((m) => [m.id, m]))
  const parent = new Map(chat.map((m) => [m.id, m.id]))
  const find = (id) => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root)
    let at = id
    while (parent.get(at) !== at) {
      const next = parent.get(at)
      parent.set(at, root)
      at = next
    }
    return root
  }
  const union = (a, b) => {
    const [ra, rb] = [find(a), find(b)]
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const m of chat) {
    for (const alias of Array.isArray(m.aliases) ? m.aliases : []) if (byId.has(alias)) union(m.id, alias)
    if (m.billing_model_name && byId.has(m.billing_model_name)) union(m.id, m.billing_model_name)
  }
  const families = new Map()
  for (const m of chat) {
    const root = find(m.id)
    if (!families.has(root)) families.set(root, [])
    families.get(root).push(m.id)
  }
  return [...families.values()].map((ids) => byId.get(representative(ids, byId)))
}

// DeepSeek answers but is not on the CLI's catalog; the Vibe key can spend its
// allowance on it (measured), so it belongs in the group.
const DEEPSEEK = /^deepseek/i

// variantsOf is one model as each wallet's id: the bare id for the Vibe
// budget, `<id>--api` for the API budget.
function variantsOf(entry, provider, keys) {
  const efforts = Array.isArray(entry.parameters?.reasoning) ? entry.parameters.reasoning : []
  const base = modelOf(entry, provider, efforts)
  const label = entry.label || entry.name || entry.id
  const out = []
  if (keys.vibe) out.push({ ...base, name: `${label} (Vibe budget)` })
  if (keys.api) {
    out.push({
      ...base,
      id: `${entry.id}${API_SUFFIX}`,
      name: `${label} (API budget)`,
      api: { ...base.api, id: `${entry.id}${API_SUFFIX}` },
    })
  }
  return out
}

export const MistralVibeAuthPlugin = async () => {
  return {
    config: async (config) => {
      config.provider ??= {}
      config.provider[PROVIDER_ID] ??= {}
      const provider = config.provider[PROVIDER_ID]
      provider.name ??= "Mistral Vibe"
      provider.npm ??= NPM
      provider.api ??= V1
      // No static defaults: the list depends on which keys the sign-in holds,
      // so only the hook below knows it. User-set model entries stay as they
      // came.
    },

    provider: {
      id: PROVIDER_ID,
      // The Vibe plan's catalog plus DeepSeek, each as both wallets' ids (the
      // ids the account's keys can serve). The account's deduped chat models
      // if the catalog can't be read; the declared list before sign-in.
      async models(provider, { auth }) {
        const keys = parseKeys(auth?.key)
        const token = keys.vibe ?? keys.api
        if (!token) return provider.models ?? {}
        const read = async (url) => {
          try {
            const response = await fetch(url, {
              headers: { authorization: `Bearer ${token}`, accept: "application/json" },
              signal: AbortSignal.timeout(8_000),
            })
            return response.ok ? await response.json() : null
          } catch {
            return null
          }
        }
        const [catalog, account] = await Promise.all([
          read(`${V1}/model-catalog?surface=vibe-code`),
          read(`${V1}/models`),
        ])
        const accountModels = listed(account?.data)
        const catalogModels = (Array.isArray(catalog?.models) ? catalog.models : []).filter((m) => m?.id)
        const base = catalogModels.length ? [...catalogModels] : [...accountModels]
        if (!base.some((m) => DEEPSEEK.test(m.id))) base.push(...accountModels.filter((m) => DEEPSEEK.test(m.id)))
        if (!base.length) return provider.models ?? {}
        const seen = new Set()
        const models = []
        for (const entry of base) {
          if (seen.has(entry.id)) continue
          seen.add(entry.id)
          models.push(...variantsOf(entry, provider, keys))
        }
        return Object.fromEntries(models.map((m) => [m.id, m]))
      },
    },

    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          // One sign-in holds both keys. The Vibe key is the one the official
          // CLI writes to ~/.vibe/.env (or chat.mistral.ai/code/extensions →
          // Vibe CLI → Advanced); the Studio key is from the console's API ›
          // API keys. Nothing is renewed: neither key expires.
          type: "api",
          label: "Mistral keys (Vibe, and API if you want both wallets)",
          placeholder: "vibe=…;api=…  (or the Vibe key alone)",
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth()
        const keys = parseKeys(auth?.key)
        if (!keys.vibe && !keys.api) return {}
        return {
          baseURL: V1,
          apiKey: "",
          // The key, the rewrites and the GLM reply normalization all live in
          // sendChat; apiKey is empty because it sets Authorization itself.
          fetch: (input, init) => sendChat(input, init, keys),
        }
      },

      // magpie's usage card: both budgets, with the key's own one first.
      async usage(getAuth) {
        const auth = await getAuth()
        const keys = parseKeys(auth?.key)
        const token = keys.vibe ?? keys.api
        if (!token) return { windows: [], signIn: "kept", error: "not signed in" }
        try {
          return await readQuota(token)
        } catch (error) {
          return { windows: [], signIn: "kept", error: `Vibe quota unreadable: ${error?.message ?? error}` }
        }
      },
    },
  }
}
