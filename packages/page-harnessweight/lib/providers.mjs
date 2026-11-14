import { kindOf } from "./usage.mjs"

const bucket = () => ({ calls: 0, failed: 0, cancelled: 0, reasons: new Map() })
function add(b, row) {
  b.calls++
  if (row.cancelled) b.cancelled++
  else if (row.failed) {
    b.failed++
    const reason = row.errorReason || "unknown"
    const status = Number.isInteger(row.status) ? row.status : 0
    const key = `${reason}:${status}`
    const entry = b.reasons.get(key) || { reason, status, count: 0 }
    entry.count++
    b.reasons.set(key, entry)
  }
}
function finish(b) {
  return {
    calls: b.calls, failed: b.failed, cancelled: b.cancelled,
    errorRate: b.calls ? b.failed / b.calls : null,
    reasons: [...b.reasons.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason) || a.status - b.status),
  }
}

export function summarizeProviders(usage, { since, now, showClients = false, model = "" }) {
  const providers = new Map(), models = new Set(), providerOptions = new Set()
  for (const row of usage) {
    if (row.t < since || row.t > now || (!showClients && kindOf(row.agent) === "client")) continue
    models.add(row.model)
    const provider = row.provider || "unknown"
    providerOptions.add(provider)
    if (model && row.model !== model) continue
    let p = providers.get(provider)
    if (!p) { p = { ...bucket(), provider, harnesses: new Map() }; providers.set(provider, p) }
    add(p, row)
    let a = p.harnesses.get(row.agent)
    if (!a) { a = bucket(); p.harnesses.set(row.agent, a) }
    add(a, row)
  }
  return {
    model, models: [...models].sort(), providerOptions: [...providerOptions].sort(),
    providers: [...providers.values()].map(p => ({
      provider: p.provider, ...finish(p),
      harnesses: [...p.harnesses].map(([agent, a]) => ({ agent, ...finish(a) }))
        .sort((a, b) => b.calls - a.calls || a.agent.localeCompare(b.agent)),
    })).sort((a, b) => b.calls - a.calls || a.provider.localeCompare(b.provider)),
  }
}
