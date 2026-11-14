// Which models to ask. With none named, one per provider: its strongest model
// (or, with fast, its quickest), from the providers answering lately first,
// then those nothing is known about; slow ones only stand in for a failure.
// With fewer than three providers, other kinds of model from the same ones
// fill up to three. What can't be used now is left out with a note, never sent.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { RANK, catalog } from "./catalog.mjs"

const listOf = (v) =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,，\s]+/) : []).map((x) => String(x).trim()).filter(Boolean)

// subscriptions and plans cost allowance, not money: their strongest model is
// fine; a key paid by the token gets nothing above maxPrice ($ per million in)
const prepaid = (kind) => kind === "subscription" || kind === "plan"

const versionOf = (id) => (String(id).toLowerCase().replace(/-\d{8}$/, "").match(/\d+/g) || []).map(Number)
const newer = (a, b) => {
  const x = versionOf(a.id)
  const y = versionOf(b.id)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1)
    if (d) return d
  }
  return 0
}

// What the user never wants asked (option exclude): a provider ("grok"), a
// model ("claude/claude-fable-5-1") or a word in its id ("fable").
export function excluded(o, m) {
  const list = listOf(o.exclude).map((x) => x.toLowerCase())
  const id = m.id.toLowerCase()
  return list.some((x) => x === m.provider.toLowerCase() || x === id || (!x.includes("/") && id.slice(m.provider.length + 1).includes(x)))
}

// A provider's models, one per kind: the kinds by their dearest model, each at its newest version.
export function kindsOf(ms, health) {
  const slow = (m) => health.state(m).s === "slow"
  const fams = new Map()
  for (const m of ms) {
    if (!fams.has(m.family)) fams.set(m.family, [])
    fams.get(m.family).push(m)
  }
  return [...fams.values()]
    .map((f) => ({ rep: [...f].sort((a, b) => slow(a) - slow(b) || newer(b, a) || a.order - b.order)[0], price: Math.max(...f.map((m) => m.price ?? -1)) }))
    .sort((a, b) => slow(a.rep) - slow(b.rep) || b.price - a.price || a.rep.order - b.rep.order)
    .map((x) => x.rep)
}

// magpie's routing groups, made on its Routing page with its own model picker:
// a group named "council" is the models council asks when none are named, and
// any group can be named to ask its members one by one. magpie keeps them in
// providers.json beside the providers' keys: only "groups" is taken from it,
// and nothing else of the file is kept or sent anywhere.
let groupCache = { at: 0, dir: "", groups: [] }
export function groupsOf(dir) {
  if (!dir) return []
  if (groupCache.dir === dir && Date.now() - groupCache.at < 5000) return groupCache.groups
  let groups = []
  try {
    const raw = JSON.parse(readFileSync(join(dir, "providers.json"), "utf8"))?.groups
    groups = (Array.isArray(raw) ? raw : [])
      .filter((g) => g && typeof g.id === "string" && Array.isArray(g.members))
      .map((g) => ({ id: g.id, name: String(g.name || g.id), members: g.members.filter((x) => typeof x === "string") }))
  } catch {}
  groupCache = { at: Date.now(), dir, groups }
  return groups
}
export const councilGroup = (dir) => groupsOf(dir).find((g) => g.id.toLowerCase() === "council" || g.name.toLowerCase() === "council")

