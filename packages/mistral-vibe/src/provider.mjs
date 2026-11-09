// The request side: Mistral answers 422 to several OpenAI fields, GLM needs a
// real max_tokens, and a rejected reasoning_effort is retried once at a level
// the model lists. Written from the behaviour measured against the API.

import { MODEL_ALIASES, REASONING_EFFORT_LEVELS } from "./constants.mjs"
import { rewritePayload, rewriteStream } from "./normalize.mjs"

const CHAT_PATHS = /\/(chat\/completions|responses)\/?$/
const API_SUFFIX = "--api"
// Without max_tokens Mistral caps a GLM completion at 4096 tokens, which its
// thinking alone can spend; GLM models accept this much output.
const GLM_OUTPUT_LIMIT = 131072

// prepareBody applies the request rewrites. Returns the body text to send
// (unchanged when there was nothing to change).
export function prepareBody(text, url) {
  if (!text) return text
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return text
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return text

  // `<id>--api` is the API-budget variant: the suffix picked the key, the
  // upstream sees the bare id.
  if (typeof body.model === "string" && body.model.endsWith(API_SUFFIX)) {
    body.model = body.model.slice(0, -API_SUFFIX.length)
  }
  if (MODEL_ALIASES[String(body.model)]) body.model = MODEL_ALIASES[String(body.model)]

  // /v1/responses has no chat messages, and Mistral takes its shape as is.
  if (!/\/responses\/?$/.test(url)) {
    if (body.stream === true && body.stream_options == null) body.stream_options = { include_usage: true }

    // Fields Mistral answers with 422.
    if ("max_completion_tokens" in body) {
      const value = body.max_completion_tokens
      delete body.max_completion_tokens
      if (value != null) body.max_tokens = value
    }
    if ("seed" in body) {
      body.random_seed = body.seed
      delete body.seed
    }
    if ("user" in body) delete body.user

    if (body.max_tokens == null && String(body.model).includes("glm")) body.max_tokens = GLM_OUTPUT_LIMIT

    if (Array.isArray(body.messages)) {
      for (const message of body.messages) {
        if (!message || typeof message !== "object") continue
        // A reply sent back as it came carries these; Mistral 422s them.
        delete message.reasoning_content
        delete message.index
      }
      const last = body.messages[body.messages.length - 1]
      if (
        body.reasoning_effort == null &&
        String(body.model).includes("glm") &&
        Array.isArray(body.tools) &&
        body.tools.length > 0 &&
        last?.role === "tool"
      ) {
        // GLM can end a tool-result turn with no visible text; asking for
        // more deliberation makes it compose (measured against the API).
        body.reasoning_effort = "high"
      }
    }
  }
  return JSON.stringify(body)
}

// levelsIn reads the quoted level names an upstream error lists.
function levelsIn(message) {
  const found = []
  for (const match of message.matchAll(/['"]([a-z]+)['"]/g)) {
    if (REASONING_EFFORT_LEVELS.includes(match[1]) && !found.includes(match[1])) found.push(match[1])
  }
  return found
}

// snapEffort answers a refusal about reasoning_effort: drop the field when the
// model has no such switch, else move it to the nearest level the model lists
// (ties lean towards less reasoning below "medium", more above it). null when
// the error is about something else, so the refusal is passed on.
export function snapEffort(text, detail) {
  const message = String(detail ?? "")
  if (!message.includes("reasoning_effort")) return null
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  const holder = body?.reasoning && typeof body.reasoning === "object" ? body.reasoning : body
  const field = holder === body ? "reasoning_effort" : "effort"
  const asked = holder?.[field]

  if (/reasoning_effort is not enabled/i.test(message) && asked != null) {
    delete holder[field]
    return JSON.stringify(body)
  }
  if (!/is not supported/i.test(message)) return null

  const allowed = levelsIn(message.split(/is not supported/i)[1] ?? message)
  if (!REASONING_EFFORT_LEVELS.includes(asked) || allowed.length === 0 || allowed.includes(asked)) return null

  const rank = (level) => REASONING_EFFORT_LEVELS.indexOf(level)
  const preferLower = rank(asked) <= rank("medium")
  let best = allowed[0]
  for (const level of allowed) {
    const distance = Math.abs(rank(level) - rank(asked))
    const bestDistance = Math.abs(rank(best) - rank(asked))
    if (distance < bestDistance) best = level
    else if (distance === bestDistance && preferLower && rank(level) < rank(best)) best = level
    else if (distance === bestDistance && !preferLower && rank(level) > rank(best)) best = level
  }
  holder[field] = best
  return JSON.stringify(body)
}

function isChat(url) {
  return CHAT_PATHS.test(new URL(url).pathname)
}

// cleanHeaders is a rebuilt reply's headers: the body is no longer the
// upstream's bytes, so its encoding and length must not be carried over.
function cleanHeaders(headers) {
  const copy = new Headers(headers)
  copy.delete("content-encoding")
  copy.delete("content-length")
  return copy
}

// sendChat is the loader's fetch: the key the model's wallet names, one retry
// when the effort is refused, and reply normalization. A 429 is returned as
// it came — magpie rests the account and falls back on it.
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
  let asked = ""
  try {
    asked = JSON.parse(originalText)?.model ?? ""
  } catch {}
  const wantsApi = typeof asked === "string" && asked.endsWith(API_SUFFIX)
  const key = wantsApi ? keys?.api : (keys?.vibe ?? keys?.api)

  const headers = new Headers(init?.headers ?? request.headers)
  headers.delete("authorization")
  headers.delete("x-api-key")
  headers.delete("content-length")
  if (!key) {
    return new Response(
      JSON.stringify({
        error: {
          message: `${asked || "this request"} needs the ${wantsApi ? "API" : "Vibe"} key, which this sign-in doesn't hold`,
          type: "invalid_request_error",
        },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    )
  }
  headers.set("authorization", `Bearer ${key}`)
  const chat = isChat(url)
  let bodyText = chat ? prepareBody(originalText, url) : originalText
  let stream = false
  try {
    stream = JSON.parse(bodyText)?.stream === true
  } catch {}

  const send = (text) =>
    fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : text,
      signal: request.signal,
      redirect: "follow",
    })

  let response = await send(bodyText)

  if (chat && (response.status === 400 || response.status === 422)) {
    const text = await response.text()
    const snapped = snapEffort(bodyText, text)
    if (snapped != null) {
      const retried = await send(snapped)
      if (retried.ok) {
        response = retried
        bodyText = snapped
      } else {
        return new Response(await retried.text(), { status: retried.status, statusText: retried.statusText, headers: cleanHeaders(retried.headers) })
      }
    } else {
      return new Response(text, { status: response.status, statusText: response.statusText, headers: cleanHeaders(response.headers) })
    }
  }

  if (!response.ok || !chat) return response

  if (stream && /(^|\n)text\/event-stream/i.test(response.headers.get("content-type") ?? "")) {
    return rewriteStream(response)
  }
  const text = await response.text()
  try {
    const parsed = rewritePayload(JSON.parse(text))
    return new Response(JSON.stringify(parsed), { status: response.status, statusText: response.statusText, headers: cleanHeaders(response.headers) })
  } catch {
    return new Response(text, { status: response.status, statusText: response.statusText, headers: cleanHeaders(response.headers) })
  }
}
