// Gumloop (gumloop.com) for OpenCode and magpie.
//
// Gumloop serves an OpenAI-compatible chat completions API at
// https://ws.gumloop.com/api/v1. Every request carries the account's API key
// (Authorization: Bearer) and its user id (x-auth-key); both are on Gumloop's
// Settings → Connectors → Gumloop API Key page. GET api.gumloop.com/api/v1/models
// lists the models an account may use.
//
// Gumloop publishes no balance endpoint, so this plugin prices each call
// itself (OpenRouter's list prices, $0.005 a credit, every call rounded up to a
// whole credit) and takes it off a balance the user reads off gumloop.com.
// Spend on gumloop.com itself shows only at the next calibration.

import { join } from "node:path"
import {
  API as DEFAULT_API,
  WS as DEFAULT_WS,
  OPENROUTER as DEFAULT_OPENROUTER,
  EXHAUSTED_FOR,
  FALLBACK_PRICES,
  PRICES_RETRY_TTL,
  PRICES_TTL,
  Store,
  availableModel,
  creditsFor,
  fetchPrices,
  gumloopHeaders,
  isObj,
  parseModels,
  usageCost,
  wireModel,
} from "./gumloop.mjs"

const ID = "gumloop"
const NPM = "@ai-sdk/openai-compatible"
const EFFORTS = Object.fromEntries(["low", "medium", "high"].map((e) => [e, { reasoningEffort: e }]))

function isCreditRefusal(status, text) {
  if (status === 402) return true
  if (status !== 403) return false
  try {
    const d = JSON.parse(text)
    const code = d?.error?.code ?? d?.error?.type ?? d?.code ?? (typeof d?.error === "string" ? d.error : "")
    if (code === "credit_limit_exceeded") return true
  } catch {}
  return false
}

