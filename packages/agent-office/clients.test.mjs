// Copilot CLI, Kimi Code, Grok Build, Claude Code subagents and omp profiles:
// each agent's own file format, as whatsmyagentdoing describes it (MIT) for
// the three clients, and the session facts the office's page needs.
//
// Every fixture lives in a fresh temporary HOME; no test reads a real agent's
// folder.
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createScanner, sources } from "./lib/scan.mjs"
import { readClaude, readCodex, readGemini, readGrok, readKimi, MESSAGES_MAX, MESSAGE_TEXT_MAX } from "./lib/readers.mjs"

const dir = import.meta.dir
const tmps = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agent-office-clients-")); tmps.push(d); return d }
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }) })

const ENV_KEYS = [
  "HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "DSH_HOME", "PI_CODING_AGENT_DIR",
  "OMP_HOME", "OMP_CONFIG_DIR", "KIMI_CODE_HOME", "KIMI_CONFIG_DIR",
  "GROK_HOME", "GROK_CONFIG_DIR", "COPILOT_HOME", "COPILOT_CONFIG_DIR",
  "QODER_CONFIG_DIR", "QODERCN_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR",
]

// run fn with exactly the environment given; every agent home is explicit so
// a developer's own sessions can never be discovered
function withEnv(vars, fn) {
  const saved = new Map()
  for (const k of ENV_KEYS) { saved.set(k, process.env[k]); delete process.env[k] }
  Object.assign(process.env, vars)
  try { return fn() } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}

const j = (o) => JSON.stringify(o)
const T = (base, n) => new Date(base + n * 1000).toISOString()
const write = (root, rel, body) => {
  const p = join(root, rel)
  mkdirSync(join(p, ".."), { recursive: true })
  writeFileSync(p, Array.isArray(body) ? body.map(j).join("\n") + "\n" : typeof body === "string" ? body : j(body))
  return p
}

// ---- where the files are -------------------------------------------------

test("new clients are found under HOME and honour their own overrides", () => {
  const h = tmp()
  write(h, ".omp/profiles/work/agent/sessions/notes/empty.jsonl", "")
  withEnv({ HOME: h }, () => {
    const srcs = sources()
    expect(srcs.find((s) => s.kind === "kimi").root).toBe(join(h, ".kimi-code", "sessions"))
    expect(srcs.find((s) => s.kind === "grok").root).toBe(join(h, ".grok", "sessions"))
    expect(srcs.find((s) => s.kind === "copilot").root).toBe(join(h, ".copilot", "session-state"))
    expect(srcs.find((s) => s.agent === "omp" && s.kind === "pi" && !s.profile).root).toBe(join(h, ".omp", "agent", "sessions"))
    expect(srcs.find((s) => s.agent === "omp" && s.profile === "work").root).toBe(join(h, ".omp", "profiles", "work", "agent", "sessions"))
    // Claude's subagent files sit one level below the session file
    const sub = srcs.find((s) => s.agent === "claude" && s.subagent)
    expect(sub.depth).toBe(3)
    expect(sub.match("agent-x.jsonl", join(h, ".claude", "projects", "-p", "s", "subagents", "agent-x.jsonl"))).toBe(true)
    expect(sub.match("agent-x.jsonl", join(h, ".claude", "projects", "-p", "s", "other", "agent-x.jsonl"))).toBe(false)
  })

  const alt = tmp()
  withEnv({
    HOME: h,
    KIMI_CODE_HOME: join(alt, "kimi"),
    GROK_HOME: join(alt, "grok"),
    COPILOT_HOME: join(alt, "copilot"),
    OMP_HOME: join(alt, "omp"),
    PI_CODING_AGENT_DIR: join(alt, "pi", "agent"),
  }, () => {
    const srcs = sources()
    expect(srcs.find((s) => s.kind === "kimi").root).toBe(join(alt, "kimi", "sessions"))
    expect(srcs.find((s) => s.kind === "grok").root).toBe(join(alt, "grok", "sessions"))
    expect(srcs.find((s) => s.kind === "copilot").root).toBe(join(alt, "copilot", "session-state"))
    expect(srcs.find((s) => s.agent === "omp" && !s.profile).root).toBe(join(alt, "omp", "agent", "sessions"))
    expect(srcs.find((s) => s.agent === "pi").root).toBe(join(alt, "pi", "agent", "sessions"))
  })
})

