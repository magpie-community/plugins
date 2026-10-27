// Claude Code's tool search on ZCode's plans (小八 on Discord, 10-24).
// api.z.ai's Anthropic endpoint, given a tool named exactly ToolSearch,
// shows the model no other tool but those a tool_reference loaded, so a
// Claude Code subagent saw only its deferred tools and no Bash, Read or
// Write. The search goes to the plan as ToolSearchTool, the tools without
// defer_loading and the placeholder, and the model's calls come back to
// Claude Code as ToolSearch. The requests go to a local Bun.serve that
// records them; nothing reaches z.ai.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let ZCodeAuthPlugin
let server
const got = []
let answer = null
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ ZCodeAuthPlugin } = await import("./index.mjs"))
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      got.push({ path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: await req.text() })
      if (answer) return answer()
      return Response.json({ type: "message", content: [] })
    },
  })
})
afterAll(() => server?.stop(true))

const real = globalThis.fetch
const HOSTS = ["https://zcode.z.ai", "https://api.z.ai", "https://open.bigmodel.cn"]
function routeToFake() {
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const host = HOSTS.find((h) => url.startsWith(h + "/"))
    if (!host) throw new Error("no network in tests: " + url)
    return real(`http://127.0.0.1:${server.port}/${new URL(host).host}${url.slice(host.length)}`, init)
  }
}
afterEach(() => {
  globalThis.fetch = real
  got.length = 0
  answer = null
})

