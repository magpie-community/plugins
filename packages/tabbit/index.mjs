// Tabbit (web.tabbit.com) as a magpie provider.
//
// The shape is the one every magpie provider plugin has — config, auth,
// provider.models — because the work is a plain HTTP conversation with
// Tabbit, not a browser drive:
//
//   sign-in  →  the `token` cookie (JWT, 7 days) the Tabbit app keeps
//   catalog  →  /proxy/v1/model_config/models
//   a turn   →  create room → POST runs → POST join (SSE)
//
// The one thing a plain OpenAI client can't do is Tabbit's turn shape, so
// loader() hands back a `fetch` that rewrites chat/completions into
// room+runs+join and writes the answer back as OpenAI chunks. That is the
// same trick the WorkBuddy plugin uses for its own protocol, not a sidecar.
//
// Turn history: Tabbit keeps it in the room, so a follow-up inside the same
// magpie session sends only the new message and hangs it off the previous
// answer's id. A request whose transcript doesn't continue the room gets a
// new room and the whole transcript flattened into one prompt — measured:
// the model answers the last question with the earlier turns as context.

import {
  credsOf,
  expiresAt,
  listModels,
  usage as readUsage,
  createRoom,
  runTurn,
  join,
  stop,
  TabbitError,
} from "./src/api.mjs"
import { BOOTSTRAP, NPM, CHAT_BASE, rowsOf } from "./src/models.mjs"
import { turnDeltas } from "./src/sse.mjs"
import { desktopSignIn } from "./src/cookie.mjs"
import { checkinOf } from "./src/checkin.mjs"

const ID = "tabbit"
const NAME = "Tabbit"
const SESSION = "x-magpie-tabbit-session"
const FREE_ONLY = "freeOnly"
const ROOM_TTL = 30 * 60 * 1000
// A cap as well as the TTL: a process that runs for days sees many sessions,
// and the map must not grow with them. Oldest goes first.
const ROOM_LIMIT = 256

// Rooms are this process's memory of a magpie session, one per session id.
// They are not persisted: a restart starts new rooms, which costs nothing
// because a room whose transcript no longer matters is simply abandoned.
const rooms = new Map()

// pruneRooms drops what is past its TTL and then the oldest beyond the cap.
function pruneRooms(now = Date.now()) {
  for (const [k, entry] of rooms) if (now - entry.at >= ROOM_TTL) rooms.delete(k)
  while (rooms.size > ROOM_LIMIT) rooms.delete(rooms.keys().next().value)
}

const clean = (v) => (typeof v === "string" ? v.trim() : "")

function sessionOf(headers) {
  try {
    return clean(new Headers(headers).get(SESSION))
  } catch {
    return ""
  }
}

// stripModel accepts either the bare id magpie sends the SDK or a
// `tabbit/<id>` spelling, so a route written by hand still resolves.
function stripModel(value) {
  const id = clean(value)
  return id.startsWith(`${ID}/`) ? id.slice(ID.length + 1) : id
}

// contentOf flattens one message's content: a string, or the array of parts
// the OpenAI SDK sends. Only text parts are taken; an image part is named so
// the turn still says something about it.
function contentOf(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts = []
  for (const part of content) {
    if (typeof part === "string") parts.push(part)
    else if (part?.type === "text" || typeof part?.text === "string") parts.push(part.text ?? "")
    else if (part?.type === "image_url" || part?.type === "image") parts.push("[image]")
  }
  return parts.join("\n")
}

// historyOf is the conversation a room would remember, in order: system
// prompts, the user's turns and the assistant's.
function historyOf(messages) {
  const out = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role === "assistant" ? "assistant" : message?.role === "system" ? "system" : "user"
    const content = contentOf(message?.content)
    if (content) out.push({ role, content })
  }
  return out
}

// flatten writes a transcript as one prompt. Tabbit's turn takes one
// `content` string, and a fresh room has no history of its own, so the
// transcript is what carries it. Measured: the model answers the last
// question with the earlier turns as context.
function flatten(history) {
  const systems = history.filter((m) => m.role === "system").map((m) => m.content)
  const turns = history.filter((m) => m.role !== "system")
  const lastUser = [...turns].reverse().find((m) => m.role === "user")
  const before = lastUser ? turns.slice(0, turns.lastIndexOf(lastUser)) : turns
  const lines = []
  if (systems.length) lines.push(`[system]\n${systems.join("\n\n")}`)
  for (const m of before) lines.push(`${m.role === "assistant" ? "assistant" : "user"}: ${m.content}`)
  const header = lines.length ? "Below is the conversation so far. Answer the final user message, continuing it.\n\n" : ""
  return header + lines.join("\n\n") + (lines.length ? "\n\n" : "") + `user: ${lastUser?.content ?? ""}`
}

