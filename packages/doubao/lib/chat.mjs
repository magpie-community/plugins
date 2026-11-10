// Doubao's web chat protocol, as `/samantha/chat/completion` speaks it, and
// the Anthropic Messages shape the agents send.
//
// Two directions:
//   buildPayload  Anthropic Messages  ->  Doubao's client_meta/content_block
//   anthropicSSE  Doubao's SSE        ->  Anthropic's event stream
//
// Doubao's web protocol is one turn at a time: it keeps the conversation
// itself, and its `messages` holds only what the user says now. So the whole
// Anthropic history is folded into one text — system prompt first, then the
// turns, labelled. Tool calls have no native place either; the tools go into
// that text as a contract and the reply is read back out of it (see tools.mjs).
//
// Block types seen in the stream:
//   10000 text, 10040 thinking, 10024 a generic tool, 10025 web search,
//   10101 a loading hint. Only 10000 becomes an answer's text; 10040 is kept
//   apart (Anthropic thinking blocks carry a signature this protocol can't
//   give, so they are not sent as thinking — see thinkingOf).

const BASE = "https://www.doubao.com"
const CHAT_PATH = "/samantha/chat/completion"

// Doubao's own web bundle as it reads them. Changing these is what gets a
// request turned away as "not the client", so they are constants, not knobs.
const SECURITY_PARAMS = {
  aid: "582478",
  real_aid: "582478",
  device_platform: "web",
  language: "zh",
  region: "CN",
  sys_region: "CN",
  pkg_type: "release_version",
  version_code: "20800",
  pc_version: "2.1.7",
  client_platform: "pc_client",
  runtime: "web",
  runtime_version: "3.5.4",
  samantha_web: "1",
  "use-olympus-account": "1",
}

const DEFAULT_FP = "verify_mlcfw5f7_TPq0YmFD_NrsC_4RuQ_BJPg_M5W7i58I7wV0"
const EXTENSION_BOT_ID = "7338286299411103781"

// Blocks
const TEXT_BLOCK = 10000
const THINKING_BLOCK = 10040
const ATTACHMENT_BLOCK = 10052
// `messages[].content_type` on the live stream: 2001 is the reply text, 2008 is
// a think trace. Same field, different namespace from block_type above.
const CMPL_CONTENT = 2008

// Codes that mean "the account is being rate-limited or challenged", not "the
// request was wrong": 710022002 (msToken), 710022004 (captcha), the shark
// admin wall. Retrying these in a loop is what turns a warning into a ban.
export const RISK_CODES = new Set([
  710022002, 710022004, 7100220, 710012001, 710012000,
])

const uuid = () => crypto.randomUUID()
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))]
  .map((b) => "0123456789abcdef"[b % 16]).join("")

function query(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&")
}

// ---------------------------------------------------------------------------
// History -> one turn
// ---------------------------------------------------------------------------

// Anthropic content is a string or a list of blocks. Text joins; images have
// no way into this endpoint without an upload, so they are named and dropped
// rather than silently changing the question.
export function textOf(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const out = []
  for (const b of content) {
    if (!b || typeof b !== "object") continue
    if (b.type === "text" && typeof b.text === "string") out.push(b.text)
    else if (b.type === "tool_result") {
      const inner = typeof b.content === "string" ? b.content : textOf(b.content)
      out.push(`[tool result ${b.tool_use_id ?? ""}${b.is_error ? " (error)" : ""}]\n${inner}`)
    } else if (b.type === "tool_use") {
      out.push(`[called ${b.name}]\n${JSON.stringify(b.input ?? {})}`)
    } else if (b.type === "image") {
      out.push("[an image was attached; this endpoint takes text only]")
    }
  }
  return out.join("\n")
}

const ROLE_LABEL = { user: "User", assistant: "Assistant" }

