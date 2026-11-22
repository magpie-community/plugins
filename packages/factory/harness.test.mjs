// @DennisYan4 on X (2026-11-19): since 11-17 Claude Code, Pi and Codex
// through Factory got 400 content_policy_rejected. Tool names weren't the
// cause; Pi passed once its system prompt said "runtime" for "harness", and
// Claude Code also hit Factory's refusal of tool search (defer_loading and
// the DeferredToolPlaceholder tool).
//
// The phrases are the clients' own bytes: Pi 1.5.2's
// dist/core/system-prompt.js, Codex 0.165.0's prompt, Claude Code 2.1.327's.
// testdata/claude-code-2.1.327-toolsearch.json is a real Claude Code
// 2.1.327 request with ENABLE_TOOL_SEARCH, captured from a sandbox HOME
// after a ToolSearch call (paths changed to /home/u, the first user turn
// cut to its words).
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const { harnessText, undeferredTools, toolDescriptions } = _internal
const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

const API = "https://api.factory.ai"
const messages = API + "/api/llm/a/v1/messages"
const responses = API + "/api/llm/o/v1/responses"
const chat = API + "/api/llm/o/v1/chat/completions"
const CAPTURE = readFileSync(new URL("./testdata/claude-code-2.1.327-toolsearch.json", import.meta.url), "utf8")

const PI = "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code."
const PI_DOCS = "Pi documentation (read only when the user asks about the harness itself, its SDK, extensions, themes, skills, or TUI):\n- Before implementing harness changes, read the relevant docs and examples in full"
const CODEX = "- Receive user prompts and other context provided by the harness, such as files in the workspace."
const CLAUDE_TOOL = "The exception is external work the harness cannot track (a CI run, a deploy, a remote queue)"

async function loaded() {
  const sent = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname === "/api/cli/whoami") return new Response(JSON.stringify({ userId: "user_k", orgId: "fac_K", email: "k@example.com", region: "" }))
    sent.push({ url: String(url), headers: new Headers(init.headers), body: init.body })
    return new Response('{"id":"ok"}')
  }
  let saved = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3_600_000, accountId: "d@example.com", activeOrganizationId: "fac_D", region: "" }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async ({ body }) => (saved = body) } } })
  const l = await hooks.auth.loader(async () => saved)
  return async (url, body) => {
    const res = await l.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) })
    expect(res.status).toBe(200)
    return JSON.parse(sent.at(-1).body)
  }
}

test("the clients' harness wording reads runtime", () => {
  expect(harnessText(PI)).toBe("You are a coding assistant running inside pi, a coding agent runtime. Help users inspect files, run commands, and modify code.")
  expect(harnessText(PI_DOCS)).toBe(PI_DOCS.replaceAll("harness", "runtime"))
  expect(harnessText(CODEX)).toBe("- Receive user prompts and other context provided by the runtime, such as files in the workspace.")
  expect(harnessText("# Harness\n - Text you output")).toBe("# Runtime\n - Text you output")
  expect(harnessText("test harnesses")).toBe("test runtimes")
  expect(harnessText("harness-tracked work")).toBe("runtime-tracked work")
})

test("a name that holds harness stays as written", () => {
  for (const s of ["harness_key", "src/harness.rs", "harness.rs", "harness-ci", "./harness", "test_harness", "MyHarness", "harnessed", "path/to/harness"]) expect(harnessText(s)).toBe(s)
})

test("Pi's, Codex's and Claude Code's prompts go to Factory without harness", async () => {
  const send = await loaded()
  const a = await send(messages, { model: "claude-opus-4-5-20251101", system: [{ type: "text", text: PI + "\n\n" + PI_DOCS }], messages: [{ role: "user", content: "a harness for my tests" }], max_tokens: 10 })
  expect(JSON.stringify(a.system)).not.toContain("harness")
  // the user's own words go as written
  expect(a.messages[0].content).toBe("a harness for my tests")

  const r = await send(responses, { model: "gpt-5.1-codex", instructions: CODEX, input: [{ role: "user", content: [{ type: "input_text", text: "fix the harness" }] }] })
  expect(r.instructions).not.toContain("harness")
  expect(r.instructions).toContain("provided by the runtime")
  expect(JSON.stringify(r.input)).toContain("fix the harness")

  const c = await send(chat, { model: "glm-5.3-flash", messages: [{ role: "system", content: PI }, { role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "Wake", description: CLAUDE_TOOL, parameters: { type: "object", properties: { why: { type: "string", description: "what the harness waits on" } } } } }] })
  expect(JSON.stringify(c)).not.toContain("harness")
})