// planTurn decides what one request sends: a new room with the flattened
// transcript, or (when the transcript continues a room we already have) only
// the newest message, hung off the previous answer.
function planTurn(entry, messages, now = Date.now()) {
  const history = historyOf(messages)
  if (entry && now - entry.at < ROOM_TTL && history.length > entry.sent.length) {
    const continues = entry.sent.every((m, i) => history[i]?.role === m.role && history[i]?.content === m.content)
    const added = history.slice(entry.sent.length)
    const lastUser = [...added].reverse().find((m) => m.role === "user")
    if (continues && lastUser && added.length <= 2) {
      return { room: entry.room, parent: entry.parent, content: lastUser.content, history }
    }
  }
  return { room: null, parent: null, content: flatten(history), history }
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text ?? "").length / 4))
}

// Tabbit names a cycle with bare dates ("2026.11.03"), in Beijing time.
function parseCycleDate(value) {
  const m = clean(value).match(/^(\d{4})\.(\d{2})\.(\d{2})$/)
  if (!m) return undefined
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00+08:00`)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function usageWindow(data) {
  const pct = Number.parseFloat(String(data?.usage_percentage ?? "").replace("%", ""))
  const start = parseCycleDate(data?.current_cycle_start)
  const end = parseCycleDate(data?.current_cycle_end)
  return {
    name: "Cycle usage",
    ...(Number.isFinite(pct) ? { used: Math.max(0, pct) } : {}),
    amount: Number.isFinite(pct) ? pct : 0,
    limit: 100,
    unit: "%",
    display: Number.isFinite(pct) ? `${pct.toFixed(2)}%` : "",
    ...(start ? { startsAt: start } : {}),
    ...(end ? { resetsAt: end } : {}),
  }
}

function freeOnly() {
  try {
    return globalThis.magpie?.option?.(ID, FREE_ONLY) === true
  } catch {
    return false
  }
}

// ---- the wire between magpie and Tabbit ---------------------------------

function chunkLine(model, delta, { finish = null, usage = null } = {}) {
  const chunk = {
    id: `chatcmpl-tabbit-${Date.now().toString(36)}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
  if (usage) chunk.usage = usage
  return `data: ${JSON.stringify(chunk)}\n\n`
}

