// The request side of what mistral-gateway did: Mistral's API answers 422 to
// several OpenAI fields, GLM needs a real max_tokens, a rejected
// reasoning_effort is retried at the nearest level the model lists, and a 429
// is retried on the same key inside a bounded window.

import { MODEL_ALIASES, REASONING_EFFORT_LEVELS } from "./constants.mjs"
import { normalizeJson, normalizeSseStream } from "./normalize.mjs"

const RETRY_429_WINDOW_MS = 60_000
const RETRY_429_INTERVAL_MS = 10_000
const CHAT_PATHS = /\/(chat\/completions|responses)\/?$/

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function realModel(id) {
  return MODEL_ALIASES[id] ?? id
}

// prepareBody applies mistral-gateway's chat rewrites. Returns the body text
// to send (unchanged when there was nothing to change).
export function prepareBody(text, url) {
  if (!text) return text
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return text
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return text

  // `<id>--api` is the API-budget variant of the model: the suffix picks the
  // key, the upstream sees the bare id.
  if (typeof parsed.model === "string" && parsed.model.endsWith("--api")) {
    parsed.model = parsed.model.slice(0, -"--api".length)
  }

  const aliased = MODEL_ALIASES[String(parsed.model)]
  if (aliased) parsed.model = aliased

  // /v1/responses carries no chat messages and Mistral takes its shape as is.
  if (!/\/responses\/?$/.test(url)) {
    const stream = parsed.stream === true
    if (stream && parsed.stream_options == null) parsed.stream_options = { include_usage: true }

    if ("max_completion_tokens" in parsed) {
      const value = parsed.max_completion_tokens
      delete parsed.max_completion_tokens
      if (value != null) parsed.max_tokens = value
    }
    if ("seed" in parsed) {
      parsed.random_seed = parsed.seed
      delete parsed.seed
    }
    if ("user" in parsed) delete parsed.user

    if (parsed.max_tokens == null) {
      // Mistral caps GLM completions at 4096 without max_tokens, which its
      // thinking alone can spend; GLM's own output limit is 128K.
      parsed.max_tokens = String(parsed.model).includes("glm") ? 131072 : 32768
    }

    if (Array.isArray(parsed.messages)) {
      for (const message of parsed.messages) {
        if (!message || typeof message !== "object") continue
        // Replies carry these; Mistral 422s a reply sent back as it came.
        delete message.reasoning_content
        delete message.index
      }
      const last = parsed.messages[parsed.messages.length - 1]
      if (
        parsed.reasoning_effort == null &&
        String(parsed.model).includes("glm") &&
        Array.isArray(parsed.tools) &&
        parsed.tools.length &&
        last?.role === "tool"
      ) {
        // GLM can end a tool-result turn with zero visible text; "high" makes
        // it finish deliberating and compose (measured by mistral-gateway).
        parsed.reasoning_effort = "high"
      }
    }
  }
  return JSON.stringify(parsed)
}

// snapEffort rewrites a rejected reasoning_effort into the nearest level the
// upstream error lists, or drops it when the model has none. null when the
// error isn't about the level, so the caller passes the refusal on.
export function snapEffort(text, detail) {
  const error = String(detail ?? "")
  if (!error.includes("reasoning_effort")) return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const nested = parsed?.reasoning
  const owner = nested && typeof nested === "object" ? nested : parsed
  const field = owner === nested ? "effort" : "reasoning_effort"
  const requested = owner?.[field]

  if (error.includes("reasoning_effort is not enabled") && requested != null) {
    delete owner[field]
    return JSON.stringify(parsed)
  }
  if (!error.includes("is not supported")) return null
  const listed = error.split("is not supported", 2)[1] ?? ""
  const supported = REASONING_EFFORT_LEVELS.filter((level) => listed.includes(`'${level}'`))
  if (!REASONING_EFFORT_LEVELS.includes(requested) || supported.includes(requested) || !supported.length) return null
  const rank = REASONING_EFFORT_LEVELS.indexOf(requested)
  const candidates = ["none", "minimal", "low"].includes(requested) ? supported : [...supported].reverse()
  let closest = candidates[0]
  for (const level of candidates) {
    if (Math.abs(REASONING_EFFORT_LEVELS.indexOf(level) - rank) < Math.abs(REASONING_EFFORT_LEVELS.indexOf(closest) - rank)) closest = level
  }
  owner[field] = closest
  return JSON.stringify(parsed)
}

