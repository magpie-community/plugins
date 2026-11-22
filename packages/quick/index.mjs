// Amazon Quick for OpenCode and magpie: the chat the web app serves,
// relayed as an OpenAI-compatible provider. Sign-in is the account's own
// browser session (its Cookie header plus the mbtc CSRF token), the
// request goes over Quick's CBOR WebSocket as a user_message, and the
// streamed reply comes back as SSE with the server's per-turn model
// fingerprint in the usage metadata.
//
// The three models are Quick's tiers — quick-fast, quick-balanced and
// quick-smart — and the thinking parameter (off/low/medium/high/max) is
// sent explicitly on every turn. Usage: the per-turn metadata plus the
// account's session/monthly pools (100 and 600 minutes), shown read-only.
//
// One paste may hold several accounts (a pool): one Cookie-header account
// per line, or a JSON array of {cookie, accountId, mbtc}. Requests rotate
// through the healthy accounts; one whose cookie is refused or whose usage
// window is exhausted is benched for a minute and the next account takes
// the turn. No auto-downgrade, no auto-stop — quota state is reported, the
// caller decides.
//
// Threads: a request may pin the server-side thread with `quick.thread_id`
// (same-thread continuation); the reply's `quick.thread_id` metadata and
// X-Quick-Thread-Id header name the thread a follow-up request can reuse.
// Without it every request opens a fresh thread and flattens the history.

import { modelsOf, PROVIDER } from "./lib/models.mjs"
import { importAccount, poolOf, stateOf, verifyAccount } from "./lib/session.mjs"
import { usageOf } from "./lib/usage.mjs"
import { AccountPool } from "./lib/pool.mjs"
import { QuickSocket } from "./lib/ws-client.mjs"
import { relayTurn, errorResponse, mapError } from "./lib/relay.mjs"
import * as research from "./lib/research.mjs"
import { browserAuthorize } from "./lib/signin.mjs"

// Quick's own mark (the hexagon), from the product's favicon —
// inlined so it renders before any network fetch.
const QUICK_ICON = "data:image/png;base64,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"

const NPM = "@ai-sdk/openai-compatible"
const BASE = "https://quick.aws.com"

// one connected socket per account+session, reused across turns. A
// `quick.session_id` request opens a socket attached to that server-side
// conversation (session_connect resumes it); other requests share the
// account's plain socket. LRU-capped so a long-lived process doesn't hold
// a socket per conversation forever.
const sockets = new Map()
const SOCKET_CAP = 8

async function socketOf(account, sessionId) {
  const key = sessionId ? `${account.accountId}::${sessionId}` : account.accountId
  let s = sockets.get(key)
  if (s && !s.closed && s.ws?.readyState === WebSocket.OPEN) {
    sockets.delete(key)
    sockets.set(key, s) // LRU touch
    return s
  }
  s?.close()
  s = await new QuickSocket(account).connect(sessionId)
  sockets.set(key, s)
  while (sockets.size > SOCKET_CAP) {
    const oldest = sockets.keys().next().value
    sockets.get(oldest)?.close()
    sockets.delete(oldest)
  }
  return s
}

