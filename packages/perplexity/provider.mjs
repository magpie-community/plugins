// The magpie / OpenCode provider plugin for Perplexity Pro & Max.
//
// Everything is plain fetch: no Python, no native modules, no sidecar process.
// A request is translated to Perplexity's web SSE endpoint and translated back
// into OpenAI chat-completions (streaming or not).

import { PROVIDER, modelCatalog, thinkingPref, tierOf } from "./models.mjs"
import {
  readSession, readQuota, buildQuery, payloadFor, startAsk, upstreamDetail,
  sseEvents, answerDelta, chunkObj, completionObj, usageChunk, sse, chatId, rotatedCookie,
  systemTimeZone,
} from "./pplx.mjs"
import { browserSignIn } from "./login.mjs"
import { fill, resolveLocale, strings } from "./i18n.mjs"

const THREAD_TTL = 30 * 60 * 1000
const THREAD_MAX = 500
// "account|session" -> { uuid, at }: a thread belongs to one account, and must
// not be handed to another after a failover.
const threads = new Map()

function threadKey(auth, sessionId) {
  const who = auth?.accountId || auth?.metadata?.email || "default"
  return `${who}|${sessionId}`
}

function rememberThread(key, uuid, at = Date.now()) {
  threads.set(key, { uuid, at })
  if (threads.size <= THREAD_MAX) return
  for (const [k, v] of threads) {
    if (at - v.at >= THREAD_TTL) threads.delete(k)
  }
  for (const k of threads.keys()) {
    if (threads.size <= THREAD_MAX) break
    threads.delete(k)
  }
}

/** A stable uuid per account, so the same visitor id is sent every request. */
function stableUuid(seed) {
  let h = 0x811c9dc5
  const src = String(seed || "perplexity")
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  let h2 = 0xc2b2ae35
  for (let i = src.length - 1; i >= 0; i--) {
    h2 ^= src.charCodeAt(i)
    h2 = Math.imul(h2, 0x01000193) >>> 0
  }
  const hex = (n) => n.toString(16).padStart(8, "0")
  return `${hex(h)}-${hex(h2).slice(0, 4)}-4${hex(h2).slice(4, 7)}-8${hex(h).slice(0, 3)}-${hex(h)}${hex(h2).slice(0, 4)}`
}

/** What the payload says about the account, instead of a random pair. */
function identityFor(auth) {
  const meta = auth?.metadata || {}
  const seed = auth?.accountId || meta.email || "perplexity"
  return {
    userId: meta.userId || stableUuid("user:" + seed),
    visitorId: meta.visitorId || stableUuid("visitor:" + seed),
    ua: typeof meta.ua === "string" ? meta.ua : "",
  }
}

function expired(t) {
  return Object.assign(new Error(t.sessionExpired), { signIn: "expired" })
}