function isChat(url) {
  return CHAT_PATHS.test(new URL(url).pathname)
}

function detailOf(text) {
  try {
    const parsed = JSON.parse(text)
    return JSON.stringify(parsed)
  } catch {
    return text
  }
}

// sendChat is the loader's fetch: the key the model's wallet names, retries
// 429, snaps a rejected effort once, and normalizes GLM replies on the way
// back.
export async function sendChat(input, init, keys) {
  const request = input instanceof Request ? input : new Request(input, init)
  const url = request.url
  const method = request.method
  let originalText = ""
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    originalText = init?.body != null && typeof init.body === "string" ? init.body : await request.clone().text()
  }

  // The model id says which wallet: `<id>--api` spends the API budget, the
  // bare id the Vibe budget.
  let requested = ""
  try {
    requested = JSON.parse(originalText)?.model ?? ""
  } catch {}
  const wantsApi = typeof requested === "string" && requested.endsWith("--api")
  const key = wantsApi ? keys?.api : (keys?.vibe ?? keys?.api)

  const headers = new Headers(init?.headers ?? request.headers)
  headers.delete("authorization")
  headers.delete("x-api-key")
  headers.delete("content-length")
  if (!key) {
    return new Response(
      JSON.stringify({
        error: {
          message: `${requested || "this request"} needs the ${wantsApi ? "API" : "Vibe"} key, which this sign-in doesn't hold`,
          type: "invalid_request_error",
        },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    )
  }
  headers.set("authorization", `Bearer ${key}`)
  const lookedLikeChat = isChat(url)
  let bodyText = lookedLikeChat ? prepareBody(originalText, url) : originalText
  let stream = false
  try {
    stream = JSON.parse(bodyText)?.stream === true
  } catch {}

  const started = Date.now()
  let response
  for (;;) {
    response = await fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : bodyText,
      signal: request.signal,
      redirect: "follow",
    })
    if (response.status !== 429 || Date.now() - started >= RETRY_429_WINDOW_MS) break
    const retryAfterRaw = response.headers.get("retry-after")
    const retryAfter = retryAfterRaw == null ? Number.NaN : Number(retryAfterRaw)
    await response.body?.cancel?.().catch(() => {})
    const wait = Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.max(100, retryAfter * 1000) : RETRY_429_INTERVAL_MS
    await sleep(Math.min(wait, Math.max(0, RETRY_429_WINDOW_MS - (Date.now() - started))))
  }

  if ((response.status === 400 || response.status === 422) && lookedLikeChat) {
    const text = await response.text()
    const snapped = snapEffort(bodyText, detailOf(text))
    if (snapped != null) {
      const retried = await fetch(url, {
        method,
        headers,
        body: snapped,
        signal: request.signal,
        redirect: "follow",
      })
      if (retried.ok) {
        bodyText = snapped
        response = retried
      } else {
        return retried
      }
    } else {
      return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers })
    }
  }

  if (!response.ok) return response
  if (!lookedLikeChat) return response

  if (stream && /(^|\n)text\/event-stream/i.test(response.headers.get("content-type") ?? "")) {
    return normalizeSseStream(response)
  }
  const text = await response.text()
  try {
    const parsed = normalizeJson(JSON.parse(text))
    const headers = new Headers(response.headers)
    headers.delete("content-length")
    return new Response(JSON.stringify(parsed), { status: response.status, statusText: response.statusText, headers })
  } catch {
    return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}
