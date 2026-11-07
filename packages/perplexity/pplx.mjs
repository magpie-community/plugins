// Perplexity web protocol: session check, quota, the SSE ask endpoint, and the
// OpenAI <-> Perplexity translation. Pure fetch, no native deps.
//
// Every failure carries a `code` and no localized text: the provider turns the
// code into a message in the user's language (see i18n.mjs).

export const PPLX_BASE = "https://www.perplexity.ai"
export const PPLX_ASK = `${PPLX_BASE}/rest/sse/perplexity_ask`
export const PPLX_SESSION = `${PPLX_BASE}/api/auth/session`
export const PPLX_RATE = `${PPLX_BASE}/rest/rate-limit/all`
export const COOKIE_NAME = "__Secure-next-auth.session-token"

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

export const BASE_HEADERS = {
  accept: "text/event-stream",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  "content-type": "application/json",
  dnt: "1",
  origin: PPLX_BASE,
  referer: `${PPLX_BASE}/`,
  "sec-ch-ua": '"Chromium";v="130", "Not?A_Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "user-agent": UA,
}

export function cookieHeader(key) {
  return `${COOKIE_NAME}=${key}`
}

/** Pull a rotated session cookie out of a response, if Perplexity sent one. */
export function rotatedCookie(res) {
  let list = []
  try {
    list = res.headers.getSetCookie?.() ?? []
  } catch { /* older runtime */ }
  if (!list.length) {
    const one = res.headers.get("set-cookie")
    if (one) list = [one]
  }
  for (const c of list) {
    const m = c.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))
    if (m) return m[1]
  }
  return ""
}

/**
 * The shortest useful form of an upstream error body: its own `error.message`
 * or `detail` when it is JSON, the raw text otherwise.
 */
export function upstreamDetail(text, limit = 300) {
  const raw = String(text || "").trim()
  if (!raw) return ""
  try {
    const j = JSON.parse(raw)
    const d =
      j?.error?.message ?? j?.error?.detail ?? j?.detail ?? j?.message ??
      (typeof j?.error === "string" ? j.error : "")
    if (d) return String(d).slice(0, limit)
  } catch { /* not JSON */ }
  return raw.slice(0, limit)
}

export async function readSession(key, signal) {
  const res = await fetch(PPLX_SESSION, {
    headers: { ...BASE_HEADERS, accept: "application/json", cookie: cookieHeader(key) },
    signal,
  })
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, code: "cookie_invalid" }
  }
  if (!res.ok) {
    const detail = upstreamDetail(await res.text().catch(() => ""))
    return { ok: false, status: res.status, code: "http", detail }
  }
  const data = await res.json().catch(() => ({}))
  const user = data?.user
  if (!user) return { ok: false, status: res.status, code: "not_signed_in" }
  return {
    ok: true,
    email: user.email || user.name || "",
    cookie: rotatedCookie(res) || key,
  }
}

/**
 * `/rest/rate-limit/all` gives counters, never a reset time: no `span` is
 * invented for them downstream.
 */
export async function readQuota(key, signal) {
  try {
    const res = await fetch(PPLX_RATE, {
      headers: { ...BASE_HEADERS, accept: "application/json", cookie: cookieHeader(key) },
      signal,
    })
    if (!res.ok) return { ok: false, status: res.status, code: "http" }
    const d = await res.json().catch(() => ({}))
    return {
      ok: true,
      remaining_pro: d?.remaining_pro ?? null,
      remaining_research: d?.remaining_research ?? null,
      remaining_labs: d?.remaining_labs ?? null,
      remaining_agentic_research: d?.remaining_agentic_research ?? null,
      free_queries: d?.free_queries?.available === true,
    }
  } catch (e) {
    return { ok: false, code: "network", detail: e?.message || String(e) }
  }
}

function flatten(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((p) =>
        typeof p === "string" ? p : p?.type === "text" || p?.type === "input_text" ? String(p.text || "") : ""
      )
      .filter(Boolean)
      .join("\n")
  }
  return content ? String(content) : ""
}

/**
 * One Perplexity query string from an OpenAI message list.
 * `backendUuid` continues Perplexity's own thread for a plain follow-up.
 */
