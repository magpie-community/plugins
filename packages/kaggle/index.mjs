/**
 * magpie-kaggle — your Kaggle account's free AI model credits as a magpie / OpenCode provider.
 *
 * Kaggle gives every verified account $10/day + $100/month of free model
 * inference through its Model Proxy (Kaggle Benchmarks). The proxy speaks
 * OpenAI Chat Completions at <baseUri>/openapi/v1, but the bearer token it
 * takes is short-lived (~2h): this plugin mints and refreshes it from your
 * long-lived Kaggle API token (KGAT_…, kaggle.com/settings/api) through the
 * same endpoint the official `kaggle benchmarks auth` CLI uses:
 *
 *   POST https://www.kaggle.com/api/v1/models/proxy/token   (Bearer KGAT)
 *     -> { token, baseUri, expiryTime }
 *   GET  https://www.kaggle.com/api/v1/models/proxy/quota   (Bearer KGAT)
 *     -> [{ quotaUsed, totalQuotaAllowed, refillPeriod, refillTime }]
 *
 * Sign-in: paste a Kaggle API token once ("API Tokens" at kaggle.com/settings,
 * magpie keeps it as the account key). The proxy token is never stored; it is
 * minted in memory a couple of minutes before expiry.
 */
import { randomUUID } from 'node:crypto'

const PROVIDER = 'kaggle'
const KAGGLE_API = 'https://www.kaggle.com'
// Requests never reach this address: the loader's fetch intercepts them.
const BASE = 'https://model-proxy.kaggle.local/magpie-kaggle/v1'
// Refresh a proxy token this long before its expiry.
const REFRESH_LEAD_MS = 2 * 60 * 1000

/**
 * Model list: short ids magpie shows -> upstream slugs the proxy takes.
 * Verified live 2026-11-26 (deepseek/qwen answered 404 that day but are in
 * the official LLMS_AVAILABLE set; they work when Kaggle serves them again).
 */
