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