export async function choose(o, health, want, opts, T) {
  const all = (await catalog(o)).filter((m) => !excluded(o, m))
  await health.refreshPriors(o)
  const notes = []
  const maxPrice = Number(o.maxPrice) > 0 ? Number(o.maxPrice) : 15
  const fits = (m) =>
    m.chat &&
    !m.group &&
    (!opts.vision || m.vision) &&
    (!m.context || m.context >= opts.tokens + 4000) &&
    (opts.tier === "fast" || prepaid(health.kindOf(m.provider)) || m.price == null || m.price * 1e6 <= maxPrice)

  const usable = all.filter((m) => fits(m) && !health.held(m))
  const speed = (m) => {
    const s = health.state(m)
    return s.s === "ok" ? s.ms : Infinity
  }
  const slow = (m) => health.state(m).s === "slow"
  const cmp =
    opts.tier === "fast"
      ? (a, b) => slow(a) - slow(b) || speed(a) - speed(b) || (a.price ?? Infinity) - (b.price ?? Infinity) || a.order - b.order
      : (a, b) => slow(a) - slow(b) || (b.price ?? -1) - (a.price ?? -1) || a.order - b.order

  // each provider's models in pick order, one per kind: with fast the quickest
  // of each; else the kinds by their dearest model (fable before opus before
  // sonnet), each kind by its newest version (opus 5.5 before opus 5, whatever
  // they cost)
  const byProvider = new Map()
  for (const m of usable) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, [])
    byProvider.get(m.provider).push(m)
  }
  const kinds = (ms) => kindsOf(ms, health)
  const lanes = [...byProvider].map(([provider, ms]) => {
    const seen = new Set()
    const queue = opts.tier === "fast" ? ms.sort(cmp).filter((m) => !seen.has(m.family) && seen.add(m.family)) : kinds(ms)
    const states = ms.map((m) => health.state(m).s)
    // answering lately; nothing known; slow lately (a stand-in only)
    const cls = states.includes("ok") ? 0 : states.includes("slow") ? 2 : 1
    return { provider, queue, cls, first: Math.min(...ms.map((m) => m.order)), fast: Math.min(...ms.map(speed)) }
  })
  // the calling agent's own provider last; answering lately first; then the
  // quickest (fast) or the strongest pick (dearest), so a review by one model
  // gets the strongest there is
  lanes.sort(
    (a, b) =>
      (a.provider === opts.avoid) - (b.provider === opts.avoid) ||
      a.cls - b.cls ||
      (opts.tier === "fast" ? a.fast - b.fast : (b.queue[0]?.price ?? -1) - (a.queue[0]?.price ?? -1)) ||
      a.first - b.first,
  )
  const provider = (p) => lanes.find((l) => l.provider.toLowerCase() === p)?.queue[0]

  const picks = []
  const add = (m) => m && !picks.some((x) => x.id === m.id) && picks.push(m)
  const groups = groupsOf(health.dir)
  const groupOf = (lower) => groups.find((g) => [g.id, `group/${g.id}`, g.name].some((x) => x.toLowerCase() === lower))
  const own = councilGroup(health.dir)
  const tokens = listOf(want).length ? listOf(want) : own ? [own.id] : []
  for (const t of tokens) {
    const lower = t.toLowerCase()
    if (lower === "auto") continue
    if (lower === "all") {
      usable.forEach(add)
      continue
    }
    // a routing group: its members, each asked on its own, at the level fixed on it
    const g = groupOf(lower)
    if (g) {
      for (const member of g.members) {
        const [id, level] = member.split(":")
        const m = all.find((x) => x.id === id)
        const h = m && health.held(m)
        if (!m) notes.push(T.unknown(id))
        else if (m.imageOut) notes.push(T.imageModel(m.id))
        else if (opts.vision && !m.vision) notes.push(T.noVision(m.id))
        else if (h) notes.push(T.held(m.id, h.kind))
        else add(level in RANK ? { ...m, fixedLevel: level } : m)
      }
      if (!g.members.length) notes.push(T.emptyGroup(g.name))
      continue
    }
    const m =
      all.find((x) => x.id.toLowerCase() === lower) ||
      all.find((x) => x.id.toLowerCase().endsWith(`/${lower}`)) ||
      all.find((x) => x.name.toLowerCase() === lower)
    if (m) {
      const h = health.held(m)
      if (m.imageOut) notes.push(T.imageModel(m.id))
      else if (!m.chat && !m.group) notes.push(T.notChat(m.id))
      else if (opts.vision && !m.vision && !m.group) notes.push(T.noVision(m.id))
      else if (h) notes.push(T.held(m.id, h.kind))
      else add(m)
      continue
    }
    if (all.some((x) => x.provider.toLowerCase() === lower)) {
      const p = provider(lower)
      if (p) add(p)
      else notes.push(T.providerDown(t))
      continue
    }
    // a short name: "sonnet", "gpt-5.6", "argon": the strongest kind it names, at its newest
    const like = (x) => x.id.toLowerCase().includes(lower) || x.name.toLowerCase().includes(lower)
    const hits = usable.filter(like)
    if (hits.length) {
      add(kinds(hits)[0])
      continue
    }
    const down = all.find((x) => like(x) && x.chat)
    if (down) {
      const h = health.held(down)
      notes.push(h ? T.held(down.id, h.kind) : opts.vision && !down.vision ? T.noVision(down.id) : T.notChat(down.id))
      continue
    }
    notes.push(T.unknown(t))
  }
  const named = picks.length > 0
  if (tokens.length && !named && !tokens.some((t) => t.toLowerCase() === "auto")) notes.push(T.fallback())

  const main = lanes.filter((l) => l.cls < 2)
  const spare = lanes.filter((l) => l.cls === 2)
  if (!named || tokens.some((t) => t.toLowerCase() === "auto")) {
    // models named beside auto come on top of the usual picks
    const target = Math.max(1, opts.count) + picks.length
    for (const l of main) if (picks.length < target) add(l.queue[0])
    for (let k = 1; picks.length < Math.min(target, 3) && main.some((l) => l.queue[k]); k++)
      for (const l of main) if (picks.length < Math.min(target, 3)) add(l.queue[k])
    if (!picks.length) for (const l of spare) if (picks.length < target) add(l.queue[0])
  }

  // stand-ins for a pick that fails: the providers not picked, then other kinds
  // of model; the slow ones apart, only for when too few would answer
  const taken = new Set(picks.map((m) => m.id))
  const reserve = []
  const slowOnes = []
  // known-good first: other kinds from providers answering lately (quickest
  // first), then providers nothing is known about
  const known = main.filter((l) => l.cls === 0)
  const fresh = main.filter((l) => l.cls === 1)
  for (const m of known.flatMap((l) => l.queue.slice(1)).sort((a, b) => speed(a) - speed(b))) if (!taken.has(m.id)) reserve.push(m)
  for (const l of fresh) if (l.queue[0] && !taken.has(l.queue[0].id)) reserve.push(l.queue[0])
  for (const l of fresh) for (const m of l.queue.slice(1)) if (!taken.has(m.id)) reserve.push(m)
  for (const l of known) if (l.queue[0] && !taken.has(l.queue[0].id)) reserve.push(l.queue[0])
  for (const l of spare) for (const m of l.queue) if (!taken.has(m.id)) slowOnes.push(m)

  // the providers left out for now, for one line under the answers
  const skipped = []
  for (const p of new Set(all.filter((m) => m.chat && !m.group).map((m) => m.provider))) {
    if (byProvider.has(p)) continue
    const h = all.filter((m) => m.provider === p).map((m) => health.held(m)).find(Boolean)
    if (h) skipped.push({ provider: p, kind: h.kind, why: h.why || "" })
  }

  // with nothing to ask, why: no models at all, all down, none that sees images, input too long
  let empty = ""
  if (!picks.length) {
    const chat = all.filter((m) => m.chat && !m.group)
    const up = chat.filter((m) => !health.held(m))
    if (!chat.length) empty = "none"
    else if (!up.length) empty = "down"
    else if (opts.vision && !up.some((m) => m.vision)) empty = "vision"
    else if (up.every((m) => m.context && m.context < opts.tokens + 4000)) empty = "toolong"
    else empty = "down"
  }
  // only models named alone get no stand-ins: auto beside them keeps them
  const alone = named && !tokens.some((t) => t.toLowerCase() === "auto")
  return { picks, reserve: alone ? [] : reserve, spare: alone ? [] : slowOnes, notes, skipped, empty }
}
