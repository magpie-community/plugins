// The conversation pool: a relayed chat that follows a previous one reuses
// the server-side conversation (inner[2] = [cid, rid, rcid, ..., tok26])
// and sends only the new message, the way the web app itself does. A
// request whose history does not match any pooled conversation rebuilds
// from scratch — the full resend stays as the always-works fallback.
//
// Temporary chats (slot 45) cannot be continued (measured 2026-11-22: the
// server answers 400), so every pooled conversation is an ordinary one.
import { createHash } from "node:crypto"

const TTL_MS = 90 * 60 * 1000 // align with the cookie's useful life
const MAX_CONVERSATIONS = 4000

export function historyKey(messages) {
  // the canonical hash of every message but the last: what the previous
  // request would have left on the server
  const h = createHash("sha256")
  for (const m of messages.slice(0, -1)) {
    h.update(String(m?.role ?? ""))
    h.update("\0")
    h.update(String(m?.content ?? ""))
    h.update("\0")
  }
  return h.digest("hex").slice(0, 32)
}

export function fullKey(messages) {
  const h = createHash("sha256")
  for (const m of messages) {
    h.update(String(m?.role ?? ""))
    h.update("\0")
    h.update(String(m?.content ?? ""))
    h.update("\0")
  }
  return h.digest("hex").slice(0, 32)
}

export class SessionPool {
  constructor({ ttl = TTL_MS, max = MAX_CONVERSATIONS } = {}) {
    this.ttl = ttl
    this.max = max
    this.map = new Map() // historyKey -> state
    // observability: how often a follow-up actually reused the server side
    this.stats = { hits: 0, misses: 0, rebuilds: 0, evicted: 0 }
  }

  // find a live conversation for this history, bound to the same account,
  // browser and model tier it was created with. `messages` is the history
  // the client brings, ending with the new user turn; the pooled entry was
  // remembered under the same history including that turn's reply, so the
  // lookup drops the trailing user message.
  find(messages, { account, browserKey, modelKey } = {}) {
    this.sweep()
    const prior = messages?.length && messages[messages.length - 1]?.role === "user" ? messages.slice(0, -1) : messages
    const state = this.map.get(fullKey(prior))
    if (!state) {
      this.stats.misses++
      return null
    }
    if (state.account !== account || state.browserKey !== browserKey || state.modelKey !== modelKey) {
      // the conversation lives under another account/browser: it cannot be
      // reused here, but it is still alive for its owner
      this.stats.misses++
      return null
    }
    this.map.delete(state.key) // LRU touch
    this.map.set(state.key, state)
    this.stats.hits++
    return state
  }

  // remember a conversation just created or continued: the next request
  // whose history is `messages` (including this turn's reply) can resume it
  remember(messages, state, { account, browserKey, modelKey } = {}) {
    this.sweep()
    const key = fullKey(messages)
    while (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
      this.stats.evicted++
    }
    this.map.set(key, { key, cid: state.cid, rid: state.rid, rcid: state.rcid ?? "", tok26: state.tok26 ?? null, turn: state.turn ?? 0, account, browserKey, modelKey, updatedAt: Date.now() })
  }

  // drop a conversation that the server refused to continue: the next
  // request with that history rebuilds from scratch
  invalidate(messages) {
    const key = fullKey(messages)
    if (this.map.delete(key)) this.stats.rebuilds++
  }

  sweep() {
    const now = Date.now()
    for (const [key, s] of this.map) if (now - s.updatedAt > this.ttl) this.map.delete(key)
  }

  size() {
    this.sweep()
    return this.map.size
  }
}
