// What a chat completion becomes on the wire, and what Warp's events fold
// into: the request carries the transcript and the tools as one MCP
// server's, and the answer's appends, tool calls and the end all map.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { PB, buildRequest, turnEvents, byNum, str, structOf } = _internal

const chat = (over = {}) => ({
  model: "auto",
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "list the files" },
    { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name: "run", arguments: "{\"cmd\":\"ls\"}" } }] },
    { role: "tool", tool_call_id: "t1", content: "a.txt\nb.txt" },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "run",
        description: "run a command",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      },
    },
  ],
  ...over,
})

test("the request carries the transcript, the tools and the settings", () => {
  const { body } = buildRequest(chat())
  const nums = [...byNum(body, 2), ...byNum(body, 3), ...byNum(body, 6)].map(() => 0) // parse to catch framing
  expect(byNum(body, 1).length).toBe(0) // no conversation continuation
  expect(byNum(body, 4).length).toBe(0) // no metadata: a fresh conversation

  const settings = byNum(body, 3)[0].data
  const modelConfig = byNum(settings, 1)[0].data
  expect(str(byNum(modelConfig, 1)[0])).toBe("auto") // model_config.base
  expect(byNum(settings, 9).map((f) => f.v)).toEqual([9]) // supported_tools: CALL_MCP_TOOL only

  const ctx = byNum(body, 6)[0].data
  const server = byNum(ctx, 3)[0].data
  expect(str(byNum(server, 1)[0])).toBe("magpie")
  const tool = byNum(server, 4)[0].data
  expect(str(byNum(tool, 1)[0])).toBe("run")
  const schema = structOf(byNum(tool, 3)[0].data)
  expect(schema.type).toBe("object")
  expect(schema.properties.cmd.type).toBe("string")
  expect(schema.required).toEqual(["cmd"])

  const input = byNum(body, 2)[0].data
  const userInput = byNum(byNum(input, 6)[0].data, 1)[0].data
  const userQuery = byNum(userInput, 1)[0].data
  const query = str(byNum(userQuery, 1)[0])
  expect(query).toContain("The following is the transcript")
  expect(query).toContain("[system instructions]\nbe brief")
  expect(query).toContain("[tool result for t1]\na.txt\nb.txt")
  expect(query).toContain("taking the tool results into account")
})

test("a lone user message rides as itself, not as a transcript", () => {
  const { body } = buildRequest({ model: "auto", messages: [{ role: "user", content: "hi" }] })
  const input = byNum(body, 2)[0].data
  const userInput = byNum(byNum(input, 6)[0].data, 1)[0].data
  const query = str(byNum(byNum(userInput, 1)[0].data, 1)[0])
  expect(query).toBe("hi")
})

// ---- the answer, as events ------------------------------------------------------

// event builds one SSE ResponseEvent: init(1), client_actions(2) or finished(3)
const event = (num, inner) => Buffer.from(new PB().b_(num, inner.b).b).toString("base64url")
const message = (id, oneofNum, inner) => new PB().s(1, id).m(oneofNum, inner)
const addToTask = (...msgs) => {
  const add = new PB().s(1, "task")
  for (const m of msgs) add.m(2, m)
  return event(2, new PB().m(1, new PB().m(3, add)))
}
const appendTo = (msg, mask) =>
  event(2, new PB().m(1, new PB().m(5, new PB().m(1, msg).m(2, new PB().s(1, mask)).s(3, "task"))))

const collect = async (lines) => {
  const text = lines.map((d) => `event:data\ndata:${d}\n\n`).join("")
  const body = (async function* () { yield text })()
  const out = []
  for await (const e of turnEvents(body)) out.push(e)
  return out
}

test("text streams by append, a tool call arrives whole, the end carries usage", async () => {
  const textMsg = (t) => message("m1", 3, new PB().s(1, t))
  const reasoningMsg = (t) => message("m2", 15, new PB().s(1, t))
  const toolMsg = message("m3", 4, new PB().s(1, "c1").m(12, new PB().s(1, "get_weather").m(2, new PB().m(1, new PB().s(1, "city").m(2, new PB().s(3, "Paris"))))))
  const out = await collect([
    event(1, new PB().s(1, "conv-1")),
    addToTask(textMsg("he"), reasoningMsg("think")),
    appendTo(textMsg("llo"), "agent_output.text"),
    addToTask(toolMsg),
    event(3, new PB().m(2, new PB()).m(11, new PB().v(10, 71))),
  ])
  expect(out.filter((e) => e.text).map((e) => e.text).join("")).toBe("hello")
  expect(out.filter((e) => e.reasoning).map((e) => e.reasoning).join("")).toBe("think")
  const tool = out.find((e) => e.tool)?.tool
  expect(tool).toMatchObject({ id: "c1", name: "get_weather", args: { city: "Paris" } })
  const end = out.at(-1).end
  expect(end.reason).toBe("done")
  expect(end.tools).toEqual([tool])
  expect(end.usage).toMatchObject({ input: 71 })
})

test("a quota end is named, and so is an internal error", async () => {
  const quota = await collect([event(3, new PB().m(4, new PB()))])
  expect(quota.at(-1).end.reason).toBe("quota")
  const err = await collect([event(3, new PB().m(7, new PB().s(1, "boom")))])
  expect(err.at(-1).end).toMatchObject({ reason: "other", message: "boom" })
})
