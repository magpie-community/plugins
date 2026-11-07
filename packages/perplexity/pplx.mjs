// Perplexity web protocol: session check, quota, the SSE ask endpoint, and the
// OpenAI <-> Perplexity translation. Pure fetch, no native deps.

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

export async function readSession(key, signal) {
  const res = await fetch(PPLX_SESSION, {
    headers: { ...BASE_HEADERS, accept: "application/json", cookie: cookieHeader(key) },
    signal,
  })
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: res.status, error: "Cookie 无效或已过期" }
  }
  if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
  const data = await res.json().catch(() => ({}))
  const user = data?.user
  if (!user) return { ok: false, status: res.status, error: "未登录" }
  return {
    ok: true,
    email: user.email || user.name || "",
    cookie: rotatedCookie(res) || key,
  }
}

export async function readQuota(key, signal) {
  try {
    const res = await fetch(PPLX_RATE, {
      headers: { ...BASE_HEADERS, accept: "application/json", cookie: cookieHeader(key) },
      signal,
    })
    if (!res.ok) return { ok: false, status: res.status }
    const d = await res.json().catch(() => ({}))
    return {
      ok: true,
      remaining_pro: d?.remaining_pro ?? null,
      remaining_research: d?.remaining_research ?? null,
    }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
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

export function payloadFor(query, pref, follow, apiVersion) {
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
      timezone: "Asia/Taipei",
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

  let delta = ""
  if (mb.progress === "DONE") {
    const finalText = full
    delta = finalText.startsWith(state.full) ? finalText.slice(state.seen) : ""
    state.full = finalText
    state.seen = finalText.length
  } else {
    const cumulative = state.full + full
    delta = cumulative.slice(state.seen)
    state.full = cumulative
    state.seen = cumulative.length
  }
  return { delta: clean(delta), thinking: thinking.join("") }
}

export function clean(text) {
  return String(text || "")
    .replace(/<grok:[^>]*>/g, "")
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/\[(\d+)\]/g, "")
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

export function completionObj(cid, model, text, promptChars) {
  const pin = Math.max(1, Math.floor(promptChars / 4))
  const pout = Math.max(1, Math.floor(text.length / 4))
  return {
    id: cid,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: null,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, logprobs: null, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: pin, completion_tokens: pout, total_tokens: pin + pout },
  }
}

export function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`
}