// aliasesFor gives every Gumloop id a slash-free name agents can type
// (gumloop/glm-5p3 for accounts/fireworks/models/glm-5p3): the last path part
// when no other id shares it, else the id with its slashes doubled into dashes.
function aliasesFor(ids) {
  const tail = (id) => id.slice(id.lastIndexOf("/") + 1)
  const count = new Map()
  for (const id of ids) count.set(tail(id), (count.get(tail(id)) ?? 0) + 1)
  return new Map(ids.map((id) => [id, count.get(tail(id)) === 1 ? tail(id) : id.replace(/\//g, "--")]))
}

const pretty = (id) => id.slice(id.lastIndexOf("/") + 1).replace(/[-_]+/g, " ").trim()

// costOf turns a price entry into the per-million rates magpie shows.
function costOf(entry) {
  if (!entry?.p) return undefined
  const [input, output, cache_read, cache_write] = entry.p
  return {
    input,
    output,
    ...(cache_read != null && { cache_read }),
    ...(cache_write != null && { cache_write }),
  }
}

// row is one model in both the config hook's shape (top-level fields) and the
// models hook's (capabilities).
function row(m, alias, entry) {
  const image = !!m.vision
  const cost = costOf(entry)
  return {
    id: alias,
    name: m.name,
    limit: { context: m.context || 0, output: 0 },
    reasoning: !!m.reasoning,
    tool_call: true,
    modalities: { input: image ? ["text", "image"] : ["text"], output: ["text"] },
    capabilities: {
      reasoning: !!m.reasoning,
      toolcall: true,
      attachment: image,
      input: { text: true, image },
      output: { text: true },
    },
    ...(m.reasoning ? { variants: EFFORTS } : {}),
    ...(cost ? { cost } : {}),
  }
}

// normalize rewrites a chat completions body the way Gumloop takes it.
function normalize(body, { cache1h } = {}) {
  // These upstream routes reject the empty system prompt Gumloop otherwise
  // supplies. Preserve every nonempty caller instruction (system or developer).
  if (/^(meta\/muse-|minimax\/minimax-m3\.1-flash$)/.test(String(body.model)) && Array.isArray(body.messages)) {
    const isSystem = (role) => role === "system" || role === "developer"
    const nonempty = (content) =>
      typeof content === "string"
        ? !!content.trim()
        : Array.isArray(content) && content.some((p) => typeof p?.text === "string" && p.text.trim())
    body.messages = body.messages.filter((m) => !isSystem(m.role) || nonempty(m.content))
    if (!body.messages.some((m) => isSystem(m.role))) {
      body.messages.unshift({ role: "system", content: "You are a helpful assistant." })
    }
  }
  if (body.stream === true) body.stream_options = { ...(isObj(body.stream_options) ? body.stream_options : {}), include_usage: true }
  else delete body.stream_options
  if (body.max_completion_tokens !== undefined) {
    if (body.max_tokens === undefined) body.max_tokens = body.max_completion_tokens
    delete body.max_completion_tokens
  }
  delete body.store
  if (typeof body.reasoning_effort === "string") {
    if (!isObj(body.reasoning)) body.reasoning = { effort: body.reasoning_effort }
    delete body.reasoning_effort
  }
  // Optional 1-hour Anthropic prompt cache TTL (opt-in via options.cache1h).
  if (cache1h && /^claude-/.test(String(body.model)) && body.cache_control === undefined) {
    body.cache_control = { type: "ephemeral", ttl: "1h" }
  }
  return body
}

// tapUsage passes a response body through unchanged and reports the usage
// block it carried (SSE or JSON) once it ends, or that it was cut short.
// Hold terminal SSE frames (and bounded JSON bodies) until accounting finishes:
// short-lived hosts can terminate us as soon as they see a complete response.
function tapUsage(stream, isSse, signal, done) {
  const dec = new TextDecoder()
  let buf = ""
  let usage
  let tooBig = false
  let finished = false
  let terminal = false
  let pending = []
  // SSE offsets are bytes, not decoded string offsets: retain only the
  // incomplete line or terminal tail, and forward original bytes unchanged.
  const sseBuffer = isSse ? new Uint8Array(256 * 1024) : undefined
  let sseSize = 0
  let lineStart = 0
  const emit = (ctl) => {
    for (const chunk of pending) ctl.enqueue(chunk)
    pending = []
  }
  const aborted = () => finish(true)
  const finish = (cut) => {
    if (finished) return
    finished = true
    signal?.removeEventListener("abort", aborted)
    done(usage, cut || (tooBig && !usage))
  }
  const take = (o) => {
    if (isObj(o?.usage)) usage = o.usage
    if (isSse && (isObj(o?.usage) || o?.choices?.some((c) => c.finish_reason != null))) terminal = true
  }
  const line = (l) => {
    const t = l.trim()
    if (!t.startsWith("data:")) return
    const d = t.slice(5).trim()
    if (d === "[DONE]") {
      terminal = true
      // The protocol is complete even if the connection remains open. Do
      // accounting before releasing any bytes from this parsed chunk.
      finish(false)
      return
    }
    if (!d.includes('"usage"') && !d.includes('"finish_reason"')) return
    try {
      take(JSON.parse(d))
    } catch {}
  }
  const sseChunk = (chunk, ctl) => {
    let offset = 0
    while (offset < chunk.byteLength) {
      if (tooBig || sseSize === sseBuffer.length) {
        // A malformed/oversized line or terminal tail must not drain an
        // unbounded source. Record the incomplete estimate before releasing
        // any held terminal bytes, then use ordinary stream backpressure.
        if (!tooBig) {
          tooBig = true
          usage = undefined
          finish(true)
          ctl.enqueue(sseBuffer.slice(0, sseSize))
          sseSize = lineStart = 0
        }
        ctl.enqueue(chunk.subarray(offset))
        return
      }
      const end = Math.min(chunk.byteLength, offset + sseBuffer.length - sseSize)
      const scanFrom = sseSize
      sseBuffer.set(chunk.subarray(offset, end), sseSize)
      sseSize += end - offset
      offset = end
      let safe = 0
      for (let i = scanFrom; i < sseSize; i++) {
        if (sseBuffer[i] !== 10) continue
        line(dec.decode(sseBuffer.subarray(lineStart, i + 1)))
        lineStart = i + 1
        if (!terminal || finished) safe = lineStart
      }
      if (safe) {
        ctl.enqueue(sseBuffer.slice(0, safe))
        sseBuffer.copyWithin(0, safe, sseSize)
        sseSize -= safe
        lineStart -= safe
      }
    }
  }
  signal?.addEventListener("abort", aborted, { once: true })
  if (signal?.aborted) aborted()
  const tap = new TransformStream({
      transform(chunk, ctl) {
        if (isSse) return sseChunk(chunk, ctl)
        pending.push(chunk)
        const s = dec.decode(chunk, { stream: true })
        if (!tooBig) {
          buf += s
          if (buf.length > 4e6) {
            tooBig = true
            buf = ""
          }
        }
        // Oversized JSON keeps the existing pass-through/unbilled behavior.
        if (tooBig) emit(ctl)
      },
      flush(ctl) {
        if (isSse) {
          if (sseSize > lineStart) line(dec.decode(sseBuffer.subarray(lineStart, sseSize)))
        } else {
          buf += dec.decode()
          try {
            take(JSON.parse(buf))
          } catch {}
        }
        buf = ""
        finish(false)
        if (isSse) {
          if (sseSize) ctl.enqueue(sseBuffer.slice(0, sseSize))
          sseSize = lineStart = 0
        } else emit(ctl)
      },
    })
  // Unlike pipeThrough, observing pipeTo also catches source failures and
  // consumer cancellation. The readable still propagates the original error.
  stream.pipeTo(tap.writable).catch(() => finish(true))
  return tap.readable
}

const errorJson = (status, message, type, headers = {}) =>
  new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

// lookup reads a per-account option: a number for every account, or an
// object keyed by user id or email.
function lookup(opt, who) {
  if (typeof opt === "number") return opt
  if (!isObj(opt)) return undefined
  for (const k of who) if (k && opt[k] !== undefined) return opt[k]
  return undefined
}

// creditsOf reads a balance as gumloop.com shows it ("7,142", "7 142.5"):
// a whole number of credits, or undefined for anything else.
function creditsOf(v) {
  const s = String(v ?? "").trim().replace(/[,\s_]/g, "")
  return /^\d+(\.\d+)?$/.test(s) ? Math.floor(Number(s)) : undefined
}

function createPlugin({ directory, magpie, options = {}, fetchImpl = globalThis.fetch, now = Date.now, env = process.env } = {}) {
  const API = env.GUMLOOP_API_BASE || DEFAULT_API
  const WS = env.GUMLOOP_WS_BASE || DEFAULT_WS
  const OPENROUTER = env.GUMLOOP_OPENROUTER_BASE || DEFAULT_OPENROUTER
  // In magpie, `directory` is magpie's config dir (`input.magpie` is present).
  // In OpenCode, `directory` is the user's project tree and must not be written to.
  const ledgerPath = magpie && directory ? join(directory, "gumloop-ledger.json") : undefined
  const store = new Store(ledgerPath, now)
  const cache1h = options.cache1h === true
  // alias -> Gumloop id: built-in defaults plus one map per account.
  const defaultIds = new Map()
  const knownIds = new Set(Object.keys(FALLBACK_PRICES))
  for (const [id, alias] of aliasesFor(Object.keys(FALLBACK_PRICES))) defaultIds.set(alias, id)
  const accountIds = new Map()
  const maxOut = new Map()
  let pricing
  let pricesFailedAt = 0

  const credOf = (auth) => {
    if (auth?.type !== "api" || !auth.key) return undefined
    const userId = typeof auth.metadata?.userId === "string" ? auth.metadata.userId : ""
    return userId ? { key: auth.key, userId, email: auth.metadata?.email } : undefined
  }

  const getModels = (cred) =>
    fetchImpl(`${API}/models`, {
      headers: { ...gumloopHeaders(cred.key, cred.userId), accept: "application/json" },
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    })

  // refreshPrices re-reads OpenRouter's list at most every PRICES_TTL; a
  // failure backs off for PRICES_RETRY_TTL and keeps the existing table.
  function refreshPrices() {
    const ids = [...knownIds]
    const cached = store.prices()
    if (cached.version === 2 && now() - cached.at < PRICES_TTL && ids.every((id) => cached.ids?.includes(id))) return Promise.resolve()
    if (pricesFailedAt && now() - pricesFailedAt < PRICES_RETRY_TTL) return Promise.resolve()
    pricing ??= (async () => {
      const table = await fetchPrices((u, i) => fetchImpl(u.replace(DEFAULT_OPENROUTER, OPENROUTER), i), ids)
      pricesFailedAt = 0
      store.setPrices(table, ids)
    })()
      .catch(() => {
        pricesFailedAt = now()
      })
      .finally(() => {
        pricing = undefined
      })
    return pricing
  }

  // calibrate applies a balance given at sign-in, or in the plugin's
  // options, once per value.
  function calibrate(cred, auth) {
    const md = auth.metadata ?? {}
    if (md.balance !== undefined && md.balanceAt) store.anchor(cred.userId, md.balance, `login:${md.balanceAt}`, Number(md.balanceAt))
    const opt = lookup(options.balance, [cred.userId, cred.email])
    if (opt !== undefined) store.anchor(cred.userId, opt, `options:${opt}`)
  }

  function charge(uid, model, usage, cut) {
    store.change(uid, (a) => {
      if (!usage) {
        // Gumloop bills the tokens a stopped stream produced, but its usage
        // block never came: tell the user the estimate is off.
        if (cut) a.unbilledStops = (a.unbilledStops ?? 0) + 1
        return
      }
      const entry = store.price(model)
      const rec = { at: now(), model }
      if (entry) {
        const c = usageCost(entry, usage)
        rec.credits = creditsFor(c.usd)
        Object.assign(rec, { in: c.prompt, out: c.out, cacheRead: c.read, cacheWrite: c.write })
        Store.spend(a, rec.credits, rec.at)
        a.month.credits += rec.credits
        a.month.usd = Math.round((a.month.usd + c.usd) * 1e6) / 1e6
      } else {
        rec.unpriced = true
        a.unpriced = (a.unpriced ?? 0) + 1
      }
      a.month.calls += 1
      a.last = rec
      delete a.exhaustedAt
    })
  }

  async function send(cred, url, init, body, signal) {
    const headers = new Headers(init?.headers)
    for (const [k, v] of Object.entries(gumloopHeaders(cred.key, cred.userId))) headers.set(k, v)
    headers.set("content-type", "application/json")
    headers.delete("content-length")
    return fetchImpl(url, { ...init, headers, body: JSON.stringify(body), signal })
  }

  async function request(cred, input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const raw = init?.body
    let body
    try {
      const text = typeof raw === "string" ? raw : raw instanceof Uint8Array || raw instanceof ArrayBuffer ? new TextDecoder().decode(raw) : undefined
      body = text === undefined ? undefined : JSON.parse(text)
    } catch {}
    if (!isObj(body)) {
      const headers = new Headers(init?.headers)
      for (const [k, v] of Object.entries(gumloopHeaders(cred.key, cred.userId))) headers.set(k, v)
      return fetchImpl(url, { ...init, headers })
    }
    const perAccount = accountIds.get(cred.userId)
    const model = wireModel(perAccount?.get(body.model) ?? defaultIds.get(body.model) ?? body.model)
    body.model = model
    const streamRequested = body.stream === true
    normalize(body, { cache1h })
    const cap = maxOut.get(model)
    if (cap && typeof body.max_tokens === "number" && body.max_tokens > cap) body.max_tokens = cap

    let res = await send(cred, url, init, body, init?.signal)
    // A model with a lower output cap refuses a generous max_tokens
    // ("max_tokens: 256000 > 128000"): learn the cap and ask once more.
    if (res.status === 400 && typeof body.max_tokens === "number") {
      const m = /max_tokens:?\s*(\d+)\s*>\s*(\d+)/.exec(await res.clone().text().catch(() => ""))
      const limit = m ? Number(m[2]) : 0
      if (limit > 0 && limit < body.max_tokens) {
        maxOut.set(model, limit)
        body.max_tokens = limit
        await res.body?.cancel().catch(() => {})
        res = await send(cred, url, init, body, init?.signal)
      }
    }

    if (!res.ok) {
      const text = await res.clone().text().catch(() => "")
      if (isCreditRefusal(res.status, text)) {
        store.change(cred.userId, (a) => {
          a.exhaustedAt = now()
        })
        await res.body?.cancel().catch(() => {})
        // 429 so magpie moves the request to the next account; the sign-in is fine.
        return errorJson(
          429,
          `Gumloop: out of credits (from HTTP ${res.status}: ${text.slice(0, 300) || res.statusText || "credit_limit_exceeded"})`,
          "insufficient_quota",
          { "x-magpie-sign-in": "kept" },
        )
      }
      if (res.status === 403) {
        // A provider's "Invalid API key" can refer to Gumloop's upstream
        // credentials. Only Gumloop's own /models check decides our sign-in.
        let signIn
        try {
          const check = await getModels(cred)
          await check.body?.cancel().catch(() => {})
          if (check.status === 200) signIn = "kept"
          else if (check.status === 401 || check.status === 403) signIn = "expired"
        } catch {}
        if (signIn) {
          const headers = new Headers(res.headers)
          headers.set("x-magpie-sign-in", signIn)
          return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
        }
      }
      return res
    }

    if (!res.body) return res
    const ct = res.headers.get("content-type") ?? ""
    const headers = new Headers(res.headers)
    headers.delete("content-length")
    headers.delete("content-encoding")
    const tapped = tapUsage(res.body, ct.includes("text/event-stream") || streamRequested, init?.signal, (usage, cut) => {
      try {
        charge(cred.userId, model, usage, cut)
      } catch {}
    })
    return new Response(tapped, { status: res.status, statusText: res.statusText, headers })
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const ids = Object.keys(FALLBACK_PRICES).filter(availableModel)
      const aliases = aliasesFor(ids)
      cfg.provider[ID] ??= {
        name: "Gumloop",
        npm: NPM, // chat completions
        api: WS,
        models: Object.fromEntries(
          ids.map((id) => {
            const alias = aliases.get(id)
            const m = { id, name: pretty(id), reasoning: /^claude-(opus|fable)/.test(id) }
            return [alias, row(m, alias, { p: FALLBACK_PRICES[id] })]
          }),
        ),
      }
    },

    auth: {
      provider: ID,
      methods: [
        {
          type: "api",
          label: "Gumloop API key",
          // magpie asks for an API method's key itself and doesn't hand it to
          // authorize; keyless has it skip that, so the key prompt below is
          // the only one and authorize can check it with the user id.
          keyless: true,
          prompts: [
            {
              type: "password",
              key: "key",
              message: "API key (Gumloop → Settings → Connectors → Gumloop API Key)",
              validate: (v) => (/^[A-Za-z0-9_-]{16,128}$/.test(String(v ?? "").trim()) ? undefined : "That doesn't look like a Gumloop API key"),
            },
            {
              type: "text",
              key: "userId",
              message: "User ID (on the same page)",
              validate: (v) => (/^[A-Za-z0-9_-]{8,128}$/.test(String(v ?? "").trim()) ? undefined : "That doesn't look like a Gumloop user id"),
            },
            {
              type: "text",
              key: "email",
              required: false,
              message: "Account email (optional; names the account in magpie)",
            },
            {
              type: "text",
              key: "balance",
              required: false,
              message: "Credits left, as gumloop.com shows them (optional; starts the estimate)",
              validate: (v) => (!String(v ?? "").trim() || creditsOf(v) !== undefined ? undefined : "A number of credits, such as 7142"),
            },
          ],
          async authorize(inputs) {
            const key = String(inputs?.key ?? "").trim()
            const userId = String(inputs?.userId ?? "").trim()
            const email = String(inputs?.email ?? "").trim()
            const balance = creditsOf(inputs?.balance)
            if (!key || !userId) return { type: "failed", error: "Gumloop needs both the API key and the user id" }
            let res
            try {
              res = await getModels({ key, userId })
            } catch (e) {
              return { type: "failed", error: `Gumloop unreachable: ${e?.cause?.code || e?.message || "network error"}` }
            }
            if (res.status === 401 || res.status === 403) {
              return { type: "failed", error: `Gumloop refused the API key or user id (HTTP ${res.status})` }
            }
            if (!res.ok) return { type: "failed", error: `Gumloop answered HTTP ${res.status}` }
            // magpie keeps the prompts' answers as the account's metadata, the
            // key among them; key: undefined drops it there (it is kept once, as
            // the account's key).
            const metadata = { key: undefined, userId, ...(email && { email }), ...(balance !== undefined && { balance, balanceAt: now() }) }
            return { type: "success", key, metadata }
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth()
        const cred = credOf(auth)
        if (!cred) return {}
        calibrate(cred, auth)
        return {
          baseURL: WS,
          apiKey: cred.key,
          headers: { "x-auth-key": cred.userId },
          fetch: (input, init) => request(cred, input, init),
        }
      },

      async usage(getAuth) {
        const auth = await getAuth()
        const cred = credOf(auth)
        if (!cred) return {}
        calibrate(cred, auth)
        let res
        try {
          res = await getModels(cred)
        } catch (e) {
          return { error: `Gumloop unreachable: ${e?.cause?.code || e?.message || "network error"}`, windows: [] }
        }
        await res.body?.cancel().catch(() => {})
        if (res.status === 401 || res.status === 403) {
          return { error: `Gumloop refused this key (HTTP ${res.status}); sign in again`, signIn: "expired", windows: [] }
        }
        await refreshPrices()

        const a = store.account(cred.userId)
        const exhausted = a.exhaustedAt && now() - a.exhaustedAt < EXHAUSTED_FOR
        const est = store.remaining(cred.userId)
        const left = exhausted ? 0 : est
        const allowance = Number(lookup(options.allowance, [cred.userId, cred.email])) || 0
        const windows = []
        if (left === undefined) {
          windows.push({ name: "Credits", display: "Not calibrated: sign in again with the credits gumloop.com shows" })
        } else if (allowance > 0) {
          windows.push({
            name: "Credits",
            amount: Math.max(0, allowance - left),
            limit: allowance,
            unit: "credits",
            display: `${left} / ${allowance} credits left (estimate)`,
          })
        } else {
          windows.push({ name: "Credits", balance: left, unit: "credits", display: `${left} credits left (estimate)` })
        }
        const notes = [
          `${a.month.credits} credits · ${a.month.calls} calls`,
          a.unbilledStops ? `${a.unbilledStops} stopped without usage` : "",
          a.unpriced ? `${a.unpriced} unpriced` : "",
        ].filter(Boolean)
        windows.push({ name: "This month via magpie", amount: a.month.credits, unit: "credits", display: notes.join(" · "), aside: true })
        return {
          plan: "Gumloop",
          user: cred.email || `user …${cred.userId.slice(-4)}`,
          ...(left !== undefined && { balance: `${left} credits` }),
          ...(!res.ok && { error: `Gumloop answered HTTP ${res.status}` }),
          windows,
        }
      },
    },

    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const cred = credOf(auth)
        if (!cred) return provider.models
        let res
        try {
          res = await getModels(cred)
        } catch {
          return provider.models
        }
        if (res.status === 401 || res.status === 403) {
          throw Object.assign(new Error(`Gumloop refused this key (HTTP ${res.status}); sign in again`), { signIn: "expired" })
        }
        if (!res.ok) return provider.models
        let list
        try {
          list = parseModels(await res.json())
        } catch (e) {
          // the host keeps the previous list
          throw new Error(e?.message || "Gumloop sent no model list")
        }
        const aliases = aliasesFor(list.map((m) => m.id))
        const acctMap = new Map()
        for (const [id, alias] of aliases) {
          const wire = wireModel(id)
          acctMap.set(alias, wire)
          knownIds.add(wire)
        }
        accountIds.set(cred.userId, acctMap)
        await refreshPrices()
        return Object.fromEntries(list.map((m) => [aliases.get(m.id), row(m, aliases.get(m.id), store.price(m.id))]))
      },
    },
  }
}

// The plugin is the only exported function; magpie calls every exported
// function as a plugin, so tests reach the internals through this object.
export const GumloopPlugin = async (input, options) =>
  createPlugin({ directory: input?.directory, magpie: input?.magpie, options: options ?? {} })
export const _internal = { createPlugin, aliasesFor, normalize, tapUsage, row, costOf, lookup, isCreditRefusal }