// ---- the new readers, through the scanner --------------------------------

test("Copilot, Kimi, Grok, Claude subagents and omp profiles: status, lineage, messages", () => {
  const h = tmp()
  const base = Date.now() - 60_000
  const t = (n) => T(base, n)

  // GitHub Copilot CLI: ~/.copilot/session-state/<session>/events.jsonl
  const SECRET_COPILOT_ARGS = "SECRET-COPILOT-ARGS ls -la"
  write(h, ".copilot/session-state/cop-1/events.jsonl", [
    { type: "session.start", timestamp: t(0), data: { sessionId: "cop-1", context: { cwd: "/Users/me/cop" }, selectedModel: "gpt-5" } },
    { type: "user.message", timestamp: t(1), data: { content: "list the files" } },
    { type: "tool.execution_start", timestamp: t(2), data: { toolName: "bash", arguments: { command: SECRET_COPILOT_ARGS } } },
    { type: "tool.execution_complete", timestamp: t(3), data: {} },
    { type: "assistant.message", timestamp: t(4), data: { content: "Here are the files." } },
    { type: "session.end", timestamp: t(5), data: {} },
  ])

  // Kimi Code: a main agent and a child agent, one state.json for the session
  const kimi = ".kimi-code/sessions/proj/kimi-session"
  write(h, `${kimi}/state.json`, { cwd: "/Users/me/kimi", title: "Kimi job", createdAt: base })
  write(h, `${kimi}/agents/main/wire.jsonl`, [
    { type: "turn.prompt", time: base, input: [{ type: "text", text: "hello kimi" }] },
    { type: "llm.request", time: base + 1000, modelAlias: "kimi-k2" },
    { type: "context.append_loop_event", time: base + 2000, event: { type: "step.begin" } },
    { type: "context.append_loop_event", time: base + 3000, event: { type: "tool.call", toolCallId: "k1", name: "Read", arguments: { path: "SECRET-KIMI-ARGS" } } },
    { type: "context.append_loop_event", time: base + 4000, event: { type: "tool.result", toolCallId: "k1" } },
    { type: "context.append_loop_event", time: base + 5000, event: { type: "content.part", part: { type: "text", text: "kimi done" } } },
    { type: "turn.ended", time: base + 6000, reason: "completed" },
  ])
  write(h, `${kimi}/agents/researcher/wire.jsonl`, [
    { type: "turn.prompt", time: base + 7000, input: [{ type: "text", text: "research this" }] },
    { type: "llm.request", time: base + 8000, modelAlias: "kimi-k2" },
  ])

  // Grok Build: explicit subagent kind and its parent
  write(h, ".grok/sessions/proj/grok-one/updates.jsonl", [
    { timestamp: (base + 1000) / 1000, params: { update: { sessionUpdate: "user_message_chunk", content: { text: "build it" } } } },
    { timestamp: (base + 2000) / 1000, params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "built" } } } },
    { timestamp: (base + 3000) / 1000, params: { update: { sessionUpdate: "turn_completed", stop_reason: "end_turn" } } },
  ])
  write(h, ".grok/sessions/proj/grok-one/summary.json", {
    info: { cwd: "/Users/me/grok" }, generated_title: "Grok job", current_model_id: "grok-4",
    session_kind: "subagent-worker", parent_session_id: "grok-parent", created_at: t(0),
  })

  // Claude Code: a subagent's own file below project/<session>/subagents/
  const SECRET_CLAUDE_ARGS = "SECRET-CLAUDE-ARGS rm -rf /"
  write(h, ".claude/projects/-Users-me-app/main.jsonl", [
    { type: "user", sessionId: "main", cwd: "/Users/me/app", timestamp: t(1), message: { role: "user", content: "main task" } },
    { type: "assistant", sessionId: "main", cwd: "/Users/me/app", timestamp: t(2), message: { role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "main done" }] } },
  ])
  write(h, ".claude/projects/-Users-me-app/main/subagents/agent-x.jsonl", [
    { type: "user", sessionId: "main", isSidechain: true, cwd: "/Users/me/app", timestamp: t(3), message: { role: "user", content: "sub task" } },
    { type: "assistant", sessionId: "main", isSidechain: true, timestamp: t(4), message: { role: "assistant", model: "claude-opus-5", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: SECRET_CLAUDE_ARGS } }] } },
    { type: "user", sessionId: "main", isSidechain: true, timestamp: t(5), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
    { type: "assistant", sessionId: "main", isSidechain: true, timestamp: t(6), message: { role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "sub done" }] } },
  ])

  // omp: the default agent folder and two named profiles
  write(h, ".omp/agent/sessions/-Users-me-omp/2026-01-01T00-00-00_default.jsonl", [
    { type: "session", id: "omp-base", cwd: "/Users/me/omp", timestamp: t(1) },
    { type: "message", timestamp: t(2), message: { role: "user", content: [{ type: "text", text: "base task" }] } },
    { type: "message", timestamp: t(3), message: { role: "assistant", content: [{ type: "text", text: "base done" }], stopReason: "stop" } },
  ])
  for (const name of ["work", "play"]) {
    write(h, `.omp/profiles/${name}/agent/sessions/-Users-me-omp/2026-01-01T00-00-00_${name}.jsonl`, [
      { type: "session", id: `omp-${name}`, cwd: "/Users/me/omp", timestamp: t(1) },
      { type: "message", timestamp: t(2), message: { role: "user", content: [{ type: "text", text: `${name} task` }] } },
      { type: "message", timestamp: t(3), message: { role: "assistant", content: [{ type: "text", text: `${name} done` }], stopReason: "stop" } },
    ])
  }

  withEnv({ HOME: h }, () => {
    const sc = createScanner({ sources: sources(), days: 2, max: 40 })
    const got = sc.scan(Date.now())
    const by = (agent, id) => got.find((s) => s.agent === agent && s.id === id)

    // Copilot
    const cop = by("copilot", "cop-1")
    expect(cop).toMatchObject({ phase: "done", model: "gpt-5", cwd: "/Users/me/cop", project: "cop" })
    expect(cop.messages.map((m) => m.role)).toEqual(["user", "tool", "assistant"])
    const copTool = cop.messages.find((m) => m.role === "tool")
    expect(copTool.text).toBe("bash")
    expect(copTool.name).toBe("bash")

    // Kimi main and child
    const main = by("kimi", "kimi-session")
    expect(main).toMatchObject({ phase: "done", title: "Kimi job", model: "kimi-k2", cwd: "/Users/me/kimi", project: "kimi", subagent: false, parent: "" })
    expect(main.messages.some((m) => m.role === "assistant" && m.text === "kimi done")).toBe(true)
    const kid = by("kimi", "kimi-session/researcher")
    expect(kid).toMatchObject({ phase: "thinking", subagent: true, parent: "kimi-session", title: "Kimi job" })

    // Grok
    const grok = by("grok", "grok-one")
    expect(grok).toMatchObject({ phase: "done", title: "Grok job", model: "grok-4", cwd: "/Users/me/grok", subagent: true, parent: "grok-parent" })
    expect(grok.messages.some((m) => m.role === "assistant" && m.text === "built")).toBe(true)

    // Claude subagent: its sidechain records are kept, and it has a parent
    const sub = by("claude", "agent-x")
    expect(sub).toMatchObject({ phase: "done", subagent: true, parent: "main", cwd: "/Users/me/app" })
    expect(sub.messages.some((m) => m.role === "tool" && m.text === "Bash")).toBe(true)
    expect(by("claude", "main")).toMatchObject({ phase: "done", subagent: false })

    // omp profiles
    expect(by("omp", "omp-work")).toMatchObject({ profile: "work", agent: "omp" })
    expect(by("omp", "omp-play")).toMatchObject({ profile: "play" })
    expect(by("omp", "omp-base")).toMatchObject({ profile: "" })

    // tool arguments never travel inside messages (they may appear in `step`,
    // which the page hides when text is off; a message is text-only)
    const msgWire = JSON.stringify(got.map((s) => s.messages))
    expect(msgWire).not.toContain("SECRET-COPILOT-ARGS")
    expect(msgWire).not.toContain("SECRET-KIMI-ARGS")
    expect(msgWire).not.toContain("SECRET-CLAUDE-ARGS")
    expect(msgWire).not.toContain("hunter2")
    for (const s of got) expect(s.messages.length).toBeLessThanOrEqual(MESSAGES_MAX)
  })
})

