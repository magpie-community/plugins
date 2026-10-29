// mail-watch as magpie's asynchronous gateway hooks (package.json
// magpie.hooks): magpie calls onRequest as a request comes in (it must
// return undefined — this plugin changes nothing) and onResponse once an
// exchange with the model is over — the reply the client got, or null with
// success false when the request failed — and this file answers with the
// alerts the user asked for, as mail.
//
// The call is bounded (the gateway gives each hook a second by default and
// moves on), so the hooks kick the work off and return at once: the scan
// of magpie's own logs, then the mail, sent through the queue one
// connection at a time, never awaited here. Nothing they do may throw —
// a broken SMTP must not turn into noise in magpie's log, let alone
// touch the request. The scan waits a moment on purpose: magpie writes
// the call's row as (or after) the reply goes out, and a scan that ran at
// once would read a log that doesn't hold it yet.

import { send, resolveSmtp } from "./smtp.js"
import { fill, message, renderHtml } from "./template.js"
import { fail, quotaScan, save, takeWithinCap } from "./watch.js"
import { readDigest, baselineDigest, digestDue, setDigestDue } from "./digest.js"

// one mail at a time, however many exchanges finish together
let queue = Promise.resolve()
// the exchange that armed the scan; a second one inside the wait rearms it
let timer = null
// the digest's due time: the next moment the window closes; 0 = unscheduled
let digestAt = 0
let digestTimer = null
// the delay the armed timer was actually started with: setTimeout clamps
// anything above 2^31-1 ms to 1 ms, so a long window is armed in capped
// steps, never in one clamped delay (see armDigest).
let digestStep = 0
// a test-only cap on that step: 0 = no cap. It lets a test force an
// early wake (a short step on a long window) and watch the still-ahead
// re-arm, without waiting out the window. Production never sets it.
let digestStepCapForTests = 0
// the hours the armed timer was set for, and the latest options seen:
// the fired digest mails with the newest options, not the arming one's
let digestHours = 0
let latestDigest = null

// PAUSE is how long the scan waits after an exchange ends, for the usage
// row to be written: short enough to stay behind the next exchange's own
// scan, long enough that magpie's append lands first.
const PAUSE = 1500

export function onRequest(_body, _ctx) {
  // mail-watch changes nothing a request carries
  return undefined
}

export async function onResponse(_reply, ctx) {
  try {
    const o = ctx?.options
    if (!o || typeof o !== "object") return
    const to = recipients(o.to)
    // the RESOLVED host: a preset-only config has no smtp.host of its
    // own, and the old guard turned every such exchange away before the
    // scan ever ran — presets could resolve but never send.
    if (!to.length || !resolveSmtp(o.smtp ?? {}).host) return
    schedule(o, to)
    scheduleDigest(o, to)
  } catch {}
  return
}

// schedule rearms the debounced scan: 1.5 s after the latest exchange, so
// a burst of parallel calls is scanned once, its rows all written.
function schedule(o, to) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    scan(o, to).catch(() => {})
  }, PAUSE)
}

