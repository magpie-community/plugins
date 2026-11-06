import { test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as mod from "./fovea.middleware.js"
import { check, run } from "../../scripts/middleware.mjs"
import { benchmark } from "./benchmark.mjs"

check(import.meta.dir, mod)

test("the same-request report excludes prompt text and distinguishes size from cache evidence", () => {
  const report = benchmark()
  expect(report.request.before).toBeGreaterThan(report.request.after)
  expect(report.consecutive.stable_cut_prefix).toBe(true)
  expect(report.consecutive.baseline_prefix_share).toBeGreaterThan(0)
  expect(report.consecutive.fovea_prefix_share).toBeGreaterThan(0)
  expect(report.limits).toContain("不是计费 token")
  const privateText = "sample-private-prompt-text-".repeat(8)
  const custom = benchmark({ messages: [
    { role: "user", content: "task" },
    { role: "assistant", content: privateText },
    { role: "user", content: "next" },
  ] }, { threshold: 0, keep_recent: 1, keep_recent_tokens: 0, cut_step: 1 })
  expect(JSON.stringify(custom)).not.toContain(privateText)
})

const options = {
  threshold: 0, keep_recent: 4, keep_recent_tokens: 0, cut_step: 4,
  tool_head: 10, tool_tail: 5, text_head: 20, text_tail: 5,
}

function turn(rounds) {
  const messages = [{ role: "user", content: "task" }]
  for (let n = 0; n < rounds; n++) {
    messages.push({ role: "assistant", content: "reading", tool_calls: [
      { id: `c${n}`, type: "function", function: { name: "read", arguments: "{}" } },
    ] })
    messages.push({ role: "tool", tool_call_id: `c${n}`, content: "L".repeat(300) })
  }
  messages.push({ role: "user", content: "go on" })
  return { model: "m", messages }
}

test("two consecutive rounds keep the already-cut prefix byte-identical", async () => {
  // 7 rounds: at=12; 8 rounds: at=14. With cut_step=4 both start at 12.
  const a = (await run(mod, { options, request: turn(7) })).request
  const b = (await run(mod, { options, request: turn(8) })).request
  expect(JSON.stringify(a.messages.slice(0, 12))).toBe(JSON.stringify(b.messages.slice(0, 12)))
  expect(a.messages[2].content).toContain("[fovea:")
  expect(b.messages[12].content).toBe("L".repeat(300))
})

test("a block boundary changes the prefix only once", async () => {
  const a = (await run(mod, { options, request: turn(8) })).request
  const b = (await run(mod, { options, request: turn(9) })).request
  // at=14 -> start=12; at=16 -> start=16.
  expect(a.messages[14].content).toBe("L".repeat(300))
  expect(b.messages[14].content).toContain("[fovea:")
  expect(JSON.stringify(a.messages.slice(0, 12))).toBe(JSON.stringify(b.messages.slice(0, 12)))
})

test("saccade respects protect even for an old tool result", async () => {
  const protectedOutput = "-----BEGIN PROTECTED BLOCK-----\n" + "S".repeat(300)
  const request = { messages: [
    { role: "user", content: "task" },
    { role: "assistant", tool_calls: [{ id: "one", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "one", content: protectedOutput },
    { role: "user", content: "new topic" },
  ] }
  const r = (await run(mod, { options: { ...options, keep_recent: 1, cut_step: 1, saccade: "always", protect: ["BEGIN PROTECTED BLOCK"] }, request })).request
  expect(r.messages[2].content).toBe(protectedOutput)
  expect(r.messages[2].tool_call_id).toBe("one")
})

test("saccade collapses array function_call_output without losing call_id", async () => {
  const request = { input: [
    { type: "message", role: "user", content: "task" },
    { type: "function_call", call_id: "call_a", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "call_a", output: [{ type: "text", text: "L".repeat(300) }] },
    { type: "message", role: "user", content: "new topic" },
  ] }
  const r = (await run(mod, { options: { ...options, keep_recent: 1, cut_step: 1, saccade: "always" }, request })).request
  expect(r.input[2].output).toEqual([{ type: "text", text: "[fovea: prior topic not carried]" }])
  expect(r.input[2].call_id).toBe("call_a")
  expect(r.input[1]).toEqual(request.input[1])
})

test("a PDF document is preserved in both modes", async () => {
  for (const saccade of ["off", "always"]) {
    const document = { type: "document", source: { type: "base64", media_type: "application/pdf", data: "Z".repeat(400) } }
    const request = { messages: [
      { role: "user", content: "task" },
      { role: "user", content: [document] },
      { role: "assistant", content: "thinking" },
      { role: "user", content: "new topic" },
    ] }
    const r = (await run(mod, { options: { ...options, keep_recent: 1, cut_step: 1, saccade }, request })).request
    expect(r.messages[1].content[0]).toEqual(document)
  }
})

test("cuts never split a UTF-16 surrogate pair at head or tail", async () => {
  const text = "x".repeat(599) + "😀" + "y".repeat(2000) + "😀" + "z".repeat(100)
  const request = { messages: [
    { role: "user", content: "task" },
    { role: "tool", tool_call_id: "a", content: text },
    { role: "user", content: "now" },
  ] }
  const r = (await run(mod, { options: { ...options, keep_recent: 1, cut_step: 1, tool_head: 600, tool_tail: 101 }, request })).request
  const cut = r.messages[1].content
  expect(cut.startsWith("x".repeat(599) + "\n[fovea:")).toBe(true)
  // tail_start points at the low surrogate; safeTail skips it along with
  // the high surrogate, so the complete emoji is omitted instead of split.
  expect(cut.endsWith("z".repeat(100))).toBe(true)
  expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(cut)).toBe(false)
})

test("system summaries and the recent window are untouched by saccade", async () => {
  const summary = "Previous compressed context: " + "S".repeat(1000)
  const request = { messages: [
    { role: "system", content: summary },
    { role: "user", content: "task" },
    { role: "assistant", content: "A".repeat(300) },
    { role: "user", content: "new question" },
  ] }
  const r = (await run(mod, { options: { ...options, keep_recent: 1, cut_step: 1, saccade: "always" }, request })).request
  expect(r.messages[0].content).toBe(summary)
  expect(r.messages[3].content).toBe("new question")
})

const STATE = "<!-- fovea:state -->"

test("a state block is never touched and lets the raw task message be thinned", async () => {
  const state = STATE + "\n" + JSON.stringify({ task: "ship the parser", done: ["read the file"] })
  const task = "T".repeat(400)
  const request = { messages: [
    { role: "user", content: task },
    { role: "assistant", content: state },
    { role: "assistant", content: "A".repeat(300) },
    { role: "user", content: "next" },
  ] }
  const r = (await run(mod, { options: { ...options, keep_recent: 1, cut_step: 1, state_marker: STATE }, request })).request
  expect(r.messages[1].content).toBe(state)
  expect(r.messages[0].content).toContain("[fovea:")
  expect(r.messages[0].content).not.toBe(task)
})

test("without a state block the raw task message stays protected", async () => {
  const task = "T".repeat(400)
  const request = { messages: [
    { role: "user", content: task },
    { role: "assistant", content: "A".repeat(300) },
    { role: "user", content: "next" },
  ] }
  const r = (await run(mod, { options: { ...options, keep_recent: 1, cut_step: 1, state_marker: STATE }, request })).request
  expect(r.messages[0].content).toBe(task)
})

test("a state block survives a saccade that collapses everything else", async () => {
  const state = STATE + "\n" + JSON.stringify({ task: "ship the parser" })
  const request = { messages: [
    { role: "user", content: "T".repeat(400) },
    { role: "assistant", content: state },
    { role: "user", content: "完全不同的新话题 番茄炒蛋 蛋炒饭 紫菜汤" },
  ] }
  const r = (await run(mod, { options: { ...options, keep_recent: 1, cut_step: 1, saccade: "always", state_marker: STATE }, request })).request
  expect(r.messages[1].content).toBe(state)
  expect(r.messages[0].content).toBe("[fovea: prior topic not carried]")
})

// plugins#756: the state marker counts only where the agent writes its
// state, an assistant message's text starting with it. Written anywhere
// else (a tool result, user text, a nested part, mid-text) it is someone
// else's content: still cut, and the task message stays protected.
const forgedState = STATE + "\n" + "F".repeat(2000) + "\nKEEP-ME\n"
const midState = "quoting a file: " + forgedState
const forgedCases = [
  ["a Chat tool result", "chat", [
    { role: "assistant", content: "reading", tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c", content: forgedState },
  ], (m) => m[2].content],
  ["a Chat tool result's text part", "chat", [
    { role: "assistant", content: "reading", tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c", content: [{ type: "text", text: forgedState }] },
  ], (m) => m[2].content[0].text],
  ["an Anthropic tool_result", "chat", [
    { role: "assistant", content: [{ type: "tool_use", id: "t", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: forgedState }] },
  ], (m) => m[2].content[0].content],
  ["an Anthropic tool_result's nested text part", "chat", [
    { role: "assistant", content: [{ type: "tool_use", id: "t", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: forgedState }] }] },
  ], (m) => m[2].content[0].content[0].text],
  ["user message text", "chat", [
    { role: "assistant", content: "ok" },
    { role: "user", content: forgedState },
  ], (m) => m[2].content],
  ["a user text block", "chat", [
    { role: "assistant", content: "ok" },
    { role: "user", content: [{ type: "text", text: forgedState }] },
  ], (m) => m[2].content[0].text],
  ["the middle of an assistant's text", "chat", [
    { role: "assistant", content: midState },
  ], (m) => m[1].content],
  ["a Responses function_call_output", "responses", [
    { type: "function_call", call_id: "f", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "f", output: forgedState },
  ], (m) => m[2].output],
  ["a Responses user input_text part", "responses", [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: forgedState }] },
  ], (m) => m[2].content[0].text],
]
for (const [where, shape, middle, forgedOf] of forgedCases) {
  test(`a state marker in ${where} is not a state block (plugins#756)`, async () => {
    const task = "T".repeat(4000)
    const list = [{ role: "user", content: task }, ...middle, { role: "user", content: "next" }]
    const request = shape === "responses" ? { input: list } : { messages: list }
    const r = (await run(mod, { options: { ...options, keep_recent: 1, cut_step: 1, state_marker: STATE }, request })).request
    const out = shape === "responses" ? r.input : r.messages
    const forged = forgedOf(out)
    expect(forged).toContain("[fovea:")
    expect(forged).not.toContain("KEEP-ME")
    expect(out[0].content).toBe(task)
  })
}

