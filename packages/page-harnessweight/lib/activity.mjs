// Hook and service run in the same plugin-host process. Never infer active
// requests from completed usage rows. State is intentionally not persisted.
export const MAX_ACTIVITY_AGE_MS = 15 * 60 * 1000
const REQUEST = Symbol("harnessweight.request")

export function createActivityTracker({ now = Date.now, maxAgeMs = MAX_ACTIVITY_AGE_MS } = {}) {
  const scopes = new Map()
  function scope(key) {
    if (!scopes.has(key)) scopes.set(key, { requests: new Map(), observed: false, expired: 0 })
    return scopes.get(key)
  }
  function expire(s, time) {
    for (const [id, request] of s.requests) {
      if (time - request.startedAt >= maxAgeMs) {
        s.requests.delete(id)
        s.expired++
      }
    }
  }
  return {
    start(key, ctx, agent) {
      if (!ctx?.state || typeof ctx.state !== "object") return
      const s = scope(key)
      s.observed = true
      const time = now()
      expire(s, time)
      if (ctx.state[REQUEST]) return
      const id = Symbol()
      ctx.state[REQUEST] = { key, id }
      s.requests.set(id, { agent, startedAt: time })
    },
    finish(ctx) {
      const request = ctx?.state?.[REQUEST]
      if (!request) return
      scopes.get(request.key)?.requests.delete(request.id)
      delete ctx.state[REQUEST]
    },
    snapshot(key) {
      const s = scope(key)
      const observedAt = now()
      expire(s, observedAt)
      const counts = new Map()
      for (const { agent } of s.requests.values()) counts.set(agent, (counts.get(agent) || 0) + 1)
      return {
        agents: [...counts].map(([agent, count]) => ({ agent, count })).sort((a, b) => a.agent.localeCompare(b.agent)),
        total: s.requests.size, observedAt, tracking: "hooks", available: s.observed,
        maxAgeMs, expired: s.expired,
      }
    },
  }
}

export const activity = createActivityTracker()
