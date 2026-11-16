// Which providers and models are answering lately, so the automatic picks skip
// a signed-out account, a dead key or a server that isn't running without the
// user seeing it fail. Three sources, newest first: council's own calls (kept
// in magpie's config folder across restarts), magpie's recent requests from
// every agent (/v1/magpie/usage/requests), and the accounts' cards
// (/v1/magpie/quotas: signed out, plan gone, allowance used up). Nothing is
// probed: knowing costs no request.

import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { getJSON } from "./gateway.mjs"

const MIN = 60_000
// how long a failure keeps a model, or its whole provider, out of the picks: a
// dead key doesn't mend itself (council_models refresh: true tries at once)
// (a refusal by a content filter holds nothing: it was the question, not the model)
export const HOLD = { account: 6 * 60 * MIN, plan: 6 * 60 * MIN, quota: 10 * MIN, unreachable: 30 * MIN, timeout: 15 * MIN, model: 30 * MIN, busy: 3 * MIN, other: 5 * MIN }
// A 429 is often one model's ("Fable 5.1 requires usage credits"), so it holds
// that model alone; an account that is used up shows on its card instead.
export const PROVIDER_WIDE = new Set(["account", "unreachable", "timeout"])
const PRIOR_TTL = 30_000
const OK_TTL = 24 * 60 * MIN

export function classify(status, message) {
  const m = String(message || "")
  if (status === 401 || status === 403) return "account"
  if (/not signed in|sign(ed)? ?out|sign in again|log ?in again|unauthori[sz]ed|forbidden|invalid[^.]{0,40}(api.?key|token|credential)|(api.?key|token)[^.]{0,20}(invalid|expired|revoked)|authentication fail|no longer supported|鉴权|未登录|登录已过期/i.test(m)) return "account"
  // the plan doesn't include the model: it won't come back by waiting
  if (/requires (usage )?credits|upgrade (your )?(plan|subscription)|not (available|included) (in|on|with) your (plan|subscription)|plan does not include|需要升级|套餐不(支持|包含)/i.test(m)) return "plan"
  if (status === 429 || /rate.?limit|quota|usage limit|exceeded|insufficient|balance|too many requests|额度|余额/i.test(m)) return "quota"
  if (/ECONNREFUSED|connection refused|dial tcp|ENOTFOUND|no such host|EHOSTUNREACH|unable to connect|connect(ion)? (failed|error|reset)/i.test(m)) return "unreachable"
  if (/content.?(policy|filter|management)|safety (system|filter)|moderation|blocked by|inappropriate|violat|data_inspection|违规|敏感|审核/i.test(m)) return "refused"
  if (status === 400 && /context|too long|too many tokens|maximum.{0,20}tokens|token limit/i.test(m)) return "toolong"
  if ([502, 503, 504, 529].includes(status) || /overloaded|temporarily unavailable|try again later|server (is )?busy|capacity|繁忙/i.test(m)) return "busy"
  if (status === 404 || /model[^.]{0,30}(not found|does not exist|unknown|not supported|unavailable)|unsupported model|no such model/i.test(m)) return "model"
  return "other"
}

const newest = (...es) => es.filter(Boolean).sort((a, b) => b.at - a.at)[0]

export class Health {
  constructor(dir) {
    this.dir = dir || ""
    this.file = dir ? join(dir, "council-health.json") : null
    this.own = new Map() // model id, or "provider:<id>" → { ok, ms, kind, why, at }
    this.prior = { at: 0, providers: new Map(), models: new Map(), kinds: new Map() }
    this.loaded = null
  }

  load() {
    this.loaded ??= (async () => {
      if (!this.file) return
      try {
        const j = JSON.parse(await readFile(this.file, "utf8"))
        for (const [k, v] of Object.entries(j?.entries || {})) if (v && typeof v.at === "number") this.own.set(k, v)
      } catch {}
    })()
    return this.loaded
  }

  save() {
    if (!this.file || this.timer) return
    this.timer = setTimeout(async () => {
      this.timer = null
      const cutoff = Date.now() - OK_TTL
      const entries = {}
      for (const [k, v] of this.own) if (v.at > cutoff) entries[k] = v
      try {
        await writeFile(this.file, JSON.stringify({ version: 1, entries }))
      } catch {}
    }, 1500)
    this.timer.unref?.()
  }

