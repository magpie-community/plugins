#!/usr/bin/env -S node
// A fake Antigravity ACP server, enough of one for the plugin's tests:
// initialize, authenticate, session/new with a model select,
// session/set_config_option, session/prompt (text, thought, and one client
// tool call through the MCP bridge the session was given), session/cancel,
// session/close.
//
// Prompt words the tests drive the failure paths with:
//   AUTHFAIL — the prompt is refused with -32000 (a lost sign-in)
//   FAILMID  — one chunk is streamed first, then the prompt is refused
//   DIEONCE  — the server exits on its first DIEONCE prompt, answers the
//              next one (the retry) normally, via a marker file
//   HANG     — the prompt never answers (for the soft-timeout test)
// The cwd of each session/new is written to $AGY_ACP_HOME/last-cwd, and each
// closed session id to $AGY_ACP_HOME/closed-sessions, for the tests to assert.
import { createInterface } from "node:readline"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const MODELS = [
  { value: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  { value: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  { value: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
  { value: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
]

const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n")
const reply = (id, result) => write({ jsonrpc: "2.0", id, result })
const fail = (id, code, message) => write({ jsonrpc: "2.0", id, error: { code, message } })
const update = (sessionId, up) => write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: up } })

const sessions = new Map()
let nextId = 1
let nextSession = 1

const configOptions = (current) => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: current, options: MODELS },
]

// mcpCallTool speaks just enough MCP over Streamable HTTP to list the
// bridge's tools and call the first one.
async function mcpCallTool(server) {
  const post = (body) =>
    fetch(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(server.headers ?? []).reduce((h, x) => ({ ...h, [x.name]: x.value }), {}) },
      body: JSON.stringify(body),
    }).then(async (res) => {
      const text = await res.text()
      return text ? JSON.parse(text) : null
    })
  await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-acp", version: "0" } } })
  await post({ jsonrpc: "2.0", method: "notifications/initialized" })
  const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  const tool = listed?.result?.tools?.[0]
  if (!tool) throw new Error("the bridge listed no tools")
  const called = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool.name, arguments: { command: "echo hi", _from: "fake-acp" } } })
  return { name: tool.name, called }
}

const handlers = {
  initialize() {
    return {
      protocolVersion: 1,
      agentInfo: { name: "antigravity-acp", version: "1.2.1" },
      authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
      agentCapabilities: { promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { close: true } },
    }
  },
  async authenticate() {
    await new Promise((r) => setTimeout(r, 50))
    return {}
  },
  "session/new"(params) {
    const id = `s-${nextSession++}`
    sessions.set(id, { model: "gemini-3.8-flash-low", mcp: params?.mcpServers?.[0] ?? null })
    // where the plugin lets the server work, for the test to assert
    try { fs.writeFileSync(path.join(process.env.AGY_ACP_HOME ?? os.tmpdir(), "last-cwd"), String(params?.cwd ?? "")) } catch {}
    return { sessionId: id, configOptions: configOptions(sessions.get(id).model) }
  },
  "session/set_config_option"(params) {
    const session = sessions.get(params?.sessionId)
    if (!session) fail(0, -32002, "no such session")
    if (params?.configId === "model") session.model = params.value
    return { configOptions: configOptions(session.model) }
  },
  async "session/prompt"(params) {
    const session = sessions.get(params?.sessionId)
    const id = nextId++
    session.pending = id
    const text = (params?.prompt ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("\n")
    // the failure paths throw out of the handler, so the wire answers with
    // the error (-32000), not with a refusal result — inside the try below
    // they would be swallowed into one
    if (/AUTHFAIL/.test(text)) throw new Error("authentication required")
    if (/HANG/.test(text)) return new Promise(() => {})
    if (/FAILMID/.test(text)) {
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial " } })
      throw new Error("authentication required")
    }
    try {
      if (/DIEONCE/.test(text)) {
        const marker = path.join(process.env.AGY_ACP_HOME ?? os.tmpdir(), "died-once")
        if (!fs.existsSync(marker)) {
          fs.writeFileSync(marker, "1")
          process.exit(3)
        }
      }
      if (session.mcp && /USE_TOOL/.test(text)) {
        const call = await mcpCallTool(session.mcp)
        update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "t1", title: `fake tool ${call.name}`, kind: "other", status: "completed" })
        const taken = session.pending === id
        session.pending = null
        return { stopReason: taken ? "end_turn" : "cancelled" }
      }
      if (/THINK/.test(text)) update(params.sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } })
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } })
      await new Promise((r) => setTimeout(r, 30))
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `from fake at ${session.model}` } })
      if (session.pending !== id) return { stopReason: "cancelled" }
      session.pending = null
      return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 }, _meta: { quota: { remaining: 90, limit: 100, tier: "ultra" } } }
    } catch (e) {
      session.pending = null
      return { stopReason: "refusal", _meta: { details: String(e?.message ?? e) } }
    }
  },
  "session/cancel"(params) {
    const session = sessions.get(params?.sessionId)
    // the in-flight prompt sees the cleared pending and answers cancelled
    if (session) session.pending = null
    return undefined
  },
  "session/close"(params) {
    sessions.delete(params?.sessionId)
    try { fs.appendFileSync(path.join(process.env.AGY_ACP_HOME ?? os.tmpdir(), "closed-sessions"), `${params?.sessionId}\n`) } catch {}
    return {}
  },
}

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on("line", async (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === undefined) return
  if (msg.id === undefined) {
    // a notification (session/cancel); still let it settle a pending prompt
    await handlers[msg.method]?.(msg.params)
    return
  }
  const fn = handlers[msg.method]
  if (!fn) return fail(msg.id, -32601, `${msg.method} is not supported`)
  try {
    const result = await fn(msg.params)
    if (result !== undefined) reply(msg.id, result)
    else reply(msg.id, {})
  } catch (e) {
    fail(msg.id, -32000, String(e?.message ?? e))
  }
})
