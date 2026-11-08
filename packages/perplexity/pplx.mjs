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

/** The OS a user agent says it runs on, for `sec-ch-ua-platform`. */
export function platformOf(ua = UA) {
  if (/Windows/i.test(ua)) return '"Windows"'
  if (/Android/i.test(ua)) return '"Android"'
  if (/iPhone|iPad|iPod/i.test(ua)) return '"iOS"'
  if (/Macintosh|Mac OS X/i.test(ua)) return '"macOS"'
  if (/Linux/i.test(ua)) return '"Linux"'
  return '"macOS"'
}

/**
 * Request headers for a specific browser, so a signed-in account keeps the user
 * agent it signed in with instead of a fixed Chrome 130 on macOS.
 */
export function baseHeaders(ua = UA) {
  // An empty string is not a user agent: fall back to the default rather than
  // sending a blank one (Cloudflare answers that with a challenge).
  const agent = String(ua || "").trim() || UA
  const version = /Chrome\/(\d+)/.exec(agent)?.[1] || "130"
  return {
    ...BASE_HEADERS,
    "user-agent": agent,
    "sec-ch-ua": `"Chromium";v="${version}", "Not?A_Brand";v="99"`,
    "sec-ch-ua-platform": platformOf(agent),
  }
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
  if (/^</.test(raw)) {
    // A Cloudflare challenge page, not an API error: name it instead of
    // pasting markup into the message.
    const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(raw)?.[1]?.trim()
    return title ? `HTML page: ${title}` : "HTML page instead of a JSON error"
  }
  try {
    const j = JSON.parse(raw)
    const d =
      j?.error?.message ?? j?.error?.detail ?? j?.detail ?? j?.message ??
      (typeof j?.error === "string" ? j.error : "")
    if (d) return String(d).slice(0, limit)
  } catch { /* not JSON */ }
  return raw.slice(0, limit)
}

