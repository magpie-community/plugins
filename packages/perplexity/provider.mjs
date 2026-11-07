// The magpie / OpenCode provider plugin for Perplexity Pro & Max.
//
// Everything is plain fetch: no Python, no native modules, no sidecar process.
// A request is translated to Perplexity's web SSE endpoint and translated back
// into OpenAI chat-completions (streaming or not).

import { PROVIDER, modelCatalog, thinkingPref, tierOf } from "./models.mjs"
import {
  readSession, readQuota, buildQuery, payloadFor, startAsk,
  sseEvents, answerDelta, chunkObj, completionObj, sse, chatId, rotatedCookie,
} from "./pplx.mjs"
import { browserSignIn } from "./login.mjs"

const THREAD_TTL = 30 * 60 * 1000
const threads = new Map() // sessionId -> { uuid, at }

function expired(msg) {
  return Object.assign(new Error(msg), { signIn: "expired" })
}

function errResponse(status, message, type = "upstream_error") {
  return new Response(JSON.stringify({ error: { message, type, code: type } }), {
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

export const server = async (input, options) => {
  const opt = { tier: "pro", keepSystem: false, chromePath: "", apiVersion: "2.18", ...(options || {}) }
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
        const info = await readSession(auth.key)
        if (!info.ok) {
          if (info.status === 401 || info.status === 403) {
            throw expired("Perplexity 会话已失效，请重新登录")
          }
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
          label: "粘贴 Session Cookie",
          placeholder: "__Secure-next-auth.session-token=… 或只贴值",
          prompts: [
            {
              type: "password",
              key: "cookie",
              message: "Perplexity session cookie",
              placeholder: "F12 → Application → Cookies → www.perplexity.ai",
              validate: (v) => (v && v.trim().length > 40 ? undefined : "太短了，请贴完整的 session-token 值"),
            },
          ],
          async authorize(inputs, ctx) {
            const raw = String(inputs?.cookie || "").trim()
            const m = raw.match(/__Secure-next-auth\.session-token=([^;]+)/)
            const key = (m ? m[1] : raw).trim()
            const info = await readSession(key, ctx?.signal)
            if (!info.ok) return { type: "failed", error: info.error }
            return {
              type: "success",
              key: info.cookie || key,
              metadata: { email: info.email, tier: opt.tier },
              accountId: info.email,
            }
          },
        },
        {
          type: "oauth",
          label: "浏览器登录 Perplexity",
          async authorize(_inputs, ctx) {
            const handle = await browserSignIn({ chromePath: opt.chromePath, signal: ctx?.signal })
            return {
              url: handle.url,
              instructions: handle.instructions,
              method: "auto",
              async callback(_code, cbCtx) {
                try {
                  const r = await handle.wait(cbCtx?.signal)
                  const info = await readSession(r.cookie, cbCtx?.signal)
                  if (!info.ok) return { type: "failed", error: info.error }
                  return {
                    type: "success",
                    key: info.cookie || r.cookie,
                    metadata: { email: info.email, tier: opt.tier },
                    accountId: info.email,
                  }
                } catch (e) {
                  return { type: "failed", error: String(e?.message || e) }
                } finally {
                  await handle.close()
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
            let model = String(body.model || "pplx_pro")
            if (body.reasoning_effort || body.thinking || body.reasoning) {
              model = thinkingPref(model) || model
            }
            const sessionId = new Headers(init?.headers).get("x-pplx-session-id") || ""
            let backendUuid = null
            if (sessionId) {
              const rec = threads.get(sessionId)
              if (rec && Date.now() - rec.at < THREAD_TTL) backendUuid = rec.uuid
            }

            const { query, follow } = buildQuery(body.messages, opt.keepSystem, backendUuid)
            const payload = payloadFor(query, model, follow, opt.apiVersion)

            let up
            try {
              up = await startAsk(auth.key, payload, init?.signal)
            } catch (e) {
              throw new Error(`连不上 Perplexity: ${e?.message || e}`)
            }

            if (up.status === 401 || up.status === 403) {
              return errResponse(401, "Perplexity 拒绝了该 Cookie，请重新登录", "session_expired")
            }
            if (up.status === 429) {
              return errResponse(429, "Pro Search 额度已用尽或触发限流", "rate_limited")
            }
            if (!up.ok) {
              const txt = await up.text().catch(() => "")
              return errResponse(up.status, `Perplexity HTTP ${up.status}: ${txt.slice(0, 300)}`)
            }

            const rotated = rotatedCookie(up)
            if (rotated) await persist(auth, rotated)

            const state = { full: "", seen: 0, thinkingSeen: new Set(), answerUsage: null }
            const cid = chatId()
            const wantsStream = body.stream === true

            if (!wantsStream) {
              let text = ""
              try {
                for await (const { event, data } of sseEvents(up.body)) {
                  if (event === "end_of_stream") break
                  if (event !== "message") continue
                  let chunk
                  try { chunk = JSON.parse(data) } catch { continue }
                  if (chunk?.error) throw new Error(String(chunk.error).slice(0, 300))
                  if (chunk?.backend_uuid && sessionId) {
                    threads.set(sessionId, { uuid: chunk.backend_uuid, at: Date.now() })
                  }
                  const r = answerDelta(chunk, state)
                  if (r.delta) text += r.delta
                }
              } catch (e) {
                return errResponse(502, String(e?.message || e))
              }
              if (!text.trim()) text = state.full
              if (!text.trim()) return errResponse(502, "Perplexity 返回了空回答")
              return new Response(JSON.stringify(completionObj(cid, model, text, query.length)), {
                status: 200,
                headers: { "content-type": "application/json; charset=utf-8" },
              })
            }

            const enc = new TextEncoder()
            const stream = new ReadableStream({
              async start(controller) {
                const push = (o) => controller.enqueue(enc.encode(sse(o)))
                try {
                  for await (const { event, data } of sseEvents(up.body)) {
                    if (event === "end_of_stream") break
                    if (event !== "message") continue
                    let chunk
                    try { chunk = JSON.parse(data) } catch { continue }
                    if (chunk?.error) throw new Error(String(chunk.error).slice(0, 300))
                    if (chunk?.backend_uuid && sessionId) {
                      threads.set(sessionId, { uuid: chunk.backend_uuid, at: Date.now() })
                    }
                    const r = answerDelta(chunk, state)
                    if (r.thinking) push(chunkObj(cid, model, "", { reasoning: r.thinking }))
                    if (r.delta) push(chunkObj(cid, model, r.delta))
                  }
                  push(chunkObj(cid, model, "", { finish: "stop" }))
                  controller.enqueue(enc.encode("data: [DONE]\n\n"))
                } catch (e) {
                  push({ error: { message: String(e?.message || e), type: "upstream_error" } })
                  controller.enqueue(enc.encode("data: [DONE]\n\n"))
                } finally {
                  controller.close()
                }
              },
            })

            return new Response(stream, {
              status: 200,
              headers: {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache",
              },
            })
          },
        }
      },

      async usage(getAuth) {
        const auth = await getAuth()
        if (!auth?.key) return { plan: "Pro", windows: [] }
        const q = await readQuota(auth.key)
        if (!q.ok) return { plan: "Pro", error: q.error || `HTTP ${q.status}`, windows: [] }
        const n = q.remaining_pro
        return {
          plan: tierOf(auth.metadata?.tier || opt.tier) === "max" ? "Max" : "Pro",
          user: auth.metadata?.email || undefined,
          windows: n === null
            ? [{ name: "Pro Search", display: "额度未知（rate-limit 接口未返回）" }]
            : [{
                name: "Pro Search",
                balance: n,
                unit: "次",
                display: `剩余 ${n} 次 Pro Search`,
                span: 30 * 24 * 3600,
              }],
        }
      },
    },

    "chat.headers": async (input_, output) => {
      if (input_?.model?.providerID === PROVIDER && input_.sessionID) {
        output.headers["x-pplx-session-id"] = input_.sessionID
      }
    },
  }
}
