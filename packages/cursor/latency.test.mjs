// Tool handoffs keep the native Run open. Even when Cursor's dashboard is
// slow or has no event yet, only final native usage counts: cache tokens must
// not be guessed at each handoff or billed again on a completed retry.
import "./nonet.mjs"
import { afterEach, beforeEach, expect, test } from "bun:test"
import http2 from "node:http2"
import { randomUUID } from "node:crypto"
import { CursorAuthPlugin } from "./index.mjs"
import { nativeSessions } from "./native-session.mjs"
import { readWire, nest, number, update, tool, text, uint, message, end, envelope, readResult } from "./native-test-wire.mjs"

const savedFetch = globalThis.fetch
const fixtures = []
beforeEach(async () => { await nativeSessions.clear() })
afterEach(async () => {
  await nativeSessions.clear()
  for (const { server, sessions } of fixtures.splice(0)) {
    for (const session of sessions) session.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
  globalThis.fetch = savedFetch
})

const COUNTS = [
  { inputTokens: 2, outputTokens: 621, cacheReadTokens: 63457, cacheWriteTokens: 3081 },
  { inputTokens: 2, outputTokens: 942, cacheReadTokens: 66538, cacheWriteTokens: 14756 },
  { inputTokens: 4, outputTokens: 151, cacheReadTokens: 67872, cacheWriteTokens: 2392 },
]
const totals = (counts) => counts.reduce((sum, u) => ({
  inputTokens: sum.inputTokens + u.inputTokens,
  outputTokens: sum.outputTokens + u.outputTokens,
  cacheReadTokens: sum.cacheReadTokens + u.cacheReadTokens,
  cacheWriteTokens: sum.cacheWriteTokens + u.cacheWriteTokens,
}), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
const usageOf = (u) => ({
  prompt_tokens: u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens,
  completion_tokens: u.outputTokens,
  total_tokens: u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.outputTokens,
  prompt_tokens_details: { cached_tokens: u.cacheReadTokens, cache_write_tokens: u.cacheWriteTokens },
  completion_tokens_details: { reasoning_tokens: 37 },
})
const billed = (steps) => steps.reduce((sum, step) => ({
  prompt: sum.prompt + step.body.usage.prompt_tokens,
  output: sum.output + step.body.usage.completion_tokens,
  cached: sum.cached + step.body.usage.prompt_tokens_details.cached_tokens,
  written: sum.written + step.body.usage.prompt_tokens_details.cache_write_tokens,
}), { prompt: 0, output: 0, cached: 0, written: 0 })
const pending = {
  prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
  prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  magpie_native: { accounting: "pending" },
}

// The server advances only after independently decoding the original exec's
// McpResult and its following close. A fresh-Run-per-tool implementation cannot
// pass by replaying fabricated Chat IDs. All HTTP traffic stays on localhost.
async function fixture({ calls = 2, dashboard = "late", session = "synthetic-latency-session" } = {}) {
  const counts = totals(Array.from({ length: calls + 1 }, (_, i) => COUNTS[i % COUNTS.length]))
  const seen = { runs: 0, results: [], closes: [], dashboard: 0, errors: [] }
  const sessions = new Set()
  const server = http2.createServer()
  server.on("session", (s) => { sessions.add(s); s.on("error", () => {}); s.on("close", () => sessions.delete(s)) })
  server.on("stream", (stream) => {
    stream.on("error", () => {})
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    let buffer = Buffer.alloc(0), phase = 0, began = false, received = null
    const advance = () => {
      if (phase < calls) {
        stream.write(update(4, text(1, "native thought " + phase)))
        stream.write(update(1, text(1, "reading " + phase)))
        stream.write(update(27, uint(1, 1)))
        stream.write(tool(7 + phase, "native-latency-" + phase, "file " + phase, { name: "Read" }))
      } else {
        stream.write(update(1, text(1, "done with " + received.content[0].text)))
        stream.write(update(14, message(
          uint(1, counts.inputTokens + counts.cacheReadTokens + counts.cacheWriteTokens),
          uint(2, counts.outputTokens), uint(3, counts.cacheReadTokens), uint(4, counts.cacheWriteTokens), uint(5, 37),
        )))
        stream.end(end())
      }
    }
    stream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      try {
        while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
          const length = buffer.readUInt32BE(1)
          const wire = buffer.subarray(5, 5 + length)
          buffer = buffer.subarray(5 + length)
          const fields = readWire(wire)
          if (fields.some((f) => f.no === 1)) {
            if (began) throw new Error("duplicate RunRequest")
            began = true
            seen.runs++
            advance()
          } else if (fields.some((f) => f.no === 2)) {
            received = readResult(wire)
            if (received.id !== 7 + phase || received.execID !== "exec-" + (7 + phase) || received.content[0]?.text !== "file result " + phase)
              throw new Error("result did not route to the current native exec")
            if (seen.results.some((r) => r.id === received.id)) throw new Error("duplicate result")
            seen.results.push(received)
          } else if (fields.some((f) => f.no === 5)) {
            const close = readWire(nest(wire, 5)).find((f) => f.no === 1)
            if (!close) continue
            const id = number(close.data, 1)
            if (!received || received.id !== id || id !== 7 + phase) throw new Error("close arrived before its native result")
            seen.closes.push(id)
            phase++
            advance()
          }
        }
      } catch (error) {
        seen.errors.push(error.message)
        stream.end(envelope(Buffer.from(JSON.stringify({ error: { code: "invalid_argument", message: error.message } })), 2))
      }
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  fixtures.push({ server, sessions })
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.endsWith("/aiserver.v1.ServerConfigService/GetServerConfig")) return Response.json({ agentUrlConfig: { agentUrl: base } })
    if (u.endsWith("/agent.v1.AgentService/GetUsableModels")) return Response.json({ models: [{ modelId: "synthetic-latency-model", displayName: "Synthetic" }] })
    if (u.endsWith("/aiserver.v1.DashboardService/GetFilteredUsageEvents")) {
      seen.dashboard++
      if (dashboard === "late") await new Promise((resolve) => setTimeout(resolve, 1200))
      return Response.json({ usageEventsDisplay: dashboard === "missing" ? [] : [{ tokenUsage: counts }] })
    }
    throw new Error("unexpected synthetic API request: " + u)
  }
  const account = { type: "oauth", access: `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 7200, sub: "synthetic-latency-" + randomUUID() })).toString("base64url")}.fixture`, refresh: "" }
  const plugin = await CursorAuthPlugin()
  const loader = await plugin.auth.loader(async () => account)
  const headers = { headers: {} }
  await plugin["chat.headers"]({ sessionID: session, model: { providerID: "cursor", id: "synthetic-latency-model" }, provider: { info: { id: "cursor" } } }, headers)
  const ask = async (chat) => {
    const started = performance.now()
    const response = await loader.fetch(base + "/v1/chat/completions", { method: "POST", headers: headers.headers, body: JSON.stringify(chat) })
    const body = await response.json()
    expect([response.status, body.error]).toEqual([200, undefined])
    return { body, ms: performance.now() - started }
  }
  return { counts, seen, ask }
}
const initial = () => ({ model: "synthetic-latency-model", messages: [{ role: "user", content: "read the repo and fix the bug " + "x".repeat(4000) }],
  tools: [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }] })