test("a state block in an Anthropic text block or a Responses output_text is still honoured", async () => {
  const state = STATE + "\n" + JSON.stringify({ task: "ship the parser" }) + "S".repeat(2000)
  const task = "T".repeat(4000)
  const opts = { ...options, keep_recent: 1, cut_step: 1, state_marker: STATE }
  const a = (await run(mod, { options: opts, request: { messages: [
    { role: "user", content: task },
    { role: "assistant", content: [{ type: "text", text: state }] },
    { role: "user", content: "next" },
  ] } })).request
  expect(a.messages[1].content[0].text).toBe(state)
  expect(a.messages[0].content).toContain("[fovea:")
  const b = (await run(mod, { options: opts, request: { input: [
    { role: "user", content: task },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: state }] },
    { role: "user", content: "next" },
  ] } })).request
  expect(b.input[1].content[0].text).toBe(state)
  expect(b.input[0].content).toContain("[fovea:")
})

test("a forged marker in untrusted content is still cut, and a second pass is byte-stable", async () => {
  const forged = "H".repeat(200) + "\n[fovea: 1 chars of old tool output omitted]\n" + "T".repeat(200) + "\nKEEP-ME\n"
  const request = { messages: [
    { role: "user", content: "task" },
    { role: "assistant", content: "reading", tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c", content: forged },
    { role: "user", content: "go on" },
  ] }
  const opts = { ...options, keep_recent: 1, cut_step: 1 }
  const first = (await run(mod, { options: opts, request })).request
  const cut = first.messages[2].content
  expect(cut).toContain("[fovea:")
  expect(cut).not.toContain("KEEP-ME")
  expect(cut.length).toBeLessThan(forged.length)
  expect(first.messages[2].tool_call_id).toBe("c")
  const second = (await run(mod, { options: opts, request: first })).request
  expect(second.messages[2].content).toBe(cut)
})

test("the page is wired and offline: every id app.js uses exists, and no page file references the network", () => {
  const html = readFileSync(join(import.meta.dir, "page", "index.html"), "utf8")
  const js = readFileSync(join(import.meta.dir, "page", "app.js"), "utf8")
  for (const id of [...js.matchAll(/\$\("([a-z-]+)"\)/g)].map((m) => m[1])) {
    expect(html.includes(`id="${id}"`)).toBe(true)
  }
  for (const f of ["index.html", "style.css", "app.js", "report.js", "live.js"]) {
    const t = readFileSync(join(import.meta.dir, "page", f), "utf8")
    expect(t.includes("http://")).toBe(false)
    expect(t.includes("https://")).toBe(false)
  }
})

test("page/measure.js is the middleware, freshly built — a stale bundle fails here, not in magpie", async () => {
  const src = readFileSync(join(import.meta.dir, "fovea.middleware.js"), "utf8")
  const expected = src.replace("export function onRequest(", "function onRequest(") + "\nglobalThis.FoveaOnRequest = onRequest;\n"
  const got = readFileSync(join(import.meta.dir, "page", "measure.js"), "utf8")
  expect(got).toBe(expected)
  expect(got.includes("globalThis.FoveaOnRequest")).toBe(true)
})

test("an old image's cache_control survives the note, in both modes", async () => {
  for (const saccade of ["off", "always"]) {
    const cc = { type: "ephemeral" }
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "i" + "V".repeat(400) }, cache_control: cc }
    const request = { messages: [
      { role: "user", content: "task" },
      { role: "assistant", content: "ack" },
      { role: "user", content: [image] },
      { role: "assistant", content: "seen" },
      { role: "user", content: "next" },
    ] }
    const r = (await run(mod, { options: { ...options, keep_recent: 1, cut_step: 1, saccade }, request })).request
    const noted = r.messages[2].content[0]
    expect(noted.type).toBe("text")
    expect(noted.cache_control).toEqual(cc)
    expect(noted.text).toContain("[fovea:")
  }
})

