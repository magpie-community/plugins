import { handleChatCompletions, handleModels } from './handler.mjs'
import { createSessionStore, SESSION_DEFAULTS } from './sessions.mjs'

function requestUrl(input) {
  try {
    return input instanceof Request ? new URL(input.url) : new URL(String(input))
  } catch {
    return null
  }
}

async function readBody(input, init) {
  if (init?.body != null) return new Response(init.body).json()
  return input instanceof Request ? input.json() : {}
}

function headerOf(input, init, name) {
  try {
    const headers = init?.headers != null ? new Headers(init.headers) : input?.headers
    return headers?.get(name) ?? undefined
  } catch {
    return undefined
  }
}

export function makeFetch(outpostMgr, opts, sessions) {
  return async function quickFetch(input, init) {
    const url = requestUrl(input)
    const pathname = url?.pathname ?? ''
    const models = /\/models\/?$/.test(pathname)
    if (!models && !/\/chat\/completions\/?$/.test(pathname)) {
      return new Response(JSON.stringify({ error: { message: `aws-quick 插件只支持 chat/completions（收到 ${pathname}）`, type: 'invalid_request_error' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase()
    const allowed = models ? 'GET' : 'POST'
    if (method !== allowed) return Response.json({ error: { message: `use ${allowed} for ${pathname}`, type: 'invalid_request_error' } }, { status: 405, headers: { allow: allowed } })
    if (models) return handleModels()
    const signal = init?.signal ?? input?.signal
    if (signal?.aborted) return Response.json({ error: { message: 'aborted', type: 'api_error' } }, { status: 499 })
    let body
    try {
      body = await readBody(input, init)
    } catch {
      return new Response(JSON.stringify({ error: { message: 'request body must be JSON', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } })
    }
    return handleChatCompletions({
      body,
      outpostMgr,
      sessions,
      options: { ...opts, identity: opts.identityKey || 'aws-quick' },
      effortHeader: headerOf(input, init, 'x-magpie-effort'),
      signal,
    })
  }
}

export function makeSessions(opts) {
  if (opts.sessionReuse === false || opts.sessionReuse === 'false' || opts.sessionReuse === 0) return undefined
  const ttlMs = Number(opts.sessionTtlMs) > 0 ? Number(opts.sessionTtlMs) : SESSION_DEFAULTS.ttlMs
  const max = Number(opts.sessionMax) > 0 ? Math.floor(Number(opts.sessionMax)) : SESSION_DEFAULTS.max
  return createSessionStore({ ttlMs, max })
}