// researchResponse wraps a finished research run as an OpenAI chat.completion:
// the report text is the assistant content; the run's ids, status, mode,
// elapsed wall clock and citation count ride the quick.* metadata.
function researchResponse(runResult, model, id) {
  const meta = {
    "quick.research": true,
    "quick.research_id": runResult.researchId,
    "quick.research_mode": runResult.mode,
    "quick.research_status": runResult.status ?? "UNKNOWN",
    "quick.turn_seconds": runResult.elapsedS ?? 0,
    ...(runResult.citations?.length ? { "quick.research_citations": runResult.citations.length } : {}),
    ...(runResult.aborted ? { "quick.research_aborted": true } : {}),
    ...(runResult.timedOut ? { "quick.research_timed_out": true } : {}),
  }
  const text = runResult.text ?? ""
  return Response.json(
    {
      id: id ?? `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: runResult.aborted ? "aborted" : "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      quick: meta,
    },
    { headers: { "x-quick-research-id": String(runResult.researchId), "x-quick-research-status": String(runResult.status ?? "") } },
  )
}

export async function QuickAuthPlugin({ client } = {}) {
  // the account pool behind the provider: rebuilt whenever the active
  // credential changes, read fresh on every request
  let pool = new AccountPool([])
  let poolFor = null // fingerprint of the credential the pool was built from
  const fingerprint = (auth) => JSON.stringify([auth?.accountId, auth?.metadata?.accounts?.length ?? 0, auth?.metadata?.mbtc ?? ""])

  const poolOfAuth = (auth) => {
    if (!auth) return null
    const fp = fingerprint(auth)
    if (poolFor !== fp) {
      pool = new AccountPool(poolOf(auth))
      poolFor = fp
    }
    return pool
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = {
        name: "Amazon Quick",
        npm: NPM,
        api: BASE,
        ...was,
        models: { ...modelsOf(), ...(was.models ?? {}) },
      }
    },
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const s = stateOf(auth)
        if (!s) return provider.models
        await verifyAccount(s) // throws a sign-in error when the cookie is dead
        return provider.models
      },
    },
    auth: {
      provider: PROVIDER,
      icon: QUICK_ICON,
      methods: [
        {
          type: "oauth",
          label: "One-click sign-in (browser)",
          // zero prompts: the plugin's own browser profile opens
          // quick.aws.com, the session cookies are read over CDP, and the
          // account id + csrf are discovered from the session itself
          authorize: browserAuthorize,
        },
        {
          type: "oauth",
          label: "Import a Quick session (Cookie header + mbtc)",
          prompts: [
            {
              type: "text",
              key: "account",
              message:
                "Paste the account's Cookie header (DevTools → Network → any quick.aws.com request → Cookie), plus its accountId and mbtc. JSON {cookie, accountId, mbtc} also works. A pool: one account per line, or a JSON array.",
            },
          ],
          authorize: importAccount,
        },
      ],
      async loader(getAuth) {
        const auth = await getAuth()
        const s = stateOf(auth)
        if (!s) return {}
        const initialAccounts = poolOf(auth)
        return {
          baseURL: BASE,
          apiKey: "quick",
          async fetch(input, init) {
            const url = input instanceof Request ? input.url : String(input)
            if (!/\/chat\/completions/.test(url)) return errorResponse(404, `Quick: no such API: ${new URL(url).pathname}`)
            if (input instanceof Request) init = { method: input.method, headers: input.headers, body: await input.text(), signal: input.signal, ...init }
            const body = (() => {
              try {
                return JSON.parse(typeof init.body === "string" ? init.body : "")
              } catch {
                return {}
              }
            })()
            const model = body.model ?? "quick-balanced"
            const accounts = poolOfAuth(await getAuth()) ?? new AccountPool(initialAccounts)
            // quick.research routes this request to the research agent instead
            // of a chat turn: {research: {goal, mode, include, exclude}} —
            // never triggered implicitly by chat traffic
            const researchOpt = body?.quick?.research && typeof body.quick.research === "object" ? body.quick.research : null
            if (researchOpt) {
              const goal = typeof researchOpt.goal === "string" ? researchOpt.goal.trim() : ""
              if (!goal) return errorResponse(400, "Quick research: set quick.research.goal to the research question")
              if (body.stream) return errorResponse(400, "Quick research: streaming is not supported — omit stream or set it false")
              const account = accounts.pick()
              if (!account) return errorResponse(401, "Quick: no usable account in the pool — re-import a cookie", { signIn: "expired" })
              try {
                const result = await research.run(account, goal, {
                  mode: researchOpt.mode ?? "FAST",
                  include: researchOpt.include,
                  exclude: researchOpt.exclude,
                  budgetMs: Number(researchOpt.budgetMs) > 0 ? Number(researchOpt.budgetMs) : 10 * 60_000,
                  pollMs: Number(researchOpt.pollMs) > 0 ? Number(researchOpt.pollMs) : 5_000,
                  signal: init.signal,
                })
                accounts.report(account, true)
                return researchResponse(result, model)
              } catch (e) {
                accounts.report(account, false, String(e?.message ?? e))
                return mapError(e)
              }
            }
            // quick.session_id resumes that server-side conversation; without
            // it the account's shared socket opens a fresh one per turn
            const sessionId = typeof body?.quick?.session_id === "string" && body.quick.session_id ? body.quick.session_id : undefined
            let lastError
            // one turn per account, round-robin, until one answers or the
            // pool is out — only account-scoped failures move on
            for (;;) {
              const account = accounts.pick()
              if (!account) {
                if (lastError) return mapError(lastError)
                return errorResponse(401, "Quick: no usable account in the pool — re-import a cookie", { signIn: "expired" })
              }
              try {
                const socket = await socketOf(account, sessionId)
                const res = await relayTurn({ socket, body, model, stream: !!body.stream, signal: init.signal, threadId: body?.quick?.thread_id })
                accounts.report(account, true)
                return res
              } catch (e) {
                lastError = e
                const msg = String(e?.message ?? e)
                if (!AccountPool.poolLevel(msg)) return mapError(e)
                accounts.report(account, false, msg) // benched; the next account takes it
              }
            }
          },
        }
      },
      async usage(getAuth) {
        const auth = await getAuth()
        const accounts = auth ? poolOf(auth) : []
        if (!accounts.length) return { plan: "quick", windows: [], accounts: [] }
        const { quickFetch } = await import("./lib/session.mjs")
        const { panelFor } = await import("./lib/panel.mjs")
        const { entitlements } = await import("./lib/research.mjs")
        const read = async (account) => {
          try {
            const res = await quickFetch(account, "/quicksight/user-experience/profile/usage")
            const usage = res.ok ? usageOf(await res.json().catch(() => ({}))) : { error: `the usage probe answered ${res.status}` }
            // the read-only panel rides along; a failed piece degrades to its own error
            const panel = await panelFor(account).catch((e) => ({ error: e?.message ?? String(e) }))
            // the research pool (separate minutes) rides too; failure degrades to an error
            const researchPool = await entitlements(account).catch((e) => ({ error: e?.message ?? String(e) }))
            return { accountId: account.accountId, label: account.label ?? account.accountId, ...usage, research, panel }
          } catch (e) {
            return { accountId: account.accountId, label: account.label ?? account.accountId, error: e?.message ?? String(e) }
          }
        }
        const cards = await Promise.all(accounts.map(read))
        // the aggregate keeps the old shape (the first account's windows);
        // every account's own card rides beside it
        return { ...cards[0], accounts: cards }
      },
    },
  }
}

export const _internal = { sockets, socketOf }
