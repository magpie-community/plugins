import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

// Expose private seams from an isolated copy, without adding production exports.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-truncated-replay-test-"))
const entry = new URL("../index.mjs", import.meta.url)
let source = fs.readFileSync(entry, "utf8")
source = source.replace(/from "(\.\/[^"\n]+)"/g, (_, target) => `from ${JSON.stringify(new URL(target, entry).href)}`)
fs.writeFileSync(
  path.join(workspace, "bridge.mjs"),
  source + "\nexport { Proc, Turn, beginTurn, clientReportedUsage, compactTargetTokens, estimateInputTokens, estimatePromptPartsTokens, makeAnthropicStream, renderInitialPromptParts, renderInitialPromptReport, settleUsage };\n",
)
const {
  Proc,
  Turn,
  beginTurn,
  clientReportedUsage,
  compactTargetTokens,
  estimateInputTokens,
  estimatePromptPartsTokens,
  makeAnthropicStream,
  renderInitialPromptParts,
  renderInitialPromptReport,
  settleUsage,
} = await import(pathToFileURL(path.join(workspace, "bridge.mjs")).href)
afterAll(() => {
  try { fs.rmSync(workspace, { recursive: true, force: true }) } catch {}
})

const tempDirs = []
const savedEnv = {
  AGY_BRIDGE_COMPACT_TARGET: process.env.AGY_BRIDGE_COMPACT_TARGET,
  AGY_BRIDGE_OVERLAY_TOOL_STEPS: process.env.AGY_BRIDGE_OVERLAY_TOOL_STEPS,
  AGY_BRIDGE_MAX_PROMPT_BYTES: process.env.AGY_BRIDGE_MAX_PROMPT_BYTES,
  AGY_BRIDGE_STEP_USAGE: process.env.AGY_BRIDGE_STEP_USAGE,
  AGY_BRIDGE_EVENTS: process.env.AGY_BRIDGE_EVENTS,
}

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})

function makeTmpDir(prefix = "agy-replay-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function makeConversationBody({ turns = 40, bytesPerMessage = 4000, systemBytes = 0, extraTools = 0 } = {}) {
  const messages = []
  const chunk = "x".repeat(Math.max(16, bytesPerMessage))
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `turn-${i}-user: ${chunk}` })
    messages.push({
      role: "assistant",
      content: [
        { type: "tool_use", id: `toolu_${i}`, name: "Read", input: { file_path: `/tmp/file_${i}.txt` } },
      ],
    })
    messages.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `toolu_${i}`, content: `result-${i}: ${chunk}` },
      ],
    })
    messages.push({ role: "assistant", content: `turn-${i}-reply: ok` })
  }
  messages.push({ role: "user", content: "latest user question: please summarize next step" })
  const tools = extraTools > 0
    ? Array.from({ length: extraTools }, (_, i) => ({
      name: `tool_${i}`,
      description: "d".repeat(200),
      input_schema: { type: "object", properties: { arg: { type: "string" } } },
    }))
    : undefined
  return {
    model: "gemini-4-hydrogen",
    system: systemBytes > 0 ? "S".repeat(systemBytes) : "You are a helpful coding assistant.",
    messages,
    ...(tools ? { tools } : {}),
  }
}

function encodeVarint(n) {
  const out = []
  let v = n >>> 0
  let hi = Math.floor(n / 0x100000000)
  while (hi > 0 || v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v = ((v >>> 7) | ((hi & 0x7f) << 25)) >>> 0
    hi = Math.floor(hi / 128)
  }
  out.push(v & 0x7f)
  return Uint8Array.from(out)
}

function encodeFieldVarint(field, val) {
  return Uint8Array.from([...encodeVarint((field << 3) | 0), ...encodeVarint(val)])
}

function encodeFieldBytes(field, bytes) {
  return Uint8Array.from([...encodeVarint((field << 3) | 2), ...encodeVarint(bytes.length), ...bytes])
}

function concatBytes(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const a of arrays) {
    out.set(a, offset)
    offset += a.length
  }
  return out
}

function encodeGenerationData({ input = 0, output = 0, write = 0, read = 0, thinking = 0, context = null } = {}) {
  const usageBytes = concatBytes(
    input ? encodeFieldVarint(2, input) : new Uint8Array(0),
    output ? encodeFieldVarint(3, output) : new Uint8Array(0),
    write ? encodeFieldVarint(4, write) : new Uint8Array(0),
    read ? encodeFieldVarint(5, read) : new Uint8Array(0),
    thinking ? encodeFieldVarint(9, thinking) : new Uint8Array(0),
  )
  const parts = [encodeFieldBytes(4, usageBytes)]
  if (context != null) {
    parts.push(encodeFieldBytes(9, encodeFieldBytes(10, encodeFieldBytes(1, encodeFieldVarint(1, context)))))
  }
  return encodeFieldBytes(1, concatBytes(...parts))
}

