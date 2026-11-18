import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

async function callRunCommand(inputSchema, args) {
  const kit = await createBridgeKit()
  try {
    let listed
    kit.prompts.push(async (agent) => {
      listed = await agent.listTools()
      await agent.tool("run_command", args)
    })
    const body = baseBody({ tools: [{ name: "run_command", input_schema: inputSchema }] })
    const result = await readSse(await kit.request(body))
    return { schema: listed.result.tools[0].inputSchema, call: result.content.find((item) => item.type === "tool_use") }
  } finally {
    await kit.dispose()
  }
}

test("run_command avoids agy's toolSummary collision and restores the argument for the client", async () => {
  const schema = {
    type: "object",
    properties: { CommandLine: { type: "string" }, toolSummary: { type: "string" } },
    required: ["CommandLine", "toolSummary"],
    additionalProperties: false,
  }
  const result = await callRunCommand(schema, { CommandLine: "pwd" })
  assert.deepEqual(result.schema.required, ["CommandLine"])
  assert.deepEqual(result.call.input, { CommandLine: "pwd", toolSummary: "Run command" })
  assert.deepEqual(schema.required, ["CommandLine", "toolSummary"])
})

test("run_command keeps supplied summaries and does not add one to unrelated schemas", async () => {
  const schema = {
    type: "object",
    properties: { CommandLine: { type: "string" }, toolSummary: { type: "string" } },
    required: ["CommandLine", "toolSummary"],
  }
  const supplied = await callRunCommand(schema, { CommandLine: "pwd", toolSummary: "Show location" })
  assert.equal(supplied.call.input.toolSummary, "Show location")
  const withoutSummary = await callRunCommand({
    type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false,
  }, { command: "pwd" })
  assert.deepEqual(withoutSummary.call.input, { command: "pwd" })
})

async function callTool(name, inputSchema, args) {
  const kit = await createBridgeKit()
  try {
    let listed
    kit.prompts.push(async (agent) => {
      listed = await agent.listTools()
      await agent.tool(name, args)
    })
    const body = baseBody({ tools: [{ name, input_schema: inputSchema }] })
    const result = await readSse(await kit.request(body))
    return { schema: listed.result.tools[0].inputSchema, call: result.content.find((item) => item.type === "tool_use") }
  } finally {
    await kit.dispose()
  }
}

// A client that is itself agy declares its eager MCP tools with agy's
// required toolSummary already in place (mcp_<server>_<tool>); the agy behind
// the bridge appends its own again, so every such tool needs the same dedup.
test("any client tool with agy's toolSummary avoids the duplicate and gets it back", async () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, toolSummary: { type: "string" } },
    required: ["name", "toolSummary"],
    additionalProperties: false,
  }
  const result = await callTool("mcp_probe_lookup", schema, { name: "alice" })
  assert.deepEqual(result.schema.required, ["name"])
  assert.deepEqual(result.call.input, { name: "alice", toolSummary: "Tool call" })
  assert.deepEqual(schema.required, ["name", "toolSummary"])
})

test("a zero-parameter client tool keeps a valid schema once toolSummary is dropped", async () => {
  const schema = {
    type: "object",
    properties: { toolSummary: { type: "string" } },
    required: ["toolSummary"],
    additionalProperties: false,
  }
  const result = await callTool("mcp_probe_ping", schema, {})
  assert.equal(result.schema.required, undefined)
  assert.deepEqual(result.call.input, { toolSummary: "Tool call" })
})

test("a client tool keeps a summary the model supplied", async () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, toolSummary: { type: "string" } },
    required: ["name", "toolSummary"],
  }
  const result = await callTool("mcp_probe_lookup", schema, { name: "bob", toolSummary: "Name lookup" })
  assert.equal(result.call.input.toolSummary, "Name lookup")
})
