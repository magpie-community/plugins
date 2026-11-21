// What ZCode's `--output-format stream-json` prints, turned into an
// Anthropic Messages reply.
//
// ZCode prints one JSON event a line (prompt-command.ts in
// zai-org/ZCode apps/zcode-cli): {type, payload, sessionId, turnId, ...}.
// The model's own text and reasoning come as model.streaming events,
// payload {kind: "text_delta" | "reasoning_delta" | ..., delta}; a failed
// turn as turn.failed; the last line is {type: "result", response, usage?,
// projection}. ZCode's own tool calls (tool.updated) ran inside ZCode and
// are not the client's, so they are not passed on as tool_use.

// A Collector takes ZCode's lines one at a time and says what each one
// adds: { thinking } or { text } deltas, a failure, or the result.
export class Collector {
  constructor() {
    this.text = ""
    this.thinking = ""
    this.result = null
    this.failure = ""
    this.sessionId = ""
    this.lines = 0
    this.bad = 0
  }

  // line is one line of ZCode's stdout; the return is a list of
  // { kind: "text" | "thinking", delta } in the order they arrived.
  take(line) {
    const s = String(line ?? "").trim()
    if (!s) return []
    let ev
    try {
      ev = JSON.parse(s)
    } catch {
      // a line that isn't JSON (a warning on stdout) is not the reply
      this.bad++
      return []
    }
    if (!ev || typeof ev !== "object") return []
    this.lines++
    if (typeof ev.sessionId === "string" && ev.sessionId) this.sessionId = ev.sessionId
    const p = ev.payload && typeof ev.payload === "object" ? ev.payload : {}
    switch (ev.type) {
      case "model.streaming": {
        const delta = typeof p.delta === "string" ? p.delta : ""
        if (!delta) return []
        if (p.kind === "text_delta") {
          this.text += delta
          return [{ kind: "text", delta }]
        }
        if (p.kind === "reasoning_delta") {
          this.thinking += delta
          return [{ kind: "thinking", delta }]
        }
        return []
      }
      case "turn.failed":
        this.failure = failureText(p) || "ZCode's turn failed"
        return []
      case "result":
        this.result = ev
        // A reply ZCode settled without streaming it (no text_delta seen):
        // the result's response is the text.
        if (!this.text && typeof ev.response === "string" && ev.response) {
          this.text = ev.response
          return [{ kind: "text", delta: ev.response }]
        }
        return []
      default:
        return []
    }
  }

  usage() {
    return usageOf(this.result?.usage, this.result?.projection)
  }
}

function failureText(p) {
  for (const v of [p.error?.message, p.message, p.reason, p.error]) {
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  if (p.error && typeof p.error === "object") {
    try {
      return JSON.stringify(p.error)
    } catch {}
  }
  return ""
}

const num = (...vs) => {
  for (const v of vs) {
    const n = Number(v)
    if (Number.isFinite(n) && n >= 0) return Math.trunc(n)
  }
  return null
}

// usageOf reads the result line's usage, whichever spelling ZCode's
// runtime gives it (the AI SDK's camelCase, or snake_case), as Anthropic
// usage. With no usage, the projection's token count is all there is: it
// is put down as input, since ZCode doesn't say the split.
export function usageOf(u, projection) {
  const x = u && typeof u === "object" ? u : {}
  const input = num(x.inputTokens, x.promptTokens, x.input_tokens, x.prompt_tokens)
  const output = num(x.outputTokens, x.completionTokens, x.output_tokens, x.completion_tokens)
  const cacheRead = num(x.cachedInputTokens, x.cacheReadInputTokens, x.cache_read_input_tokens, x.inputTokenDetails?.cacheReadTokens)
  if (input === null && output === null) {
    const total = num(projection?.totalTokenCount)
    return { input_tokens: total ?? 0, output_tokens: 0 }
  }
  const out = { input_tokens: input ?? 0, output_tokens: output ?? 0 }
  if (cacheRead) {
    // Anthropic counts cache reads apart from input_tokens
    out.cache_read_input_tokens = cacheRead
    out.input_tokens = Math.max(0, out.input_tokens - cacheRead)
  }
  return out
}

// errorOf says what a failed run's message is about, for the status magpie
// answers with: 3012 is zcode.z.ai's risk-control block (the ZCode app's own
// requests get it too, and only ZCode support lifts it); a missing sign-in
// asks for `zcode login`; a rate or quota limit is a 429.
export function errorOf(message) {
  const m = String(message || "").trim() || "ZCode CLI failed"
  if (/\b3012\b|unusual activity/i.test(m))
    return { status: 403, code: "zcode_blocked", message: `${m} — zcode.z.ai blocked this account (code 3012). The ZCode app's own requests get the same answer; only ZCode support can lift it.` }
  if (/not (?:logged|signed) in|\blogin required|please (?:log|sign) ?in|unauthori[sz]ed|\b401\b|user information is invalid/i.test(m))
    return { status: 401, code: "zcode_sign_in", message: `${m} — sign in with \`zcode login\` in a terminal (a Coding Plan account; ZCode's free Start Plan doesn't work outside the ZCode app).` }
  if (/\b429\b|rate.?limit|too many requests|\b1302\b|\b1113\b|quota|余额不足|频率/i.test(m))
    return { status: 429, code: "rate_limited", message: m }
  return { status: 502, code: "zcode_failed", message: m }
}

// lastErrorLine is the line ZCode's stderr ends a failed run with
// ("Error: <message> (traceId: …)"), else its last non-empty line.
export function lastErrorLine(stderr) {
  const lines = String(stderr || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^Error:\s*(.+)$/.exec(lines[i])
    if (m) return m[1]
  }
  return lines.at(-1) ?? ""
}