// ---- usage and message limits -------------------------------------------

const DAY = "2026-10-28" // timestamps are pinned; today is passed explicitly
const at = (n) => `2026-10-28T10:${String(n).padStart(2, "0")}:00.000Z`
const NOW = Date.parse("2026-10-28T12:00:00.000Z")

test("Claude usage: today's tokens, context window, one turn", () => {
  const usage = { input_tokens: 1000, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, output_tokens: 50 }
  const text = [
    j({ type: "user", sessionId: "c1", timestamp: at(1), message: { role: "user", content: "fix it" } }),
    // one API response is logged once per content block: the same id must not count twice
    j({ type: "assistant", sessionId: "c1", timestamp: at(2), message: { id: "msg_1", role: "assistant", model: "claude-opus-5", stop_reason: "tool_use", usage, content: [{ type: "text", text: "working" }] } }),
    j({ type: "assistant", sessionId: "c1", timestamp: at(3), message: { id: "msg_1", role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", usage, content: [{ type: "text", text: "done" }] } }),
  ].join("\n")
  const r = readClaude(text, "claude", "c1", { now: NOW })
  expect(r).toMatchObject({ phase: "done", context: 1550, contextWindow: 200000, tokensToday: 1250, turnsToday: 1, turns: 1 })
  expect(r.messages.filter((m) => m.role === "user")).toHaveLength(1)
  expect(DAY).toBe(new Date(NOW).toISOString().slice(0, 10))
})

test("Codex usage: token_count feeds today's tokens and the context window", () => {
  const text = [
    j({ timestamp: at(1), type: "session_meta", payload: { id: "cx", cwd: "/Users/me/blog" } }),
    j({ timestamp: at(1), type: "event_msg", payload: { type: "task_started", turn_id: "u1" } }),
    j({ timestamp: at(2), type: "event_msg", payload: { type: "item_completed", item: { type: "UserMessage", content: [{ type: "text", text: "export it" }] } } }),
    j({ timestamp: at(3), type: "event_msg", payload: { type: "token_count", info: { model_context_window: 200000, last_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 80 } } } }),
    j({ timestamp: at(4), type: "event_msg", payload: { type: "task_complete", last_agent_message: "Exported." } }),
  ].join("\n")
  const r = readCodex(text, "cx", { now: NOW })
  expect(r).toMatchObject({ phase: "done", context: 1080, contextWindow: 200000, tokensToday: 680, turnsToday: 1 })
})

test("messages keep text, clip it, and never carry a tool's arguments", () => {
  const long = "x".repeat(900)
  const text = [
    j({ type: "user", sessionId: "m1", timestamp: at(1), message: { role: "user", content: long } }),
    ...Array.from({ length: 10 }, (_, i) => j({ type: "assistant", sessionId: "m1", timestamp: at(2 + i), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: `reply ${i}` }] } })),
    j({ type: "assistant", sessionId: "m1", timestamp: at(20), message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "SECRET-ARGS curl -u admin:hunter2" } }] } }),
  ].join("\n")
  const r = readClaude(text, "claude", "m1", { now: NOW })
  expect(r.messages.length).toBe(MESSAGES_MAX)
  for (const m of r.messages) expect(m.text.length).toBeLessThanOrEqual(MESSAGE_TEXT_MAX)
  expect(JSON.stringify(r.messages)).not.toContain("SECRET-ARGS")
  expect(JSON.stringify(r.messages)).not.toContain("hunter2")
  expect(r.messages.some((m) => m.role === "tool" && m.text === "Bash" && m.name === "Bash")).toBe(true)
  expect(r.messages.every((m) => Number.isFinite(m.at))).toBe(true)
})