// scheduleDigest arms the periodic usage report — opt-in only: no
// report.hours, no digest, ever (the old package default mailed one every
// 6 hours to anyone who had only filled in SMTP).
//
// The timer arms ONCE and is not moved by later exchanges: the old code
// re-armed on every onResponse, so under continuous traffic the due time
// slid forward forever and the digest never fired. Only two things move
// it: the schedule itself changing (hours edited — re-arm with the new
// wait), or the report being turned off (cancel). The fired digest mails
// with the latest options seen, then arms the next window.
//
// The due time also lives on disk, next to digestOffset in the state
// file: magpie restarts the plugin host when any plugin is installed,
// updated, turned on or off, or has its options edited, when Bun
// updates, and every time magpie itself restarts or updates. A due time
// kept only in memory restarted the window on every one of those, so
// with report.hours: 24 a user who updates magpie or any plugin once a
// day never got a digest — the same outcome as the re-arm bug, by
// another route. On arming, a persisted due time for the same schedule
// that is still ahead is waited for; one already past sends now and arms
// the next window. A changed schedule re-arms with the new wait.
function scheduleDigest(o, to) {
  const hours = Number(o.report?.hours)
  if (!Number.isFinite(hours) || hours <= 0) {
    if (digestTimer) clearTimeout(digestTimer)
    digestTimer = null
    digestAt = 0
    digestHours = 0
    digestStep = 0
    // a disabled report leaves no due time behind — but only write when
    // one is actually due: with the report off (the default) this runs on
    // every exchange, and an unconditional write is a state-file read and
    // write per exchange for nothing.
    if (digestDue()) setDigestDue(0, 0)
    return
  }
  if (!digestAt) baselineDigest() // first sight: report from here on
  latestDigest = { o, to }
  if (digestTimer && hours === digestHours) return // already armed: leave the due time alone
  if (digestTimer) clearTimeout(digestTimer)
  digestHours = hours
  const persisted = digestDue()
  if (persisted && persisted.hours === hours && persisted.at > Date.now()) {
    digestAt = persisted.at
    armDigest(digestAt - Date.now(), { o, to })
    return
  }
  if (persisted && persisted.at <= Date.now()) {
    // the host died before the due time: the window is owed now. The
    // send reads from digestOffset, so a digest that already fired
    // before the crash finds an empty window and mails nothing.
    const cur = latestDigest
    sendDigest(cur.o, cur.to).catch(() => {})
  }
  const wait = hours * 3_600_000
  digestAt = Date.now() + wait
  setDigestDue(digestAt, hours)
  armDigest(wait, { o, to })
}

// armDigest starts the timer for the window: on fire it spends the
// persisted due time, mails with the latest options seen, then arms the
// next window.
//
// The step is capped: setTimeout (Bun and Node alike) clamps any delay
// above 2^31-1 ms (24.8 days) to 1 ms with a TimeoutOverflowWarning, so a
// monthly digest (report.hours: 720, 2,592,000,000 ms) used to fire at
// once, clear the due time, send, and re-arm another 1 ms timer — a
// digest on every exchange, flooding the host's log with warnings. A long
// window is armed in capped steps instead: on wake, a due time still
// ahead re-arms for the remainder; only a due time reached sends.
function armDigest(wait, cur) {
  const step = Math.min(wait, 2 ** 31 - 1, digestStepCapForTests || Infinity)
  digestStep = step
  digestTimer = setTimeout(() => {
    digestTimer = null
    digestStep = 0
    if (Date.now() < digestAt) {
      armDigest(digestAt - Date.now(), cur) // still ahead: wait the rest
      return
    }
    digestAt = 0
    setDigestDue(0, 0)
    const c = latestDigest ?? cur
    sendDigest(c.o, c.to).catch(() => {})
    scheduleDigest(c.o, c.to) // arm the next window
  }, step)
}

// digestScheduleForTests exposes the digest timer's state, and
// resetDigestScheduleForTests clears it: production never calls either.
export function digestScheduleForTests() {
  return { at: digestAt, armed: digestTimer !== null, stepMs: digestStep }
}
export function setDigestStepCapForTests(ms) {
  digestStepCapForTests = ms
}
export function resetDigestScheduleForTests() {
  if (digestTimer) clearTimeout(digestTimer)
  digestTimer = null
  digestAt = 0
  digestHours = 0
  digestStep = 0
  digestStepCapForTests = 0
  latestDigest = null
}

