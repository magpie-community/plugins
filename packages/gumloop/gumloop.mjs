// Gumloop's API: what an account can use, what a call costs, and what this
// plugin has spent. Nothing here signs in or holds a key; index.mjs does.
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

export const API = "https://api.gumloop.com/api/v1"
export const WS = "https://ws.gumloop.com/api/v1"
export const OPENROUTER = "https://openrouter.ai/api/v1"

// Gumloop bills $0.005 per credit and rounds every call up to a whole credit.
export const USD_PER_CREDIT = 0.005
export const PRICES_TTL = 12 * 60 * 60 * 1000
export const PRICES_RETRY_TTL = 5 * 60 * 1000
// A credit-limit refusal keeps the account shown as out of credits this long.
export const EXHAUSTED_FOR = 12 * 60 * 60 * 1000

// USD per million tokens [input, output, cacheRead, cacheWrite], used until
// (or when) OpenRouter's list cannot be read. cacheWrite null = billed as input.
// From vwfactory-dsh (2026-10), supplemented with OpenRouter provider rates
// checked on 2026-11-11. These are estimates, not a Gumloop balance API.
export const FALLBACK_PRICES = {
  "claude-fable-5-1": [10, 50, 0.25, 12.5],
  "claude-fable-5": [10, 50, 1, 12.5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-haiku-4-5": [1, 5, 0.1, 1.25],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.1, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
  "gpt-6-astra": [10, 50, 1, 12.5],
  "gpt-6.1-sol": [2, 10, 0.1, 2.5],
  "gpt-6.1-terra": [1, 5, 0.05, 1.25],
  "gpt-6-sol": [2, 10, 0.2, 2.5],
  "gpt-6-luna": [0.1, 0.5, 0.01, 0.125],
  "grok-4.7": [2, 6, 0.5, null],
  "grok-4.6": [2, 6, 0.5, null],
  "meta/muse-spark-1.3": [1.25, 4.25, 0.15, null],
  "meta/muse-wonder-1.0": [4, 20, 0.2, null],
  "minimax/minimax-m3.1-flash": [0.15, 0.6, 0.015, null],
  "accounts/fireworks/models/glm-5p3": [1.4, 4.4, 0.26, null],
  "z-ai/glm-5.3-flash": [0.15, 0.5, 0.03, null],
  "accounts/fireworks/routers/kimi-k3-us": [3, 15, 0.3, null],
  "accounts/fireworks/models/kimi-k2p7-code": [0.95, 4, 0.19, null],
  "gemini-4-argon": [2, 10, 0.1, 0.1875],
  "gemini-3.1-pro-preview": [2, 12, 0.2, 0.375],
  "gemini-3.8-flash": [0.825, 4.125, 0.0825, 0.04166666667],
  "gemini-3.7-flash": [0.75, 3.75, 0.075, 0.04166666667],
  "google/gemma-4-26b-a4b-it": [0.15, 0.6, null, null],
  "accounts/fireworks/models/deepseek-v4p1-flash": [0.3, 1.2, 0.006, null],
  "accounts/fireworks/models/deepseek-v4-pro-0813": [1.32, 3.96, 0.044, null],
  "accounts/fireworks/models/minimax-m3": [0.3, 1.2, 0.06, null],
}

// /models uses catalog names; /chat/completions still requires these routes.
// Verified against both Gumloop endpoints on 2026-11-11.
export const MODEL_ROUTES = {
  "glm-5.3": "accounts/fireworks/models/glm-5p3",
  "glm-5.3-flash": "z-ai/glm-5.3-flash",
  "kimi-k3": "accounts/fireworks/routers/kimi-k3-us",
  "deepseek-v4.1-flash": "accounts/fireworks/models/deepseek-v4p1-flash",
  "gemma-4-26b-a4b-it": "google/gemma-4-26b-a4b-it",
  "muse-spark-1.3": "meta/muse-spark-1.3",
  "muse-wonder-1.0": "meta/muse-wonder-1.0",
  "minimax-m3": "accounts/fireworks/models/minimax-m3",
  "minimax-m3.1-flash": "minimax/minimax-m3.1-flash",
}
export const wireModel = (id) => Object.hasOwn(MODEL_ROUTES, id) ? MODEL_ROUTES[id] : id
// Gumloop currently injects an unsupported `provider` field for this route.
// Keep it out of offered models until the upstream route is repaired.
export const availableModel = (id) => wireModel(id) !== "accounts/fireworks/models/minimax-m3"

const VENDORS = [
  [/^claude-/, "anthropic", "Anthropic"],
  [/^(gpt-|o\d)/, "openai", "OpenAI"],
  [/^(gemini-|gemma-)/, "google", "Google"],
  [/^grok-/, "x-ai", "xAI"],
  [/^deepseek/, "deepseek", "DeepSeek"],
  [/^glm-/, "z-ai", "Z.AI"],
  [/^kimi-/, "moonshotai", "Moonshot AI"],
  [/^minimax-/, "minimax", "Minimax"],
  [/^qwen/, "qwen", "Alibaba"],
  [/^muse-/, "meta", "Meta"],
]

export const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

export function gumloopHeaders(key, userId) {
  return { authorization: `Bearer ${key}`, "x-auth-key": userId }
}

// parseModels reads GET /models ({model_groups: [{groupLabel, options: [...]}]})
// into the chat models an agent can drive: active, not restricted, able to
// call tools, and not an image, voice, transcription or classifier model.
// gumloop-chew is Gumloop's own router, which bills unpredictably.
export function parseModels(body) {
  if (!isObj(body) || !Array.isArray(body.model_groups)) throw new Error("Gumloop sent no model list")
  const out = []
  for (const g of body.model_groups) {
    for (const o of Array.isArray(g?.options) ? g.options : []) {
      if (!isObj(o) || typeof o.value !== "string" || !o.value) continue
      const caps = Array.isArray(o.metadata?.capabilities) ? o.metadata.capabilities : []
      if (o.status !== "active" || o.restricted || o.is_classifier_model || o.is_image_generation || o.is_voice || o.is_transcription) continue
      if (!caps.includes("functions") || o.value === "gumloop-chew") continue
      if (!availableModel(o.value)) continue
      out.push({
        id: o.value,
        name: typeof o.label === "string" && o.label ? o.label : o.value,
        vision: caps.includes("vision"),
        reasoning: caps.includes("reasoning") || /^claude-(opus|fable)/.test(o.value),
        // Every call bills the whole context, so the short window keeps one
        // long conversation from spending thousands of credits per turn.
        context: Number(o.metadata?.short_context_window) || Number(o.metadata?.context_window) || 0,
      })
    }
  }
  if (!out.length) throw new Error("Gumloop listed no usable chat models")
  return out
}

// priceRef maps a Gumloop model id to the OpenRouter ids that may price it.
// Fireworks-hosted ones ("accounts/fireworks/models/glm-5p3") are priced at
// Fireworks' endpoint, which is what Gumloop pays, not OpenRouter's cheapest.
export function priceRef(id) {
  id = wireModel(id)
  const fireworks = /^accounts\/fireworks\//.test(id)
  let bare = id.replace(/^accounts\/fireworks\/(models|routers)\//, "")
  if (bare.includes("/")) {
    const provider = bare.startsWith("z-ai/") ? "Z.AI" : bare.startsWith("google/gemma-") ? "Google Vertex" : undefined
    return { orIds: [...new Set([bare, bare.replace(/-\d+(\.\d+)*$/, "")])], fireworks: false, provider }
  }
  bare = bare.replace(/(\d)p(\d)/g, "$1.$2").replace(/-us$/, "")
  const dotted = bare.replace(/(\d)-(\d)/g, "$1.$2")
  const v = VENDORS.find(([re]) => re.test(bare))
  const orIds = v ? [`${v[1]}/${dotted}`, `${v[1]}/${bare}`] : [dotted, bare]
  return { orIds: [...new Set(orIds)], fireworks, vendorName: v?.[2], provider: fireworks ? "Fireworks" : undefined }
}

function perMillion(p) {
  const n = (x) => (x === undefined || x === null || x === "" ? null : Number((Number(x) * 1e6).toPrecision(10)))
  const out = [n(p.prompt), n(p.completion), n(p.input_cache_read), n(p.input_cache_write)]
  return out[0] === null || out[1] === null || out.some((x) => x !== null && (!Number.isFinite(x) || x < 0)) ? undefined : out
}

// priceEntry reads one OpenRouter pricing block, with its long-context tier.
export function priceEntry(pricing) {
  if (!isObj(pricing)) return undefined
  const base = perMillion(pricing)
  if (!base) return undefined
  const entry = { p: base }
  const ov = Array.isArray(pricing.overrides) ? pricing.overrides.find((o) => Number(o?.min_prompt_tokens) > 0) : undefined
  const long = ov ? perMillion({ ...pricing, ...ov }) : undefined
  if (long) Object.assign(entry, { longAt: Number(ov.min_prompt_tokens), long })
  return entry
}

// fetchPrices prices the given Gumloop ids from OpenRouter's public list.
export async function fetchPrices(fetchImpl, ids) {
  const r = await fetchImpl(`${OPENROUTER}/models`, { signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error(`OpenRouter price list: HTTP ${r.status}`)
  const data = (await r.json())?.data ?? []
  const byId = new Map(data.filter((m) => typeof m?.id === "string").map((m) => [m.id, m]))
  const endpointCache = new Map()
  const getEndpoints = (orId) => {
    if (!endpointCache.has(orId)) {
      endpointCache.set(
        orId,
        (async () => {
          const er = await fetchImpl(`${OPENROUTER}/models/${orId}/endpoints`, { signal: AbortSignal.timeout(20000) })
          return er.ok ? ((await er.json())?.data?.endpoints ?? []) : []
        })().catch(() => []),
      )
    }
    return endpointCache.get(orId)
  }
  const rows = await Promise.all(
    ids.map(async (id) => {
      const ref = priceRef(id)
      const orId = ref.orIds.find((x) => byId.has(x))
      if (!orId) return undefined
      let entry
      if (ref.provider) {
        const eps = await getEndpoints(orId)
        const ep = eps.find(
          (e) =>
            e?.provider_name === ref.provider &&
            priceEntry(e.pricing) &&
            (ref.provider !== "Fireworks" || !e.tag || e.tag === "fireworks"),
        )
        if (ep) entry = priceEntry(ep.pricing)
        // Keep the known route's fallback, not another host's headline price.
        if (!entry) return undefined
      }
      entry ??= priceEntry(byId.get(orId).pricing)
      return entry ? [id, { ...entry, ref: orId }] : undefined
    }),
  )
  return Object.fromEntries(rows.filter(Boolean))
}

// usageCost prices one completion from its OpenAI-style usage block.
export function usageCost(entry, usage) {
  const prompt = Number(usage?.prompt_tokens) || 0
  const out = Number(usage?.completion_tokens) || 0
  const det = isObj(usage?.prompt_tokens_details) ? usage.prompt_tokens_details : {}
  const read = Number(det.cached_tokens) || 0
  const write = Number(det.cache_write_tokens ?? det.cache_creation_tokens) || 0
  const fresh = Math.max(0, prompt - read - write)
  const [pin, pout, pread, pwrite] = entry.long && prompt >= entry.longAt ? entry.long : entry.p
  const usd = (fresh * pin + read * (pread ?? pin) + write * (pwrite ?? pin) + out * pout) / 1e6
  return { usd, prompt, out, read, write }
}

export const creditsFor = (usd) => (usd > 0 ? Math.ceil(usd / USD_PER_CREDIT - 1e-9) : 0)

export function monthKey(t) {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
}

// Store keeps the ledger (calibrated balance and spend per account) and the
// price table in one JSON file in magpie's config directory. Every terminal
// `magpie` command runs its own plugin host beside the app's, so each change
// locks and re-reads the file first rather than trusting what this process holds.
let seq = 0
export const LOCK_WAIT_MS = 250
export const LOCK_STALE_MS = 30_000
// A change that waited LOCK_WAIT_MS for a peer, or found the ledger
// unreadable, hasn't run: it is kept and tried again from a timer, and once
// more, waiting up to EXIT_WAIT_MS, when the process exits.
export const EXIT_WAIT_MS = 2000
// A retry runs on the event loop, so it waits for a peer only briefly; the
// next change this store makes, at full LOCK_WAIT_MS, takes the kept ones too.
const RETRY_WAIT_MS = 25
const RETRY_FIRST_MS = 25
const RETRY_MAX_MS = 5000
const PENDING_MAX = 1000
const lockWait = new Int32Array(new SharedArrayBuffer(4))
const ownedLocks = new Set()
const waitingStores = new Set()
// Windows can temporarily reject opening/deleting a name being renamed or
// replacing a file another process is reading. Retry the filesystem operation,
// never the caller's mutation, within a monotonic deadline.
function retryFs(fn, deadline = performance.now() + LOCK_WAIT_MS) {
  while (true) {
    try {
      return fn()
    } catch (e) {
      const remaining = deadline - performance.now()
      if (!["EPERM", "EACCES", "EBUSY"].includes(e?.code) || remaining <= 0) throw e
      Atomics.wait(lockWait, 0, 0, Math.min(5, remaining))
    }
  }
}
const remove = (path, deadline) => {
  try {
    retryFs(() => unlinkSync(path), deadline)
  } catch (e) {
    if (e?.code !== "ENOENT") throw e
  }
}
process.once("exit", () => {
  for (const store of waitingStores) {
    try { store.flush(EXIT_WAIT_MS) } catch {}
  }
  for (const path of ownedLocks) {
    try { remove(path) } catch {}
  }
})

// Lamport's bakery lock, with one never-reused participant name per attempt.
// Publishing ticket 0 announces "choosing"; contenders then take max(ticket)+1
// and wait for earlier (ticket, name) pairs. Atomic rename publishes complete
// records, so a crash while writing a temporary file cannot leave a partial
// participant. Local filesystem directory listings/renames must be coherent.
//
// There is deliberately no shared lock pathname to unlink. A dead owner's
// unique files can be removed by any number of recoverers without touching a
// later acquisition. ESRCH from kill(pid, 0) recovers immediately; otherwise a
// record older than LOCK_STALE_MS recovers even when the OS reused its PID.
function ledgerLock(file, onChoosing = undefined, waitMs = LOCK_WAIT_MS) {
  const directory = dirname(file)
  const base = basename(file)
  const prefix = `${base}.lock.`
  const tmpPrefix = `${base}.`
  const name = `${process.pid}.${randomUUID()}`
  const participant = join(directory, `${prefix}${name}.json`)
  const temporary = join(directory, `${prefix}${name}.tmp`)
  const deadline = performance.now() + waitMs
  const release = () => {
    for (const path of [participant, temporary]) {
      try {
        remove(path)
        ownedLocks.delete(path)
      } catch {} // normal exit or another process can retry cleanup
    }
  }
  const publish = (ticket) => {
    writeFileSync(temporary, JSON.stringify({ pid: process.pid, name, ticket }), { flag: "wx" })
    // Fully written before publication.
    retryFs(() => renameSync(temporary, participant))
  }
  const isAlive = (pid, alive) => {
    if (!alive.has(pid)) {
      try {
        process.kill(pid, 0)
        alive.set(pid, true)
      } catch (e) {
        alive.set(pid, e?.code !== "ESRCH")
      }
    }
    return alive.get(pid)
  }
  const isStale = (path) => {
    try {
      return Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS
    } catch {
      return false
    }
  }
  const peers = () => {
    const out = []
    const alive = new Map()
    for (const entry of readdirSync(directory)) {
      if (!entry.startsWith(prefix)) {
        if (entry.startsWith(tmpPrefix)) {
          const tmpMatch = /^([1-9]\d*)\.\d+\.tmp$/.exec(entry.slice(tmpPrefix.length))
          const pid = tmpMatch ? Number(tmpMatch[1]) : NaN
          const path = join(directory, entry)
          if (Number.isSafeInteger(pid) && (!isAlive(pid, alive) || isStale(path))) {
            try { remove(path) } catch {}
          }
        }
        continue
      }
      const match = /^([1-9]\d*)\.([a-f0-9-]{36})\.(json|tmp)$/.exec(entry.slice(prefix.length))
      const pid = match ? Number(match[1]) : NaN
      if (!match || !Number.isSafeInteger(pid)) continue
      const path = join(directory, entry)
      if (path === participant || path === temporary) continue
      if (!isAlive(pid, alive) || isStale(path)) {
        remove(path)
        continue
      }
      if (match[3] === "tmp") continue
      let record
      try {
        record = JSON.parse(retryFs(() => readFileSync(path, "utf8")))
      } catch (e) {
        if (e?.code === "ENOENT") continue // owner released after the listing
        throw e
      }
      const peerName = `${match[1]}.${match[2]}`
      if (record?.pid !== pid || record.name !== peerName || !Number.isSafeInteger(record.ticket) || record.ticket < 0) {
        remove(path)
        continue
      }
      out.push(record)
    }
    return out
  }
  try {
    mkdirSync(directory, { recursive: true })
    ownedLocks.add(participant)
    ownedLocks.add(temporary)
    publish(0)
    const ticket = Math.max(0, ...peers().map((p) => p.ticket)) + 1
    if (!Number.isSafeInteger(ticket)) throw new Error("Ledger lock ticket overflow")
    onChoosing?.()
    publish(ticket)
    // The deadline bounds only the wait for a peer. A stalled host (GC, disk,
    // antivirus) must still get one check, or an uncontended update is lost.
    for (let first = true; first || performance.now() < deadline; first = false) {
      const blocked = peers().some((p) => p.ticket === 0 || (p.ticket > 0 && (p.ticket < ticket || (p.ticket === ticket && p.name < name))))
      if (!blocked) return release
      Atomics.wait(lockWait, 0, 0, Math.min(5, Math.max(0, deadline - performance.now())))
    }
  } catch {} // estimates must not fail chat on an acquisition/filesystem error
  release()
  return undefined
}

export class Store {
  constructor(file, now = Date.now, onChoosing = undefined) {
    this.file = file
    this.now = now
    this.onChoosing = onChoosing
    this.mem = { accounts: {} }
    this.readable = true
    // Changes that haven't run yet, oldest first (see EXIT_WAIT_MS).
    this.pending = []
    this.timer = undefined
    this.retryMs = RETRY_FIRST_MS
  }

  withLock(fn) {
    if (!this.file) return fn()
    const release = ledgerLock(this.file, this.onChoosing)
    if (!release) return undefined
    // A callback runs exactly once; its error propagates after release.
    try {
      return fn()
    } finally {
      release()
    }
  }

  // update runs fn(d) on a fresh read under the lock and writes d. When the
  // lock or the read fails, fn hasn't run: it is kept, and runs once, after
  // the changes kept before it, the next time this store holds the lock and
  // can read the ledger. A busy peer delays a change; it never loses it.
  update(fn) {
    if (!this.file) {
      const d = this.read()
      const result = fn(d)
      this.write(d)
      return result
    }
    const release = ledgerLock(this.file, this.onChoosing)
    if (!release) {
      this.keep(fn)
      return undefined
    }
    try {
      const d = this.read()
      if (!this.readable) {
        this.keep(fn)
        return undefined
      }
      const kept = this.runPending(d)
      const before = kept ? structuredClone(d) : undefined
      let result
      try {
        result = fn(d)
      } catch (e) {
        // A throwing callback leaves the disk as it was, but not the kept
        // changes that ran before it.
        if (before) this.write(before)
        throw e
      }
      this.write(d)
      return result
    } finally {
      release()
    }
  }

  keep(fn) {
    this.pending.push(fn)
    // An unreadable ledger that never heals must not grow without bound.
    if (this.pending.length > PENDING_MAX) this.pending.shift()
    waitingStores.add(this)
    this.schedule()
  }

  schedule() {
    if (this.timer || this.pending.length === 0) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush(RETRY_WAIT_MS)
    }, this.retryMs)
    this.timer.unref?.()
    this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2)
  }

  runPending(d) {
    const fns = this.pending.splice(0)
    waitingStores.delete(this)
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.retryMs = RETRY_FIRST_MS
    for (const fn of fns) {
      try { fn(d) } catch {} // ran once, as it would have the first time
    }
    return fns.length > 0
  }

  // flush writes the kept changes; it returns false when they're still kept.
  flush(waitMs = LOCK_WAIT_MS) {
    if (this.pending.length === 0) return true
    if (!existsSync(dirname(this.file))) {
      // The config directory is gone: there is no ledger to keep them for.
      this.runPending({ accounts: {} })
      return true
    }
    const release = ledgerLock(this.file, undefined, waitMs)
    if (release) {
      try {
        const d = this.read()
        if (this.readable) {
          this.runPending(d)
          this.write(d)
          return true
        }
      } finally {
        release()
      }
    }
    this.schedule()
    return false
  }

  read() {
    if (!this.file) {
      if (!isObj(this.mem)) this.mem = {}
      if (!isObj(this.mem.accounts)) this.mem.accounts = {}
      this.readable = true
      return this.mem
    }
    try {
      const parsed = JSON.parse(retryFs(() => readFileSync(this.file, "utf8")))
      if (!isObj(parsed)) throw new Error("invalid ledger root")
      if (!isObj(parsed.accounts)) parsed.accounts = {}
      this.mem = parsed
      this.readable = true
      return parsed
    } catch (e) {
      if (e?.code === "ENOENT") {
        const fresh = { accounts: {} }
        this.mem = fresh
        this.readable = true
        return fresh
      }
      // Keep the last good in-memory copy on partial reads, corrupt JSON or
      // permission errors so the next write never wipes the ledger.
      this.readable = false
      if (!isObj(this.mem)) this.mem = {}
      if (!isObj(this.mem.accounts)) this.mem.accounts = {}
      return structuredClone(this.mem)
    }
  }

  write(d) {
    if (!this.file) {
      this.mem = d
      return
    }
    if (!this.readable) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.${++seq}.tmp`
      writeFileSync(tmp, JSON.stringify(d, null, 2))
      retryFs(() => renameSync(tmp, this.file))
      this.mem = d
    } catch {
      // the ledger is an estimate; losing one write must not fail a request
    }
  }

  static account(d, uid, now) {
    const a = isObj(d.accounts[uid]) ? d.accounts[uid] : (d.accounts[uid] = {})
    if (typeof a.spent !== "number") a.spent = 0
    if (!Array.isArray(a.applied)) a.applied = []
    const key = monthKey(now)
    if (!isObj(a.month) || a.month.key !== key) a.month = { key, credits: 0, calls: 0, usd: 0 }
    return a
  }

  change(uid, fn) {
    return this.update((d) => fn(Store.account(d, uid, this.now()), d))
  }

  account(uid) {
    return Store.account(this.read(), uid, this.now())
  }

  // anchor sets the balance read off gumloop.com at time `at`. Each source (a
  // sign-in, an options value) is applied once, so a reload doesn't erase what
  // was spent since. A balance may be applied after calls were made past `at`
  // (magpie reads usage after the first requests), so those still count.
  anchor(uid, balance, source, at = this.now()) {
    const b = Number(balance)
    if (!Number.isFinite(b) || b < 0) return false
    return this.update((d) => {
      const a = Store.account(d, uid, this.now())
      if (a.applied.includes(source)) return false
      a.anchor = { balance: Math.round(b), at }
      a.charges = (a.charges ?? []).filter(([t]) => t > at)
      a.spent = a.charges.reduce((s, [, c]) => s + c, 0)
      // an out-of-credits refusal after the balance was read still stands
      if (!(a.exhaustedAt > at)) delete a.exhaustedAt
      delete a.unbilledStops
      a.applied = [...a.applied, source].slice(-20)
      return true
    })
  }

  // spend counts credits against the balance, remembering when for anchor.
  static spend(a, credits, at) {
    a.spent += credits
    a.charges = [...(a.charges ?? []), [at, credits]]
  }

  remaining(uid) {
    const a = this.account(uid)
    return a.anchor ? Math.max(0, Math.floor(a.anchor.balance - a.spent + 1e-9)) : undefined
  }

  prices() {
    const p = this.read().prices
    return isObj(p) && isObj(p.table) ? p : { at: 0, table: {} }
  }

  setPrices(table, ids = Object.keys(table)) {
    const at = this.now()
    this.update((d) => {
      d.prices = { at, table, ids, version: 2 }
    })
  }

  // price is the live entry for a model, else the built-in one.
  price(model) {
    model = wireModel(model)
    const live = this.prices().table[model]
    if (live?.p) return live
    const fb = FALLBACK_PRICES[model]
    return fb ? { p: fb } : undefined
  }
}
