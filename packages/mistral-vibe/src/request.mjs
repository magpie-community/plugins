// What a request has to look like for Mistral's API, written from what the
// API does with it: the fields it refuses, GLM's output cap without
// max_tokens, and the tool-result turn GLM ends too early.

import { MODEL_ALIASES } from "./constants.mjs"

export const WALLET_SUFFIX = "--api"
const GLM_OUTPUT = 131072
const RENAMED = [
  ["max_completion_tokens", "max_tokens"],
  ["seed", "random_seed"],
]
const DROPPED = new Set(["user"])
const NOT_SENT_BACK = new Set(["reasoning_content", "index"])

const usesGlm = (model) => String(model).includes("glm")
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

// bareModel is the model Mistral serves for an id a client may have picked:
// the wallet suffix is ours, and the alias table maps the friendly names.
export function bareModel(id) {
  const withoutWallet = typeof id === "string" && id.endsWith(WALLET_SUFFIX) ? id.slice(0, -WALLET_SUFFIX.length) : id
  return MODEL_ALIASES[withoutWallet] ?? withoutWallet
}

// withoutReplyFields is a message a client sent back: the two fields Mistral
// refuses on the way in are dropped, everything else is kept as it was.
function withoutReplyFields(message) {
  if (!isPlainObject(message)) return message
  return Object.fromEntries(Object.entries(message).filter(([name]) => !NOT_SENT_BACK.has(name)))
}

// shapeRequest returns the body to send. A body it can't read, or a
// /v1/responses body (which Mistral takes as it is), goes through untouched
// apart from the model id.
export function shapeRequest(text, { responses = false } = {}) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return text
  }
  if (!isPlainObject(body)) return text

  const model = bareModel(body.model)
  if (responses) return JSON.stringify({ ...body, model })

  const shaped = { ...body, model }

  // A stream that names no usage option gets no usage chunk, and clients that
  // bill tokens then see zero.
  if (shaped.stream === true && shaped.stream_options === undefined) shaped.stream_options = { include_usage: true }

  // Fields Mistral answers with 422; each moves to the name it knows, or goes.
  for (const [from, to] of RENAMED) {
    if (!(from in shaped)) continue
    if (shaped[from] != null) shaped[to] = shaped[from]
    delete shaped[from]
  }
  for (const name of DROPPED) delete shaped[name]

  // Without max_tokens Mistral stops a GLM completion at 4096 tokens, which
  // its thinking alone can spend.
  if (shaped.max_tokens === undefined && usesGlm(model)) shaped.max_tokens = GLM_OUTPUT

  if (Array.isArray(shaped.messages)) {
    shaped.messages = shaped.messages.map(withoutReplyFields)
    const last = shaped.messages[shaped.messages.length - 1]
    const composingAfterTool = shaped.reasoning_effort === undefined && usesGlm(model) && Array.isArray(shaped.tools) && shaped.tools.length > 0 && last?.role === "tool"
    // GLM can end such a turn with no visible text; a higher effort makes it
    // finish deliberating and compose.
    if (composingAfterTool) shaped.reasoning_effort = "high"
  }

  return JSON.stringify(shaped)
}
