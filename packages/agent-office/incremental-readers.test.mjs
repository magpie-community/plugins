import { expect, test } from "bun:test"
import { createSessionReader, finalizeUsage, readClaude, readCodex, readDsh, readGemini, readPi, readCopilot, readKimi, readGrok, MESSAGES_MAX, MESSAGE_TEXT_MAX, TEXT_MAX } from "./lib/readers.mjs"

const now = new Date(2026, 9, 30, 12).getTime()
const nextDay = new Date(2026, 9, 31, 12).getTime()
const iso = (t = now) => new Date(t).toISOString()
const j = JSON.stringify
const claude = (role, content, extra = {}, t = now) => ({ type: role, timestamp: iso(t), message: { role, content, ...extra } })
const codex = (type, payload, t = now) => ({ type, timestamp: iso(t), payload })
const dsh = (type, data = {}) => ({ type, time: iso(), data })
const pi = (role, content, extra = {}) => ({ type: "message", timestamp: iso(), message: { role, content, ...extra } })
const copilot = (type, data = {}) => ({ type, timestamp: iso(), data })
const kimi = (type, extra = {}) => ({ type, time: iso(), ...extra })
const grok = (type, text = "", extra = {}, meta = {}) => ({ timestamp: now / 1000, params: { update: { sessionUpdate: type, content: { text }, ...extra }, _meta: meta } })
const fullReaders = {
  claude: (text) => readClaude(text, "claude", "id", { now }),
  codex: (text) => readCodex(text, "id", { now }),
  dsh: (text) => readDsh(text, "id", { now }),
  gemini: (text) => readGemini(text, "gemini", "id", { now }),
  pi: (text) => readPi(text, "pi", "id", { now }),
  copilot: (text) => readCopilot(text, "id", { now }),
  kimi: (text) => readKimi(text, "id", {}, { now }),
  grok: (text) => readGrok(text, "id", {}, { now }),
}
const fixtures = {
  claude: [
    claude("user", "first"),
    claude("assistant", [{ type: "tool_use", id: "t", name: "Bash", input: { command: "echo secret" } }], { id: "r", usage: { input_tokens: 100, output_tokens: 2 } }),
    claude("user", [{ type: "tool_result", tool_use_id: "t", content: "result" }]),
    claude("assistant", [{ type: "text", text: "done" }], { id: "r", usage: { input_tokens: 100, output_tokens: 8 }, stop_reason: "end_turn" }),
    claude("user", "second"),
    claude("assistant", [{ type: "text", text: "second reply" }], { id: "r2", usage: { input_tokens: 50, output_tokens: 3 }, stop_reason: "end_turn" }),
  ],
  codex: [
    codex("event_msg", { type: "user_message", message: "first" }),
    codex("response_item", { type: "function_call", call_id: "t", name: "shell", arguments: { command: "echo secret" } }),
    codex("event_msg", { type: "exec_approval_request", command: "echo secret" }),
    codex("response_item", { type: "function_call_output", call_id: "t", output: "result" }),
    codex("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 8 }, model_context_window: 200000 } }),
    codex("event_msg", { type: "task_complete", last_agent_message: "done" }),
    codex("event_msg", { type: "user_message", message: "second" }),
    codex("event_msg", { type: "turn_aborted" }),
  ],
  dsh: [
    dsh("user/message", { source: { kind: "user" }, content: "first" }),
    dsh("turn/start"),
    dsh("tool/call", { callId: "t", name: "shell", arguments: {} }),
    dsh("approval/asked"),
    dsh("approval/decided"),
    dsh("tool/result", { message: { toolCallId: "t" } }),
    dsh("assistant/message", { message: { content: [{ type: "text", text: "done" }] } }),
    dsh("turn/end", { reason: { kind: "completed" } }),
    dsh("user/message", { source: { kind: "user" }, content: "second" }),
  ],
  gemini: [
    { type: "user", timestamp: iso(), content: "first" },
    { type: "gemini", timestamp: iso(), toolCalls: [{ id: "t", name: "shell", status: "awaiting_approval" }] },
    { type: "gemini", timestamp: iso(), toolCalls: [{ id: "t", name: "shell", status: "executing" }] },
    { type: "gemini", timestamp: iso(), toolCalls: [{ id: "t", name: "shell", status: "success" }] },
    { type: "gemini", timestamp: iso(), content: "done" },
    { type: "user", timestamp: iso(), content: "second" },
    { type: "gemini", timestamp: iso(), toolCalls: [{ id: "t2", name: "shell", status: "executing" }] },
  ],
  pi: [
    pi("user", "first"),
    pi("assistant", [{ type: "toolCall", id: "t", name: "shell", arguments: {} }], { stopReason: "toolUse" }),
    pi("toolResult", "result", { toolCallId: "t" }),
    pi("assistant", [{ type: "text", text: "done" }], { stopReason: "stop" }),
    pi("user", "second"),
    pi("assistant", [], { stopReason: "aborted" }),
  ],
  copilot: [
    copilot("session.start", { context: { cwd: "/project" }, selectedModel: "model" }),
    copilot("user.message", { content: "first" }),
    copilot("tool.execution_start", { toolCallId: "t", toolName: "shell" }),
    copilot("tool.execution_complete", { toolCallId: "t" }),
    copilot("assistant.message", { content: "done" }),
    copilot("session.end"),
    copilot("user.message", { content: "second" }),
  ],
  kimi: [
    kimi("turn.prompt", { input: "first" }),
    kimi("context.append_loop_event", { event: { type: "content.part", part: { type: "text", text: "hello " } } }),
    kimi("context.append_loop_event", { event: { type: "content.part", part: { type: "text", text: "world" } } }),
    kimi("context.append_loop_event", { event: { type: "tool.call", toolCallId: "t", name: "shell", arguments: {} } }),
    kimi("interaction.request", { id: "a", kind: "approval" }),
    kimi("context.append_loop_event", { event: { type: "tool.result", toolCallId: "t" } }),
    kimi("interaction.resolved", { id: "a" }),
    kimi("usage.record", { usage: { inputTokens: 100, outputTokens: 8 } }),
    kimi("turn.ended", { reason: "completed" }),
    kimi("turn.prompt", { input: "second" }),
    kimi("context.append_loop_event", { event: { type: "content.part", part: { type: "text", text: "second reply" } } }),
  ],
  grok: [
    grok("user_message_chunk", "first ", {}, { turnStartMs: now }),
    grok("user_message_chunk", "prompt", {}, { turnStartMs: now }),
    grok("agent_message_chunk", "hello ", {}, { streamStartMs: now + 1 }),
    grok("agent_message_chunk", "world", {}, { streamStartMs: now + 1 }),
    grok("tool_call", "", { toolCallId: "t", title: "shell", status: "in_progress" }),
    grok("tool_call_update", "", { toolCallId: "t", title: "shell renamed", status: "in_progress" }),
    grok("tool_call_update", "", { toolCallId: "t", status: "completed" }),
    grok("turn_completed"),
    grok("user_message_chunk", "second", {}, { turnStartMs: now + 2 }),
    grok("agent_message_chunk", "second reply", {}, { streamStartMs: now + 3 }),
  ],
}

for (const [kind, events] of Object.entries(fixtures)) {
  test(`${kind}: appended batches match one-shot parsing at every boundary`, () => {
    const rows = events.map(j)
    for (const width of [1, 2, 3, 5]) {
      const reader = createSessionReader(kind, kind, "id", { now })
      const stable = reader.session
      for (let i = 0; i < rows.length; i += width) {
        const end = Math.min(i + width, rows.length)
        expect(reader.update(rows.slice(i, end))).toBe(stable)
        expect(stable).toEqual(fullReaders[kind](rows.slice(0, end).join("\n")))
        const snapshot = structuredClone(stable)
        expect(reader.update([], { now })).toEqual(snapshot)
      }
      expect(stable.turns).toBe(2)
      expect(stable.messages.length).toBeLessThanOrEqual(MESSAGES_MAX)
      expect(stable.messages.some((m) => m.text.includes("secret"))).toBe(false)
    }
  })
}

test("Claude: interleaved response IDs replace their prior usage and move days", () => {
  const before = new Date(2026, 9, 30, 23, 59, 59).getTime()
  const after = new Date(2026, 9, 31, 0, 0, 1).getTime()
  const r = createSessionReader("claude", "claude", "id", { now: before })
  const usage = (id, output, t) => j(claude("assistant", [], { id, usage: { input_tokens: 100, cache_creation_input_tokens: 5, cache_read_input_tokens: 50, output_tokens: output } }, t))
  r.update([j(claude("user", "first", {}, before)), usage("a", 1, before), usage("b", 10, before)])
  expect(r.session).toMatchObject({ tokensToday: 221, turnsToday: 1, context: 165 })
  r.update([usage("a", 20, after)], { now: after })
  expect(r.session).toMatchObject({ tokensToday: 125, turnsToday: 0, context: 175 })
  r.update([usage("a", 20, after)], { now: after })
  expect(r.session.tokensToday).toBe(125)
  r.update([], { now: before })
  expect(r.session).toMatchObject({ tokensToday: 115, turnsToday: 1 })
  // A later correction may lower an already-accounted response total.
  r.update([usage("a", 2, before)], { now: before })
  expect(r.session.tokensToday).toBe(222)
  r.update([], { now: after })
  expect(r.session.tokensToday).toBe(0)
})

test("Gemini: tool dedupe survives batches and approval transitions", () => {
  const r = createSessionReader("gemini")
  for (const event of fixtures.gemini) r.update([j(event)], { now })
  expect(r.session.messages.filter((m) => m.role === "tool")).toHaveLength(2)
  expect(r.session.pending).toMatchObject([{ id: "t2", name: "shell" }])
  expect(r.session.phase).toBe("tool")
  r.update([j({ type: "gemini", timestamp: iso(), content: "finished" })], { now })
  expect(r.session.pending).toHaveLength(0)
  expect(r.session.phase).toBe("done")
})

test("Grok: metadata and replacement sidecar usage refresh without log input", () => {
  const r = createSessionReader("grok", "grok", "id", { now })
  r.update(fixtures.grok.map(j))
  const messages = structuredClone(r.session.messages)
  const turns = r.session.turns
  const usage = { turns: [
    { endedAt: iso(), inputTokens: 100, cachedReadTokens: 40, outputTokens: 8 },
    { endedAt: iso(nextDay), inputTokens: 20, outputTokens: 3 },
  ] }
  const meta = { info: { cwd: "/new" }, generated_title: "Renamed", current_model_id: "grok-new", session_kind: "subagent_worker", parent_session_id: "parent" }
  r.update([], { meta, usage, now })
  expect(r.session).toMatchObject({ cwd: "/new", project: "new", title: "Renamed", model: "grok-new", tokensToday: 68, turnsToday: 2, subagent: true, parent: "parent" })
  r.update([], { meta, usage, now })
  expect(r.session.tokensToday).toBe(68)
  usage.turns[0].outputTokens = 12
  r.update([], { usage, now })
  expect(r.session.tokensToday).toBe(72)
  r.update([], { now: nextDay })
  expect(r.session).toMatchObject({ tokensToday: 23, turnsToday: 0 })
  expect(r.session.messages).toEqual(messages)
  expect(r.session.turns).toBe(turns)
  r.update([], { usage: null, now })
  expect(r.session.tokensToday).toBe(0)
  expect(r.session.turnsToday).toBe(2)
})

test("Kimi: metadata refresh preserves approval and active reply text", () => {
  const r = createSessionReader("kimi", "kimi", "parent/child", { now })
  r.update([j(kimi("turn.prompt", { input: "hello" })), j(kimi("context.append_loop_event", { event: { type: "content.part", part: { type: "text", text: "hello " } } })), j(kimi("interaction.request", { id: "a", kind: "question" }))])
  r.update([], { meta: { cwd: "/new", title: "new title", modelAlias: "kimi-new" }, now })
  expect(r.session).toMatchObject({ subagent: true, parent: "parent", phase: "ask", title: "new title", cwd: "/new", model: "kimi-new", turns: 1 })
  r.update([j(kimi("interaction.resolved", { id: "a" })), j(kimi("context.append_loop_event", { event: { type: "content.part", part: { type: "text", text: "world" } } }))])
  expect(r.session.reply).toBe("hello world")
})

const sidecars = {
  kimi: { title: "Named", cwd: "/old", modelAlias: "model", createdAt: iso(now - 10000) },
  grok: { title: "Named", info: { cwd: "/old" }, current_model_id: "model", session_kind: "subagent_worker", parent_session_id: "parent", created_at: iso(now - 10000) },
}
const readWithMeta = (kind, rows, meta, usage) => kind === "kimi"
  ? readKimi(rows.join("\n"), "id", meta, { now })
  : readGrok(rows.join("\n"), "id", meta, { now, usage })

for (const kind of ["kimi", "grok"]) {
  test(`${kind}: metadata snapshots replace all fields and restore parsed fallbacks`, () => {
    const usage = { turns: [{ endedAt: iso(), inputTokens: 100, outputTokens: 8 }] }
    const rows = fixtures[kind].map(j)
    for (const meta of [{}, null, undefined, { title: "Replacement" }, kind === "kimi" ? { cwd: "/new" } : { info: { cwd: "/new" } }, kind === "kimi" ? { model: "new-model" } : { current_model_id: "new-model" }, { parent_session_id: "orphan" }]) {
      const r = createSessionReader(kind, kind, "id", { now, meta: sidecars[kind], usage })
      const stable = r.session
      r.update(rows)
      expect(stable.title).toBe("Named")
      expect(r.update([], { meta })).toBe(stable)
      expect(stable).toEqual(readWithMeta(kind, rows, meta, usage))
      expect(stable.started).toBe(now)
      expect(stable.subagent).toBe(false)
      expect(stable.parent).toBe("")
      if (!meta?.title) expect(stable.title).toBe(kind === "kimi" ? "first" : "first prompt")
      const snapshot = structuredClone(stable)
      r.update([]) // omitting meta preserves the latest snapshot
      expect(stable).toEqual(snapshot)
      finalizeUsage(stable, nextDay)
      expect(stable).toMatchObject({ tokensToday: 0, turnsToday: 0 })
      finalizeUsage(stable, now)
      expect(stable.tokensToday).toBe(108)
      expect(stable.turnsToday).toBe(2)
    }
  })

  test(`${kind}: removing metadata between stream chunks preserves text, usage and first prompt`, () => {
    const prompt = (text) => kind === "kimi" ? kimi("turn.prompt", { input: text }) : grok("user_message_chunk", text, {}, { turnStartMs: now })
    const chunk = (text) => kind === "kimi" ? kimi("context.append_loop_event", { event: { type: "content.part", part: { type: "text", text } } }) : grok("agent_message_chunk", text, {}, { streamStartMs: now + 1 })
    const usage = { turns: [{ endedAt: iso(), inputTokens: 100, outputTokens: 8 }] }
    const r = createSessionReader(kind, kind, "id", { now, meta: sidecars[kind], usage })
    const rows = [j(prompt("first "))]
    r.update(rows)
    if (kind === "grok") {
      r.update([], { meta: null })
      rows.push(j(prompt("prompt")))
      r.update(rows.slice(-1))
      expect(r.session.title).toBe("first prompt")
    }
    if (kind === "kimi") {
      rows.push(j(kimi("usage.record", { usage: { inputTokens: 100, outputTokens: 8 } })))
      r.update(rows.slice(-1))
    }
    rows.push(j(chunk("hello ")))
    r.update(rows.slice(-1))
    const messages = structuredClone(r.session.messages)
    const counts = { turns: r.session.turns, turnsToday: r.session.turnsToday, tokensToday: r.session.tokensToday }
    for (const meta of [{ title: "Changed" }, {}, null]) {
      r.update([], { meta })
      expect(r.session.messages).toEqual(messages)
      expect(r.session).toMatchObject(counts)
    }
    rows.push(j(chunk("world")))
    r.update(rows.slice(-1))
    expect(r.session.reply).toBe("hello world")
    expect(r.session.messages.at(-1).text).toBe("hello world")
    expect(r.session).toEqual(readWithMeta(kind, rows, {}, usage))
    finalizeUsage(r.session, now)
    expect(r.session.tokensToday).toBe(108)
  })

  test(`${kind}: log model and cwd take precedence while metadata titles override`, () => {
    const events = kind === "kimi"
      ? [kimi("profile.bind", { modelAlias: "log-model", environmentDisclosure: { cwd: "/log" } }), ...fixtures.kimi.slice(0, 3)]
      : [grok("user_message_chunk", "first ", {}, { turnStartMs: now, modelId: "log-model" }), ...fixtures.grok.slice(1, 4)]
    const rows = events.map(j)
    const r = createSessionReader(kind, kind, "id", { now, meta: sidecars[kind] })
    r.update(rows)
    const expected = { model: "log-model", title: "Named" }
    if (kind === "kimi") Object.assign(expected, { cwd: "/log", project: "log" })
    expect(r.session).toMatchObject(expected)
    for (const meta of [sidecars[kind], { ...sidecars[kind], title: "New title" }, {}, null]) {
      r.update([], { meta })
      expect(r.session).toEqual(readWithMeta(kind, rows, meta))
      expect(r.session.model).toBe("log-model")
      if (kind === "kimi") expect(r.session.cwd).toBe("/log")
    }
  })
}

test("Grok: removing individual child metadata fields clears only their own effects", () => {
  const rows = fixtures.grok.map(j)
  const r = createSessionReader("grok", "grok", "id", { now, meta: sidecars.grok })
  r.update(rows)
  for (const field of Object.keys(sidecars.grok)) {
    const meta = { ...sidecars.grok }
    delete meta[field]
    r.update([], { meta })
    expect(r.session).toEqual(readWithMeta("grok", rows, meta))
    if (field === "parent_session_id") expect(r.session).toMatchObject({ subagent: true, parent: "" })
    if (field === "session_kind") expect(r.session).toMatchObject({ subagent: false, parent: "" })
  }
})

test("Kimi: removing metadata preserves child identity derived from the session id", () => {
  const rows = fixtures.kimi.map(j)
  const r = createSessionReader("kimi", "kimi", "parent/child", { now, meta: sidecars.kimi })
  r.update(rows)
  r.update([], { meta: null })
  expect(r.session).toEqual(readKimi(rows.join("\n"), "parent/child", {}, { now }))
  expect(r.session).toMatchObject({ subagent: true, parent: "parent", title: "first", cwd: "", model: "" })
})

test("Kimi and Grok: whitespace and bounded reply streams survive updates and reset at turns", () => {
  for (const kind of ["kimi", "grok"]) {
    const r = createSessionReader(kind, kind, "id", { now })
    const prompt = (text) => kind === "kimi" ? kimi("turn.prompt", { input: text }) : grok("user_message_chunk", text)
    const chunk = (text) => kind === "kimi" ? kimi("context.append_loop_event", { event: { type: "content.part", part: { type: "text", text } } }) : grok("agent_message_chunk", text)
    r.update([j(prompt("first"))])
    for (const text of [" ".repeat(5000), "hello", " ", "世界", " ", "x".repeat(10000)]) r.update([j(chunk(text))])
    expect(r.session.reply.startsWith("hello 世界 ")).toBe(true)
    expect(r.session.reply.length).toBeLessThanOrEqual(TEXT_MAX)
    expect(r.session.messages.at(-1).text.length).toBeLessThanOrEqual(MESSAGE_TEXT_MAX)
    r.update([j(prompt("second"))])
    r.update([j(chunk("second reply"))])
    expect(r.session.reply).toBe("second reply")
    expect(r.session.turns).toBe(2)
  }
})

test("every reader parses only new input and no lines on an empty update", () => {
  const parse = JSON.parse
  const rows = new Set(Object.values(fixtures).flat().map(j))
  let parsed = 0
  JSON.parse = function (text, ...args) {
    if (rows.has(text)) parsed++
    return parse.call(this, text, ...args)
  }
  try {
    for (const [kind, events] of Object.entries(fixtures)) {
      const r = createSessionReader(kind, kind, "id", { now })
      parsed = 0
      for (const event of events) r.update([j(event)])
      expect(parsed).toBe(events.length)
      r.update([], { meta: { title: "changed" }, now: nextDay })
      expect(parsed).toBe(events.length)
      expect(r.session).toMatchObject({ tokensToday: 0, turnsToday: 0 })
      r.update([], { now })
      expect(r.session.turnsToday).toBe(2)
    }
  } finally { JSON.parse = parse }
})

test("one-shot Gemini documents and alternate agent names remain compatible", () => {
  const document = { sessionId: "document-id", startTime: iso(), messages: fixtures.gemini }
  const result = readGemini(JSON.stringify(document, null, 2), "qwen", "fallback", { now })
  expect(result).toMatchObject({ id: "document-id", agent: "qwen", turns: 2, phase: "tool" })
  const qwen = createSessionReader("gemini", "qwen", "id", { now })
  qwen.update(fixtures.gemini.map(j))
  expect(qwen.session.agent).toBe("qwen")
  const omp = createSessionReader("pi", "omp", "id", { now })
  omp.update(fixtures.pi.map(j))
  expect(omp.session).toMatchObject({ agent: "omp", turns: 2, phase: "aborted" })
  const child = createSessionReader("claude", "claude", "child", { now, subagent: true })
  child.update([j({ ...fixtures.claude[0], isSidechain: true })])
  expect(child.session).toMatchObject({ subagent: true, turns: 1 })
})

test("all JSONL readers accept leading whitespace and retain only bounded messages", () => {
  for (const [kind, events] of Object.entries(fixtures)) {
    const r = createSessionReader(kind, kind, "id", { now })
    for (let i = 0; i < 20; i++) r.update(events.map((e) => ` \t${j(e)}`))
    expect(r.session.turns).toBe(40)
    expect(r.session.messages.length).toBeLessThanOrEqual(MESSAGES_MAX)
    expect(r.session.messages.every((m) => m.text.length <= MESSAGE_TEXT_MAX)).toBe(true)
  }
})
