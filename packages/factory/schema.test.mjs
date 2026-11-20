import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
const url = "https://api.factory.ai/api/llm/a/v1/messages"
const object = { type: "object", properties: { mode: { const: "view" }, id: { type: "string" } }, required: ["mode", "id"], additionalProperties: false }
const input = { mode: "view", id: "task_1" }
const request = (schema, extra = {}) => ({
  model: "claude-opus-5-5", max_tokens: 64, system: [{ type: "text", text: _internal.DROID_LINE }],
  messages: [{ role: "user", content: "Use the task tool." }],
  tools: [{ name: "Task", input_schema: schema }], ...extra,
})

async function loaded(serve) {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), ...init })
    return serve(JSON.parse(init.body), init)
  }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => { throw new Error("unexpected auth write") } } } })
  const auth = { type: "oauth", access: "test-token", expires: Date.now() + 3_600_000, activeOrganizationId: "test-org" }
  return { l: await hooks.auth.loader(async () => auth), seen }
}

for (const keyword of ["anyOf", "oneOf", "allOf"]) {
  test(`Factory accepts ${keyword} tools and the caller receives the original arguments`, async () => {
    const create = { type: "object", properties: { mode: { const: "create" }, name: { type: "string" } }, required: ["mode", "name"], additionalProperties: false }
    const schema = { [keyword]: keyword === "allOf" ? [object, { properties: { id: { pattern: "^task_" } } }] : [object, create] }
    const { l, seen } = await loaded((body) => {
      if (body.tools.some((t) => ["anyOf", "oneOf", "allOf"].some((k) => Object.hasOwn(t.input_schema, k)))) {
        return Response.json({ type: "error", error: { type: "invalid_request_error", message: "tools.0.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level" } }, { status: 400 })
      }
      return Response.json({ id: "msg_1", type: "message", content: [{ type: "tool_use", id: "call_1", name: "Task", input: { arguments: input } }], stop_reason: "tool_use", usage: { input_tokens: 7, output_tokens: 5 } })
    })
    const res = await l.fetch(url, { method: "POST", body: JSON.stringify(request(schema)) })
    expect(res.status).toBe(200)
    expect(JSON.parse(seen[0].body).tools[0].input_schema).toEqual({ type: "object", properties: { arguments: schema }, required: ["arguments"], additionalProperties: false })
    const answer = await res.json()
    expect(answer.content[0]).toEqual({ type: "tool_use", id: "call_1", name: "Task", input })
    expect(answer.usage).toEqual({ input_tokens: 7, output_tokens: 5 })
  })
}

test("wraps previous tool inputs and examples, preserving ordinary tools and count_tokens replies", async () => {
  const schema = { anyOf: [object] }
  const ordinary = { name: "Read", input_schema: { type: "object", properties: { path: { anyOf: [{ type: "string" }, { type: "null" }] } } } }
  const body = request(schema, {
    tools: [{ name: "Task", input_schema: schema, input_examples: [input], cache_control: { type: "ephemeral" } }, ordinary],
    messages: [{ role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "Task", input }, { type: "tool_use", id: "call_2", name: "Read", input: { path: null } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "done" }] }],
  })
  const { l, seen } = await loaded(() => Response.json({ input_tokens: 42 }))
  const res = await l.fetch(url + "/count_tokens", { method: "POST", body: JSON.stringify(body) })
  const sent = JSON.parse(seen[0].body)
  expect(sent.messages[0].content[0].input).toEqual({ arguments: input })
  expect(sent.messages[0].content[1]).toEqual(body.messages[0].content[1])
  expect(sent.messages[1]).toEqual(body.messages[1])
  expect(sent.tools[0].input_examples).toEqual([{ arguments: input }])
  expect(sent.tools[0].cache_control).toEqual(body.tools[0].cache_control)
  expect(sent.tools[1]).toEqual(ordinary)
  expect(await res.json()).toEqual({ input_tokens: 42 })
})

