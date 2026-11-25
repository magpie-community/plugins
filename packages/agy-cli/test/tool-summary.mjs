import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

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

test("run_command avoids agy's toolSummary collision and restores the argument for the client", async () => {
  const schema = {
    type: "object",
    properties: { CommandLine: { type: "string" }, toolSummary: { type: "string" } },
    required: ["CommandLine", "toolSummary"],
    additionalProperties: false,
  }
  const result = await callTool("run_command", schema, { CommandLine: "pwd" })
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
  const supplied = await callTool("run_command", schema, { CommandLine: "pwd", toolSummary: "Show location" })
  assert.equal(supplied.call.input.toolSummary, "Show location")
  const withoutSummary = await callTool("run_command", {
    type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false,
  }, { command: "pwd" })
  assert.deepEqual(withoutSummary.call.input, { command: "pwd" })
})

test("an eager MCP tool keeps its required arguments and receives the consumed summary", async () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" }, toolSummary: { type: "string" } },
    required: ["name", "toolSummary"],
    additionalProperties: false,
  }
  const result = await callTool("mcp_example_lookup", schema, { name: "example" })
  assert.deepEqual(result.schema.required, ["name"])
  assert.deepEqual(result.call.input, { name: "example", toolSummary: "Tool call" })
  const supplied = await callTool("mcp_example_lookup", schema, { name: "example", toolSummary: "Example lookup" })
  assert.equal(supplied.call.input.toolSummary, "Example lookup")
})

test("an eager MCP tool that only requires a summary has no required list in ide-tools", async () => {
  const schema = {
    type: "object",
    properties: { text: { type: "string" }, toolSummary: { type: "string" } },
    required: ["toolSummary"],
    additionalProperties: false,
  }
  const result = await callTool("mcp_example_echo", schema, { text: "example" })
  assert.equal(Object.hasOwn(result.schema, "required"), false)
  assert.deepEqual(result.call.input, { text: "example", toolSummary: "Tool call" })
})

test("an unrelated tool's optional toolSummary argument stays optional", async () => {
  const schema = {
    type: "object",
    properties: { toolSummary: { type: "string" } },
  }
  const result = await callTool("mcp_example_optional", schema, {})
  assert.equal(Object.hasOwn(result.schema, "required"), false)
  assert.deepEqual(result.call.input, {})
})