function errResponse(status, message, type = "upstream_error", code = type) {
  return new Response(JSON.stringify({ error: { message, type, code } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

function readBody(init) {
  const raw = init?.body
  if (typeof raw === "string") {
    try { return JSON.parse(raw) } catch { return {} }
  }
  if (raw instanceof Uint8Array) {
    try { return JSON.parse(new TextDecoder().decode(raw)) } catch { return {} }
  }
  return {}
}

/**
 * Tools asked for but impossible to serve: Perplexity's web endpoint has none.
 * `tool_choice` alone is not evidence — clients send "auto" with no tools at all.
 */
function asksForTools(body) {
  if (Array.isArray(body?.tools) && body.tools.length) return true
  if (Array.isArray(body?.functions) && body.functions.length) return true
  return false
}


/** Why a session check failed, in the user's language. */
function authFailureMessage(t, info) {
  if (info.code === "cookie_invalid") return t.cookieInvalid
  if (info.code === "not_signed_in") return t.notSignedIn
  if (info.code === "http") return fill(t.upstreamHttp, { status: info.status, detail: info.detail || "" })
  return t.cookieInvalid
}

/** Why browser sign-in failed, in the user's language. */
function loginFailureMessage(t, e) {
  switch (e?.code) {
    case "chrome_missing": return t.loginChromeMissing
    case "debug_port": return t.loginDebugPort
    case "devtools": return t.loginDevtools
    case "cancelled": return t.loginCancelled
    case "timeout": return t.loginTimeout
    case "profile_cleanup": return fill(t.loginProfileCleanup, { detail: e?.detail || e?.message || e })
    default: return String(e?.message || e)
  }
}

export const server = async (input, options) => {
  const opt = {
    tier: "pro",
    keepSystem: false,
    chromePath: "",
    apiVersion: "2.18",
    locale: "auto",
    tools: "reject",
    ...(options || {}),
  }
  const t = strings(resolveLocale(opt.locale))
  const client = input?.client

  const persist = async (auth, cookie) => {
    if (!cookie || cookie === auth.key || !client?.auth?.set) return
    try {
      await client.auth.set({
        path: { id: PROVIDER },
        body: { type: "api", key: cookie, metadata: auth.metadata },
      })
    } catch { /* the old token still works until it doesn't */ }
  }

  /** Perplexity's own words for a rejection, so a 403 is not always "expired". */
  async function rejection(up, status, key) {
    const body = await up.text().catch(() => "")
    return fill(t[key], { status, detail: upstreamDetail(body) || t.notSignedIn })
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "Perplexity Pro",
        npm: "@ai-sdk/openai-compatible",
        api: "https://www.perplexity.ai",
        models: modelCatalog(opt.tier),
      }
    },

    provider: {
      id: PROVIDER,
      async models(provider, ctx) {
        const auth = ctx?.auth
        if (!auth?.key) return provider.models
        const info = await readSession(auth.key, undefined, auth.metadata?.ua)
        if (!info.ok) {
          if (info.code === "cookie_invalid") throw expired(t)
          return provider.models
        }
        if (info.cookie) await persist(auth, info.cookie)
        const wanted = modelCatalog(opt.tier)
        return Object.fromEntries(
          Object.keys(wanted).map((id) => [id, { ...(provider.models[id] || {}), ...wanted[id] }])
        )
      },
    },

    auth: {
      provider: PROVIDER,
      maxConcurrency: 2,
      methods: [
        {
          type: "api",
          label: t.methodCookieLabel,
          placeholder: "__Secure-next-auth.session-token=… 或只贴值 / or just the value",
          prompts: [
            {
              type: "password",
              key: "cookie",
              message: t.cookieMessage,
              placeholder: t.cookiePlaceholder,
              validate: (v) => (v && v.trim().length > 40 ? undefined : t.cookieTooShort),
            },
          ],
          async authorize(inputs, ctx) {
            const raw = String(inputs?.cookie || "").trim()
            const m = raw.match(/__Secure-next-auth\.session-token=([^;]+)/)
            const key = (m ? m[1] : raw).trim()
            const info = await readSession(key, ctx?.signal, opt.ua)
            if (!info.ok) {
              return { type: "failed", error: authFailureMessage(t, info) }
            }
            return {
              type: "success",
              key: info.cookie || key,
              metadata: {
                email: info.email,
                tier: info.tier || opt.tier,
                userId: info.userId,
                visitorId: crypto.randomUUID(),
              },
              accountId: info.email,
            }
          },
        },
        {
          type: "oauth",
          label: t.methodBrowserLabel,
          async authorize(_inputs, ctx) {
            const handle = await browserSignIn({
              chromePath: opt.chromePath,
              signal: ctx?.signal,
              locale: t.locale,
            })
            return {
              url: handle.url,
              instructions: t.browserInstructions,
              method: "auto",
              async callback(_code, cbCtx) {
                try {
                  const r = await handle.wait(cbCtx?.signal)
                  const info = await readSession(r.cookie, cbCtx?.signal, r.ua)
                  if (!info.ok) return { type: "failed", error: authFailureMessage(t, info) }
                  return {
                    type: "success",
                    key: info.cookie || r.cookie,
                    metadata: {
                      email: info.email,
                      tier: info.tier || opt.tier,
                      userId: info.userId,
                      visitorId: crypto.randomUUID(),
                      ua: r.ua,
                    },
                    accountId: info.email,
                  }
                } catch (e) {
                  return { type: "failed", error: loginFailureMessage(t, e) }
                } finally {
                  try {
                    await handle.close()
                  } catch (e) {
                    // A profile left behind can still hold the session cookie,
                    // so this is reported rather than swallowed.
                    client?.app?.log?.({
                      body: { service: "perplexity", level: "warn", message: loginFailureMessage(t, e) },
                    })?.catch?.(() => {})
                  }
                }
              },
            }
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth?.key) return {}
        return {
          baseURL: "https://www.perplexity.ai",
          headers: { "x-pplx-hook": "1" },
          async fetch(requestUrl, init) {
            const body = readBody(init)
            // A host that sends tools cannot be served by this endpoint. Either
            // say so (reject) or answer as text and mark the response (ignore).
            const stripTools = asksForTools(body)
            if (stripTools && opt.tools !== "ignore") {
              return errResponse(400, t.toolsUnsupported, "invalid_request", "tools_unsupported")
            }
            const extraHeaders = stripTools ? { "x-magpie-tools-ignored": "1" } : {}

            let model = String(body.model || "pplx_pro")
            if (body.reasoning_effort || body.thinking || body.reasoning) {
              model = thinkingPref(model) || model
            }
            const sessionId = new Headers(init?.headers).get("x-pplx-session-id") || ""
            const scoped = sessionId ? threadKey(auth, sessionId) : ""
            let backendUuid = null
            if (scoped) {
              const rec = threads.get(scoped)
              if (rec && Date.now() - rec.at < THREAD_TTL) backendUuid = rec.uuid
              else if (rec) threads.delete(scoped)
            }

            const identity = identityFor(auth)
            const { query, follow } = buildQuery(body.messages, opt.keepSystem, backendUuid)
            const payload = payloadFor(query, model, follow, opt.apiVersion, systemTimeZone(), identity)

            let up
            try {
              up = await startAsk(auth.key, payload, init?.signal, identity.ua)
            } catch (e) {
              return errResponse(502, fill(t.upstreamNetwork, { detail: e?.message || e }), "upstream_error", "network")
            }

            // 401/403/429 carry Perplexity's own reason: a 403 is not always an
            // expired cookie, and a 429 says which limit was hit.
            if (up.status === 401 || up.status === 403) {
              return errResponse(
                up.status,
                await rejection(up, up.status, "cookieRejected"),
                up.status === 401 ? "session_expired" : "forbidden",
                up.status === 401 ? "session_expired" : "forbidden",
              )
            }
            if (up.status === 429) {
              return errResponse(
                429,
                await rejection(up, up.status, "rateLimited"),
                "rate_limited",
                "rate_limited",
              )
            }
            if (!up.ok) {
              const detail = upstreamDetail(await up.text().catch(() => ""))
              return errResponse(
                up.status,
                fill(t.upstreamHttp, { status: up.status, detail }),
                "upstream_error",
                "upstream_http",
              )
            }

            const rotated = rotatedCookie(up)
            if (rotated) await persist(auth, rotated)

            const state = { full: "", cleaned: "", thinkingSeen: new Set(), answerUsage: null }
            const cid = chatId()
            const wantsStream = body.stream === true
            const wantUsage = body.stream_options?.include_usage === true
            // Cancelling the client must cancel the upstream read as well.
            const upstreamAbort = new AbortController()

            const noteThread = (chunk) => {
              if (chunk?.backend_uuid && scoped) rememberThread(scoped, chunk.backend_uuid)
            }
            const upstreamError = (chunk) => {
              const detail = typeof chunk.error === "string" ? chunk.error : JSON.stringify(chunk.error)
              return new Error(detail.slice(0, 300))
            }

            if (!wantsStream) {
              let text = ""
              try {
                for await (const { event, data } of sseEvents(up.body, upstreamAbort.signal)) {
                  if (event === "end_of_stream") break
                  if (event !== "message") continue
                  let chunk
                  try { chunk = JSON.parse(data) } catch { continue }
                  // A mid-answer error still ran up a bill: report it as one.
                  if (chunk?.error) throw upstreamError(chunk)
                  noteThread(chunk)
                  const r = answerDelta(chunk, state)
                  if (r.delta) text += r.delta
                }
              } catch (e) {
                return errResponse(502, fill(t.upstreamMidStream, { detail: e?.message || e }), "upstream_error", "midstream_error")
              }
              if (!text.trim()) text = state.cleaned
              if (!text.trim()) return errResponse(502, t.upstreamEmpty, "upstream_error", "empty_answer")
              // Said in the answer itself, not in a header nothing reads.
              if (stripTools) text = t.toolsIgnoredNotice + "\n\n" + text
              return new Response(JSON.stringify(completionObj(cid, model, text, query)), {
                status: 200,
                headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
              })
            }

            // Read up to the first piece of answer before answering 200: an
            // error there is a failed request, not an event inside a stream.
            const queued = []
            let iterator
            let ended = false
            try {
              iterator = sseEvents(up.body, upstreamAbort.signal)[Symbol.asyncIterator]()
              for (;;) {
                const step = await iterator.next()
                if (step.done) { ended = true; break }
                const { event, data } = step.value
                if (event === "end_of_stream") { ended = true; break }
                if (event !== "message") continue
                let chunk
                try { chunk = JSON.parse(data) } catch { continue }
                if (chunk?.error) throw upstreamError(chunk)
                noteThread(chunk)
                const r = answerDelta(chunk, state)
                if (r.thinking) queued.push(chunkObj(cid, model, "", { reasoning: r.thinking }))
                if (r.delta) queued.push(chunkObj(cid, model, r.delta))
                if (queued.some((c) => c.choices?.[0]?.delta?.content)) break
              }
            } catch (e) {
              return errResponse(502, fill(t.upstreamMidStream, { detail: e?.message || e }), "upstream_error", "midstream_error")
            }
            if (ended && !queued.some((c) => c.choices?.[0]?.delta?.content)) {
              return errResponse(502, t.upstreamEmpty, "upstream_error", "empty_answer")
            }

            const enc = new TextEncoder()
            const stream = new ReadableStream({
              async start(controller) {
                const push = (o) => controller.enqueue(enc.encode(sse(o)))
                try {
                  if (stripTools) push(chunkObj(cid, model, t.toolsIgnoredNotice + "\n\n"))
                  for (const o of queued) push(o)
                  for (;;) {
                    const step = await iterator.next()
                    if (step.done) break
                    const { event, data } = step.value
                    if (event === "end_of_stream") break
                    if (event !== "message") continue
                    let chunk
                    try { chunk = JSON.parse(data) } catch { continue }
                    if (chunk?.error) throw upstreamError(chunk)
                    noteThread(chunk)
                    const r = answerDelta(chunk, state)
                    if (r.thinking) push(chunkObj(cid, model, "", { reasoning: r.thinking }))
                    if (r.delta) push(chunkObj(cid, model, r.delta))
                  }
                  if (wantUsage) push(usageChunk(cid, model, state.cleaned, query))
                  push(chunkObj(cid, model, "", { finish: "stop" }))
                  controller.enqueue(enc.encode("data: [DONE]\n\n"))
                } catch (e) {
                  // Past the first byte there is no status left to change; the
                  // error is labelled as such rather than dropped.
                  push({
                    error: {
                      message: fill(t.upstreamMidStream, { detail: e?.message || e }),
                      type: "upstream_error",
                      code: "midstream_error",
                    },
                  })
                  controller.enqueue(enc.encode("data: [DONE]\n\n"))
                } finally {
                  controller.close()
                }
              },
              async cancel() {
                // The client went away: stop reading the upstream answer.
                try { upstreamAbort.abort() } catch { /* already aborted */ }
                try { await iterator?.return?.() } catch { /* already finished */ }
              },
            })

            return new Response(stream, {
              status: 200,
              headers: {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache",
                ...extraHeaders,
              },
            })
          },
        }
      },

      async usage(getAuth) {
        const auth = await getAuth()
        const plan = tierOf(auth?.metadata?.tier || opt.tier) === "max" ? t.planMax : t.planPro
        if (!auth?.key) return { plan, windows: [] }
        const q = await readQuota(auth.key, undefined, auth.metadata?.ua)
        if (!q.ok) {
          return {
            plan,
            user: auth.metadata?.email || undefined,
            error: fill(t.usageUnavailable, { detail: q.detail || `HTTP ${q.status}` }),
            windows: [],
          }
        }
        // Only counters the endpoint actually returned; no invented reset span.
        const windows = []
        const counter = (value, nameKey, displayKey) => {
          if (value === null || value === undefined) return
          windows.push({
            name: t[nameKey],
            balance: value,
            unit: "calls",
            display: fill(t[displayKey], { n: value }),
          })
        }
        counter(q.remaining_pro, "proSearchesName", "proSearches")
        counter(q.remaining_research, "researchName", "research")
        counter(q.remaining_labs, "labsName", "labs")
        counter(q.remaining_agentic_research, "agenticResearchName", "agenticResearch")
        if (q.free_queries) {
          windows.push({ name: t.freeQueriesName, display: t.freeQueries })
        }
        if (!windows.length) {
          windows.push({ name: t.proSearchesName, display: t.quotaUnknown })
        }
        return { plan, user: auth.metadata?.email || undefined, windows }
      },
    },

    "chat.headers": async (input_, output) => {
      if (input_?.model?.providerID === PROVIDER && input_.sessionID) {
        output.headers["x-pplx-session-id"] = input_.sessionID
      }
    },
  }
}
