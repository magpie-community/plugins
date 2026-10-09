// Kiro refuses a tool name longer than 64 characters with
// "Invalid tool use format" (yetone/magpie#1393). The name is aliased on
// the way in — declaration and history — and the original comes back on
// the way out.
import { createHash } from "node:crypto"
import { expect, test } from "bun:test"
import { _internal } from "./index.mjs"

const { buildKiro, events, reply } = _internal

const DOCS = "mcp__plugin_cloudflare_cloudflare-docs__search_cloudflare_documentation" // 71
const GUIDE = "mcp__plugin_cloudflare_cloudflare-docs__migrate_pages_to_workers_guide" // 70

const sent = (req) => JSON.parse(buildKiro(req, "claude-sonnet-4.5", "", 0)).conversationState
const specs = (s) => s.currentMessage.userInputMessage.userInputMessageContext.tools.map((t) => t.toolSpecification.name)

test("a name that fits is sent unchanged", () => {
  const fit = "a".repeat(64)
  const s = sent({ messages: [{ role: "user", content: "hi" }], tools: [{ name: fit, description: "d", input_schema: { type: "object" } }, { name: "Bash", description: "d", input_schema: { type: "object" } }] })
  expect(specs(s)).toEqual([fit, "Bash"])
})

test("a name Kiro would refuse for length is aliased in the declaration and in history", () => {
  const s = sent({
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_a", name: DOCS, input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "ok" }] },
    ],
    tools: [
      { name: DOCS, description: "Search Cloudflare docs", input_schema: { type: "object", properties: {} } },
      { name: GUIDE, description: "Migrate", input_schema: { type: "object", properties: {} } },
    ],
  })
  const names = specs(s)
  expect(names).toHaveLength(2)
  for (const n of names) {
    expect(n).toHaveLength(64)
    expect(n).not.toBe(DOCS)
    expect(n).not.toBe(GUIDE)
  }
  expect(new Set(names).size).toBe(2)
  expect(s.history[1].assistantResponseMessage.toolUses.map((c) => c.name)).toEqual([names[0]])
})

test("an alias already taken by a shorter tool shifts along the hash", () => {
  const long = "b".repeat(70)
  const h = createHash("sha256").update(long).digest("hex")
  const taken = long.slice(0, 55) + "_" + h.slice(0, 8)
  const s = sent({
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { name: taken, description: "short", input_schema: { type: "object" } },
      { name: long, description: "long", input_schema: { type: "object" } },
    ],
  })
  const names = specs(s)
  expect(names[0]).toBe(taken)
  expect(names[1]).toHaveLength(64)
  expect(names[1]).not.toBe(taken)
  expect(names[1]).toBe(long.slice(0, 55) + "_" + h.slice(1, 9))
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

test("the original name is what the caller sees when Kiro calls the alias", async () => {
  const alias = sent({ messages: [{ role: "user", content: "hi" }], tools: [{ name: DOCS, description: "d", input_schema: { type: "object" } }] })
  const aliased = specs(alias)[0]
  const body = new ReadableStream({
    start(c) {
      c.enqueue(frame({ ":message-type": "event", ":event-type": "toolUseEvent" }, { toolUseId: "tid", name: aliased, input: "{}" }))
      c.close()
    },
  })
  const res = await reply(events(body, "claude-sonnet-4.5", 0, new Map([[aliased, DOCS]])), "claude-sonnet-4.5", false)
  expect(res.status).toBe(200)
  expect((await res.json()).content).toEqual([{ type: "tool_use", id: "tid", name: DOCS, input: {} }])
})