const MODELS = [
  { id: 'sonnet-5', name: 'Claude Sonnet 5', upstream: 'anthropic/claude-sonnet-5@default', context: 200000, output: 64000, reasoning: true },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', upstream: 'google/gemini-3-flash-preview', context: 1000000, output: 64000, reasoning: true },
  { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', upstream: 'google/gemini-3.1-flash-lite-preview', context: 1000000, output: 64000, reasoning: false },
  { id: 'gpt-5.4-nano', name: 'GPT-5.4 nano', upstream: 'openai/gpt-5.4-nano-2026-03-17', context: 400000, output: 128000, reasoning: true },
  { id: 'gpt-oss-120b', name: 'gpt-oss 120B', upstream: 'openai/gpt-oss-120b', context: 128000, output: 32000, reasoning: true },
  { id: 'granite-4h', name: 'Granite 4.0 H Small', upstream: 'ibm/granite-4.0-h-small', context: 128000, output: 8000, reasoning: true },
  { id: 'deepseek-r1', name: 'DeepSeek R1', upstream: 'deepseek-ai/deepseek-r1-0528', context: 128000, output: 32000, reasoning: true },
  { id: 'qwen3-next-80b', name: 'Qwen3 Next 80B', upstream: 'qwen/qwen3-next-80b-a3b-instruct', context: 256000, output: 32000, reasoning: false },
]
const UPSTREAM_BY_ID = Object.fromEntries(MODELS.map((m) => [m.id, m.upstream]))

function modelEntry(m) {
  return {
    limit: { context: m.context, output: m.output },
    tool_call: true,
    api: { url: BASE, npm: '@ai-sdk/openai-compatible' },
    capabilities: {
      temperature: false,
      reasoning: m.reasoning,
      attachment: true,
      toolcall: true,
      input: { text: true, image: true, audio: false, video: false, pdf: false },
      output: { text: true },
      interleaved: false,
    },
  }
}

// ---- proxy token minting ----------------------------------------------------

const sessions = new Map() // kgat -> { token, baseUri, expiryMs, pending }

async function mint(kgat, fetchImpl) {
  const resp = await fetchImpl(`${KAGGLE_API}/api/v1/models/proxy/token`, {
    method: 'POST',
    headers: { authorization: `Bearer ${kgat}`, 'content-type': 'application/json' },
    body: '{}',
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    const err = new Error(`Kaggle 铸币失败 ${resp.status}: ${text.slice(0, 200)}`)
    err.status = resp.status
    throw err
  }
  const data = await resp.json()
  if (!data?.token || !data?.baseUri) throw new Error('Kaggle 铸币响应缺少 token/baseUri')
  const expiryMs = data.expiryTime ? new Date(data.expiryTime).getTime() : Date.now() + 110 * 60 * 1000
  return { token: data.token, baseUri: String(data.baseUri).replace(/\/+$/, ''), expiryMs }
}

/** A valid proxy session for this Kaggle token, minting or refreshing as needed. */
async function proxySession(kgat, fetchImpl) {
  const c = sessions.get(kgat)
  if (c?.token && c.expiryMs - REFRESH_LEAD_MS > Date.now()) return c
  if (c?.pending) return c.pending
  const pending = mint(kgat, fetchImpl)
    .then((fresh) => {
      sessions.set(kgat, { ...fresh, pending: null })
      return sessions.get(kgat)
    })
    .catch((e) => {
      sessions.delete(kgat)
      throw e
    })
  sessions.set(kgat, { pending })
  return pending
}

// ---- the intercepted fetch --------------------------------------------------

function requestUrl(input) {
  try {
    return input instanceof Request ? new URL(input.url) : new URL(String(input))
  } catch {
    return null
  }
}

async function readBodyText(input, init) {
  let raw = init?.body
  if (raw == null && input instanceof Request) raw = await input.text()
  if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) raw = new TextDecoder().decode(raw)
  return typeof raw === 'string' ? raw : raw == null ? '' : String(raw)
}

function openaiModelsList() {
  return {
    object: 'list',
    data: MODELS.map((m) => ({ id: m.id, object: 'model', created: 0, owned_by: 'kaggle' })),
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

function errorResponse(message, status, type = 'api_error') {
  return jsonResponse({ error: { message, type, code: status } }, status)
}

function makeFetch(kgat, opts) {
  const fetchImpl = opts.fetchImpl || fetch
  return async function kaggleFetch(input, init) {
    const url = requestUrl(input)
    const path = url?.pathname ?? ''
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()

    if (/\/models\/?$/.test(path) && method === 'GET') return jsonResponse(openaiModelsList())

    if (!/\/chat\/completions\/?$/.test(path) && !/\/responses\/?$/.test(path)) {
      return errorResponse(`magpie-kaggle 只支持 chat/completions 和 responses（收到 ${method} ${path}）`, 404, 'invalid_request_error')
    }

    let bodyText
    try {
      bodyText = await readBodyText(input, init)
    } catch {
      return errorResponse('request body must be JSON', 400, 'invalid_request_error')
    }
    let body
    try {
      body = JSON.parse(bodyText || '{}')
    } catch {
      return errorResponse('request body must be JSON', 400, 'invalid_request_error')
    }

    // Map magpie's short model id to the upstream slug; pass unknown ids through.
    const asked = typeof body.model === 'string' ? body.model : ''
    if (UPSTREAM_BY_ID[asked]) body.model = UPSTREAM_BY_ID[asked]

    let sess
    try {
      sess = await proxySession(kgat, fetchImpl)
    } catch (e) {
      return errorResponse(`Kaggle 代理令牌获取失败：${e?.message ?? e}。请检查 API Token 是否有效（kaggle.com/settings/api）`, e?.status === 401 ? 401 : 502)
    }

    const endpoint = /\/responses\/?$/.test(path) ? 'responses' : 'chat/completions'
    const upstream = `${sess.baseUri}/openapi/v1/${endpoint}`
    try {
      const headers = {
        authorization: `Bearer ${sess.token}`,
        'content-type': 'application/json',
        accept: body.stream ? 'text/event-stream' : 'application/json',
      }
      return await fetchImpl(upstream, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: init?.signal,
      })
    } catch (e) {
      return errorResponse(`Kaggle 代理请求失败：${e?.message ?? e}`, 502)
    }
  }
}

// ---- quota / usage ----------------------------------------------------------

async function fetchQuota(kgat, fetchImpl) {
  const resp = await fetchImpl(`${KAGGLE_API}/api/v1/models/proxy/quota`, {
    headers: { authorization: `Bearer ${kgat}` },
  })
  if (!resp.ok) {
    const err = new Error(`quota ${resp.status}`)
    err.status = resp.status
    throw err
  }
  return resp.json()
}

function usageFromQuota(quota, { user } = {}) {
  const list = Array.isArray(quota) ? quota : quota?.quotaBalances ?? []
  const windows = []
  for (const q of list) {
    const total = Number(q.totalQuotaAllowed ?? q.total_quota_allowed) || 0
    const usedAmt = Number(q.quotaUsed ?? q.quota_used) || 0
    const period = String(q.refillPeriod ?? q.refill_period ?? '')
    const name = /daily/i.test(period) ? '每日额度' : /monthly/i.test(period) ? '每月额度' : period || '额度'
    const resetsAt = q.refillTime ?? q.refill_time
    windows.push({
      name,
      ...(total > 0 ? { used: Math.min(100, (usedAmt / total) * 100) } : {}),
      amount: Math.round(usedAmt * 100) / 100,
      limit: total,
      unit: '$',
      ...(resetsAt ? { resetsAt: new Date(resetsAt).toISOString() } : {}),
    })
  }
  return { plan: 'Kaggle AI Models (free)', ...(user ? { user } : {}), signIn: 'kept', windows }
}

// ---- the plugin -------------------------------------------------------------

export const KagglePlugin = async (_input, options) => {
  const opts = options && typeof options === 'object' ? options : {}
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: 'Kaggle Models',
        npm: '@ai-sdk/openai-compatible',
        api: BASE,
        models: {},
      }
    },

    auth: {
      provider: PROVIDER,
      methods: [
        {
          type: 'api',
          label: 'Kaggle API Token（kaggle.com/settings/api 创建）',
          labels: {
            zh: 'Kaggle API Token（kaggle.com/settings/api 创建）',
            'zh-TW': 'Kaggle API Token（kaggle.com/settings/api 建立）',
            en: 'Kaggle API Token (kaggle.com/settings/api)',
          },
          placeholder: 'KGAT_…',
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth?.key) return {}
        return {
          baseURL: BASE,
          apiKey: 'kaggle-proxy',
          fetch: makeFetch(auth.key, { fetchImpl: opts.fetchImpl }),
        }
      },
      // magpie's own hook: free-credit windows for the account card / Usage page.
      usage: async (getAuth, _provider, ctx) => {
        const auth = await getAuth()
        if (!auth?.key) return { error: '未配置 Kaggle API Token' }
        try {
          const quota = await fetchQuota(auth.key, opts.fetchImpl || fetch)
          return usageFromQuota(quota, {})
        } catch (e) {
          return { error: `Kaggle 额度查询失败：${e?.message ?? e}` }
        }
      },
    },

    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        if (auth?.type !== 'api' || !auth.key) return provider.models
        const out = {}
        for (const m of MODELS) out[m.id] = modelEntry(m)
        return out
      },
    },
  }
}

export const _internal = { makeFetch, proxySession, usageFromQuota, MODELS, PROVIDER, BASE }
