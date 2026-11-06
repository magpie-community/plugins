import { applyOutputStyles } from "./apply.js"
import { record, flush } from "./stats-writer.js"

const hasSelection = options => Object.values(options?.styles || {}).some(enabled => enabled === true)
let exitFlushRegistered = false

function registerExitFlush() {
  if (exitFlushRegistered) return
  exitFlushRegistered = true
  // Long-lived servers never emit beforeExit on their own; a periodic timer
  // (unref'd so it cannot keep the process alive) persists the last batch.
  const timer = setInterval(() => {
    flush().catch(() => {})
  }, 30_000)
  if (typeof timer.unref === "function") timer.unref()
  process.once("beforeExit", async () => {
    try { await flush(true) } catch { /* Shutdown telemetry is best effort. */ }
  })
}

export async function onRequest(body, ctx) {
  try {
    const options = ctx?.options && typeof ctx.options === "object" ? ctx.options : {}
    // Observe only: never return a rewritten body. Injection belongs to the
    // middleware entry point, so a request can never be injected twice and
    // telemetry reflects what the middleware actually did.
    const result = applyOutputStyles(body, { ...options, protocol: ctx?.protocol })
    const alreadyRecorded = ctx?.state && typeof ctx.state === "object" ? ctx.state.__outputStrategyRecorded === true : false
    if (!alreadyRecorded && hasSelection(options) && ctx?.origin === "local" && options.telemetry !== false) {
      if (ctx?.state && typeof ctx.state === "object") ctx.state.__outputStrategyRecorded = true
      registerExitFlush()
      record(result)
    }
    return undefined
  } catch {
    return undefined
  }
}