// The conversation as one block of text: system, tools' contract, then every
// turn in order. The last user turn is echoed at the end so the model answers
// it rather than continuing the transcript.
export function foldHistory({ system, messages = [], tools = [], toolContract = "" }) {
  const parts = []
  const sys = typeof system === "string" ? system : textOf(system)
  if (sys.trim()) parts.push(sys.trim())
  if (toolContract) parts.push(toolContract)
  const turns = []
  for (const m of messages) {
    const t = textOf(m?.content)
    if (!t.trim()) continue
    turns.push(`${ROLE_LABEL[m.role] ?? m.role}: ${t.trim()}`)
  }
  // A single user turn is the common case and needs no transcript framing.
  if (turns.length === 1 && messages.filter((m) => m?.role === "user").length === 1) {
    if (parts.length) return `${parts.join("\n\n")}\n\n${textOf(messages.at(-1)?.content).trim()}`
    return textOf(messages.at(-1)?.content).trim()
  }
  if (parts.length) parts.push(turns.join("\n\n"))
  else return turns.join("\n\n")
  return parts.join("\n\n")
}

// ---------------------------------------------------------------------------
// Anthropic Messages -> Doubao payload
// ---------------------------------------------------------------------------

// The body `/samantha/chat/completion` accepts. It is flat — not the
// client_meta/content_block shape newer Doubao endpoints take — and the text
// rides inside `messages[].content` as a *JSON string*: sending an object here
// is answered with `unexpected end of JSON input [biz error]` even though the
// cookie is perfectly valid, which is a confusing way to learn the difference.
export function buildPayload({
  text,
  deepThink = 0,
  botId = "",
  fp = DEFAULT_FP,
  conversationId = "",
  localConversationId = `local_${hex(16)}`,
}) {
  const body = {
    messages: [{
      content: JSON.stringify({ text }),
      content_type: 2001,
      attachments: [],
      references: [],
    }],
    completion_option: {
      is_regen: false,
      with_suggest: true,
      need_create_conversation: !conversationId,
      launch_stage: 1,
      is_replace: false,
      is_delete: false,
      is_ai_playground: false,
      memory_type: 2,
      message_from: 0,
      use_deep_think: Boolean(deepThink),
      use_auto_cot: false,
      resend_for_regen: false,
      enable_commerce_credit: false,
    },
    evaluate_option: { web_ab_params: "" },
    local_conversation_id: conversationId || localConversationId,
    local_message_id: uuid(),
  }
  // A bot id pins the reply to a specific Doubao agent; leaving it out lands on
  // the default Agent-Chat, which is what a general-purpose client wants.
  //
  // NOTE on model selection: the web endpoint `/samantha/chat/completion` does
  // NOT read a per-message model. Empirically (against the live endpoint) an
  // `option.model_item_key`, `bot_id`, `model`, `model_config`,
  // `model_config_v2`, `conversation_init_ext` and `completion_option.model*`
  // were all ignored — even a bogus key returns 200 with the same constant
  // `bot_id` (7338286299411103781). Model choice is conversation-level / the
  // account default, so we deliberately do not fake it here. `use_deep_think`
  // below is a real toggle and IS honoured.
  if (botId) body.bot_id = botId
  return body
}

export function chatURL({ deviceId, webId, fp = DEFAULT_FP, msToken = "" }) {
  const params = {
    ...SECURITY_PARAMS,
    device_id: deviceId,
    tea_uuid: deviceId,
    web_id: webId,
    fp,
    web_tab_id: uuid(),
  }
  // An empty msToken is safest: a made-up one is what draws 710022002.
  if (msToken) params.msToken = msToken
  return `${BASE}${CHAT_PATH}?${query(params)}`
}

// The header Doubao's own page sends with the cookie it holds. A cookie jar
// without it is answered as a different session.
export function chatHeaders({ cookie, csrfToken = "" }) {
  const h = {
    Accept: "text/event-stream",
    "Content-Type": "application/json",
    "Agw-Js-Conv": "str",
    "User-Agent": DOUBAO_UA,
  }
  if (csrfToken) h["x-tt-passport-csrf-token"] = csrfToken
  if (cookie) h.Cookie = cookie
  return h
}

export const DOUBAO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) DoubaoDesktop/2.32.6 Chrome/147.0.7727.149 Safari/537.36"

// ---------------------------------------------------------------------------
// Doubao SSE -> events
// ---------------------------------------------------------------------------

