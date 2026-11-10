import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile, appendFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { measureTools } from "../lib/measure.mjs"
import { parseUsageLine, protocolOf, kindOf, createUsageReader } from "../lib/usage.mjs"
import { summarize } from "../lib/summarize.mjs"
import { onRequest, onResponse } from "../harnessweight.hooks.mjs"

const schema = { type: "object", properties: { path: { type: "string" } } }

test("measureTools reads all four protocol shapes", () => {
  assert.equal(measureTools({ tools: [{ name: "Read", description: "d", input_schema: schema }] }).count, 1) // anthropic
  assert.deepEqual(measureTools({ tools: [{ type: "function", function: { name: "shell", parameters: schema } }] }).names, ["shell"]) // chat
  assert.deepEqual(measureTools({ tools: [{ type: "namespace", tools: [{ type: "function", name: "a" }, { type: "function", name: "b" }] }] }).names, ["a", "b"]) // responses namespace
  assert.deepEqual(measureTools({ tools: [{ functionDeclarations: [{ name: "g1" }, { name: "g2" }] }] }).names, ["g1", "g2"]) // gemini
  assert.equal(measureTools({}).count, 0)
  assert.ok(measureTools({ tools: [{ name: "x", input_schema: schema }] }).bytes > 0)
})

test("usage lines: protocol, failure, cancel, clients", () => {
  assert.equal(protocolOf("/v1/chat/completions → /v1/messages"), "anthropic")
  assert.equal(protocolOf("/v1/chat/completions → /v1internal:streamGenerateContent?alt=sse"), "gemini")
  const ok = parseUsageLine(JSON.stringify({ t: "2026-11-09T10:00:00+08:00", agent: "dsh", model: "m", status: 200, in: 10, cache_read: 90, out: 5 }))
  assert.equal(ok.failed, false); assert.equal(ok.cacheRead, 90)
  assert.equal(parseUsageLine(JSON.stringify({ t: 1, agent: "a", status: 502 })).failed, true)
  const c = parseUsageLine(JSON.stringify({ t: 1, agent: "a", status: 499 }))
  assert.equal(c.failed, false); assert.equal(c.cancelled, true)
  assert.equal(parseUsageLine("{broken"), null)
  assert.equal(kindOf("curl"), "client"); assert.equal(kindOf("ai"), "client"); assert.equal(kindOf("magpie"), "client"); assert.equal(kindOf("dsh"), "agent")
})

test("summarize groups by agent, hides clients, computes cache rate", () => {
  const now = Date.now()
  const r = (agent, inp, cr, failed = false) => ({ t: now - 1000, agent, model: "m", protocol: "anthropic", in: inp, out: 1, cacheRead: cr, cacheWrite: 0, credits: 0, ms: 100, ttft: 10, failed, cancelled: false })
  const usage = [...Array(30)].map(() => r("a", 10, 90)).concat([...Array(30)].map(() => r("b", 50, 50)), [r("curl", 1, 0)])
  const s = summarize({ usage, period: "7d", now })
  assert.deepEqual(s.agents.map((x) => x.agent).sort(), ["a", "b"])
  assert.equal(s.hiddenClients, 1)
  const a = s.agents.find((x) => x.agent === "a")
  assert.equal(a.cacheRate, 0.9)
  assert.ok(s.insights.some((i) => i.kind === "cache"))
  assert.equal(summarize({ usage, period: "7d", now, showClients: true }).agents.length, 3)
})

test("usage reader is incremental and skips a half-written last line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "al-"))
  const f = join(dir, "usage.jsonl")
  const line = (n) => JSON.stringify({ t: new Date().toISOString(), agent: "x" + n, status: 200, in: 1 }) + "\n"
  await writeFile(f, line(1) + line(2) + '{"t":"half')
  const r = createUsageReader(f)
  await r.refresh(); assert.equal(r.rows().length, 2)
  await appendFile(f, '-written"}\n' + line(3))
  await r.refresh(); assert.equal(r.rows().length, 3)
})

test("hook never changes the request and writes only names and numbers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "al-"))
  const body = { model: "m", messages: [{ role: "user", content: "SECRET PROMPT" }], tools: [{ name: "Read", input_schema: schema }] }
  const ctx = { agent: "dsh", protocol: "anthropic", model: "m", options: { dataDir: dir } }
  assert.equal(await onRequest(structuredClone(body), ctx), undefined)
  await onResponse({ usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5 } }, { ...ctx, request: body, success: true })
  const text = await readFile(join(dir, "tools.jsonl"), "utf8")
  const row = JSON.parse(text.trim())
  assert.equal(row.agent, "dsh"); assert.equal(row.tools, 1); assert.deepEqual(row.toolNames, ["Read"]); assert.equal(row.cacheRead, 5)
  assert.ok(!text.includes("SECRET"))
})

test("insights ignore clients and use display names", () => {
  const now = Date.now()
  const r = (agent, inp, cr) => ({ t: now - 1000, agent, model: "m", protocol: "chat", in: inp, out: 1, cacheRead: cr, cacheWrite: 0, credits: 0, ms: 1, ttft: 1, failed: false, cancelled: false })
  const usage = [...Array(30)].flatMap(() => [r("a", 10, 90), r("b", 50, 50), r("curl", 1, 0)])
  const s = summarize({ usage, period: "7d", now, showClients: true, nameOf: (x) => ({ a: "Agent A" })[x] || x })
  assert.ok(s.insights.every((i) => !i.text.includes("curl")))
  assert.ok(s.insights.some((i) => i.text.includes("Agent A")))
})

test("brands come from the gateway and fall back softly", async () => {
  const { createBrands } = await import("../lib/brands.mjs")
  const ok = createBrands({}, async () => ({ ok: true, json: async () => ({ agents: [{ id: "claude", name: "Claude Code", icon: "claudecode-color" }, { id: "x", name: "X", icon: "generic" }] }) }))
  await ok.refresh()
  assert.deepEqual(ok.of("claude"), { name: "Claude Code", icon: "claudecode-color.svg" })
  assert.equal(ok.of("x").icon, null)
  assert.match(await ok.dataUri("claudecode-color.svg"), /^data:image\/svg\+xml;base64,/)
  const down = createBrands({}, async () => { throw new Error("down") })
  await down.refresh()
  assert.equal(down.of("codex").name, "codex")
})