function createStepsDb(dir, rows) {
  const file = path.join(dir, "session.db")
  const db = new Database(file)
  db.run("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
  const stmt = db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)")
  for (const row of rows) {
    stmt.run(row.idx, encodeGenerationData(row.usage))
  }
  db.close()
  return file
}

async function readSseEvents(stream) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()
  const events = []
  for (const block of text.split("\n\n")) {
    const lines = block.trim().split("\n")
    let eventName = null
    let dataLine = null
    for (const line of lines) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim()
      else if (line.startsWith("data:")) dataLine = line.slice(5).trim()
    }
    if (eventName && dataLine) events.push({ event: eventName, data: JSON.parse(dataLine) })
  }
  return events
}

describe("renderInitialPromptReport & beginTurn truncation detection", () => {
  test("does not mark untruncated conversations with many small tool calls as truncated", async () => {
    process.env.AGY_BRIDGE_EVENTS = "0"
    const body = makeConversationBody({ turns: 30, bytesPerMessage: 60 })
    const report = renderInitialPromptReport(body, null, false)
    expect(report.truncated).toBe(false)
    expect(renderInitialPromptParts(body, null, false)).toEqual(report.parts)

    const proc = new Proc("agy", "conv-untruncated", { workDir: null, instructions: "" })
    let startedParts = null
    proc.startTurn = (parts, messages) => {
      startedParts = parts
      return new Turn(proc, messages)
    }
    await beginTurn(proc, [], body, null, "gemini-4-hydrogen", { model: "gemini-4-hydrogen" }, new Set())
    expect(startedParts).not.toBeNull()
    expect(proc.promptTruncated).toBe(false)
    expect(proc.omittedHistoryTokens).toBe(0)
  })

  test("marks long replay >112 KiB as truncated and records omittedHistoryTokens", async () => {
    process.env.AGY_BRIDGE_EVENTS = "0"
    const body = makeConversationBody({ turns: 60, bytesPerMessage: 8000 })
    const report = renderInitialPromptReport(body, null, false)
    expect(report.truncated).toBe(true)

    const proc = new Proc("agy", "conv-long", { workDir: null, instructions: "" })
    proc.startTurn = (_parts, messages) => new Turn(proc, messages)
    await beginTurn(proc, [], body, null, "gemini-4-hydrogen", { model: "gemini-4-hydrogen" }, new Set())
    expect(proc.promptTruncated).toBe(true)
    expect(proc.omittedHistoryTokens).toBeGreaterThan(200_000)

    const rawEstimate = estimateInputTokens(body)
    expect(proc.estimatePromptTokens(body)).toBe(Math.max(1, rawEstimate - proc.omittedHistoryTokens))
  })
})

