// The read-only account panel: what else the account holds on Quick's
// server, fetched over the same qbsproxy REST the web app itself uses
// (all GET via the _method override; nothing here mutates state).
//
//   store/sessions/<id>            — one conversation's full metadata
//   store/sessions/<id>/tree       — the conversation's branch tree
//   api/runs?status=…&max_age=…    — agent runs (duration, status, cost)
//   api/a2a-agents                 — agent-to-agent agents registered
//   api/acp-agents                 — ACP agents (kiro/claude-code/…)
//
// Everything is read-only and additive: the usage() reply gains a
// `panel` object per account, and a failure to read any piece degrades to
// an `error` string on that piece — never to a failed request.

import { quickFetch } from "./session.mjs"

// iso like usage.mjs: epoch seconds/millis → ISO UTC, else pass through
function isoEpoch(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return v
  const ms = n > 1e12 ? n : n * 1000
  const d = new Date(ms)
  return isNaN(d.getTime()) ? v : d.toISOString()
}

async function getJson(account, path) {
  const res = await quickFetch(account, path)
  if (!res.ok) throw new Error(`the probe answered ${res.status}`)
  let txt = await res.text()
  // qbsproxy wraps the payload: {type:"api_response", body:"<json string>"}
  try {
    let o = JSON.parse(txt)
    if (typeof o === "string") o = JSON.parse(o)
    if (o && typeof o.body === "string") return JSON.parse(o.body)
    if (o && typeof o === "object" && o.body && typeof o.body === "object") return o.body
    return o
  } catch {
    return txt
  }
}

// sessionCard trims one conversation's metadata to what the panel shows
export function sessionCard(raw) {
  if (!raw || typeof raw !== "object") return null
  return {
    id: raw.id,
    title: raw.title ?? "",
    agentMode: raw.agent_mode ?? "",
    messageCount: raw.message_count ?? 0,
    createdAt: isoEpoch(raw.created_at),
    updatedAt: isoEpoch(raw.updated_at),
    incognito: !!raw.incognito,
    private: !!raw.private,
    pinned: !!raw.pinned,
    archived: !!raw.archived,
    sessionType: raw.session_type ?? "main",
    parentSessionId: raw.parent_session_id ?? null,
    forkSourceSessionId: raw.fork_source_session_id ?? null,
    taskStatus: raw.task_status ?? null,
    deletedAt: raw.deleted_at ? isoEpoch(raw.deleted_at) : null,
  }
}

// runCard trims one agent run
export function runCard(raw) {
  if (!raw || typeof raw !== "object") return null
  return {
    id: raw.id ?? raw.run_id ?? "",
    sessionId: raw.session_id ?? null,
    status: raw.status ?? "",
    agentMode: raw.agent_mode ?? raw.mode ?? "",
    durationS: Number.isFinite(Number(raw.duration_s)) ? Number(raw.duration_s) : undefined,
    createdAt: isoEpoch(raw.created_at ?? raw.started_at),
  }
}

// agentCard trims an a2a/acp agent entry
export function agentCard(raw) {
  if (!raw || typeof raw !== "object") return null
  return {
    id: raw.id ?? raw.agent_id ?? "",
    name: raw.name ?? raw.display_name ?? "",
    type: raw.type ?? raw.agent_type ?? "",
    enabled: raw.enabled ?? raw.a2a_enabled ?? undefined,
    url: raw.url ?? raw.endpoint ?? undefined,
  }
}

// listSessions reads the account's conversation list. The web app reads
// the sidebar from api/sessions (store/sessions/<id> is the per-session
// detail); both return the same metadata objects.
export async function listSessions(account, { limit = 20 } = {}) {
  const body = await getJson(account, `/quicksight/accounts/${account.accountId}/invocations/api/sessions?_method=GET&limit=${limit}&surfaceType=WEB_EXPERIENCE&appVersion=qbiz-web-bridge`)
  const list = Array.isArray(body) ? body : Array.isArray(body?.sessions) ? body.sessions : []
  return list.map(sessionCard).filter(Boolean)
}