const source = (root, kind, extra = {}) => ({ root, kind, agent: kind, depth: 0, match: (n) => n.endsWith(".jsonl"), ...extra })
const claudeTurn = (time, prompt = "work", tokens = 100) => [
  { type: "user", timestamp: new Date(time).toISOString(), message: { role: "user", content: prompt } },
  { type: "assistant", timestamp: new Date(time + 1000).toISOString(), message: { id: `msg-${time}`, role: "assistant", usage: { input_tokens: tokens, output_tokens: 10 }, stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } },
]

test("cached Today counts roll over at local midnight without rereading the file", () => {
  const h = tmp()
  const before = new Date(2026, 9, 28, 23, 59, 30).getTime()
  const after = new Date(2026, 9, 29, 0, 0, 30).getTime()
  const p = write(h, "cached.jsonl", claudeTurn(before))
  utimesSync(p, before / 1000, before / 1000)
  const sc = createScanner({ sources: [source(h, "claude")] })
  expect(sc.scan(before)[0]).toMatchObject({ tokensToday: 110, turnsToday: 1 })
  const cached = sc.files.get(p)
  expect(sc.scan(after)[0]).toMatchObject({ tokensToday: 0, turnsToday: 0, turns: 1 })
  expect(sc.files.get(p)).toBe(cached)
  // Buckets remain private, and scanning another day does not discard history.
  expect(sc.scan(before)[0]).toMatchObject({ tokensToday: 110, turnsToday: 1 })
  expect(JSON.stringify(sc.scan(after))).not.toContain("buckets")
})