test("rebases document pointers, respecting resource ids, anchors and literal data", async () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
    anyOf: [{ $ref: "#/$defs/view" }, { $ref: "#%2F$defs%2Fview" }, { $ref: "#anchor" }, { $ref: "https://example.test/other.json" }],
    $defs: {
      view: { ...object, $anchor: "anchor", properties: { ...object.properties, nested: { $ref: "#" } } },
      resource: { $id: "child.json", $defs: { value: { type: "string" } }, anyOf: [{ $ref: "#/$defs/value" }] },
    },
    properties: { literal: { const: { $ref: "#/$defs/untouched", anyOf: [{ $ref: "literal" }] }, default: { $ref: "default" }, examples: [{ $ref: "example" }] } },
  }
  const { l, seen } = await loaded(() => Response.json({ content: [] }))
  await l.fetch(url, { method: "POST", body: JSON.stringify(request(schema)) })
  const wrapped = JSON.parse(seen[0].body).tools[0].input_schema
  const original = wrapped.properties.arguments
  expect(wrapped.$schema).toBe(schema.$schema)
  expect(original.anyOf).toEqual([{ $ref: "#/properties/arguments/$defs/view" }, { $ref: "#/properties/arguments%2F$defs%2Fview" }, schema.anyOf[2], schema.anyOf[3]])
  expect(original.$defs.view.properties.nested.$ref).toBe("#/properties/arguments")
  expect(original.$defs.resource).toEqual(schema.$defs.resource)
  expect(original.properties.literal).toEqual(schema.properties.literal)
  expect(schema.anyOf[0].$ref).toBe("#/$defs/view")
})

test("keeps a root $id resource and its references intact", async () => {
  const schema = { $id: "https://example.test/tool.json", $defs: { view: object }, oneOf: [{ $ref: "#/$defs/view" }] }
  const { l, seen } = await loaded(() => Response.json({ content: [] }))
  await l.fetch(url, { method: "POST", body: JSON.stringify(request(schema)) })
  expect(JSON.parse(seen[0].body).tools[0].input_schema.properties.arguments).toEqual(schema)
})

test("does not silently relocate a recursive resource without $id", async () => {
  const { l, seen } = await loaded(() => Response.json({ content: [] }))
  const schema = { anyOf: [{ $recursiveRef: "#" }], $recursiveAnchor: true }
  await expect(l.fetch(url, { method: "POST", body: JSON.stringify(request(schema)) })).rejects.toThrow("recursive tool schema needs $id")
  expect(seen).toHaveLength(0)
})

test("ordinary tools, nested compositions and OpenAI routes retain their original bytes", async () => {
  const response = '{ "content": [{"type":"tool_use","name":"Task","input":{"arguments":"a real caller field"}}] }'
  const { l, seen } = await loaded(() => new Response(response, { headers: { "content-type": "application/json" } }))
  const body = JSON.stringify(request({ type: "object", properties: { value: { anyOf: [{ type: "string" }, { type: "null" }] } } }))
  const res = await l.fetch(url, { method: "POST", body })
  expect(seen[0].body).toBe(body)
  expect(await res.text()).toBe(response)
  const openai = JSON.stringify({ model: "gpt-6-sol", instructions: _internal.DROID_LINE, input: "OK", tools: [{ type: "function", name: "Task", parameters: { anyOf: [object] } }] })
  const other = await l.fetch("https://api.factory.ai/api/llm/o/v1/responses", { method: "POST", body: openai })
  expect(seen[1].body).toBe(openai)
  expect(await other.text()).toBe(response)
})

test("drops stale lengths after changing a request or reply, preserving response metadata", async () => {
  const reply = JSON.stringify({ content: [{ type: "tool_use", name: "Task", id: "call_1", input: { arguments: input } }], usage: { output_tokens: 42 } })
  const { l, seen } = await loaded(() => new Response(reply, { headers: { "content-type": "application/json", "content-length": String(reply.length), "content-encoding": "identity", "x-request-id": "request_1" } }))
  const res = await l.fetch(url, { method: "POST", headers: { "content-length": "1" }, body: JSON.stringify(request({ type: "object", anyOf: [object] })) })
  expect(seen[0].headers.get("content-length")).toBeNull()
  expect(res.headers.get("content-length")).toBeNull()
  expect(res.headers.get("content-encoding")).toBeNull()
  expect(res.headers.get("x-request-id")).toBe("request_1")
  expect(res.headers.get("x-magpie-sign-in")).toBe("kept")
  expect((await res.json()).content[0].input).toEqual(input)
})

for (const input of [{ wrong: {} }, { arguments: {}, extra: true }]) {
  test("invalid argument envelopes fail instead of reaching the caller", async () => {
    const { l } = await loaded(() => Response.json({ content: [{ type: "tool_use", name: "Task", input }] }))
    await expect(l.fetch(url, { method: "POST", body: JSON.stringify(request({ anyOf: [object] })) })).rejects.toThrow("invalid wrapped arguments")
  })
}

