#!/usr/bin/env node
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { spawn } from "node:child_process"
import { join } from "node:path"

function writeUsage(inputTokens, outputTokens, cacheReadTokens) {
  const dir = join(process.env.FACTORY_HOME_OVERRIDE, ".factory", "sessions", realpathSync(process.cwd()).replace(/[\\/:]/g, "-"))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "s.settings.json"), JSON.stringify({ tokenUsage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens: 9 } }))
}


if (process.argv.includes("--list-tools")) {
  if (process.env.FAKE_DROID_IMAGE) console.log("  • GenerateImage (Generate Image) - status: blocked")
  process.exit(0)
}
assert.deepEqual(process.argv.slice(2, 6), ["exec", "--output-format", "acp", "--settings"])
const settings = JSON.parse(readFileSync(process.argv[6]))
assert.equal(settings.sessionDefaultSettings.autonomyLevel, "off")
assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "exit 2")
const reply = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n")
const update = (value, sessionId = "s") => reply({ method: "session/update", params: { sessionId, update: value } })
let mcp, serverName, seq = 0
const awaiting = new Map()
function ask(method, params) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    awaiting.set(id, { resolve, reject })
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  })
}
const builtin = process.argv.at(-2) === "--only-tools" ? process.argv.at(-1) : undefined
const catalogFixture = process.env.FAKE_DROID_CATALOG
const fixture = catalogFixture && JSON.parse(readFileSync(catalogFixture, "utf8"))
const listing = fixture?.[process.env.FACTORY_API_KEY || "local"] ?? {}
if (catalogFixture) appendFileSync(catalogFixture + ".calls", "spawn\n")
// Droid 1.21.1 answers a level the model lacks by keeping its current one, and
// refuses only a name it does not know. These are the levels of deepseek-v4.1-flash-1017.
const levels = listing.picker ? ["low"] : ["off", "low", "high", "max"]
const knownLevels = ["none", "off", "minimal", "low", "medium", "high", "xhigh", "max"]
const defaultEffort = listing.picker ? "low" : "high"
function optionsFor(model) {
  const effortOption = { id: listing.picker ? "effort-" + model : "effort", category: "thought_level", type: "select",
    currentValue: effort ?? defaultEffort, options: levels.map(value => ({ value, name: value })) }
  if (!listing.picker) return [effortOption]
  return [
    { id: "pick-model", category: "model", type: "select", currentValue: model,
      options: [{ group: "Offered", options: [{ value: "fake", name: "Picker model" }, { value: "denied", disabled: true }] }] },
    effortOption,
  ]
}
let model = "start", effort, tools = [], promptId, waitingForTool = false, steer
// A line on stdout that is not part of ACP, like an update notice.
if (process.env.FAKE_DROID_NOTICE) console.log(process.env.FAKE_DROID_NOTICE)
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line)
  switch (method) {
    case "initialize":
      assert.equal(params.clientInfo.name, "@magpie-community/opencode-factory-droid-auth")
      reply({ id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: process.env.FAKE_DROID_RESUME ? { resume: {} } : {}, _meta: { factory: { modelsList: !listing.legacy, promptWhileRunning: !process.env.FAKE_DROID_NO_STEER } }, promptCapabilities: { image: true } } } })
      break
    case "_factory/models/list":
      if (listing.delay) await new Promise(resolve => setTimeout(resolve, listing.delay))
      if (listing.error) { reply({ id, error: listing.error }); break }
      if ("models" in listing) { reply({ id, result: { models: listing.models } }); break }
      reply({ id, result: { models: [{ id: "fake", displayName: "Fake model", supportedReasoningEfforts: ["low", "high"], disabledReasoningEfforts: ["high"] }, { id: "locked", disabled: true }] } })
      break
    case "session/resume":
      assert.equal(params.sessionId, "s")
      assert.equal(realpathSync(params.cwd), realpathSync(process.cwd()))
      model = "fake"
      reply({ id, result: { models: { currentModelId: model }, configOptions: optionsFor(model) } })
      break
    case "session/new": {
      assert.equal(realpathSync(params.cwd), realpathSync(process.cwd()))
      if (process.env.FAKE_DROID_WORKSPACE) writeFileSync(process.env.FAKE_DROID_WORKSPACE, params.cwd)
      if (process.env.FACTORY_API_KEY === "bad") {
        reply({ id, error: { code: -32000, message: "Authentication required" } })
        break
      }
      const [server] = params.mcpServers
      if (server) {
        serverName = server.name
        mcp = spawn(server.command, server.args, { stdio: ["pipe", "pipe", "inherit"] })
        createInterface({ input: mcp.stdout }).on("line", line => {
          const { id, result, error } = JSON.parse(line)
          const pending = awaiting.get(id)
          awaiting.delete(id)
          if (error) pending.reject(new Error(error.message))
          else pending.resolve(result)
        })
        tools = (await ask("tools/list")).tools
      }
      reply({ id, result: { sessionId: "s", models: { currentModelId: model, availableModels: listing.availableModels }, configOptions: optionsFor(model) } })
      break
    }
    case "session/set_model":
      if (listing.picker) assert.equal(listing.picker, "legacy-set")
      model = params.modelId
      reply({ id, result: { configOptions: optionsFor(model) } })
      break
    case "session/set_config_option":
      if (params.configId === "pick-model") {
        if (listing.picker === "legacy-set") {
          reply({ id, error: { code: -32601, message: "Use legacy model selection" } })
        } else {
          if (listing.picker !== "ignored") model = params.value
          reply({ id, result: { configOptions: optionsFor(model) } })
        }
        break
      }
      assert.equal(model, "fake")
      assert.equal(params.configId, listing.picker ? "effort-" + model : "effort")
      if (!knownLevels.includes(params.value)) {
        reply({ id, error: { code: -32602, message: "Invalid params: Invalid reasoning effort value: " + params.value, data: { configId: params.configId, value: params.value } } })
        break
      }
      if (levels.includes(params.value) && !process.env.FAKE_DROID_IGNORE_EFFORT) effort = params.value
      reply({ id, result: { configOptions: optionsFor(model) } })
      break
    case "session/prompt": {
      assert.equal(params.sessionId, "s")
      const content = params.prompt.map((p) => p.text ?? p.mimeType).join("")
      if (builtin) {
        const input = builtin === "WebSearch" ? { query: "native search" } : { prompt: "test image" }
        update({ sessionUpdate: "tool_call", toolCallId: "native", name: builtin, status: "pending", rawInput: input })
        let text = "**First result**\n  URL: https://example.org/one\n\n  First snippet.\n---\n**Next result**\n  URL: https://example.org/two\n Second snippet.\nFound 2 results"
        if (builtin === "GenerateImage") {
          const refs = JSON.parse(readFileSync(join(process.cwd(), "references.json")))
          for (const ref of refs) assert.ok(readFileSync(ref).length)
          const dir = join(process.env.FACTORY_HOME_OVERRIDE, ".factory", "generated-images")
          mkdirSync(dir, { recursive: true })
          const dest = join(dir, "test.png")
          writeFileSync(dest, Buffer.from("89504e470d0a1a0a00", "hex"))
          text = "Saved to: " + dest
        }
        update({ sessionUpdate: "tool_call_update", toolCallId: "native", name: builtin, status: "completed", rawOutput: { text } })
        reply({ id, result: { stopReason: "end_turn" } })
        break
      }
      if (waitingForTool) { steer = { id, content }; break }
      promptId = id
      if (content.includes("check effort")) assert.equal(effort, "low")
      if (content.includes("stream-then-end")) {
        // Output keeps coming for 1.5 seconds before the turn ends.
        void (async () => {
          for (let i = 0; i < 30; i++) {
            await new Promise(resolve => setTimeout(resolve, 50))
            update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } })
          }
          reply({ id, result: { stopReason: "end_turn" } })
        })()
        break
      }
      if (content.includes("update-then-wait")) {
        void new Promise(resolve => setTimeout(resolve, 100)).then(() => update({ sessionUpdate: "usage_update", used: 1, size: 250000 }))
        break
      }
      if (content.includes("wait-until-abort")) break
      if (content.includes("crash-now")) process.exit(3)
      if (content.includes("fail-now")) { reply({ id, error: { code: -32603, message: "Prompt failed" } }); break }
      if (tools.length && !content.includes('"tool_result":')) {
        const { name, inputSchema } = tools[0]
        assert.equal(inputSchema.type, "object")
        const matcher = new RegExp(settings.hooks.PreToolUse[0].matcher)
        assert.equal(matcher.test("Execute"), true)
        assert.equal(matcher.test(serverName + "___" + name), false)
        reply({ id: 91, method: "session/request_permission", params: { sessionId: "s", toolCall: { name: serverName + "___" + name }, options: [{ kind: "allow_once", optionId: "once" }] } })
        const run = async () => {
          waitingForTool = true
          if (content.includes("meter steps")) writeUsage(100, 12, 50)
          const call = word => ask("tools/call", { name, arguments: { word } })
          const values = content.includes("parallel tools") ? await Promise.all([call("lime"), call("pear")]) : [await call("lime")]
          const first = values.length === 1 ? values[0] : { content: values.map(v => v.content[0]) }
          if (content.includes("fail after receipt")) {
            reply({ id, error: { code: -32603, message: "Prompt failed after tool result" } })
            return
          }
          let result = first
          if (content.includes("two calls")) result = await ask("tools/call", { name, arguments: { word: first.content[0].text } })
          if (content.includes("meter steps")) {
            await new Promise(resolve => setTimeout(resolve, 100))
            writeUsage(110, 15, 120)
          }
          waitingForTool = false
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "MCP returned " + JSON.stringify(result) + (steer?.content || "") } })
          if (steer) { reply({ id: steer.id, result: { stopReason: "end_turn" } }); steer = undefined }
          reply({ id, result: { stopReason: "end_turn" } })
        }
        void run().catch(() => {})
        break
      }
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "foreign" } }, "elsewhere")
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } })
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: model + ":" + content.slice(-100) } })
      reply({ id: 90, method: "session/request_permission", params: { sessionId: "s", options: [] } })
      break
    }
    case undefined:
      if (id === 91) { assert.deepEqual(result.outcome, { outcome: "selected", optionId: "once" }); break }
      assert.equal(id, 90)
      assert.deepEqual(result, { outcome: { outcome: "cancelled" } })
      reply({ id: promptId, result: { stopReason: "end_turn", usage: { inputTokens: 9, outputTokens: 4 } } })
      break
  }
}

mcp?.stdin.end()