test("large JSONL replays usage and turns in the omitted middle, across updates and rewrites", () => {
  const h = tmp()
  const now = Date.now()
  // Today's only events sit between >64 KiB of head and >512 KiB of tail.
  const padding = { type: "padding", text: "x".repeat(1024) }
  const rows = [
    { type: "user", timestamp: new Date(now - 3 * 86400e3).toISOString(), cwd: "/old/project", message: { role: "user", content: "old prompt" } },
    ...Array.from({ length: 100 }, () => padding),
    ...claudeTurn(now - 10000, "middle prompt", 6000),
    ...Array.from({ length: 600 }, () => padding),
  ]
  const p = write(h, "large.jsonl", rows)
  const sc = createScanner({ sources: [source(h, "claude")] })
  expect(statSync(p).size).toBeGreaterThan(576 * 1024)
  expect(sc.scan(now)[0]).toMatchObject({ tokensToday: 6010, turnsToday: 1, turns: 2, cwd: "/old/project", query: "middle prompt", phase: "done" })
  write(h, "large.jsonl", [...rows, ...claudeTurn(now - 5000, "new prompt", 200)])
  expect(sc.scan(now)[0]).toMatchObject({ tokensToday: 6220, turnsToday: 2, turns: 3, query: "new prompt" })
  rows[0].cwd = "/new/project"
  write(h, "large.jsonl", rows)
  expect(sc.scan(now)[0]).toMatchObject({ cwd: "/new/project", tokensToday: 6010, turnsToday: 1 })
})

test("chunked JSONL preserves UTF-8 characters split across a read boundary", () => {
  const h = tmp()
  const prefix = j({ type: "padding", text: "x".repeat(65500) }) + "\n"
  const user = j({ type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "hello 世界 🌍" } })
  // Put the first Chinese character's first byte at the end of a read chunk.
  const marker = Buffer.byteLength(prefix + user.slice(0, user.indexOf("世")))
  const target = Math.ceil(marker / 65536) * 65536 - 1
  const adjusted = prefix.replace("x", "x".repeat(target - marker + 1))
  write(h, "utf8.jsonl", adjusted + user + "\n")
  const sc = createScanner({ sources: [source(h, "claude")] })
  expect(sc.scan()[0].query).toBe("hello 世界 🌍")
})

test("undocumented CONFIG_DIR aliases are ignored while Claude's documented override works", () => {
  const h = tmp()
  const aliases = ["OMP_CONFIG_DIR", "KIMI_CONFIG_DIR", "GROK_CONFIG_DIR", "COPILOT_CONFIG_DIR", "QODER_CONFIG_DIR", "QODERCN_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR"]
  withEnv({ HOME: h, CLAUDE_CONFIG_DIR: join(h, "claude-custom"), ...Object.fromEntries(aliases.map((k) => [k, join(h, "ignored", k)])) }, () => {
    const roots = sources().map((s) => s.root)
    expect(roots.every((p) => !p.includes("/ignored/"))).toBe(true)
    expect(roots).toContain(join(h, "claude-custom", "projects"))
    expect(roots).toContain(join(h, ".qoder", "projects"))
    expect(roots).toContain(join(h, ".workbuddy", "projects"))
  })
})

const grokEvent = (time, type, text = "", extra = {}) => ({ timestamp: time / 1000, params: { update: { sessionUpdate: type, content: { text }, ...extra } } })

