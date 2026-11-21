// A stand-in for `zcode --prompt … --output-format stream-json`, printing
// what ZCode's prompt-command.ts prints. It reaches no network. What it was
// started with goes to FAKE_ZCODE_RECORD; FAKE_ZCODE_MODE picks the run.
import { readFileSync, writeFileSync, existsSync } from "node:fs"

const args = process.argv.slice(2)
const at = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
const cfgFile = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
if (process.env.FAKE_ZCODE_RECORD) {
  writeFileSync(process.env.FAKE_ZCODE_RECORD, JSON.stringify({
    args,
    cwd: process.cwd(),
    providerConfig: cfgFile && existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, "utf8")) : null,
    attached: args.flatMap((a, i) => (a === "--attach" ? [args[i + 1]] : [])).map((f) => (existsSync(f) ? readFileSync(f).length : -1)),
    conversationFile: (() => {
      const m = /The file (\S+) holds the request/.exec(at("--prompt") ?? "")
      return m && existsSync(m[1]) ? readFileSync(m[1], "utf8") : null
    })(),
  }))
}
const mode = process.env.FAKE_ZCODE_MODE || "ok"
const sid = "ses_fake"
let seq = 0
const ev = (type, payload) => process.stdout.write(JSON.stringify({ deliveryKind: "live", eventId: `e${++seq}`, payload, seq, sessionId: sid, timestamp: Date.now(), traceId: "tr_1", turnId: "t1", type }) + "\n")

if (mode === "blocked") {
  process.stderr.write("Error: API error 405: {\"code\":3012,\"msg\":\"request has been blocked due to unusual activity\"} (traceId: tr_1)\n")
  process.exit(1)
}
if (mode === "signin") {
  process.stderr.write("Error: Not logged in. Run zcode login first.\n")
  process.exit(1)
}
ev("session.created", {})
ev("turn.started", {})
if (mode === "turnfail") {
  ev("turn.failed", { error: { message: "429 Too Many Requests" } })
  process.exit(1)
}
ev("model.streaming", { kind: "reasoning_delta", delta: "Thinking it " })
ev("model.streaming", { kind: "reasoning_delta", delta: "over." })
ev("tool.updated", { kind: "started", name: "Read" })
ev("model.streaming", { kind: "tool_input_delta", delta: "{\"path\"" })
if (mode === "slow") {
  ev("model.streaming", { kind: "text_delta", delta: "partial" })
  setInterval(() => {}, 1000)
} else {
  ev("model.streaming", { kind: "text_delta", delta: "Hello" })
  ev("model.streaming", { kind: "text_delta", delta: " from ZCode" })
  process.stdout.write("not json, a warning\n")
  ev("turn.completed", {})
  process.stdout.write(JSON.stringify({ type: "result", sessionId: sid, traceId: "tr_1", turnId: "t1", response: "Hello from ZCode", usage: { inputTokens: 120, outputTokens: 7, cachedInputTokens: 20 }, eventCount: seq, projection: { status: "completed", turnCount: 1, totalTokenCount: 127, contextUsed: null, contextWindow: null } }) + "\n")
}
