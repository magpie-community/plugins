// Inject selected output styles into Chat Completions, Anthropic and Responses
// requests. Media turns, existing markers, empty selections and unknown request
// shapes pass through. Any middleware error leaves the request unchanged.

import { applyOutputStyles } from "./apply.js"

export function onRequest(body, ctx) {
  try {
    const result = applyOutputStyles(body, { ...ctx?.options, protocol: ctx?.protocol })
    return result.applied ? result.body : undefined
  } catch {
    return undefined
  }
}