export function buildQuery(messages, keepSystem, backendUuid) {
  const msgs = (messages || []).filter((m) => m && typeof m === "object")
  if (!msgs.length) return { query: "", follow: null }
  const userTurns = msgs.filter((m) => m.role === "user")

  if (backendUuid && userTurns.length >= 2) {
    return { query: flatten(userTurns.at(-1).content), follow: backendUuid }
  }

  const hist = []
  let last = ""
  for (const m of msgs) {
    const text = flatten(m.content)
    if (!text) continue
    if (m.role === "system" || m.role === "developer") {
      // Dropped by default: Perplexity searches every word of query_str, and a
      // coding agent's system prompt poisons its web results.
      if (keepSystem) hist.push("[Instructions] " + text)
    } else if (m.role === "user") {
      if (last) hist.push("User: " + last)
      last = text
    } else if (m.role === "assistant") {
      hist.push("Assistant: " + text)
    } else if (m.role === "tool") {
      hist.push("Tool result: " + text)
    }
  }

  let query = ""
  if (hist.length) {
    query = "[Conversation so far — context only, do not search for it]\n" + hist.join("\n") +
      "\n[/Conversation so far]\n\n"
  }
  query += last || "Hello"
  return { query, follow: null }
}

/** The machine's IANA time zone, or UTC where the runtime cannot say. */
export function systemTimeZone(intl) {
  try {
    const tz = intl?.resolvedOptions?.().timeZone
    if (tz) return tz
  } catch { /* no ICU */ }
  return "UTC"
}

export function payloadFor(query, pref, follow, apiVersion, timezone = systemTimeZone()) {
  return {
    query_str: query,
    params: {
      attachments: [],
      frontend_context_uuid: crypto.randomUUID(),
      frontend_uuid: crypto.randomUUID(),
      is_incognito: true,
      language: "en-US",
      last_backend_uuid: follow,
      mode: pref === "pplx_pro" || pref === "experimental" ? "concise" : "copilot",
      model_preference: pref,
      source: "default",
      sources: ["web"],
      // The single most important field: without it Perplexity uses "writing"
      // mode and the model ignores its own search results.
      search_focus: "internet",
      search_recency_filter: null,
      timezone,
      visitor_id: crypto.randomUUID(),
      user_nextauth_id: crypto.randomUUID(),
      prompt_source: "user",
      query_source: "home",
      browser_history_summary: [],
      is_related_query: false,
      is_sponsored: false,
      is_nav_suggestions_disabled: false,
      use_schematized_api: true,
      send_back_text_in_streaming_api: false,
      supported_block_use_cases: [
        "answer_modes", "media_items", "knowledge_cards", "inline_entity_cards",
        "place_widgets", "finance_widgets", "sports_widgets", "shopping_widgets",
        "search_result_widgets",
      ],
      client_coordinates: null,
      version: apiVersion || "2.18",
    },
  }
}

/** Kick off the ask. Returns the raw fetch Response (SSE or error JSON). */
export async function startAsk(key, payload, signal) {
  return fetch(PPLX_ASK, {
    method: "POST",
    headers: { ...BASE_HEADERS, cookie: cookieHeader(key) },
    body: JSON.stringify(payload),
    signal,
  })
}

/** Yield {event, data} from an SSE body. */
export async function* sseEvents(body) {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  let event = "message"
  let data = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf("\n")) >= 0) {
      let line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (line.endsWith("\r")) line = line.slice(0, -1)
      if (line === "") {
        if (data.length) yield { event, data: data.join("\n") }
        event = "message"
        data = []
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim()
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""))
      }
    }
  }
  if (data.length) yield { event, data: data.join("\n") }
}

/** Text delta + thinking delta from one Perplexity SSE message. */
export function answerDelta(chunk, state) {
  const blocks = chunk?.blocks || []
  const thinking = []
  for (const b of blocks) {
    const usage = String(b?.intended_usage || "")
    if (usage === "pro_search_steps") {
      for (const step of b?.plan_block?.steps || []) {
        if (step?.step_type === "SEARCH_WEB") {
          for (const q of step?.search_web_content?.queries || []) {
            const t = q?.query || ""
            if (t && !state.thinkingSeen.has(t)) {
              state.thinkingSeen.add(t)
              thinking.push(`Searching: ${t}\n`)
            }
          }
        }
      }
    }
    if (usage === "plan") {
      for (const g of b?.plan_block?.goals || []) {
        const t = g?.description || ""
        if (t && !state.thinkingSeen.has(t)) {
          state.thinkingSeen.add(t)
          thinking.push(`${t}\n`)
        }
      }
    }
  }

  const candidates = blocks.filter(
    (b) => String(b?.intended_usage || "").startsWith("ask_text") && b?.markdown_block
  )
  if (!candidates.length) return { delta: "", thinking: thinking.join("") }

  let block = state.answerUsage
    ? candidates.find((b) => b.intended_usage === state.answerUsage)
    : null
  if (!block) {
    block = candidates.find((b) => b.intended_usage === "ask_text") || candidates[0]
    state.answerUsage = block.intended_usage
  }

  const mb = block.markdown_block
  const chunks = mb?.chunks || []
  if (!chunks.length) return { delta: "", thinking: thinking.join("") }
  const full = chunks.join("")

  // Non-final messages carry a fragment; the final one carries the whole answer.
  state.full = mb.progress === "DONE" ? full : (state.full || "") + full

  // Cleaned on the accumulated text, not per delta: a citation marker split
  // across two chunks only becomes removable once both halves have arrived.
  const cleaned = clean(state.full)
  const previous = state.cleaned || ""
  const delta = cleaned.startsWith(previous) ? cleaned.slice(previous.length) : ""
  state.cleaned = cleaned

  return { delta, thinking: thinking.join("") }
}