// A minimal SSE reader: `event:` and `data:` lines, blank-line separated,
// multi-line data joined with "\n" as the spec says. Yields {event, data}
// where data is the raw string; `json` is left to the caller so a malformed
// payload is one skipped frame, not a dead stream.
export function* sseFrames(text) {
  let event = ""
  let data = []
  for (const raw of text.split(/\r?\n/)) {
    if (raw === "") {
      if (data.length || event) yield { event, data: data.join("\n") }
      event = ""
      data = []
      continue
    }
    if (raw.startsWith(":")) continue
    const i = raw.indexOf(":")
    const field = i < 0 ? raw : raw.slice(0, i)
    let value = i < 0 ? "" : raw.slice(i + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") event = value
    else if (field === "data") data.push(value)
  }
  if (data.length || event) yield { event, data: data.join("\n") }
}

// What one frame of Doubao's stream means, in this protocol's terms:
//   { kind: "text"|"thinking"|"conversation"|"error"|"ignore", ... }
export function readFrame(frame) {
  let obj = null
  if (frame.data) {
    try { obj = JSON.parse(frame.data) } catch { obj = null }
  }
  if (frame.event === "gateway-error") {
    const code = Number(obj?.code) || 0
    return { kind: "error", code, message: String(obj?.message ?? frame.data).slice(0, 300), fatal: true }
  }
  if (!obj) return { kind: "ignore" }
  // The live stream (verified against a real account, 2026-11-01) is
  // `{event_type, event_data}` where event_data is itself a JSON string:
  //   2001 the answer, 2002 the conversation id, 2003 the turn end,
  //   2010 seed intention, plus ack frames — all noise except the first three.
  if (typeof obj.event_type === "number") {
    let ed = obj.event_data
    if (typeof ed === "string") {
      try { ed = JSON.parse(ed) } catch { ed = null }
    }
    if (obj.event_type === 2001) {
      const msg = ed?.message ?? {}
      const raw = msg.content
      if (typeof raw !== "string" || !raw) return { kind: "ignore" }
      let parsed = null
      try { parsed = JSON.parse(raw) } catch { return { kind: "ignore" } }
      // a think trace is reasoning, not the reply
      if (Number(msg.content_type) === CMPL_CONTENT) {
        const t = parsed?.think ?? parsed?.text
        return typeof t === "string" && t ? { kind: "thinking", text: t } : { kind: "ignore" }
      }
      const t = parsed?.text
      // Doubao closes a message with `{}` / `{"text":""}`; replaying that as a
      // delta would append an empty chunk to every reply
      return typeof t === "string" && t ? { kind: "text", text: t, endsThinking: true } : { kind: "ignore" }
    }
    if (obj.event_type === 2002) {
      const cid = String(ed?.conversation_id ?? "").trim()
      return cid && cid !== "0" ? { kind: "conversation", id: cid } : { kind: "ignore" }
    }
    return { kind: "ignore" }
  }
  if (frame.event === "SSE_ACK") {
    const cid = String(obj?.ack_client_meta?.conversation_id ?? "").trim()
    return cid && cid !== "0" ? { kind: "conversation", id: cid } : { kind: "ignore" }
  }
  if (frame.event === "STREAM_ERROR" || "error_code" in obj) {
    const code = Number(obj.error_code) || 0
    if (!code) return { kind: "ignore" }
    return { kind: "error", code, message: String(obj.error_msg ?? ""), fatal: RISK_CODES.has(code) }
  }
  // chunk_delta: a bare {"text": "..."}
  if (typeof obj.text === "string" && !("error_code" in obj)) {
    return { kind: "text", text: obj.text }
  }
  // content_block arrays, through either a patch_op or a content wrapper
  const blocks = []
  for (const patch of obj.patch_op ?? []) {
    const pv = patch?.patch_value
    if (Array.isArray(pv?.content_block)) blocks.push(...pv.content_block)
  }
  if (Array.isArray(obj.content?.content_block)) blocks.push(...obj.content.content_block)
  for (const cb of blocks) {
    const bt = Number(cb?.block_type) || 0
    const c = cb?.content ?? {}
    if (bt === THINKING_BLOCK) return { kind: "thinking", text: "" }
    if (bt === TEXT_BLOCK) {
      const t = c?.text_block?.text
      // A text block is the answer: whatever was thinking has ended, or the
      // rest of the reply would be read as reasoning and thrown away.
      if (typeof t === "string" && t) return { kind: "text", text: t, endsThinking: true }
    }
    // a search or tool block is progress, not answer text: swallow it, so a
    // reply never gains "[tool] ..." lines the user didn't ask for
  }
  return { kind: "ignore" }
}

// ---------------------------------------------------------------------------
// Doubao SSE -> Anthropic SSE
// ---------------------------------------------------------------------------

const enc = new TextEncoder()

function frame(event, data) {
  return enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

// Rough token counts: this protocol never says. Better an approximate number
// than 0, which some agents read as "no context used" and which makes a
// context meter sit at empty.
export function estimateTokens(text) {
  if (!text) return 0
  let ascii = 0
  let wide = 0
  for (const ch of text) {
    if (ch.codePointAt(0) > 0x2e80) wide++
    else ascii++
  }
  return Math.max(1, Math.round(ascii / 4 + wide))
}

// Turns a Doubao response body into an Anthropic message stream.
//
// `thinking` is off by default: an Anthropic thinking block must carry a
// signature, and a made-up one is rejected outright by the agents that check
// it. When asked for, the thinking goes out as ordinary text inside a
// <thinking> wrapper instead — visible, harmless, and not mistaken for a real
// signed block.
export function anthropicSSE(doubaoBody, { model = "doubao", thinking = false, onConversation } = {}) {
  const reader = doubaoBody.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let started = false
  let closed = false
  let outText = ""
  let sawText = false
  let inThinking = false

  const head = (usage = {}) => frame("message_start", {
    type: "message_start",
    message: {
      id: `msg_${hex(24)}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: usage.input ?? 0, output_tokens: 0 },
    },
  })

  const open = () => started
    ? []
    : (started = true, [
        head(),
        frame("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      ])

  const stop = () => {
    closed = true
    return [
      frame("content_block_stop", { type: "content_block_stop", index: 0 }),
      frame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: estimateTokens(outText) },
      }),
      frame("message_stop", { type: "message_stop" }),
    ]
  }

  return new ReadableStream({
    async pull(controller) {
      if (closed) return controller.close()
      let done = false
      while (!done) {
        const { value, done: eof } = await reader.read()
        if (eof) {
          buffer += decoder.decode()
          done = true
        } else {
          buffer += decoder.decode(value, { stream: true })
        }
        // frames end at a blank line; keep the trailing partial in the buffer
        let cut
        while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const raw = buffer.slice(0, cut)
          buffer = buffer.slice(cut + (buffer[cut] === "\r" ? 4 : 2))
          for (const f of sseFrames(raw + "\n\n")) {
            const ev = readFrame(f)
            if (ev.kind === "conversation") { onConversation?.(ev.id); continue }
            if (ev.kind === "thinking") { inThinking = true; continue }
            if (ev.kind === "error") {
              if (!ev.fatal) continue
              for (const c of open()) controller.enqueue(c)
              controller.enqueue(frame("error", {
                type: "error",
                error: { type: "api_error", message: `doubao: ${ev.code} ${ev.message}`.trim() },
              }))
              closed = true
              controller.close()
              return
            }
            if (ev.kind !== "text" || !ev.text) continue
            // A text block ends whatever thinking preceded it.
            if (ev.endsThinking) inThinking = false
            // Doubao answers in blocks; a thinking block's text is kept apart
            if (inThinking && !thinking) continue
            if (inThinking && thinking) {
              for (const c of open()) controller.enqueue(c)
              controller.enqueue(frame("content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: ev.text },
              }))
              outText += ev.text
              sawText = true
              continue
            }
            sawText = true
            for (const c of open()) controller.enqueue(c)
            controller.enqueue(frame("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: ev.text },
            }))
            outText += ev.text
          }
        }
        if (done) break
      }
      for (const c of open()) controller.enqueue(c)
      if (!sawText) {
        controller.enqueue(frame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "" },
        }))
      }
      for (const c of stop()) controller.enqueue(c)
      controller.close()
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
}

export const internal = {
  BASE, CHAT_PATH, SECURITY_PARAMS, TEXT_BLOCK, THINKING_BLOCK, ATTACHMENT_BLOCK,
  EXTENSION_BOT_ID, DEFAULT_FP,
}