function completionBody(model, text, reasoning, usage) {
  return {
    id: `chatcmpl-tabbit-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text, ...(reasoning ? { reasoning_content: reasoning } : {}) },
        finish_reason: "stop",
      },
    ],
    ...(usage ? { usage } : {}),
  }
}

// Statuses magpie reads for itself: a 400/404 is the request's fault, a 429
// says wait, 401 marks the account, and 403 with code 492 is a paywall the
// account survives. Anything else is a gateway failure and goes as 502.
const PASS_THROUGH = new Set([400, 401, 403, 404, 429])

// errorResponse carries the sign-in state magpie reads (`X-Magpie-Sign-In:
// expired` on a 401) and Tabbit's `retry-after` on a 429.
function errorResponse(error) {
  const status = Number.isFinite(error?.status) ? error.status : 500
  const headers = { "content-type": "application/json" }
  if (error?.signIn) headers["x-magpie-sign-in"] = error.signIn
  if (error?.retryAfter) headers["retry-after"] = String(error.retryAfter)
  const passthrough = PASS_THROUGH.has(status)
  return new Response(
    JSON.stringify({
      error: {
        message: error?.message ?? String(error),
        type: error?.signIn === "expired" ? "authentication_error" : "tabbit_error",
        ...(error?.code !== undefined ? { code: error.code } : {}),
      },
    }),
    { status: passthrough ? status : 502, headers },
  )
}

// streamTurn writes one joined turn out as OpenAI chunk lines. `onCancel`
// ends the run at Tabbit when the client goes away early: the turn keeps
// producing for a while otherwise, and the account pays for it.
function streamTurn(response, { model, plan, body, signal, onEnd, onCancel }) {
  const encoder = new TextEncoder()
  const stopReading = new AbortController()
  let stopped = false
  const stopOnce = () => {
    if (stopped) return
    stopped = true
    try {
      onCancel?.()
    } catch {
      /* stopping is best effort */
    }
  }
  return new ReadableStream({
    async start(controller) {
      const send = (text) => {
        try {
          controller.enqueue(encoder.encode(text))
        } catch {
          /* the reader went away */
        }
      }
      // magpie's way of giving up is aborting the request's signal; stop the
      // run then too, not only when the reader is cancelled.
      if (signal) {
        if (signal.aborted) stopOnce()
        else signal.addEventListener("abort", stopOnce, { once: true })
      }
      let text = ""
      try {
        send(chunkLine(model, { role: "assistant", content: "" }))
        for await (const part of turnDeltas(response, {
          signal: signal ? AbortSignal.any([signal, stopReading.signal]) : stopReading.signal,
          onTimeout: stopOnce,
        })) {
          if (part.type === "thinking" && part.value) send(chunkLine(model, { reasoning_content: part.value }))
          else if (part.type === "text" && part.value) {
            text += part.value
            send(chunkLine(model, { content: part.value }))
          } else if (part.type === "end") {
            if (part.state.failed) throw new TabbitError(`Tabbit's turn failed: ${JSON.stringify(part.state.failed).slice(0, 300)}`)
            if (part.state.truncated) {
              // The turn never finished. An empty or half answer reported as
              // `stop` would be taken as the answer; this says it is not.
              send(`data: ${JSON.stringify({ error: { message: "Tabbit's turn ended without finishing", type: "tabbit_error" } })}\n\n`)
              send("data: [DONE]\n\n")
              return
            }
            const usage = body?.stream_options?.include_usage
              ? {
                  prompt_tokens: estimateTokens(plan.content),
                  completion_tokens: estimateTokens(text),
                  total_tokens: estimateTokens(plan.content) + estimateTokens(text),
                }
              : null
            send(chunkLine(model, {}, { finish: "stop", usage }))
            send("data: [DONE]\n\n")
            onEnd?.(part.state)
          }
        }
      } catch (error) {
        // A stream that has already started can't change its status, so the
        // failure goes out as an event and the stream ends.
        send(`data: ${JSON.stringify({ error: { message: error?.message ?? String(error), type: "tabbit_error" } })}\n\n`)
        send("data: [DONE]\n\n")
      } finally {
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }
    },
    async cancel() {
      // Stop reading the stream, then tell Tabbit to end the run: leaving it
      // producing would spend the account's allowance for an answer nobody
      // will read.
      stopReading.abort(new Error("cancelled"))
      stopOnce()
      signal?.removeEventListener?.("abort", stopOnce)
    },
  })
}

// ---- the plugin ---------------------------------------------------------

function createPlugin() {
  async function chat(getAuth, request) {
    const body = await request.json()
    const model = stripModel(body?.model)
    if (!model) throw new TabbitError("tabbit: no model was named", { status: 400 })
    const messages = Array.isArray(body?.messages) ? body.messages : []
    if (!messages.length) throw new TabbitError("tabbit: no messages were sent", { status: 400 })

    const auth = await getAuth()
    const creds = credsOf(auth)
    if (!creds) throw Object.assign(new TabbitError("tabbit: not signed in", { status: 401 }), { signIn: "expired" })

    const session = sessionOf(request.headers)
    // The account is part of the key: magpie may send a session's next request
    // on another account, and continuing that account's room would either be
    // refused (403 → marked signed out) or answered by someone else's room.
    const account = creds.uid || "?"
    const roomKey = session ? `${account}\u0000${session}` : ""
    const plan = planTurn(rooms.get(roomKey), messages)

    const start = async (roomId, parentMessageId) => {
      await runTurn(creds, roomId, { content: plan.content, model, parentMessageId, signal: request.signal })
      return await join(creds, roomId, { signal: request.signal })
    }

    let response = null
    if (plan.room) {
      try {
        response = await start(plan.room, plan.parent)
      } catch (error) {
        // A room that has been reset or dropped is replaced, not reported:
        // the transcript flattens the same way a new room needs.
        if (![400, 404, 409].includes(error?.status)) throw error
        plan.content = flatten(plan.history)
        plan.room = null
      }
    }
    let room = plan.room
    if (!room) {
      room = await createRoom(creds, request.signal)
      response = await start(room, null)
    }

    if (body?.stream === true) {
      const stream = streamTurn(response, {
        model,
        plan,
        body,
        signal: request.signal,
        onEnd: (state) => remember(roomKey, room, plan.history, state?.assistantMessageId ?? null),
        onCancel: () => stop(creds, room),
      })
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      })
    }

    // Not streaming: drain the turn, then answer once.
    let text = ""
    let reasoning = ""
    let assistantId = null
    for await (const part of turnDeltas(response, { signal: request.signal, onTimeout: () => stop(creds, room) })) {
      if (part.type === "text") text += part.value
      else if (part.type === "thinking") reasoning += part.value
      else if (part.type === "end") {
        assistantId = part.state.assistantMessageId
        if (part.state.failed) throw new TabbitError(`Tabbit's turn failed: ${JSON.stringify(part.state.failed).slice(0, 300)}`)
        if (part.state.truncated) throw new TabbitError("Tabbit's turn was cut before it finished")
      }
    }
    remember(roomKey, room, plan.history, assistantId)
    return Response.json(
      completionBody(model, text, reasoning, {
        prompt_tokens: estimateTokens(plan.content),
        completion_tokens: estimateTokens(text),
        total_tokens: estimateTokens(plan.content) + estimateTokens(text),
      }),
    )
  }

  function remember(key, room, history, parent) {
    if (!key) return
    pruneRooms()
    rooms.set(key, { room, parent, sent: history, at: Date.now() })
  }


  return {
    async config(cfg) {
      cfg.provider ??= {}
      cfg.provider[ID] ??= {}
      const provider = cfg.provider[ID]
      provider.name ??= NAME
      provider.npm ??= NPM
      provider.api ??= CHAT_BASE
      // The bootstrap rows fill in whatever the user hasn't pinned.
      provider.models = { ...rowsOf(BOOTSTRAP), ...(provider.models ?? {}) }
    },

    // The session id the room is keyed by, when magpie names one.
    "chat.headers": async (input, output) => {
      const providerId = input?.model?.providerID ?? input?.provider?.info?.id
      if (providerId !== ID || !input?.sessionID) return
      output.headers[SESSION] = String(input.sessionID).slice(0, 128)
    },

    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const creds = credsOf(auth)
        if (!creds) return provider.models
        let catalog
        try {
          catalog = await listModels(creds)
        } catch (error) {
          if (error?.signIn) throw error
          return provider.models
        }
        const rows = rowsOf(catalog, { freeOnly: freeOnly() })
        return Object.keys(rows).length ? rows : provider.models
      },
    },

    auth: {
      provider: ID,
      maxConcurrency: 1,
      async loader(getAuth) {
        return {
          baseURL: CHAT_BASE,
          apiKey: "",
          async fetch(input, init) {
            const request = new Request(input, init)
            try {
              const path = new URL(request.url).pathname
              if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
                throw new TabbitError(`tabbit: ${request.method} ${path} is not served by this provider`, { status: 404 })
              }
              return await chat(getAuth, request)
            } catch (error) {
              return errorResponse(error)
            }
          },
        }
      },

      options: [
        {
          key: FREE_ONLY,
          label: "Free models only",
          description:
            "Lists only the models Tabbit serves at no credit cost (free_unlimited and free_metered). A premium-only model is left out instead of failing at the turn.",
          labels: { zh: "仅免费模型" },
          descriptions: {
            zh: "只列出 Tabbit 不消耗额度的模型（free_unlimited 与 free_metered）。付费专属的模型直接不出现，而不是等请求时被 403 拒绝。",
          },
          filtersModels: true,
        },
      ],

      methods: [
        {
          type: "oauth",
          label: "Read Tabbit Browser sign-in (macOS)",
          authorize: () => ({
            url: "",
            instructions: "Reads the sign-in Tabbit Browser already has on this computer. Nothing is copied by hand.",
            method: "auto",
            callback: async () => {
              try {
                const sign = desktopSignIn()
                return { type: "success", key: sign.key, accountId: sign.userId, metadata: { userId: sign.userId, source: "desktop" } }
              } catch (error) {
                return { type: "failed", error: String(error?.message ?? error) }
              }
            },
          }),
        },
        {
          type: "api",
          label: "Paste Tabbit token (the browser's `token` cookie)",
          placeholder: "eyJhbGci…",
        },
      ],

      // The daily sign-in: magpie runs it once a day per account while the
      // user has it on, and draws the outcome on the account's card. A throw
      // is a failure magpie retries on its own backoff; a returned "failed"
      // waits for its longer one. Tabbit's sign-in is the desktop pet's
      // activity, and today it is the only scene the service takes.
      async checkin(getAuth) {
        const auth = await getAuth()
        const creds = credsOf(auth)
        if (!creds) return { outcome: "failed", message: "tabbit: not signed in" }
        return await checkinOf(creds)
      },

      async usage(getAuth) {
        const auth = await getAuth()
        const creds = credsOf(auth)
        if (!creds) return { windows: [] }
        try {
          const data = await readUsage(creds)
          const level = clean(data?.member_level)
          return {
            plan: level ? `Tabbit ${level}` : "Tabbit",
            windows: [usageWindow(data)],
            ...(auth?.metadata?.userId || creds.uid ? { accountId: auth?.metadata?.userId || creds.uid } : {}),
            ...(expiresAt(auth) ? { expiresAt: expiresAt(auth) } : {}),
          }
        } catch (error) {
          return { error: error?.message ?? String(error), signIn: error?.signIn, windows: [] }
        }
      },
    },
  }
}

// The plugin function. magpie calls every exported function as a plugin, so
// the internals stay reachable through `_internal` only.
export const TabbitPlugin = async () => createPlugin()

export const _internal = {
  createPlugin,
  planTurn,
  historyOf,
  flatten,
  stripModel,
  contentOf,
  usageWindow,
  parseCycleDate,
  estimateTokens,
  pruneRooms,
  rooms,
}