// sendDigest reads the window's rows and mails the summary through the
// same queue the alerts use. The window honours the provider list, the
// way the alerts do.
async function sendDigest(o, to) {
  const { digest } = readDigest({ providers: o.watch?.providers })
  if (!digest.rows) return // an empty window sends nothing
  const t = o.template && typeof o.template === "object" ? o.template : {}
  const vars = digestVars(digest)
  const subject = fill(t.reportSubject ?? "[magpie] usage digest · {{rows}} calls · {{credits}} credits", vars)
  const body = fill(t.reportBody ?? DEFAULT_REPORT_BODY, vars)
  const html = t.html === false ? undefined : renderHtml(t.reportHtml, vars)
  await send(o.smtp, to, message({ from: o.smtp.from ?? o.smtp.user, to, subject, body, html }))
}

// bar is a tiny inline bar for the HTML report: a 100px track with the
// share filled.
function bar(share) {
  const pct = Math.max(0, Math.min(100, Math.round(share)))
  return `<div style="display:inline-block;vertical-align:middle;width:100px;height:8px;background:#e5e7eb;border-radius:4px;overflow:hidden;"><div style="width:${pct}%;height:100%;background:#2563eb;"></div></div>`
}

// digestVars renders the digest for the templates: sorted tables as text
// lines for the plain body, rows for the HTML layout.
function digestVars(d) {
  const rows = d.rows || 1
  const table = (counts) => Object.entries(counts).sort((x, y) => y[1] - x[1])
  const agents = table(d.agents)
  const providers = table(d.providers)
  const models = table(d.models)
  const sessions = Object.entries(d.sessions)
  const line = ([k, n]) => `${k} — ${n} calls (${Math.round((n / rows) * 100)}%)`
  const modelLine = (kv) =>
    kv.map(([k, n]) => `<tr><td style="padding:4px 0;color:#6b7280;">${k}</td><td style="padding:4px 0;">${n} calls ${bar((n / rows) * 100)} <span style="color:#9ca3af;font-size:12px;">${Math.round((n / rows) * 100)}%</span></td></tr>`).join("")
  return {
    rows: d.rows,
    ok: d.ok,
    failed: d.failed,
    credits: d.credits.toFixed(2),
    tokensIn: d.tokensIn.toLocaleString("en-US"),
    tokensOut: d.tokensOut.toLocaleString("en-US"),
    sessionCount: sessions.length,
    agentList: agents.map(line).join("\n"),
    providerList: providers.map(line).join("\n"),
    modelList: models.map(line).join("\n"),
    sessionList: sessions.slice(0, 20).map(([sid, s]) => `${sid}… (${s.rows} calls · ${Object.keys(s.agents).length} agents)`).join("\n"),
    agentRows: modelLine(agents),
    providerRows: modelLine(providers),
    modelRows: modelLine(models),
    detail: `Calls: ${d.rows} (ok ${d.ok} / failed ${d.failed})\nCredits: ${d.credits.toFixed(2)}\nTokens: ${d.tokensIn.toLocaleString("en-US")} in / ${d.tokensOut.toLocaleString("en-US")} out\nSessions: ${sessions.length}\n\nAgents:\n${agents.map(line).join("\n")}\n\nProviders:\n${providers.map(line).join("\n")}\n\nModels:\n${models.map(line).join("\n")}`,
  }
}

const DEFAULT_REPORT_BODY = `magpie usage digest

Calls: {{rows}} (ok {{ok}} / failed {{failed}})
Credits: {{credits}}
Tokens: {{tokensIn}} in / {{tokensOut}} out
Sessions: {{sessionCount}}

Agents:
{{agentList}}

Providers:
{{providerList}}

Models:
{{modelList}}
`