async function conversation(f, calls) {
  let chat = initial()
  const steps = []
  for (let i = 0; i <= calls; i++) {
    const step = await f.ask(chat)
    steps.push(step)
    expect(step.body.choices[0].finish_reason).toBe(i < calls ? "tool_calls" : "stop")
    if (i < calls) {
      expect(step.body.usage).toEqual(pending)
      expect([...nativeSessions.entries][0].state).toBe("awaiting-results")
      const assistant = step.body.choices[0].message
      chat = { ...chat, messages: [...chat.messages, assistant, { role: "tool", tool_call_id: assistant.tool_calls[0].id, content: "file result " + i }] }
    }
  }
  const final = steps.at(-1)
  expect(final.body.usage).toEqual(usageOf(f.counts))
  expect(final.body.choices[0].message.content).toBe("done with file result " + (calls - 1))
  expect(final.body.usage.magpie_deferred).toBeUndefined()
  expect(f.seen).toMatchObject({ runs: 1, dashboard: 0, errors: [] })
  expect(f.seen.results.map((r) => r.id)).toEqual(Array.from({ length: calls }, (_, i) => 7 + i))
  expect(f.seen.closes).toEqual(f.seen.results.map((r) => r.id))
  expect(billed(steps)).toEqual({ prompt: final.body.usage.prompt_tokens, output: f.counts.outputTokens, cached: f.counts.cacheReadTokens, written: f.counts.cacheWriteTokens })
  return { steps, finalChat: chat }
}

test("latency: a distant dashboard never delays same-Run tool handoffs or final cache totals", async () => {
  const f = await fixture()
  const { steps } = await conversation(f, 2)
  // This bound detects the fixture's 1200 ms dashboard wait. It is an offline
  // scheduling regression check, not a provider performance measurement.
  for (const step of steps) expect(step.ms).toBeLessThan(1000)
})

test("latency: missing dashboard events across six tool steps retain one Run and count once", async () => {
  const f = await fixture({ calls: 6, dashboard: "missing" })
  const { steps } = await conversation(f, 6)
  for (const step of steps) expect(step.ms).toBeLessThan(1000)
})

test("latency: a selectorless same-Run continuation stays pending then returns native cache usage", async () => {
  const f = await fixture({ session: "" })
  await conversation(f, 2)
})

test("latency: immediate dashboard counts cannot duplicate native totals or completed retries", async () => {
  const f = await fixture({ dashboard: "immediate" })
  const { steps, finalChat } = await conversation(f, 2)
  const replay = await f.ask(finalChat)
  expect(replay.body.choices).toEqual(steps.at(-1).body.choices)
  expect(replay.body.usage).toEqual({ ...pending, magpie_native: { accounting: "replayed" } })
  expect(billed([...steps, replay])).toEqual(billed(steps))
  expect(f.seen).toMatchObject({ runs: 1, dashboard: 0 })
  expect(f.seen.results).toHaveLength(2)
  expect(replay.ms).toBeLessThan(1000)
})