test("upstream errors pass through without attempting to unwrap them", async () => {
  const error = '{"type":"error","error":{"type":"overloaded_error","message":"try later"}}'
  const { l } = await loaded(() => new Response(error, { status: 529, headers: { "content-type": "application/json", "retry-after": "5" } }))
  const res = await l.fetch(url, { method: "POST", body: JSON.stringify(request({ anyOf: [object] })) })
  expect(res.status).toBe(529)
  expect(res.headers.get("retry-after")).toBe("5")
  expect(await res.text()).toBe(error)
})

const event = (type, data, eol = "\n") => `event: ${type}${eol}data: ${JSON.stringify({ type, ...data })}${eol}${eol}`
function bytes(text, size = 1, cancel) {
  const data = new TextEncoder().encode(text)
  let offset = 0
  return new ReadableStream({
    pull(c) {
      if (offset >= data.length) c.close()
      else { c.enqueue(data.slice(offset, offset + size)); offset += size }
    }, cancel,
  })
}
function events(text) {
  return text.split(/\r\n\r\n|\n\n|\r\r/).flatMap((frame) => {
    const data = frame.split(/\r\n|\n|\r/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
    return data && data !== "[DONE]" ? [JSON.parse(data)] : []
  })
}

for (const eol of ["\n", "\r\n"]) {
  test(`streaming tools survive ${JSON.stringify(eol)} frames, split UTF-8 and interleaved blocks`, async () => {
    const wrapped = JSON.stringify({ arguments: { ...input, text: '汉字 😀 "arguments" { braces }' } })
    const ordinary = JSON.stringify({ arguments: "a caller-owned field" })
    let stream = ": keep-alive" + eol + eol
      + event("message_start", { message: { id: "msg_1", usage: { input_tokens: 7 } } }, eol)
      + event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }, eol)
      + event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "先调用" } }, eol)
      + "id: event_1" + eol + "retry: 1000" + eol
      + event("content_block_start", { index: 1, content_block: { type: "tool_use", id: "call_1", name: "Task", input: {} } }, eol)
      + event("content_block_start", { index: 2, content_block: { type: "tool_use", id: "call_2", name: "read", input: {} } }, eol)
    for (let i = 0; i < wrapped.length; i += 3) stream += event("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: wrapped.slice(i, i + 3) } }, eol)
    stream += event("ping", {}, eol)
      + event("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: ordinary } }, eol)
      + event("content_block_stop", { index: 2 }, eol)
      + event("content_block_stop", { index: 1 }, eol)
      + event("content_block_stop", { index: 0 }, eol)
      + event("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }, eol)
      + event("message_stop", {}, eol)
    const { l } = await loaded(() => new Response(bytes(stream), { headers: { "content-type": "text/event-stream", "content-length": "1" } }))
    const tools = [{ name: "Task", input_schema: { anyOf: [object] } }, { name: "read", input_schema: { type: "object" } }]
    const res = await l.fetch(url, { method: "POST", body: JSON.stringify(request({}, { tools, stream: true })) })
    const text = await res.text(), out = events(text)
    expect(text).toContain(": keep-alive")
    expect(text).toContain("id: event_1")
    expect(text).toContain("retry: 1000")
    expect(res.headers.get("content-length")).toBeNull()
    const argumentsFor = (index) => out.filter((e) => e.type === "content_block_delta" && e.index === index && e.delta.type === "input_json_delta").map((e) => e.delta.partial_json).join("")
    expect(JSON.parse(argumentsFor(1))).toEqual({ ...input, text: '汉字 😀 "arguments" { braces }' })
    expect(argumentsFor(2)).toBe(ordinary)
    expect(out.filter((e) => e.type === "content_block_start").map((e) => e.content_block.id).filter(Boolean)).toEqual(["call_1", "call_2"])
    expect(out.find((e) => e.type === "message_delta").usage).toEqual({ output_tokens: 9 })
    expect(out.at(-1).type).toBe("message_stop")
  })
}