const DEFAULT_REPORT_HTML = `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
    <div style="padding:16px 24px;background:#1f2937;color:#ffffff;">
      <span style="display:inline-block;padding:2px 10px;border-radius:10px;font-size:12px;background:#2563eb;color:#fff;">usage digest</span>
      <span style="margin-left:8px;font-size:14px;color:#d1d5db;">magpie mail-watch</span>
    </div>
    <div style="padding:24px;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;color:#111827;margin-bottom:16px;">
        <tr><td style="padding:6px 0;color:#6b7280;width:96px;">Calls</td><td style="padding:6px 0;">{{rows}} <span style="color:#9ca3af;">(ok {{ok}} / failed {{failed}})</span></td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Credits</td><td style="padding:6px 0;">{{credits}}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Tokens</td><td style="padding:6px 0;">{{tokensIn}} in / {{tokensOut}} out</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Sessions</td><td style="padding:6px 0;">{{sessionCount}}</td></tr>
      </table>
      <div style="font-size:13px;color:#6b7280;margin:12px 0 4px;">Agents</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;color:#111827;">{{agentRows}}</table>
      <div style="font-size:13px;color:#6b7280;margin:12px 0 4px;">Providers</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;color:#111827;">{{providerRows}}</table>
      <div style="font-size:13px;color:#6b7280;margin:12px 0 4px;">Models</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;color:#111827;">{{modelRows}}</table>
    </div>
    <div style="padding:12px 24px;background:#f9fafb;color:#9ca3af;font-size:12px;">sent by magpie mail-watch from your own gateway</div>
  </div>
</body></html>`

async function scan(o, to) {
  const opts = { watch: o.watch ?? {}, cooldown: o.cooldownMinutes ?? {} }
  const events = takeWithinCap([...fail(opts).events, ...quotaScan(opts)], o.maxMailsPerHour)
  if (!events.length) {
    save()
    return
  }
  save()
  for (const ev of events) {
    queue = queue.then(() => mail(o, to, ev)).catch(() => {})
  }
}

// mail renders one event through the user's template and hands it to the
// SMTP client. A failure is swallowed: the next event tries again, the
// cooldown keeps a broken server from collecting a backlog.
async function mail(o, to, ev) {
  const vars = {
    kind: ev.kind === "error" ? "error" : ev.kind === "quotaExhausted" ? "quota exhausted" : "quota low",
    provider: ev.provider,
    account: ev.account ? ` · ${ev.account}` : "",
    model: ev.model ?? "",
    agent: ev.agent ?? "",
    status: ev.status ?? "",
    errType: ev.errType ?? "",
    endpoint: ev.endpoint ?? "",
    window: ev.window ? ` · ${ev.window}` : "",
    used: ev.used ?? "",
    resetsAt: ev.resetsAt ?? "",
    time: new Date().toISOString(),
    modelLine: ev.model ? `Model: ${ev.model}${ev.agent ? ` · ${ev.agent}` : ""}\n` : "",
    windowLine: ev.window ? `Window: ${ev.window} — ${ev.used}% used${ev.resetsAt ? `, resets ${ev.resetsAt}` : ""}\n` : "",
    detail:
      ev.kind === "error"
        ? `Status: ${ev.status}${ev.errType ? ` (${ev.errType})` : ""}\n${ev.endpoint ? `Endpoint: ${ev.endpoint}\n` : ""}${ev.err || "(the vendor said nothing)"}`
        : `${ev.used}% of the window "${ev.window}" is used${ev.resetsAt ? `; it resets at ${ev.resetsAt}` : ""}.`,
  }
  const t = o.template && typeof o.template === "object" ? o.template : {}
  const subject = fill(t.subject ?? "[magpie] {{kind}} · {{provider}}{{window}}", vars)
  const body = fill(t.body ?? "What: {{kind}}\nProvider: {{provider}}{{account}}\n{{modelLine}}{{windowLine}}When: {{time}}\n\n{{detail}}", vars)
  // the HTML layout: the user's own page when they set one (filled with
  // the same vars, HTML-escaped variants for the interpolations), the
  // built-in card otherwise; false opts out of the HTML part entirely
  const html = t.html === false ? undefined : renderHtml(t.html, vars)
  await send(o.smtp, to, message({ from: o.smtp.from ?? o.smtp.user, to, subject, body, html }))
}

// recipients is the option as a list of addresses: a string with commas,
// an array, one address.
function recipients(v) {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []
  return list.map((s) => String(s ?? "").trim()).filter(Boolean)
}
