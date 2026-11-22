// Quick thread reuse.
//
// Same problem as magpie-comate: OpenAI clients resend the whole history every
// request, while the Quick bidi socket keeps server-side history per thread_id.
// We recognise a request as the continuation of a thread we answered by hashing
// its message chain:
//
//   scope = H(account, agent_mode, system prompt, tool schemas)
//   key   = H(scope, m1, …, mk, our reply)
//
// A later request whose messages start with exactly that prefix continues the
// same Quick thread with only the messages after it. Anything else (edited or
// branched history, changed system prompt/tools/mode, expired or evicted
// entry) starts a fresh thread. Entries are claimed when used so a retry never
// replays a turn. Memory only.
import { createHash } from 'node:crypto'
import { textOf } from './translate.mjs'

export const SESSION_DEFAULTS = Object.freeze({ ttlMs: 30 * 60 * 1000, max: 200 })

const sha = (s) => createHash('sha256').update(s).digest('hex')
// JSON encoders can reorder keys or change spacing without changing an argument.
const stableJson = (value) => JSON.stringify(value, (_key, v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
    : v)

function argumentsOf(call) {
  const args = call.function?.arguments ?? call.arguments ?? {}
  if (typeof args !== 'string') return args
  try { return JSON.parse(args) } catch { return args }
}

/** Canonical form of one message, tolerant to client/gateway rewrites. */
export function canonMessage(m) {
  if (!m) return ''
  const calls = m.role === 'assistant' && Array.isArray(m.tool_calls)
    ? m.tool_calls.map((c) => [c.id ?? '', c.function?.name ?? c.name ?? '', argumentsOf(c)])
    : []
  return stableJson([m.role, m.name ?? '', m.tool_call_id ?? '', textOf(m.content), calls])
}

/** Assistant message as we answered it (text + any tool calls we emitted). */
export function replyMessage(text, toolCalls) {
  const m = { role: 'assistant', content: text ?? '' }
  if (toolCalls?.length) {
    m.tool_calls = toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name ?? c.function?.name, arguments: c.arguments ?? c.function?.arguments ?? '{}' },
    }))
  }
  return m
}

export function sessionScope(identity, agentMode, systemText, tools) {
  return sha(stableJson([identity, agentMode, systemText, tools ?? []]))
}

/** h[k] = hash of the first k messages under scope (h[0] = scope). */
export function chainHashes(scope, messages) {
  const h = [scope]
  for (const m of messages) h.push(sha(`${h[h.length - 1]}\n${canonMessage(m)}`))
  return h
}

export const extendHash = (prev, m) => sha(`${prev}\n${canonMessage(m)}`)

export function createSessionStore({ ttlMs = SESSION_DEFAULTS.ttlMs, max = SESSION_DEFAULTS.max, now = () => Date.now() } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(max) || max < 0) {
    throw new RangeError('session ttlMs must be positive and finite and max must be a nonnegative integer')
  }
  const map = new Map() // key → {entry, at}; insertion order = LRU order
  const live = (key) => {
    const v = map.get(key)
    if (!v) return undefined
    if (now() - v.at > ttlMs) { map.delete(key); return undefined }
    return v
  }
  return {
    has: (key) => !!live(key),
    take(key) {
      const v = live(key)
      if (!v) return undefined
      map.delete(key)
      return v.entry
    },
    set(key, entry) {
      map.delete(key)
      map.set(key, { entry, at: now() })
      while (map.size > max) map.delete(map.keys().next().value)
    },
    get size() { return map.size },
    clear: () => map.clear(),
  }
}

/**
 * Find the newest cached thread state that this conversation extends.
 * @returns {{index:number, entry:object, delta:Array}|undefined}
 */
export function findContinuation(store, hashes, convo) {
  for (let i = convo.length - 1; i >= 1; i--) {
    if (convo[i - 1]?.role !== 'assistant') continue
    if (!store.has(hashes[i])) continue
    const delta = convo.slice(i)
    // only new user turns / tool results can be appended to server-side history
    if (!delta.length || delta.some((m) => m.role !== 'user' && m.role !== 'tool' && m.role !== 'function')) return undefined
    const entry = store.take(hashes[i])
    return entry ? { index: i, entry, delta } : undefined
  }
  return undefined
}