test("Grok uses timestamped usage.json deltas, refreshes sidecars and resets at midnight", () => {
  const h = tmp()
  const now = new Date(2026, 9, 28, 12).getTime()
  const yesterday = new Date(2026, 9, 27, 12).getTime()
  const nextDay = new Date(2026, 9, 29, 12).getTime()
  write(h, ".grok/sessions/proj/session/updates.jsonl", [grokEvent(now, "user_message_chunk", "test"), grokEvent(now + 1000, "turn_completed")])
  const summary = { generated_title: "old title", info: { cwd: "/old" } }
  const rel = ".grok/sessions/proj/session"
  write(h, `${rel}/summary.json`, summary)
  // Schema taken from xai-org/grok-build's SessionUsageFile / TurnUsage.
  const usage = { padding: "x".repeat(300 * 1024), sessionId: "session", updatedAt: new Date(now).toISOString(), session: { inputTokens: 999999, outputTokens: 999999 }, turns: [
    { turnNumber: 1, endedAt: new Date(yesterday).toISOString(), inputTokens: 5000, outputTokens: 1000 },
    { turnNumber: 2, endedAt: new Date(now).toISOString(), inputTokens: 1000, cachedReadTokens: 400, cacheCreationTokens: 50, outputTokens: 80, reasoningTokens: 20, totalTokens: 1080, modelUsage: { grok: { inputTokens: 1000, outputTokens: 80 } } },
  ] }
  write(h, `${rel}/usage.json`, usage)
  withEnv({ HOME: h }, () => {
    const sc = createScanner({ sources: sources().filter((s) => s.kind === "grok"), days: 10000 })
    expect(sc.scan(now)[0]).toMatchObject({ title: "old title", tokensToday: 680, turnsToday: 1, context: 0 })
    write(h, `${rel}/summary.json`, { ...summary, generated_title: "updated title", info: { cwd: "/new" } })
    usage.turns[1].outputTokens = 120
    write(h, `${rel}/usage.json`, usage)
    expect(sc.scan(now)[0]).toMatchObject({ title: "updated title", cwd: "/new", tokensToday: 720, turnsToday: 1 })
    expect(sc.scan(nextDay)[0]).toMatchObject({ tokensToday: 0, turnsToday: 0 })
    // A malformed or missing sidecar must not keep its stale usage or hide the session.
    write(h, `${rel}/usage.json`, "{")
    expect(sc.scan(now)[0]).toMatchObject({ phase: "done", tokensToday: 0, turnsToday: 1 })
    rmSync(join(h, rel, "usage.json"))
    expect(sc.scan(now)[0].tokensToday).toBe(0)
  })
})

test("Grok does not invent a usage day from lifetime totals or malformed turn values", () => {
  const now = Date.now()
  const text = [grokEvent(now, "user_message_chunk", "hi"), grokEvent(now + 1000, "turn_completed")].map(j).join("\n")
  expect(readGrok(text, "g", {}, { now, usage: { session: { totalTokens: 5000 }, updatedAt: new Date(now).toISOString() } }).tokensToday).toBe(0)
  expect(readGrok(text, "g", {}, { now, usage: { turns: [null, { endedAt: "bad date", inputTokens: 200 }, { endedAt: new Date(now).toISOString(), inputTokens: "100", outputTokens: -2 }] } }).tokensToday).toBe(0)
})

test("Grok and Kimi streamed whitespace survives chunk boundaries and clipping", () => {
  const now = Date.now()
  for (const chunks of [["hello ", "world"], ["hello", " ", "world"], ["hel", "lo", " world"], ["hello\n", "world"], ["x".repeat(499), " ", "tail"], ["x".repeat(500), " ".repeat(1000), "tail"], [" ".repeat(1000), "hello ", "world"]]) {
    const expected = chunks.join("").replace(/\s+/g, " ").trim()
    const kimi = readKimi(chunks.map((text) => j({ type: "context.append_loop_event", time: now, event: { type: "content.part", part: { type: "text", text } } })).join("\n"))
    const grok = readGrok(chunks.map((text) => j(grokEvent(now, "agent_message_chunk", text))).join("\n"))
    const clipped = expected.length > MESSAGE_TEXT_MAX ? expected.slice(0, MESSAGE_TEXT_MAX - 1).trimEnd() + "…" : expected
    for (const s of [kimi, grok]) {
      expect(s.messages).toHaveLength(1)
      expect(s.messages[0].text).toBe(clipped)
      expect(s.reply).toBe(expected.length > 280 ? expected.slice(0, 279).trimEnd() + "…" : expected)
    }
  }
})