const jwt = ["{}", JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
const coding = { type: "oauth", access: "id.secret", refresh: JSON.stringify({ site: "zai", key: "id.secret" }), expires: 0 }
const startPlan = { type: "oauth", access: jwt, refresh: JSON.stringify({ site: "zai", device: "11111111-2222-4333-8444-555555555555", jwt }), expires: 0 }

async function send(auth, body) {
  routeToFake()
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const opts = await hooks.auth.loader(async () => auth, { id: "zcode" })
  const headers = {
    "content-type": "application/json",
    "x-api-key": "zcode",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219,mid-conversation-tool-changes-2026-07-01,advanced-tool-use-2025-11-20",
  }
  const res = await opts.fetch("https://api.z.ai/api/anthropic/v1/messages?beta=true", { method: "POST", headers, body: JSON.stringify(body) })
  return { res, sent: got.length ? JSON.parse(got[got.length - 1].body) : null }
}

const schema = { type: "object", properties: { command: { type: "string" } } }
// a Claude Code 2.1.310 subagent's request, as it reached magpie: its tools
// in Claude Code's order, the placeholder deferred, an MCP tool a search
// loaded (deferred, its schema sent), and the search that loaded it
const claudeCode = () => ({
  model: "glm-5.3",
  max_tokens: 32000,
  stream: true,
  system: [{ type: "text", text: "You are an agent for Claude Code, Anthropic's official CLI for Claude." }],
  messages: [
    { role: "user", content: [{ type: "text", text: "List the files here with Bash, then report." }] },
    { role: "system", content: [{ type: "text", text: "The following deferred tools are now available via ToolSearch.\nmcp__probe__probe_0" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_s", name: "ToolSearch", input: { query: "select:mcp__probe__probe_0", max_results: 5 } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_s", content: [{ type: "tool_reference", tool_name: "mcp__probe__probe_0" }] }, { type: "text", text: "go on" }] },
  ],
  tools: [
    { name: "Agent", description: "Launch a new agent", input_schema: schema },
    { name: "Bash", description: "Executes a bash command", input_schema: schema },
    { name: "Read", description: "Reads a file", input_schema: schema },
    { name: "ToolSearch", description: "Fetches full schema definitions for deferred tools", input_schema: schema },
    { name: "DeferredToolPlaceholder", description: "Reserved placeholder that keeps deferred tool loading active; never call this tool.", input_schema: { type: "object", properties: {} }, defer_loading: true },
    { name: "Write", description: "Writes a file", input_schema: schema },
    { name: "mcp__probe__probe_0", description: "Probe tool 0", input_schema: schema, defer_loading: true },
  ],
})

function expectSearchless(sent) {
  const names = sent.tools.map((t) => t.name)
  expect(names).toEqual(["Agent", "Bash", "Read", "ToolSearchTool", "Write", "mcp__probe__probe_0"])
  expect(sent.tools.some((t) => "defer_loading" in t)).toBe(false)
  expect(JSON.stringify(sent)).not.toContain('"name":"ToolSearch"')
  const call = sent.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((x) => x.type === "tool_use")
  expect(call).toMatchObject({ id: "toolu_s", name: "ToolSearchTool" })
  const result = sent.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((x) => x.type === "tool_result")
  expect(result.content).toEqual([{ type: "tool_reference", tool_name: "mcp__probe__probe_0" }])
}

test("a GLM Coding Plan request offers Claude Code's search as ToolSearchTool, every tool undeferred", async () => {
  const { res, sent } = await send(coding, claudeCode())
  expect(res.status).toBe(200)
  expect(got[0].path).toBe("/api.z.ai/api/anthropic/v1/messages")
  expectSearchless(sent)
  // the rest of the request is the agent's
  expect(sent.system).toEqual(claudeCode().system)
  expect(got[0].headers["anthropic-beta"]).toContain("advanced-tool-use-2025-11-20")
})

test("a Start Plan request offers it as ToolSearchTool too", async () => {
  const { sent } = await send(startPlan, claudeCode())
  expect(got[0].path).toBe("/zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages")
  expectSearchless(sent)
})

test("a request without Claude Code's search goes as the agent sent it", async () => {
  const body = claudeCode()
  body.tools = body.tools.filter((t) => t.name !== "ToolSearch")
  body.messages = body.messages.slice(0, 2)
  const { sent } = await send(coding, body)
  // but for the device ZCode names on every request (#387)
  expect(typeof sent.metadata?.user_id).toBe("string")
  delete sent.metadata.user_id
  if (!Object.keys(sent.metadata).length && !body.metadata) delete sent.metadata
  expect(sent).toEqual(body)
})

const sse = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("")

test("the model's streamed call to ToolSearchTool reaches Claude Code as ToolSearch", async () => {
  const events = [
    { type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: 'I will call "ToolSearchTool".' } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "ToolSearchTool", input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":"select:Bash"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_2", name: "Bash", input: {} } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
    { type: "message_stop" },
  ]
  const text = sse(events)
  // in small chunks, so an event's line arrives in pieces
  answer = () => {
    const bytes = new TextEncoder().encode(text)
    const cut = 7 // lines and multi-byte reads cross chunks
    return new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < bytes.length; i += cut) c.enqueue(bytes.slice(i, i + cut))
          c.close()
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  }
  const { res } = await send(coding, claudeCode())
  const back = (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => JSON.parse(l.slice(5)))
  expect(back.length).toBe(events.length)
  expect(back[4].content_block).toEqual({ type: "tool_use", id: "toolu_1", name: "ToolSearch", input: {} })
  expect(back[7].content_block.name).toBe("Bash")
  // the model's own text is its own
  expect(back[2].delta.text).toBe('I will call "ToolSearchTool".')
  expect(back.filter((_, i) => i !== 4)).toEqual(events.filter((_, i) => i !== 4))
})

test("a whole message's call to ToolSearchTool reaches Claude Code as ToolSearch, on the Start Plan too", async () => {
  for (const auth of [coding, startPlan]) {
    answer = () =>
      Response.json({
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "ToolSearchTool" },
          { type: "tool_use", id: "toolu_1", name: "ToolSearchTool", input: { query: "select:Read" } },
        ],
        stop_reason: "tool_use",
      })
    const body = { ...claudeCode(), stream: false }
    const { res } = await send(auth, body)
    const v = await res.json()
    expect(v.content).toEqual([
      { type: "text", text: "ToolSearchTool" },
      { type: "tool_use", id: "toolu_1", name: "ToolSearch", input: { query: "select:Read" } },
    ])
    got.length = 0
  }
})
