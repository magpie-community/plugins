// The research bridge: Quick's vibranium research agent, over the same
// qbsproxy REST the web app itself uses. The paths are the web client's
// own (verified live 2026-11-22):
//
//   GET  <qbsproxy>/quicksight/research/entitlement-units   — the pool
//   POST <qbsproxy>/quicksight/research/execute-research-immediate
//        {researchGoal, researchId, researchMode, webSourceFilter…}
//   GET  <qbsproxy>/quicksight/research/get-updates?researchId=…
//        &executionVersion=&startingTraceSequenceId=&maxTraces=
//   POST <qbsproxy>/quicksight/research/get  {researchId}
//   POST <qbsproxy>/quicksight/research/cancel {researchId}
//
// researchMode: "FAST" (default — minutes) or "DEEP" (slower, deeper).
// The research pool is separate from the chat pools: 600 min provisioned
// on this account, RESEARCH_AGENT_HOUR_UNIT.
//
// A run goes: execute → poll get-updates until a terminal status
// (REPORT_COMPLETE / TERMINATED / USER_CANCELED / FAILED_*) → the report
// text from get. Everything here is read-only except the explicit
// execute/cancel the caller asks for; nothing auto-retries a run.

const ORIGIN = "https://quick.aws.com"
const BASE = "/quicksight/research"

// The research endpoints require the page's csrf token (x-amzn-csrf-token),
// which is NOT the mbtc — it is embedded in the start page's HTML config.
// Bootstrap it once per account from the page the web app itself loads.
const csrfCache = new Map() // accountId -> { token, fetchedAt }
const CSRF_TTL_MS = 30 * 60_000

// the csrf loader is swappable so tests can stub the bootstrap
let csrfLoader = null

async function csrfOf(account) {
  const hit = csrfCache.get(account.accountId)
  if (hit && Date.now() - hit.fetchedAt < CSRF_TTL_MS) return hit.token
  const token = await (csrfLoader ?? loadCsrfFromPage)(account)
  csrfCache.set(account.accountId, { token, fetchedAt: Date.now() })
  return token
}

async function loadCsrfFromPage(account) {
  const res = await fetch(`${ORIGIN}/sn/account/${account.accountId}/start/chat`, {
    headers: { Cookie: account.cookie, "X-Amzn-Web-Client-Version": "qbiz-web-bridge" },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`Quick research: could not load the session page (${res.status}) to read the csrf token`)
  const html = await res.text()
  const token = /"csrf"\s*:\s*"([^"]+)"/.exec(html)?.[1]
  if (!token) throw new Error("Quick research: the session page carried no csrf token — re-import the cookie")
  return token
}

// test hook: override how the csrf token is obtained
export function _setCsrfLoader(fn) {
  csrfLoader = fn
  csrfCache.clear()
}

// the statuses that end a run (the web client's terminal set)
export const TERMINAL_STATUSES = new Set([
  "REPORT_COMPLETE",
  "INVESTIGATION_COMPLETE", // plan-only completion (no report requested)
  "TERMINATED",
  "USER_CANCELED",
  "FAILED_INVESTIGATION",
  "FAILED_INVESTIGATION_QUEUED_FOR_RETRY",
  "FAILED_PLAN_GENERATION",
])

export const RESEARCH_MODES = new Set(["FAST", "DEEP"])