test("Grok streamed user messages retain message length beyond the query limit", () => {
  const now = Date.now()
  const chunks = ["hello ", "world ", "x".repeat(250)]
  const s = readGrok(chunks.map((text) => j(grokEvent(now, "user_message_chunk", text))).join("\n"))
  expect(s.turns).toBe(1)
  expect(s.messages[0].text).toBe(chunks.join(""))
  expect(s.query.length).toBe(200)
  expect(s.query.startsWith("hello world ")).toBe(true)
})

test("Gemini approval clears when a tool resolves or the assistant finishes", () => {
  for (const final of [
    { type: "gemini", content: "", toolCalls: [{ id: "t1", name: "shell", status: "success" }] },
    { type: "gemini", content: "done" },
  ]) {
    const s = readGemini(j({ messages: [
      { type: "user", content: "run it" },
      { type: "gemini", content: "", toolCalls: [{ id: "t1", name: "shell", status: "awaiting_approval" }] },
      final,
    ] }))
    expect(s.phase).toBe(final.toolCalls ? "thinking" : "done")
    expect(s.pending).toHaveLength(0)
  }
})

test("compressed scan eventually decodes a final write skipped by the throttle", () => {
  const h = tmp()
  const now = Date.now()
  const header = { type: "session", id: "compressed", createdAt: new Date(now).toISOString() }
  const p = join(h, "session.v4.jsonl.zstd")
  const compressed = (events) => writeFileSync(p, Bun.zstdCompressSync(Buffer.from(events.map(j).join("\n") + "\n")))
  compressed([header, { type: "turn/start", time: new Date(now).toISOString(), data: {} }])
  const sc = createScanner({ sources: [source(h, "dsh", { match: (n) => n.endsWith(".zstd") })], zstdEvery: 4000 })
  expect(sc.scan(now)[0].phase).toBe("thinking")
  compressed([header, { type: "turn/end", time: new Date(now + 1000).toISOString(), data: { reason: { kind: "completed" } } }])
  expect(sc.scan(now + 1000)[0].phase).toBe("thinking")
  expect(sc.scan(now + 4001)[0].phase).toBe("done")
})

test("Grok logs beyond the old 32 MiB cap retain middle turns and open tools", () => {
  const h = tmp()
  const now = Date.now()
  const padding = j({ type: "padding", text: "x".repeat(1024 * 1024) }) + "\n"
  const events = [grokEvent(now, "user_message_chunk", "middle prompt"), grokEvent(now + 1000, "tool_call", "", { toolCallId: "still-open", title: "Read", status: "in_progress" })]
  write(h, "updates.jsonl", padding + events.map(j).join("\n") + "\n" + padding.repeat(32))
  const sc = createScanner({ sources: [source(h, "grok")] })
  const s = sc.scan(now + 2000)[0]
  expect(s).toMatchObject({ query: "middle prompt", turnsToday: 1, phase: "tool" })
  expect(s.pending.map((p) => p.id)).toEqual(["still-open"])
})

test("Grok empty prompt chunks wait for text and turn metadata separates adjacent turns", () => {
  const now = Date.now()
  const chunks = ["", " ", "hello ", "world"]
  const rows = chunks.map((text) => grokEvent(now, "user_message_chunk", text))
  for (const row of rows) row.params._meta = { turnStartMs: now }
  let s = readGrok(rows.map(j).join("\n"), "g", {}, { now })
  expect(s).toMatchObject({ query: "hello world", title: "hello world", turns: 1, turnsToday: 1 })
  expect(s.messages.map((m) => m.text)).toEqual(["hello world"])
  const next = grokEvent(now + 1000, "user_message_chunk", "second turn")
  next.params._meta = { turnStartMs: now + 1000 }
  s = readGrok([...rows, next].map(j).join("\n"), "g", { title: "named" }, { now })
  expect(s).toMatchObject({ query: "second turn", title: "named", turns: 2, turnsToday: 2 })
})

test("Claude counts final usage once for interleaved blocks of the same response", () => {
  const row = (id, output, time) => ({ type: "assistant", timestamp: at(time), message: { id, role: "assistant", usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 400, output_tokens: output }, content: [] } })
  const s = readClaude([row("a", 0, 1), row("b", 5, 2), row("a", 10, 3), row("b", 5, 4)].map(j).join("\n"), "claude", "c", { now: NOW })
  expect(s).toMatchObject({ tokensToday: 255, context: 525 })
})
