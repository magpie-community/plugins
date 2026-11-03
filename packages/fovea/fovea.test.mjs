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
