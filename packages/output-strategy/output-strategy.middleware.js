// Inject selected output styles into Chat Completions, Anthropic and Responses
// requests. Existing markers, empty selections and unknown request shapes pass
// through. No telemetry, filesystem access or asynchronous hook is involved.

import { applyOutputStyles } from "./apply.js"

export function onRequest(body, ctx) {
  try {
    const result = applyOutputStyles(body, { ...ctx?.options, protocol: ctx?.protocol })
    return result.applied ? result.body : undefined
  } catch {
    return undefined
  }
}