  record(r, m) {
    const at = Date.now()
    if (r.ok) {
      this.own.set(m.id, { ok: true, ms: r.ms, at })
      this.own.delete(`provider:${m.provider}`)
    } else if (r.kind === "slow") {
      this.own.set(m.id, { ok: false, kind: "slow", at })
    } else if (HOLD[r.kind]) {
      const e = { ok: false, kind: r.kind, why: String(r.why || "").slice(0, 200), at }
      // "temporarily unavailable" for hours: each time again waits twice as long, up to an hour
      const before = this.own.get(m.id)
      if (r.kind === "busy" && before?.kind === "busy" && at - before.at < 2 * 60 * MIN) e.hold = Math.min(60 * MIN, (before.hold || HOLD.busy) * 2)
      this.own.set(m.id, e)
      if (PROVIDER_WIDE.has(r.kind)) this.own.set(`provider:${m.provider}`, e)
      // "Fable 5.1 requires usage credits" goes for Fable 5 too: the kind of model
      if ((r.kind === "quota" || r.kind === "plan") && m.family) this.own.set(`family:${m.provider}/${m.family}`, e)
    } else return // a too-long input or an empty answer says nothing about the model
    this.save()
  }

  clear() {
    this.own.clear()
    this.prior.at = 0
    this.save()
  }

  async refreshPriors(o) {
    if (Date.now() - this.prior.at < PRIOR_TTL) return
    const providers = new Map()
    const models = new Map()
    const kinds = new Map()
    const now = Date.now()
    const [q, u] = await Promise.allSettled([
      getJSON(o, "/v1/magpie/quotas", 4000),
      getJSON(o, "/v1/magpie/usage/requests?limit=300", 4000),
    ])
    if (q.status === "fulfilled") {
      const by = new Map()
      for (const a of q.value?.data || []) {
        if (!a?.provider) continue
        if (!by.has(a.provider)) by.set(a.provider, [])
        by.get(a.provider).push(a)
      }
      for (const [p, accounts] of by) {
        kinds.set(p, accounts[0].kind || "")
        // a card not read yet says nothing either way
        const live = accounts.filter((a) => !(a.error && /not read yet|refresh this account/i.test(a.error)))
        if (!live.length) continue
        const out = (a) =>
          (a.error && ["account", "quota"].includes(classify(0, a.error))) ||
          (a.windows || []).some((w) => !w.text && typeof w.remaining === "number" && w.remaining <= 0)
        if (live.every(out)) {
          const a = live.find((x) => x.error) || live[0]
          providers.set(p, { ok: false, kind: a.error ? classify(0, a.error) : "quota", why: a.error || "allowance used up", at: now })
        }
      }
    }
    if (u.status === "fulfilled") {
      for (const r of u.value?.rows || []) {
        if (!r?.provider || !r?.model) continue
        const id = `${r.provider}/${r.model}`
        const at = Date.parse(r.t) || 0
        if (models.has(id) && models.get(id).at >= at) continue
        if (r.status === 200) {
          if (now - at < OK_TTL) models.set(id, { ok: true, ms: Number(r.ms) || 0, at })
        } else if (r.status === 499) {
          // the caller gave up: slow, if it waited a while
          if (now - at < 60 * MIN && Number(r.ms) >= 20_000) models.set(id, { ok: false, kind: "slow", at })
        } else if (r.status >= 400 || r.err) {
          const kind = classify(r.status, r.err)
          if (!HOLD[kind] || now - at >= HOLD[kind]) continue
          const e = { ok: false, kind, why: String(r.err || "").slice(0, 200), at }
          models.set(id, e)
          if (PROVIDER_WIDE.has(kind) && !(providers.get(r.provider)?.at > at)) providers.set(r.provider, e)
        }
      }
    }
    this.prior = { at: now, providers, models, kinds }
  }

  kindOf(provider) {
    return this.prior.kinds.get(provider) || ""
  }

  entry(m) {
    return newest(this.own.get(m.id), this.prior.models.get(m.id))
  }

  // When this provider last answered, by any of its models.
  lastOk(provider) {
    let at = 0
    const prefix = `${provider}/`
    for (const map of [this.own, this.prior.models]) for (const [k, v] of map) if (v.ok && k.startsWith(prefix) && v.at > at) at = v.at
    return at
  }

  // Why the model is out of the automatic picks now, or null.
  held(m) {
    const now = Date.now()
    const live = (e) => (e && !e.ok && HOLD[e.kind] && now - e.at < (e.hold || HOLD[e.kind]) ? e : null)
    const p = live(newest(this.own.get(`provider:${m.provider}`), this.prior.providers.get(m.provider)))
    const cardSays = p && p === this.prior.providers.get(m.provider)
    if (p && (cardSays || PROVIDER_WIDE.has(p.kind)) && this.lastOk(m.provider) < p.at) return p
    const e = this.entry(m)
    if (e?.ok) return null
    return live(e) || live(m.family ? this.own.get(`family:${m.provider}/${m.family}`) : null)
  }

  // ok (answered lately, with how fast), slow, held or unknown
  state(m) {
    const h = this.held(m)
    if (h) return { s: "held", ...h }
    const e = this.entry(m)
    if (!e) return { s: "unknown" }
    if (e.ok) return Date.now() - e.at < OK_TTL ? { s: "ok", ms: e.ms } : { s: "unknown" }
    if (e.kind === "slow") return { s: "slow" }
    return { s: "unknown" }
  }
}