test("a tool's description and its parameters' read runtime, its values as written", () => {
  const tools = [{ name: "Wake", description: CLAUDE_TOOL, input_schema: { type: "object", properties: { mode: { type: "string", enum: ["harness"], default: "harness", description: "the harness's mode" } } } }]
  expect(toolDescriptions(tools)).toBe(true)
  expect(tools[0].description).toContain("the runtime cannot track")
  expect(tools[0].input_schema.properties.mode.description).toBe("the runtime's mode")
  expect(tools[0].input_schema.properties.mode.enum).toEqual(["harness"])
  expect(tools[0].input_schema.properties.mode.default).toBe("harness")
  expect(toolDescriptions([{ name: "x", description: "plain" }])).toBe(false)
})

test("Claude Code's tool search reaches Factory as tools declared in full", async () => {
  const before = JSON.parse(CAPTURE)
  // the capture is what Claude Code sends: the placeholder, a deferred
  // WebFetch, and ToolSearch's answer as a tool_reference
  expect(before.tools.find((t) => t.name === "DeferredToolPlaceholder")?.defer_loading).toBe(true)
  expect(before.tools.find((t) => t.name === "WebFetch")?.defer_loading).toBe(true)
  expect(CAPTURE).toContain('{"type": "tool_reference", "tool_name": "WebFetch"}')
  expect(CAPTURE).toContain("harness")

  const send = await loaded()
  const b = await send(messages, CAPTURE)
  const out = JSON.stringify(b)
  expect(out).not.toContain("defer_loading")
  expect(out).not.toContain("DeferredToolPlaceholder")
  expect(out).not.toContain("tool_reference")
  expect(out).not.toContain("harness")
  // (Claude Code's own tool names go out as droid's, renamed in place)
  expect(b.tools.length).toBe(before.tools.length - 1)
  const web = b.tools.find((t) => t.name === "WebFetch")
  expect(web.input_schema).toEqual(before.tools.find((t) => t.name === "WebFetch").input_schema)
  // ToolSearch's call and its answer stay paired, the answer as text
  const use = b.messages[1].content.find((c) => c.type === "tool_use")
  const result = b.messages[2].content.find((c) => c.type === "tool_result")
  expect(result.tool_use_id).toBe(use.id)
  expect(result.content).toEqual([{ type: "text", text: "Tool WebFetch is loaded and can be called now." }])
  expect(b.messages.length).toBe(before.messages.length)
})

test("tool definitions Claude Code carries in messages join the tools", () => {
  const request = {
    tools: [{ name: "Read", input_schema: { type: "object" } }, { name: "DeferredToolPlaceholder", description: "Reserved placeholder that keeps deferred tool loading active; never call this tool.", input_schema: { type: "object", properties: {} }, defer_loading: true }],
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "ToolSearch", input: { query: "grep" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "tool_definition", definition: { name: "Grep", description: "search", input_schema: { type: "object" }, defer_loading: true } }] }] },
      { role: "user", content: [{ type: "tool_addition", tool: { type: "tool_definition", definition: { name: "Glob", input_schema: { type: "object" }, defer_loading: true } } }, { type: "tool_removal", tool_name: "Old" }] },
      { role: "user", content: [{ type: "text", text: "go" }] },
    ],
  }
  expect(undeferredTools(request)).toBe(true)
  expect(request.tools).toEqual([{ name: "Read", input_schema: { type: "object" } }, { name: "Grep", description: "search", input_schema: { type: "object" } }, { name: "Glob", input_schema: { type: "object" } }])
  expect(request.messages.length).toBe(4)
  expect(request.messages[2].content[0].content).toEqual([{ type: "text", text: "Tool Grep is loaded and can be called now." }])
  expect(request.messages[3].content).toEqual([{ type: "text", text: "go" }])
  // a request without tool search is left as it was
  const plain = { tools: [{ name: "Read" }], messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }
  expect(undeferredTools(plain)).toBe(false)
})
