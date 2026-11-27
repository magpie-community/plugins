import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

const USAGE = { inputTokens: 100, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 5, totalTokens: 105 }

const CALL_MCP_TOOL_SCHEMA = {
  type: "object",
  properties: {
    ServerName: { type: "string" },
    ToolName: { type: "string" },
    Arguments: { type: "string" },
  },
  required: ["ServerName", "ToolName", "Arguments"],
}

async function callToolOnce(toolName, inputSchema, args) {
  const kit = await createBridgeKit()
  try {
    kit.prompts.push(async (agent) => {
      await agent.tool(toolName, args)
    })
    const body = baseBody({ tools: [{ name: toolName, input_schema: inputSchema }] })
    const result = await readSse(await kit.request(body))
    return result.content.find((item) => item.type === "tool_use")
  } finally {
    await kit.dispose()
  }
}

test("call_mcp_tool unwraps a JSON-object Arguments string and keeps the live session on tool_result", async () => {
  const kit = await createBridgeKit()
  try {
    let forwardedResult
    kit.prompts.push(async (agent) => {
      forwardedResult = await agent.tool("call_mcp_tool", {
        ServerName: "magpie",
        ToolName: "amd-doc-search__vivado_doc_search",
        Arguments: ' {"query":"Vivado synthesis","limit":2} ',
      })
      await agent.text("done")
      return { stopReason: "end_turn", usage: USAGE }
    })

    const body = baseBody({ tools: [{ name: "call_mcp_tool", input_schema: CALL_MCP_TOOL_SCHEMA }] })
    const firstRes = await kit.request(body)
    assert.equal(firstRes.status, 200)
    const first = await readSse(firstRes)
    assert.equal(first.stopReason, "tool_use")
    const call = first.content.find((item) => item.type === "tool_use")
    assert.deepEqual(call.input, {
      ServerName: "magpie",
      ToolName: "amd-doc-search__vivado_doc_search",
      Arguments: { query: "Vivado synthesis", limit: 2 },
    })

    const nextBody = {
      ...body,
      messages: [
        ...body.messages,
        { role: "assistant", content: [call] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: call.id, content: "DOC #UG901" }],
        },
      ],
    }
    const secondRes = await kit.request(nextBody)
    assert.equal(secondRes.status, 200, await (secondRes.status === 200 ? "" : secondRes.text()))
    const second = await readSse(secondRes)
    assert.equal(second.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1, "tool_result continues the live ACP session without replay")
    assert.equal(forwardedResult?.result?.content?.[0]?.text, "DOC #UG901")
  } finally {
    await kit.dispose()
  }
})

test("call_mcp_tool preserves already-object Arguments and leaves non-object or invalid strings intact", async () => {
  const objCall = await callToolOnce("call_mcp_tool", CALL_MCP_TOOL_SCHEMA, {
    ServerName: "calc",
    ToolName: "eval",
    Arguments: { expression: "1+1" },
  })
  assert.deepEqual(objCall.input.Arguments, { expression: "1+1" })

  for (const raw of ["", "   ", "null", "123", '"text"', "[1,2]", "{bad json"]) {
    const call = await callToolOnce("call_mcp_tool", CALL_MCP_TOOL_SCHEMA, {
      ServerName: "calc",
      ToolName: "eval",
      Arguments: raw,
    })
    assert.equal(call.input.Arguments, raw)
  }
})

test("unrelated tools with a string Arguments property are not unwrapped", async () => {
  const call = await callToolOnce("custom_tool", CALL_MCP_TOOL_SCHEMA, {
    ServerName: "magpie",
    ToolName: "x",
    Arguments: '{"a":1}',
  })
  assert.equal(call.input.Arguments, '{"a":1}')
})
