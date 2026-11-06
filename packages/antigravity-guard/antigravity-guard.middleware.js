// Antigravity accounts are suspended by Google's abuse detection when their
// product OAuth credentials are used through third-party tools. The suspension
// is a 403 TOS_VIOLATION / PERMISSION_DENIED, not a rate limit: every further
// request to that account is refused and, per Google's appeal form, a repeat
// violation is a permanent ban.
//
// This middleware does NOT hide anything from Google. It never rewrites a
// request, never cloaks a prompt and never changes what an agent sends. It
// does three things, all on the defensive side:
//
//   1. strategies.guard spreads work evenly across accounts and puts resting,
//      over-budget or suspended accounts last.
//   2. onAccount returns {skip: true} for accounts the operator has denied or
//      that tripped the guard. magpie's gateway sends nothing when every
//      candidate is skipped (gateway-middleware.md: "no fail-open"), so a
//      suspended account really stops receiving requests.
//   3. onUsage notices repeated 403s and marks that account as blocked.
//
// State limits, stated plainly: magpie's gateway-middleware.md says only
// `strategies` and `onUsage` share module state across requests; `onRequest`
// and `onAccount` run in per-request runtimes. So the counters here are best
// effort, and the RELIABLE switches are the ones that come from options:
// `deniedRefs` and `pauseUntil`. An external guard process can set those
// (or the operator can, with `magpie plugin options`) after a suspension.
// A true global circuit breaker has to live in the gateway itself.
//
// Options (all optional):
//   off               true leaves every request alone.
//   deniedRefs        account refs that onAccount skips and guard ranks last.
//   pauseUntil        unix ms; until then onRequest rejects and onAccount skips.
//   dailyCap          best-effort per-account request ceiling (0 disables).
//   cooldownMinutes   how long a detected suspension blocks its account.
//   suspension403     consecutive 403s before an account is treated as banned.

const DEFAULTS = {
  off: false,
  deniedRefs: [],
  pauseUntil: 0,
  dailyCap: 300,
  cooldownMinutes: 1440,
  suspension403: 2,
}

const S = {
  day: 0,
  counts: {},
  errors: {},
  blocked: {},
}

function settings(ctx) {
  const o = (ctx && ctx.options) || {}
  const num = (v, d) => typeof v === "number" && isFinite(v) ? v : d
  return {
    off: o.off === true,
    deniedRefs: Array.isArray(o.deniedRefs) ? o.deniedRefs : [],
    pauseUntil: num(o.pauseUntil, DEFAULTS.pauseUntil),
    dailyCap: num(o.dailyCap, DEFAULTS.dailyCap),
    cooldownMinutes: num(o.cooldownMinutes, DEFAULTS.cooldownMinutes),
    suspension403: num(o.suspension403, DEFAULTS.suspension403),
  }
}

function today() {
  return Math.floor(Date.now() / 86400000)
}

function roll() {
  const d = today()
  if (S.day !== d) {
    S.day = d
    S.counts = {}
    S.errors = {}
  }
}

function refOf(account) {
  if (!account) return "?"
  return String(account.ref || account.name || account.key || "?")
}

function rowKey(row) {
  if (!row) return "?"
  const p = row.provider || {}
  return String(row.key || p.key || p.account || row.account || "?")
}

// Only options are a reliable pause switch: they are passed to every hook,
// every request, whatever runtime the hook runs in. The state above is best
// effort, so it never rejects a request on its own; it only skips accounts.
function paused(o, now) {
  return o.pauseUntil > now
}

function pauseMinutes(o, now) {
  return Math.ceil((o.pauseUntil - now) / 60000)
}

// ---- hooks ---------------------------------------------------------------

export function onUsage(row, options) {
  const o = settings({ options: options || {} })
  if (o.off) return
  roll()
  const now = Date.now()
  const k = rowKey(row)
  S.counts[k] = (S.counts[k] || 0) + 1
  const status = row && row.status
  if (status === 403 || status === 429) {
    const n = (S.errors[k] || 0) + 1
    S.errors[k] = n
    if (status === 403 && n >= o.suspension403) {
      S.blocked[k] = now + o.cooldownMinutes * 60000
    }
  } else if (status === 200) {
    S.errors[k] = 0
  }
}

export function onAccount(account, ctx) {
  const o = settings(ctx)
  if (o.off) return
  const now = Date.now()
  if (paused(o, now)) return { skip: true }
  const k = refOf(account)
  if (o.deniedRefs.indexOf(k) >= 0) return { skip: true }
  if ((S.blocked[k] || 0) > now) return { skip: true }
  roll()
  if (o.dailyCap > 0 && (S.counts[k] || 0) >= o.dailyCap) return { skip: true }
  return
}

export function onRequest(body, ctx) {
  const o = settings(ctx)
  if (o.off) return
  const now = Date.now()
  if (paused(o, now)) {
    if (ctx && typeof ctx.reject === "function") {
      ctx.reject(429, "antigravity-guard: a suspension was detected, requests are paused for " + pauseMinutes(o, now) + " minutes; check the account and clear pauseUntil when it is restored")
    }
  }
  return
}

export const strategies = {
  // A strategy must return a full permutation of the seats. We only reorder:
  // accounts that are resting, denied, over budget or blocked go last.
  guard(pool, seats, options) {
    const o = settings({ options: options || {} })
    roll()
    const now = Date.now()
    const rank = (s, i) => {
      const k = String(s.key || i)
      let r = Number(s.used) || 0
      if (s.resting) r += 100000
      if (o.dailyCap > 0 && (S.counts[k] || 0) >= o.dailyCap) r += 10000
      if ((S.blocked[k] || 0) > now) r += 1000000
      if (o.deniedRefs.indexOf(k) >= 0) r += 1000000
      return r
    }
    return seats
      .map((s, i) => ({ i: i, r: rank(s, i) }))
      .sort((a, b) => (a.r - b.r) || (a.i - b.i))
      .map((x) => x.i)
  },
}
