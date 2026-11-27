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
    const tool = listed.result.tools.find((item) => item.name === name)
    return { schema: tool.inputSchema, call: result.content.find((item) => item.type === "tool_use") }
  } finally {
    await kit.dispose()
  }
}

const callRunCommand = (inputSchema, args) => callTool("run_command", inputSchema, args)

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

// #visamzh on X (0.1.120): an MCP tool the outer agy forwards already lists
// toolSummary as required, so agy's own toolSummary duplicated it and the
// toolbox failed to build with "'allOf' failed • at '/required': items at 0
// and 1 are equal". The collision guard must cover every tool, not run_command.
test("an MCP tool with an injected toolSummary does not duplicate agy's own", async () => {
  const name = "mcp_ide-tools_mcp_magpie-artifacts_publish_artifact"
  const schema = {
    type: "object",
    properties: {
      id: { type: "string" },
      type: { type: "string" },
      title: { type: "string" },
      content: { type: "string" },
      // The original publish_artifact schema has no toolSummary; the terminal
      // agy adds this property and the required entry before forwarding it.
      toolSummary: { type: "string" },
    },
    required: ["id", "type", "title", "content", "toolSummary"],
    additionalProperties: false,
  }
  const result = await callTool(name, schema, {
    id: "a1", type: "markdown", title: "Hello", content: "# Hi",
  })
  // toolSummary is stripped from required, so agy adds exactly one and the
  // schema stays valid (no "items 0 and 1 are equal").
  assert.deepEqual(result.schema.required, ["id", "type", "title", "content"])
  assert.ok(!result.schema.required.includes("toolSummary"))
  // On the return path the client's required field is filled back in.
  assert.deepEqual(result.call.input, {
    id: "a1", type: "markdown", title: "Hello", content: "# Hi", toolSummary: name,
  })
})

test("an MCP tool keeps a summary the model supplied", async () => {
  const name = "mcp_magpie-artifacts_publish_artifact"
  const schema = {
    type: "object",
    properties: { id: { type: "string" }, toolSummary: { type: "string" } },
    required: ["id", "toolSummary"],
  }
  const supplied = await callTool(name, schema, { id: "a2", toolSummary: "Publish the doc" })
  assert.equal(supplied.call.input.toolSummary, "Publish the doc")
})
