// Kiro refuses a tool name longer than 64 characters with
// "Invalid tool use format" (yetone/magpie#1393). The name is aliased on
// the way in — declaration and history — and the original comes back on
// the way out.
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { buildKiro, events, reply, toolName, namesBack } = _internal

const DOCS = "mcp__plugin_cloudflare_cloudflare-docs__search_cloudflare_documentation" // 71
const GUIDE = "mcp__plugin_cloudflare_cloudflare-docs__migrate_pages_to_workers_guide" // 70

const sent = (req) => JSON.parse(buildKiro(req, "claude-sonnet-4.5", "", 0)).conversationState
const specs = (s) => s.currentMessage.userInputMessage.userInputMessageContext.tools.map((t) => t.toolSpecification.name)
const tool = (name, description = "d") => ({ name, description, input_schema: { type: "object" } })

test("a name that fits is sent unchanged", () => {
  const fit = "a".repeat(64)
  const s = sent({ messages: [{ role: "user", content: "hi" }], tools: [tool(fit), tool("Bash")] })
  expect(specs(s)).toEqual([fit, "Bash"])
  expect(toolName(fit)).toBe(fit)
  expect(toolName("Bash")).toBe("Bash")
  expect(toolName("")).toBe("")
  expect(toolName(undefined)).toBeUndefined()
})

test("a name Kiro would refuse for length is aliased the same way every time", () => {
  const req = {
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_a", name: DOCS, input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "ok" }] },
    ],
    tools: [tool(DOCS, "Search Cloudflare docs"), tool(GUIDE, "Migrate")],
  }
  const names = specs(sent(req))
  expect(names).toEqual([toolName(DOCS), toolName(GUIDE)])
  for (const n of names) expect(n).toHaveLength(64)
  expect(names[0]).not.toBe(DOCS)
  expect(names[1]).not.toBe(GUIDE)
  expect(new Set(names).size).toBe(2)
  expect(sent(req).history[1].assistantResponseMessage.toolUses.map((c) => c.name)).toEqual([names[0]])
  expect(specs(sent(req))).toEqual(names)
  expect(toolName(names[0])).toBe(names[0])
})

test("two long names that share the kept prefix stay distinct", () => {
  const stem = "p".repeat(60)
  const a = toolName(stem + "alpha")
  const b = toolName(stem + "beta")
  expect(a).toHaveLength(64)
  expect(b).toHaveLength(64)
  expect(a).not.toBe(b)
  expect(a).not.toBe(stem + "alpha")
})

test("a long name only the history used is declared once, under the alias", () => {
  const req = {
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_a", name: DOCS, input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "ok" }] },
    ],
  }
  const s = sent(req)
  const names = specs(s)
  expect(names).toEqual([toolName(DOCS)])
  expect(names[0]).toHaveLength(64)
  expect(s.history[1].assistantResponseMessage.toolUses[0].name).toBe(names[0])
  expect(s.currentMessage.userInputMessage.userInputMessageContext.tools).toEqual([
    { toolSpecification: { name: names[0], description: "Tool", inputSchema: { json: { type: "object", properties: {} } } } },
  ])
  expect(namesBack(req).get(names[0])).toBe(DOCS)
})

// frame is one AWS event-stream message with string headers. frames() does
// not check the trailing checksum.
function frame(headers, payload) {
  const enc = new TextEncoder()
  const hs = []
  for (const [k, v] of Object.entries(headers)) {
    const name = enc.encode(k)
    const val = enc.encode(v)
    const h = new Uint8Array(1 + name.length + 1 + 2 + val.length)
    h[0] = name.length
    h.set(name, 1)
    h[1 + name.length] = 7
    new DataView(h.buffer).setUint16(2 + name.length, val.length)
    h.set(val, 4 + name.length)
    hs.push(h)
  }
  const hlen = hs.reduce((n, h) => n + h.length, 0)
  const body = enc.encode(JSON.stringify(payload))
  const total = 12 + hlen + body.length + 4
  const out = new Uint8Array(total)
  const v = new DataView(out.buffer)
  v.setUint32(0, total)
  v.setUint32(4, hlen)
  let i = 12
  for (const h of hs) {
    out.set(h, i)
    i += h.length
  }
  out.set(body, i)
  return out
}

test("the caller sees the original name, and a short name is left alone", async () => {
  const req = { messages: [{ role: "user", content: "hi" }], tools: [tool(DOCS), tool("Bash")] }
  const aliased = specs(sent(req))[0]
  const back = namesBack(req)
  expect([...back.keys()]).toEqual([aliased])
  expect(back.get(aliased)).toBe(DOCS)
  const body = new ReadableStream({
    start(c) {
      c.enqueue(frame({ ":message-type": "event", ":event-type": "toolUseEvent" }, { toolUseId: "tid", name: aliased, input: "{}" }))
      c.enqueue(frame({ ":message-type": "event", ":event-type": "toolUseEvent" }, { toolUseId: "bid", name: "Bash", input: "{}" }))
      c.close()
    },
  })
  const res = await reply(events(body, "claude-sonnet-4.5", 0, back), "claude-sonnet-4.5", false)
  expect(res.status).toBe(200)
  expect((await res.json()).content).toEqual([
    { type: "tool_use", id: "tid", name: DOCS, input: {} },
    { type: "tool_use", id: "bid", name: "Bash", input: {} },
  ])
})