test("preserves large integer arguments in JSON, history and streaming replies", async () => {
  const number = "900719925474099312345"
  const input = '{"number":' + number + '}'
  const reply = '{"content":[{"type":"tool_use","name":"Task","input":{"arguments":' + input + '}}]}'
  const { l, seen } = await loaded(() => new Response(reply, { headers: { "content-type": "application/json" } }))
  const body = JSON.stringify(request({ anyOf: [{ type: "object" }] }, { messages: [{ role: "assistant", content: [{ type: "tool_use", name: "Task", id: "call_1", input: "RAW_INPUT" }] }, { role: "user", content: "continue" }] })).replace('"RAW_INPUT"', input)
  const res = await l.fetch(url, { method: "POST", body })
  expect(seen[0].body).toContain('"arguments":' + input)
  expect(await res.text()).toContain('"input":' + input)
  const stream = event("content_block_start", { index: 1, content_block: { type: "tool_use", name: "Task", input: {} } })
    + event("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"arguments":' + input + '}' } })
    + event("content_block_stop", { index: 1 }) + event("message_stop", {})
  globalThis.fetch = async () => new Response(bytes(stream, 5), { headers: { "content-type": "text/event-stream" } })
  const streamed = await l.fetch(url, { method: "POST", body: JSON.stringify(request({ anyOf: [{ type: "object" }] }, { stream: true })) })
  expect(events(await streamed.text()).find((e) => e.type === "content_block_delta").delta.partial_json).toBe(input)
})

test("streaming initial inputs are unwrapped when the upstream sends no argument deltas", async () => {
  const stream = event("content_block_start", { index: 1, content_block: { type: "tool_use", name: "Task", input: { arguments: input } } }) + event("content_block_stop", { index: 1 }) + event("message_stop", {})
  const { l } = await loaded(() => new Response(bytes(stream, 7), { headers: { "content-type": "text/event-stream" } }))
  const res = await l.fetch(url, { method: "POST", body: JSON.stringify(request({ anyOf: [object] }, { stream: true })) })
  const out = events(await res.text())
  expect(out[0].content_block.input).toEqual({})
  expect(JSON.parse(out[1].delta.partial_json)).toEqual(input)
})

for (const end of ["", event("message_stop", {})]) {
  test("an incomplete stream cannot deliver a completed tool call", async () => {
    const stream = event("content_block_start", { index: 1, content_block: { type: "tool_use", name: "Task", input: {} } }) + event("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"arguments":{' } }) + end
    const { l } = await loaded(() => new Response(bytes(stream), { headers: { "content-type": "text/event-stream" } }))
    const res = await l.fetch(url, { method: "POST", body: JSON.stringify(request({ anyOf: [object] }, { stream: true })) })
    await expect(res.text()).rejects.toThrow("incomplete wrapped tool arguments")
  })
}

test("upstream stream errors are preserved even during a partial tool call", async () => {
  const error = event("error", { error: { type: "overloaded_error", message: "try later" } })
  const stream = event("content_block_start", { index: 1, content_block: { type: "tool_use", name: "Task", input: {} } }) + error
  const { l } = await loaded(() => new Response(bytes(stream), { headers: { "content-type": "text/event-stream" } }))
  const res = await l.fetch(url, { method: "POST", body: JSON.stringify(request({ anyOf: [object] }, { stream: true })) })
  expect(await res.text()).toContain(error)
})

test("cancelling the adapted stream cancels the upstream reader", async () => {
  let cancelled
  const { l } = await loaded(() => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(event("message_start", { message: { id: "msg_1" } }))) }, cancel(reason) { cancelled = reason } }), { headers: { "content-type": "text/event-stream" } }))
  const res = await l.fetch(url, { method: "POST", body: JSON.stringify(request({ anyOf: [object] }, { stream: true })) })
  const reader = res.body.getReader()
  await reader.read()
  await reader.cancel("caller stopped")
  expect(cancelled).toBe("caller stopped")
})

test("concurrent requests do not share their wrapped tool names", async () => {
  const { l } = await loaded((body) => Response.json({ content: [{ type: "tool_use", name: "Task", input: Object.hasOwn(body.tools[0].input_schema.properties ?? {}, "arguments") ? { arguments: input } : { arguments: "ordinary" } }] }))
  const [wrapped, ordinary] = await Promise.all([
    l.fetch(url, { method: "POST", body: JSON.stringify(request({ anyOf: [object] })) }),
    l.fetch(url, { method: "POST", body: JSON.stringify(request({ type: "object", properties: {} })) }),
  ])
  expect((await wrapped.json()).content[0].input).toEqual(input)
  expect((await ordinary.json()).content[0].input).toEqual({ arguments: "ordinary" })
})