// A citation marker as Perplexity emits it in the answer text: a bare index,
// or an index run ("[1][2]", "[1, 3]", "[1–3]").
const CITATION = /\[\d{1,3}(?:\s*[,–—-]\s*\d{1,3})*\]/g
const IDENT = /[A-Za-z0-9_$]/

/** Does `[12, 15]` look like a citation run rather than an array literal? */
function citationShaped(inner) {
  const parts = String(inner).split(/\s*[,–—-]\s*/)
  return parts.every((n) => /^[1-9]\d{0,2}$/.test(n))
}

/**
 * Strip citation markers that are not code.
 *
 * Perplexity emits no citation metadata, so the marker has to be recognised by
 * shape. Only a run of plain indexes (`[1]`, `[1][2]`, `[1, 3]`, `[1–3]`) that
 * does not start with a zero is treated as a citation. Anything inside a
 * fenced block or an inline code span is left untouched, as is `arr[0]` — a
 * zero index cannot be a citation — and `a[1]`, where the preceding name is a
 * single letter and therefore a variable.
 *
 * The residual trade-off is documented, not hidden: a bare `foo[3]` written
 * outside backticks is indistinguishable from a citation and is stripped.
 */
export function stripCitations(text) {
  // Odd splits are code: fenced blocks (closed or still open) and `spans`.
  const parts = String(text).split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part
      return part.replace(CITATION, (whole, offset, source) => {
        if (!citationShaped(whole.slice(1, -1))) return whole
        let start = offset - 1
        while (start >= 0 && IDENT.test(source[start])) start--
        const run = source.slice(start + 1, offset)
        if (/^[A-Za-z_$]$/.test(run)) return whole
        return ""
      })
    })
    .join("")
}

export function clean(text) {
  const src = String(text || "")
    .replace(/<grok:[^>]*>/g, "")
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
  return stripCitations(src)
}

export function chatId() {
  return "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24)
}

export function chunkObj(cid, model, content, opts = {}) {
  const delta = {}
  if (content) delta.content = content
  if (opts.reasoning) delta.reasoning_content = opts.reasoning
  return {
    id: cid,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: null,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: opts.finish ?? null }],
  }
}

/** Rough token count: corrected nowhere, so every usage block says it is one. */
const ESTIMATE_SOURCE = "perplexity_chars_div_4"

function estimate(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4))
}

/**
 * A non-streaming completion. Perplexity reports no usage, so the counts are
 * flagged `estimated` instead of passed off as measured.
 */
export function completionObj(cid, model, text, promptText, finish = "stop") {
  const pin = estimate(promptText)
  const pout = estimate(text)
  return {
    id: cid,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: null,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, logprobs: null, finish_reason: finish },
    ],
    usage: {
      prompt_tokens: pin,
      completion_tokens: pout,
      total_tokens: pin + pout,
      prompt_tokens_details: { estimated: true, source: ESTIMATE_SOURCE },
      completion_tokens_details: { estimated: true, source: ESTIMATE_SOURCE },
    },
  }
}

/** The final streaming chunk, carrying the same estimated usage. */
export function usageChunk(cid, model, text, promptText) {
  const pin = estimate(promptText)
  const pout = estimate(text)
  return {
    id: cid,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: null,
    choices: [],
    usage: {
      prompt_tokens: pin,
      completion_tokens: pout,
      total_tokens: pin + pout,
      prompt_tokens_details: { estimated: true, source: ESTIMATE_SOURCE },
      completion_tokens_details: { estimated: true, source: ESTIMATE_SOURCE },
    },
  }
}

export function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`
}