describe("clientReportedUsage and 350K compaction target linkage", () => {
  test("leaves normal untruncated usage untouched", () => {
    const proc = new Proc("agy", "conv-normal", {})
    proc.omittedHistoryTokens = 0
    const raw = { input_tokens: 3400, cache_read_input_tokens: 52600, cache_creation_input_tokens: 0, output_tokens: 450 }
    expect(clientReportedUsage(proc, { rawInputEstimate: 60000 }, raw)).toEqual(raw)
  })

  test("preserves zero-usage agy_same_generation steps even when omittedHistoryTokens > 0", () => {
    const proc = new Proc("agy", "conv-samegen", {})
    proc.omittedHistoryTokens = 300_000
    const zero = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 }
    expect(clientReportedUsage(proc, { rawInputEstimate: 360_000 }, zero)).toEqual(zero)
  })

  test("overlays omitted history for truncated replay below 350K without premature compaction", () => {
    const proc = new Proc("agy", "conv-mid", {})
    proc.omittedHistoryTokens = 130_000
    const raw = { input_tokens: 4000, cache_read_input_tokens: 52000, cache_creation_input_tokens: 0, output_tokens: 500 }
    const out = clientReportedUsage(proc, { rawInputEstimate: 186_000 }, raw)
    const totalContext = out.input_tokens + out.cache_read_input_tokens + out.cache_creation_input_tokens
    expect(totalContext).toBe(186_000)
    expect(totalContext).toBeLessThan(compactTargetTokens())
    expect(out.input_tokens).toBe(4000)
    expect(out.output_tokens).toBe(500)
  })

  test("guarantees >= 350K reported context when raw payload meets 350K even if agy tokenizer undercounts", () => {
    const proc = new Proc("agy", "conv-350k", {})
    proc.omittedHistoryTokens = 304_000
    const raw = { input_tokens: 2000, cache_read_input_tokens: 36000, cache_creation_input_tokens: 0, output_tokens: 900 }
    const out = clientReportedUsage(proc, { rawInputEstimate: 360_000 }, raw)
    const totalContext = out.input_tokens + out.cache_read_input_tokens + out.cache_creation_input_tokens
    expect(totalContext).toBe(360_000)
    expect(totalContext).toBeGreaterThanOrEqual(350_000)
    expect(out.input_tokens).toBe(2000)
    expect(out.cache_read_input_tokens).toBe(358_000)
  })

  test("surfaces full 1.3M+ context so uncompacted mega-payloads compact immediately", () => {
    const proc = new Proc("agy", "conv-1m3", {})
    proc.omittedHistoryTokens = 1_244_000
    const raw = { input_tokens: 3000, cache_read_input_tokens: 53000, cache_creation_input_tokens: 0, output_tokens: 800 }
    const out = clientReportedUsage(proc, { rawInputEstimate: 1_300_000 }, raw)
    expect(out.input_tokens + out.cache_read_input_tokens).toBe(1_300_000)
  })

  test("supports AGY_BRIDGE_COMPACT_TARGET override and disable", () => {
    process.env.AGY_BRIDGE_COMPACT_TARGET = "200000"
    expect(compactTargetTokens()).toBe(200_000)
    process.env.AGY_BRIDGE_COMPACT_TARGET = "0"
    expect(compactTargetTokens()).toBe(0)
  })

  test("isolates internal inputTokenScale and lastCacheRatio calibration from omitted-history overlay", () => {
    const proc = new Proc("agy", "conv-cal", {})
    const body = makeConversationBody({ turns: 60, bytesPerMessage: 8000 })
    const rawEstimate = estimateInputTokens(body)
    proc.omittedHistoryTokens = rawEstimate - 42_000
    const turn = new Turn(proc, body.messages)
    const step = turn.registerResponse(body)
    expect(step.rawInputEstimate).toBe(rawEstimate)
    expect(step.inputEstimate).toBe(42_000)

    const agyTotal = Math.round(step.inputEstimate * 1.1)
    const agyRead = Math.round(agyTotal * 0.9)
    const rawUsage = {
      input_tokens: agyTotal - agyRead,
      cache_read_input_tokens: agyRead,
      cache_creation_input_tokens: 0,
      output_tokens: 400,
    }
    const clientUsage = clientReportedUsage(proc, step, rawUsage)
    turn.recordResponseUsage(step, clientUsage, true, true, rawUsage)

    expect(proc.inputTokenScale).toBeCloseTo(1.1, 2)
    expect(proc.lastCacheRatio).toBeCloseTo(0.9, 2)
    expect(step.usage.input_tokens + step.usage.cache_read_input_tokens).toBeGreaterThanOrEqual(rawEstimate)
  })
})

