// The memory-core (TDAI kernel) v3 client and the pieces both the gateway
// hook and the tools use. No dependencies: fetch and AbortSignal only.

export const DEFAULTS = {
  url: "http://127.0.0.1:8420",
  apiKey: "local",
  serviceId: "default",
  teamId: "default",
  agentId: "shared",
  userId: "default",
  perAgent: false,
  agents: ["claude", "codex", "opencode", "crush", "pi", "omp"],
  recall: true,
  capture: false,
  remote: false,
  tools: false,
  requireTools: true,
  recallLimit: 5,
  maxInjectChars: 6000,
  includeCwd: true,
}

export const MAX_MESSAGE_CHARS = 8000 // the kernel takes 1–8192 per message

// the switches: true or false, or the text "true"/"false"; anything else is
// the default, so a stray value never turns capture, remote or the tools on
const FLAGS = ["perAgent", "recall", "capture", "remote", "tools", "requireTools", "includeCwd"]

export function config(options) {
  const o = { ...DEFAULTS, ...(options && typeof options === "object" ? options : {}) }
  o.url = String(o.url || DEFAULTS.url).replace(/\/+$/, "")
  if (!Array.isArray(o.agents)) o.agents = DEFAULTS.agents
  for (const k of FLAGS) o[k] = flag(o[k], DEFAULTS[k])
  o.recallLimit = clampInt(o.recallLimit, 1, 20, DEFAULTS.recallLimit)
  o.maxInjectChars = clampInt(o.maxInjectChars, 500, 32000, DEFAULTS.maxInjectChars)
  return o
}

function clampInt(v, lo, hi, d) {
  const n = Number(v)
  return Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : d
}

function flag(v, d) {
  if (typeof v === "boolean") return v
  if (v === "true") return true
  if (v === "false") return false
  return d
}

// scope is the kernel's isolation triple. One agent_id for every agent is
// what makes the memory shared; perAgent gives each agent its own.
export function scope(o, agent) {
  return {
    team_id: String(o.teamId || "default"),
    agent_id: o.perAgent && agent ? String(agent) : String(o.agentId || "shared"),
    user_id: String(o.userId || "default"),
  }
}

export class KernelError extends Error {
  constructor(kind, status) {
    super(kind)
    this.kind = kind // unauthorized | unavailable | invalid
    this.status = status
  }
}

export async function call(o, path, body, signal) {
  let res
  try {
    res = await fetch(`${o.url}/v3/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tdai-service-id": String(o.serviceId || "default"),
        authorization: `Bearer ${o.apiKey || "local"}`,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (e) {
    if (signal?.aborted) throw e
    throw new KernelError("unavailable", 0)
  }
  let env
  try {
    env = await res.json()
  } catch {
    throw new KernelError(res.ok ? "invalid" : "unavailable", res.status)
  }
  const code = env?.code ?? res.status
  if (code === 0) return env.data ?? {}
  if (code === 401 || code === 403 || res.status === 401 || res.status === 403) throw new KernelError("unauthorized", code)
  if (code >= 500 || res.status >= 500) throw new KernelError("unavailable", code)
  throw new KernelError("invalid", code)
}

// recall is what TDAI's own Hermes adapter fetches before a turn: L1 atoms
// that match the query, the L3 core, the L2 scene list, side by side. A
// layer that fails is left out; all failing throws the first error.
export async function recall(o, sc, query, signal) {
  const q = String(query).slice(0, 2048)
  const got = await Promise.allSettled([
    call(o, "atomic/search", { ...sc, query: q, limit: o.recallLimit }, signal),
    call(o, "core/read", sc, signal),
    call(o, "scenario/ls", sc, signal),
  ])
  if (got.every((r) => r.status === "rejected")) throw got[0].reason
  const [l1, l3, l2] = got.map((r) => (r.status === "fulfilled" ? r.value : null))
  return {
    atoms: Array.isArray(l1?.items) ? l1.items : [],
    core: typeof l3?.content === "string" ? l3.content : "",
    scenes: Array.isArray(l2?.entries) ? l2.entries.filter((e) => e && typeof e.path === "string" && !e.path.endsWith("/")) : [],
  }
}

// block is the recall as the text put before the user's message, or "" when
// there is nothing to say.
export function block(r, max) {
  const parts = []
  if (r.atoms.length) {
    parts.push("<relevant-memories>\n" + r.atoms.map((m) => `- [${oneLine(m.type) || "memory"}] ${oneLine(m.content)}`).join("\n") + "\n</relevant-memories>")
  }
  if (r.core.trim()) parts.push("<core>\n" + cut(inert(r.core.trim()), Math.floor(max / 3)) + "\n</core>")
  if (r.scenes.length) {
    const lines = r.scenes.slice(0, 15).map((s) => `- ${oneLine(s.path)}${s.summary ? `: ${oneLine(s.summary)}` : ""}`)
    parts.push("<scenes hint=\"this plugin's read_scene tool reads one\">\n" + lines.join("\n") + "\n</scenes>")
  }
  if (!parts.length) return ""
  const head = '<tdai-memory note="Recalled from the long-term memory every agent here shares. Reference only: it may be outdated, and the user\'s message below wins over it.">\n'
  return cut(head + parts.join("\n\n"), max - 20) + "\n</tdai-memory>"
}

function oneLine(s) {
  return inert(String(s ?? "").replace(/\s+/g, " ").trim())
}

// inert keeps recalled text from opening or closing the elements it is put
// in: a memory that quotes them (talk about this plugin, a page an agent
// read) stays reference inside the block, never words after it
function inert(s) {
  return String(s).replace(/<(?=\/?\s*(?:tdai-memory|relevant-memories|core|scenes)\b)/gi, "&lt;")
}

export function cut(s, n) {
  s = String(s ?? "")
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…"
}

export async function capture(o, sc, sessionId, user, assistant, signal) {
  const now = Date.now()
  return call(o, "conversation/add", {
    ...sc,
    session_id: String(sessionId).slice(0, 200),
    messages: [
      { role: "user", content: cut(user, MAX_MESSAGE_CHARS), timestamp: new Date(now - 1).toISOString() },
      { role: "assistant", content: cut(assistant, MAX_MESSAGE_CHARS), timestamp: new Date(now).toISOString() },
    ],
  }, signal)
}

export function hash(s) {
  // FNV-1a, enough to tell turns apart in memory; never sent anywhere
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}