export async function readSession(key, signal, ua) {
  const res = await fetch(PPLX_SESSION, {
    headers: { ...baseHeaders(ua), accept: "application/json", cookie: cookieHeader(key) },
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
    userId: user.id || "",
    tier: user.subscription_tier || user.payment_tier || "",
    cookie: rotatedCookie(res) || key,
  }
}

/**
 * `/rest/rate-limit/all` gives counters, never a reset time: no `span` is
 * invented for them downstream.
 */
export async function readQuota(key, signal, ua) {
  try {
    const res = await fetch(PPLX_RATE, {
      headers: { ...baseHeaders(ua), accept: "application/json", cookie: cookieHeader(key) },
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
  let formatter = intl
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat()
    } catch {
      formatter = null
    }
  }
  try {
    const tz = formatter?.resolvedOptions?.().timeZone
    if (tz) return tz
  } catch { /* no ICU */ }
  return "UTC"
}

export function payloadFor(query, pref, follow, apiVersion, timezone = systemTimeZone(), identity = {}) {
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
      // Stable per account: a fresh pair on every request is one of the
      // clearest tells that this is not the web client.
      visitor_id: identity.visitorId || crypto.randomUUID(),
      user_nextauth_id: identity.userId || crypto.randomUUID(),
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
export async function startAsk(key, payload, signal, ua) {
  return fetch(PPLX_ASK, {
    method: "POST",
    headers: { ...baseHeaders(ua), cookie: cookieHeader(key) },
    body: JSON.stringify(payload),
    signal,
  })
}

/** Yield {event, data} from an SSE body. */
export async function* sseEvents(body, signal) {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  let event = "message"
  let data = []
  // A pending read would otherwise keep the generator (and the upstream
  // response) alive after the client walked away.
  const aborted = signal
    ? new Promise((_, reject) => {
        if (signal.aborted) reject(new Error("aborted"))
        else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    : null
  try {
    for (;;) {
      const { value, done } = aborted ? await Promise.race([reader.read(), aborted]) : await reader.read()
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
  } finally {
    // A client that walks away must also stop the upstream response.
    if (!body.locked || true) {
      try { await reader.cancel() } catch { /* already closed */ }
    }
  }
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
    // The answer's sources are listed by the stream itself; the count is what
    // decides whether a `[n]` in the text is a citation at all.
    if (usage === "web_results" || usage === "sources_answer_mode") {
      // Seen in all three shapes in real captures: nested under the block kind,
      // or straight on the block.
      const listed =
        b?.web_result_block?.web_results ??
        b?.sources_mode_block?.web_results ??
        b?.web_results ??
        []
      // Lists grow as the answer streams (2 → 3 → 7 in the captured second
      // turn), so the count only ever rises. Cleaning happens on the fresh
      // fragment, so a later, longer list never rewrites text already sent.
      if (listed.length > (state.sources || 0)) state.sources = listed.length
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

  // Only emit text that cannot still change: a trailing `[1` may become `[1]`
  // and disappear, and an open backtick may still turn into code.
  const stable = stableCut(state.full, mb.progress === "DONE")
  const sent = state.rawSent || ""
  const sources = state.sources || 0
  let delta
  if (stable.startsWith(sent)) {
    // Cleaned per fragment, never recomputed: a longer source list can then
    // only affect text that has not been sent yet.
    delta = clean(stable.slice(sent.length), sources)
  } else {
    // The endpoint rewrote the text instead of extending it. Send only what is
    // new: never re-send text the client already has.
    const whole = clean(stable, sources)
    const previous = state.emitted || ""
    delta = whole.startsWith(previous) ? whole.slice(previous.length) : ""
  }
  state.rawSent = stable
  state.emitted = (state.emitted || "") + delta

  return { delta, thinking: thinking.join("") }
}

// A citation run as Perplexity emits it: `[1]`, `[1][2][3]`, `[1, 3]`, `[1–3]`.
const CITATION = /\[(\d{1,3}(?:\s*[,–—-]\s*\d{1,3})*)\]/g

// Perplexity puts its markers straight after sentence punctuation — measured
// on a real capture (test/fixtures), where every one of them followed `.` or
// another marker. That is what keeps `argv[1]` out: no letter precedes a
// citation.
const SENTENCE_END = new Set([".", "。", "!", "！", "?", "？", ";", "；", ":", "：", "…", ")", "）", "”"])

/**
 * Cut a raw answer at the last point that later fragments cannot change.
 *
 * A fragment may end mid-marker (`[`, `[1`) or mid-code (an unclosed backtick
 * or fence); cleaning those bytes and sending them would leave text the client
 * has already seen and that the cleaned answer no longer contains.
 */
export function stableCut(text, flush = false) {
  const src = String(text || "")
  if (flush) return src

  const fenceAt = src.lastIndexOf("```")
  if (fenceAt >= 0 && src.split("```").length % 2 === 0) return src.slice(0, fenceAt)

  const tailStart = fenceAt >= 0 ? fenceAt + 3 : 0
  const tail = src.slice(tailStart)
  const tickAt = tail.lastIndexOf("`")
  if (tickAt >= 0 && tail.split("`").length % 2 === 0) return src.slice(0, tailStart + tickAt)

  let cut = src
  // A run that is already complete may still gain a marker in the next
  // fragment (`[1]` + `[2]`), and the chain is what makes the second one a
  // citation: hold the trailing run until the fragment after it.
  const trailingRun = src.match(/\[\d{1,3}(?:\]\[\d{1,3})*\]$/)
  if (trailingRun && trailingRun.index > 0) cut = src.slice(0, trailingRun.index)
  const pending = cut.match(/\[[\d\s,–—-]*$/)
  if (pending && pending.index > 0) cut = cut.slice(0, pending.index)

  // Hold back a trailing sentence end too: the next fragment may open with the
  // marker (`." + "[1]`), and the punctuation is what makes it a citation.
  const trimmed = cut.replace(/\s+$/, "")
  if (trimmed && SENTENCE_END.has(trimmed[trimmed.length - 1])) cut = cut.slice(0, trimmed.length - 1)
  return cut
}

/**
 * Strip citation markers, and only those.
 *
 * A run is a citation when every index it names is one the stream listed as a
 * source, it sits outside code, and it follows sentence punctuation. With no
 * sources listed, nothing is stripped: an unmarked `[1]` is text, not a
 * citation.
 */
export function stripCitations(text, sources = 0) {
  const src = String(text || "")
  if (!sources) return src
  // Odd splits are code: fenced blocks (closed or still open) and `spans`.
  const parts = src.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part
      let out = ""
      let last = 0
      let chainEnd = -1
      for (const m of part.matchAll(CITATION)) {
        const start = m.index
        const contiguous = start === chainEnd
        const before = start > 0 ? part[start - 1] : ""
        if (!contiguous && !SENTENCE_END.has(before)) continue
        const indexes = m[1].split(/\s*[,–—-]\s*/).map(Number)
        if (!indexes.every((n) => n >= 1 && n <= sources)) continue
        out += part.slice(last, start)
        last = start + m[0].length
        chainEnd = last
      }
      return out + part.slice(last)
    })
    .join("")
}

export function clean(text, sources = 0) {
  const src = String(text || "")
    .replace(/<grok:[^>]*>/g, "")
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
  return stripCitations(src, sources)
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