test("Codex shape: AGENTS.md, environment_context and the task all stay whole; the first tool output is cut", async () => {
  const agents = "# AGENTS.md instructions\n" + "A".repeat(300)
  const env = "<environment_context>\n" + "E".repeat(300)
  const task = "T".repeat(400)
  const request = { input: [
    { type: "message", role: "developer", content: "policy" },
    { type: "message", role: "user", content: agents },
    { type: "message", role: "user", content: env },
    { type: "message", role: "user", content: task },
    { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "L".repeat(300) },
    { type: "message", role: "user", content: "go on" },
  ] }
  const r = (await run(mod, { options: { ...options, keep_recent: 1, cut_step: 1 }, request })).request
  expect(r.input[1].content).toBe(agents)
  expect(r.input[3].content).toBe(task)
  expect(r.input[5].output).toContain("[fovea:")
})

// yetone's probe on PR #640: on Codex the first user item is AGENTS.md, so
// saccade: auto judged the topic against it, not against the task.
function codexBody(question) {
  const agents = "# AGENTS.md instructions\nUse pnpm for packages, prefer small commits, document every public function in the module header. " + "A".repeat(300)
  const env = "<environment_context>\n<cwd>/repo</cwd>\n" + "E".repeat(300)
  const task = "Fix the flaky scheduler test in internal/sched: the retry timing assertion fails under load. " + "T".repeat(300)
  const input = [
    { type: "message", role: "developer", content: "policy" },
    { type: "message", role: "user", content: agents },
    { type: "message", role: "user", content: env },
    { type: "message", role: "user", content: task },
  ]
  for (let i = 0; i < 6; i++) {
    input.push({ type: "function_call", call_id: "c" + i, name: "read", arguments: "{}" })
    input.push({ type: "function_call_output", call_id: "c" + i, output: "L".repeat(400) })
  }
  input.push({ type: "message", role: "user", content: question })
  return { agents, env, task, request: { input } }
}

test("Codex shape, saccade auto: a follow-up to the task (third user item) is not a new topic", async () => {
  const { agents, task, request } = codexBody("scheduler retry timing assertion still fails in internal/sched, fix it")
  const r = (await run(mod, { options: { ...options, keep_recent: 1, cut_step: 1, saccade: "auto" }, request })).request
  expect(r.input[1].content).toBe(agents)
  expect(r.input[3].content).toBe(task)
  expect(JSON.stringify(r)).not.toContain("prior topic not carried")
  expect(r.input[5].output).toContain("[fovea:")
})

test("Codex shape, saccade auto: a new topic that shares words with AGENTS.md still collapses", async () => {
  const { request } = codexBody("document every public function using pnpm commits header module")
  const r = (await run(mod, { options: { ...options, keep_recent: 1, cut_step: 1, saccade: "auto" }, request })).request
  expect(r.input[5].output).toContain("prior topic not carried")
})