// sessionDetail reads one conversation: its metadata, tree and (a page
// of) messages. Returns {session, tree, messages}.
export async function sessionDetail(account, sessionId, { messageLimit = 25 } = {}) {
  const base = `/quicksight/accounts/${account.accountId}/invocations/store/sessions/${sessionId}`
  const [session, tree, messages] = await Promise.all([
    getJson(account, `${base}?_method=GET&include=a2ui&surfaceType=WEB_EXPERIENCE&appVersion=qbiz-web-bridge`),
    getJson(account, `${base}/tree?_method=GET&surfaceType=WEB_EXPERIENCE&appVersion=qbiz-web-bridge`).catch(() => null),
    getJson(account, `${base}/messages?_method=GET&limit=${messageLimit}&surfaceType=WEB_EXPERIENCE&appVersion=qbiz-web-bridge`).catch(() => null),
  ])
  const msgList = Array.isArray(messages) ? messages : Array.isArray(messages?.messages) ? messages.messages : []
  return {
    session: sessionCard(session),
    tree: tree ?? null,
    messages: msgList.map((m) => ({
      id: m?.id ?? m?.message_id ?? "",
      role: m?.role ?? "",
      createdAt: isoEpoch(m?.created_at ?? m?.timestamp),
      text: typeof m?.text === "string" ? m.text.slice(0, 2000) : undefined,
    })),
  }
}

// listRuns reads recent agent runs (the running/paused/needs-input monitor)
export async function listRuns(account, { status = "needs_input,paused,running", maxAge = 3600, limit = 20 } = {}) {
  const body = await getJson(account, `/quicksight/accounts/${account.accountId}/invocations/api/runs?_method=GET&status=${encodeURIComponent(status)}&max_age=${maxAge}&limit=${limit}&surfaceType=WEB_EXPERIENCE&appVersion=qbiz-web-bridge`)
  const list = Array.isArray(body) ? body : Array.isArray(body?.runs) ? body.runs : []
  return list.map(runCard).filter(Boolean)
}

// listAgents reads the a2a and acp agent registries
export async function listAgents(account) {
  const [a2a, acp] = await Promise.all([
    getJson(account, `/quicksight/accounts/${account.accountId}/invocations/api/a2a-agents?_method=GET&surfaceType=WEB_EXPERIENCE&appVersion=qbiz-web-bridge`).catch(() => null),
    getJson(account, `/quicksight/accounts/${account.accountId}/invocations/api/acp-agents?_method=GET&surfaceType=WEB_EXPERIENCE&appVersion=qbiz-web-bridge`).catch(() => null),
  ])
  const pick = (body) => {
    const list = Array.isArray(body) ? body : Array.isArray(body?.agents) ? body.agents : []
    return list.map(agentCard).filter(Boolean)
  }
  return { a2a: pick(a2a), acp: pick(acp) }
}

// panelFor assembles one account's read-only panel. Every piece degrades
// independently; a piece that fails carries {error}. Use the appVersion
// helper paths from quickFetch (it already prefixes /sn/account/<id>/qbsproxy).
export async function panelFor(account, { sessions = 10, runs = true, agents = true } = {}) {
  const out = {}
  const jobs = [
    listSessions(account, { limit: sessions }).then((list) => (out.sessions = list)).catch((e) => (out.sessions = { error: e?.message ?? String(e) })),
  ]
  if (runs) jobs.push(listRuns(account).then((list) => (out.runs = list)).catch((e) => (out.runs = { error: e?.message ?? String(e) })))
  if (agents) jobs.push(listAgents(account).then((a) => (out.agents = a)).catch((e) => (out.agents = { error: e?.message ?? String(e) })))
  await Promise.all(jobs)
  return out
}