// researchFetch calls one research endpoint the way the web client does:
// the Operation=VibraniumProxy query with mbtc, the page csrf + api target
// headers (live-verified against the web app's own calls, 2026-11-22).
// GET for reads (entitlement-units, get-updates), POST with a JSON body for
// actions (execute/get/cancel).
export async function researchFetch(account, path, { method = "GET", body, timeoutMs = 30_000 } = {}) {
  const q = new URLSearchParams({ Operation: "VibraniumProxy", mbtc: account.mbtc })
  const csrf = await csrfOf(account)
  const res = await fetch(`${ORIGIN}/sn/account/${account.accountId}/qbsproxy${BASE}${path}?${q}`, {
    method,
    headers: {
      Cookie: account.cookie,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "x-amzn-csrf-token": csrf,
      "x-amzn-target": "api",
      "X-Amzn-Web-Client-Version": "0.1.4",
      Origin: ORIGIN,
      Referer: `${ORIGIN}/sn/account/${account.accountId}/research`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  return res
}

// entitlements reads the research pool: minutes available/provisioned and
// the throttle state
export async function entitlements(account) {
  const res = await researchFetch(account, "/entitlement-units")
  if (res.status === 401 || res.status === 403) throw new Error(`Quick research: the cookie was refused (${res.status}) — re-import`)
  if (!res.ok) throw new Error(`Quick research: entitlement-units answered ${res.status}`)
  const raw = await res.json().catch(() => ({}))
  const e = (raw.entitlements ?? []).find((x) => x.unitType === "RESEARCH_AGENT_HOUR_UNIT") ?? raw.entitlements?.[0] ?? {}
  return {
    unitType: e.unitType ?? "RESEARCH_AGENT_HOUR_UNIT",
    availableMinutes: e.numMinsAvailable ?? 0,
    provisionedMinutes: e.numMinsProvisioned ?? 0,
    overageAllowed: !!e.overageAllowed,
    throttled: !!e.rateLimitStatus?.isThrottled,
    ...(Number(e.rateLimitStatus?.estimatedMinutesToResume) > 0 ? { resumeInMinutes: Number(e.rateLimitStatus.estimatedMinutesToResume) } : {}),
    subscription: raw.subscriptionMetadata
      ? {
          name: raw.subscriptionMetadata.subscriptionType ?? "",
          status: raw.subscriptionMetadata.freeTrialMetadata?.status ?? "",
          expiresAt: raw.subscriptionMetadata.freeTrialMetadata?.expiryDate
            ? new Date(raw.subscriptionMetadata.freeTrialMetadata.expiryDate * 1000).toISOString()
            : undefined,
        }
      : undefined,
  }
}

// start launches one research run. goal is the research question; mode is
// FAST (default) or DEEP; include/exclude narrow the web sources. Returns
// the run's researchId.
export async function start(account, goal, { mode = "FAST", include, exclude } = {}) {
  const text = String(goal ?? "").trim()
  if (!text) throw new Error("Quick research: a research goal is required")
  const m = String(mode ?? "FAST").toUpperCase()
  if (!RESEARCH_MODES.has(m)) throw new Error(`Quick research: mode must be FAST or DEEP, got ${mode}`)
  const res = await researchFetch(account, "/execute-research-immediate", {
    method: "POST",
    body: {
      researchGoal: text,
      researchId: null,
      researchMode: m,
      ...(Array.isArray(include) && include.length ? { webSourceFilterInclusions: include } : {}),
      ...(Array.isArray(exclude) && exclude.length ? { webSourceFilterExclusions: exclude } : {}),
    },
  })
  if (res.status === 401 || res.status === 403) throw new Error(`Quick research: the cookie was refused (${res.status}) — re-import`)
  if (!res.ok) throw new Error(`Quick research: execute-research-immediate answered ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const raw = await res.json().catch(() => ({}))
  const id = raw.researchId ?? raw.research?.researchId
  if (!id) throw new Error("Quick research: the server did not return a researchId")
  return { researchId: id, mode: m }
}

// updates polls one batch of progress traces
export async function updates(account, researchId, { executionVersion, sinceSequence = 0, maxTraces = 50 } = {}) {
  const res = await researchFetch(account, "/get-updates", { method: "POST", body: { researchId, executionVersion, startingTraceSequenceId: sinceSequence, maxTraces } })
  if (!res.ok) throw new Error(`Quick research: get-updates answered ${res.status}`)
  return res.json().catch(() => ({}))
}

// read pulls the finished research: report text (and plan/summary when present)
export async function read(account, researchId) {
  const res = await researchFetch(account, "/get", { method: "POST", body: { researchId } })
  if (!res.ok) throw new Error(`Quick research: get answered ${res.status}`)
  const raw = await res.json().catch(() => ({}))
  const report = raw.report ?? raw.research?.report ?? {}
  const text = report.reportText ?? report.text ?? raw.reportText ?? ""
  return {
    researchId,
    status: raw.researchStatus ?? raw.research?.researchStatus ?? raw.status,
    title: raw.researchTitle ?? raw.research?.researchTitle,
    text: typeof text === "string" ? text : JSON.stringify(text),
    citations: Array.isArray(report.citations) ? report.citations : Array.isArray(raw.citations) ? raw.citations : [],
    raw,
  }
}

// cancel asks the server to stop a run
export async function cancel(account, researchId) {
  const res = await researchFetch(account, "/cancel", { method: "POST", body: { researchId } })
  return { ok: res.ok, status: res.status }
}

// run drives one research end to end: start → poll updates → read. onTick
// gets each progress batch as it arrives (status lines for the caller).
// budgetMs caps the wall clock; polling stops at a terminal status.
export async function run(account, goal, { mode, include, exclude, onTick, pollMs = 5_000, budgetMs = 10 * 60_000, signal } = {}) {
  const startedAt = Date.now()
  const { researchId, mode: m } = await start(account, goal, { mode, include, exclude })
  onTick?.({ event: "started", researchId, mode: m })
  let lastVersion
  let lastSequence = 0
  let finalStatus
  while (Date.now() - startedAt < budgetMs) {
    if (signal?.aborted) {
      await cancel(account, researchId).catch(() => {})
      return { researchId, mode: m, status: "USER_CANCELED", text: "", aborted: true, elapsedS: (Date.now() - startedAt) / 1000 }
    }
    await new Promise((r) => setTimeout(r, pollMs))
    let batch
    try {
      batch = await updates(account, researchId, { executionVersion: lastVersion, sinceSequence: lastSequence })
    } catch (e) {
      onTick?.({ event: "poll_error", message: e?.message ?? String(e) })
      continue
    }
    lastVersion = batch.executionVersion ?? lastVersion
    const traces = Array.isArray(batch.traces) ? batch.traces : []
    for (const t of traces) {
      const seq = t?.actionTrace?.sequenceId ?? t?.observationTrace?.sequenceId ?? t?.taskTrace?.sequenceId ?? t?.writerTrace?.sequenceId
      if (typeof seq === "number" && seq > lastSequence) lastSequence = seq
    }
    if (traces.length) onTick?.({ event: "progress", status: batch.researchStatus, traces: traces.length })
    if (batch.researchStatus && TERMINAL_STATUSES.has(batch.researchStatus)) {
      finalStatus = batch.researchStatus
      break
    }
  }
  if (!finalStatus) {
    // out of budget: read whatever exists, mark timed out (the run may
    // still finish server-side; the caller can re-read with read())
    const got = await read(account, researchId).catch(() => ({}))
    return { researchId, mode: m, status: got.status ?? "TIMEOUT", text: got.text ?? "", timedOut: true, elapsedS: (Date.now() - startedAt) / 1000 }
  }
  // a failed/canceled run has no report to read — come back with the status
  if (finalStatus !== "REPORT_COMPLETE" && finalStatus !== "INVESTIGATION_COMPLETE") {
    return { researchId, mode: m, status: finalStatus, text: "", failed: true, elapsedS: (Date.now() - startedAt) / 1000 }
  }
  const got = await read(account, researchId)
  return { ...got, mode: m, elapsedS: (Date.now() - startedAt) / 1000 }
}