describe("end-to-end SSE stream usage with SQLite store and fallback", () => {
  test("truncated session_new keeps tool_use steps scoped to agy window by default and surfaces >=350K on end_turn", async () => {
    process.env.AGY_BRIDGE_EVENTS = "0"
    const dir = makeTmpDir()
    const stepsFile = createStepsDb(dir, [
      { idx: 1, usage: { input: 3500, read: 52500, write: 0, output: 150, thinking: 20, context: 56000 } },
    ])

    const body1 = makeConversationBody({ turns: 90, bytesPerMessage: 8000 })
    const rawEst1 = estimateInputTokens(body1)
    expect(rawEst1).toBeGreaterThanOrEqual(350_000)

    const proc = new Proc("agy", "conv-e2e-sqlite", { workDir: dir, instructions: "" })
    proc.recordAssistantResponse = () => {}
    proc.finalizeTurn = () => {}
    proc.startTurn = (parts, messages) => {
      const turn = new Turn(proc, messages)
      turn.stepsFile = stepsFile
      turn.stepCursor = { source: "gen_metadata", idx: 0 }
      turn.sentBytes = estimatePromptPartsTokens(parts)
      return turn
    }

    const turn1 = await beginTurn(proc, [], body1, null, "gemini-4-hydrogen", { model: "gemini-4-hydrogen" }, new Set())
    expect(proc.omittedHistoryTokens).toBeGreaterThan(250_000)

    // Step 1: intermediate tool_use keeps raw agy window (< 120K) by default
    const toolStream = makeAnthropicStream(proc, turn1, body1, "msg_t1_tool")
    turn1.push({ type: "tool", call: { id: "call_1", name: "Read", arguments: { file_path: "/tmp/a.txt" } } })
    const toolEvents = await readSseEvents(toolStream)
    const toolDelta = toolEvents.find((e) => e.event === "message_delta")
    expect(toolDelta.data.usage.input_tokens + toolDelta.data.usage.cache_read_input_tokens).toBe(56_000)

    // Step 2: agy completes generation 2 and final end_turn overlays omitted history context (>= 350K)
    {
      const db = new Database(stepsFile)
      db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(
        2,
        encodeGenerationData({ input: 1800, read: 55200, write: 0, output: 600, thinking: 200, context: 57000 }),
      )
      db.close()
    }
    const stream1 = makeAnthropicStream(proc, turn1, body1, "msg_t1_end")
    turn1.push({ type: "text", text: "Hello from truncated replay." })
    turn1.push({
      type: "result",
      result: { stopReason: "end_turn", usage: { inputTokens: 5300, cachedReadTokens: 107700, outputTokens: 750, thoughtTokens: 220, totalTokens: 113750 } },
    })

    const events1 = await readSseEvents(stream1)
    const delta1 = events1.find((e) => e.event === "message_delta")
    const reported1 = delta1.data.usage.input_tokens + delta1.data.usage.cache_read_input_tokens + delta1.data.usage.cache_creation_input_tokens
    expect(reported1).toBeGreaterThanOrEqual(rawEst1)
    expect(reported1).toBeGreaterThanOrEqual(350_000)
    expect(proc.lastCacheRatio).toBeCloseTo(55200 / 57000, 3)

    // Turn 2 on same live proc (!isFirstTurn): client adds 20K more tokens, SQLite records 76K live context
    const db = new Database(stepsFile)
    db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(
      3,
      encodeGenerationData({ input: 2000, read: 74000, write: 0, output: 300, thinking: 50, context: 76000 }),
    )
    db.close()

    const body2 = {
      ...body1,
      messages: [
        ...body1.messages,
        { role: "assistant", content: "Hello from truncated replay." },
        { role: "user", content: "follow-up: " + "y".repeat(80_000) },
      ],
    }
    const rawEst2 = estimateInputTokens(body2)
    proc.hasSentFirstTurn = true
    proc.startTurn = (_parts, messages) => {
      const turn = new Turn(proc, messages)
      turn.stepsFile = stepsFile
      turn.stepCursor = { source: "gen_metadata", idx: 2 }
      return turn
    }
    const turn2 = await beginTurn(proc, body1.messages, body2, null, "gemini-4-hydrogen", { model: "gemini-4-hydrogen" }, new Set())
    const stream2 = makeAnthropicStream(proc, turn2, body2, "msg_t2")
    turn2.push({ type: "text", text: "Continued answer." })
    turn2.push({
      type: "result",
      result: { stopReason: "end_turn", usage: { inputTokens: 2000, cachedReadTokens: 74000, outputTokens: 300, thoughtTokens: 50, totalTokens: 76300 } },
    })

    const events2 = await readSseEvents(stream2)
    const delta2 = events2.find((e) => e.event === "message_delta")
    const reported2 = delta2.data.usage.input_tokens + delta2.data.usage.cache_read_input_tokens + delta2.data.usage.cache_creation_input_tokens
    expect(reported2).toBeGreaterThanOrEqual(rawEst2)
    expect(reported2).toBeGreaterThan(reported1)
  })

  test("AGY_BRIDGE_OVERLAY_TOOL_STEPS=1 enables overlay on intermediate tool_use steps", async () => {
    process.env.AGY_BRIDGE_EVENTS = "0"
    process.env.AGY_BRIDGE_OVERLAY_TOOL_STEPS = "1"
    const dir = makeTmpDir()
    const stepsFile = createStepsDb(dir, [
      { idx: 1, usage: { input: 3500, read: 52500, write: 0, output: 150, thinking: 20, context: 56000 } },
    ])
    const body = makeConversationBody({ turns: 90, bytesPerMessage: 8000 })
    const rawEst = estimateInputTokens(body)

    const proc = new Proc("agy", "conv-tool-overlay", { workDir: dir, instructions: "" })
    proc.recordAssistantResponse = () => {}
    proc.finalizeTurn = () => {}
    proc.startTurn = (_parts, messages) => {
      const turn = new Turn(proc, messages)
      turn.stepsFile = stepsFile
      turn.stepCursor = { source: "gen_metadata", idx: 0 }
      return turn
    }

    const turn = await beginTurn(proc, [], body, null, "gemini-4-hydrogen", { model: "gemini-4-hydrogen" }, new Set())
    const stream = makeAnthropicStream(proc, turn, body, "msg_tool_ov")
    turn.push({ type: "tool", call: { id: "call_ov", name: "Read", arguments: { file_path: "/tmp/a.txt" } } })
    const events = await readSseEvents(stream)
    const delta = events.find((e) => e.event === "message_delta")
    expect(delta.data.usage.input_tokens + delta.data.usage.cache_read_input_tokens).toBeGreaterThanOrEqual(rawEst)
  })

  test("truncated session_new fallback (no SQLite store) still reports full context via responseUsage", async () => {
    process.env.AGY_BRIDGE_EVENTS = "0"
    const body = makeConversationBody({ turns: 90, bytesPerMessage: 8000 })
    const rawEst = estimateInputTokens(body)

    const proc = new Proc("agy", "conv-e2e-fallback", { workDir: null, instructions: "" })
    proc.recordAssistantResponse = () => {}
    proc.finalizeTurn = () => {}
    proc.startTurn = (_parts, messages) => {
      const turn = new Turn(proc, messages)
      turn.stepsFile = null
      turn.stepCursor = null
      return turn
    }

    const turn = await beginTurn(proc, [], body, null, "gemini-4-hydrogen", { model: "gemini-4-hydrogen" }, new Set())
    const stream = makeAnthropicStream(proc, turn, body, "msg_fb")
    turn.push({ type: "text", text: "Fallback answer." })
    turn.push({
      type: "result",
      result: { stopReason: "end_turn", usage: { inputTokens: 56000, cachedReadTokens: 0, outputTokens: 200, totalTokens: 56200 } },
    })

    const events = await readSseEvents(stream)
    const delta = events.find((e) => e.event === "message_delta")
    const reported = delta.data.usage.input_tokens + delta.data.usage.cache_read_input_tokens
    expect(reported).toBeGreaterThanOrEqual(rawEst)
    expect(reported).toBeGreaterThanOrEqual(350_000)

    const settled = await settleUsage(proc, turn, turn.currentResponse, [{ type: "text", text: "Fallback answer." }], { stopReason: "end_turn" })
    expect(settled.input_tokens + settled.cache_read_input_tokens).toBe(reported)
  })

  test("normal untruncated SSE stream returns exact agy SQLite usage with zero overlay", async () => {
    process.env.AGY_BRIDGE_EVENTS = "0"
    const dir = makeTmpDir()
    const stepsFile = createStepsDb(dir, [
      { idx: 1, usage: { input: 1200, read: 8800, write: 0, output: 250, thinking: 50, context: 10000 } },
    ])
    const body = makeConversationBody({ turns: 4, bytesPerMessage: 200 })
    const proc = new Proc("agy", "conv-e2e-normal", { workDir: dir, instructions: "" })
    proc.recordAssistantResponse = () => {}
    proc.finalizeTurn = () => {}
    proc.startTurn = (_parts, messages) => {
      const turn = new Turn(proc, messages)
      turn.stepsFile = stepsFile
      turn.stepCursor = { source: "gen_metadata", idx: 0 }
      return turn
    }

    const turn = await beginTurn(proc, [], body, null, "gemini-4-hydrogen", { model: "gemini-4-hydrogen" }, new Set())
    expect(proc.omittedHistoryTokens).toBe(0)
    const stream = makeAnthropicStream(proc, turn, body, "msg_norm")
    turn.push({ type: "text", text: "Short reply." })
    turn.push({
      type: "result",
      result: { stopReason: "end_turn", usage: { inputTokens: 1200, cachedReadTokens: 8800, outputTokens: 250, thoughtTokens: 50, totalTokens: 10250 } },
    })

    const events = await readSseEvents(stream)
    const delta = events.find((e) => e.event === "message_delta")
    expect(delta.data.usage).toEqual({
      input_tokens: 1200,
      cache_read_input_tokens: 8800,
      cache_creation_input_tokens: 0,
      output_tokens: 250,
      output_tokens_details: { thinking_tokens: 50 },
    })
  })
})
