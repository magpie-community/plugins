import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { after, test } from "node:test"

// Expose private seams from an isolated copy, without adding production exports.
// These cases cover the assistant-prefill tail: run positions, validation, the
// continuation carrier rendering, the cross-turn ledger alignment, and the
// AGY_BRIDGE_PREFILL=0 stock-behavior toggle.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-prefill-tail-test-"))
const entry = new URL("../index.mjs", import.meta.url)
let source = fs.readFileSync(entry, "utf8")
source = source.replace(/from "(\.\/[^"\n]+)"/g, (_, target) => `from ${JSON.stringify(new URL(target, entry).href)}`)
fs.writeFileSync(path.join(workspace, "bridge.mjs"), source + "\nexport { trailingMessages, prefillRun, assistantTextOf, validateBody, renderTurnMessagesParts, renderInitialPromptParts };\n")
const { trailingMessages, prefillRun, assistantTextOf, validateBody, renderTurnMessagesParts, renderInitialPromptParts } = await import(pathToFileURL(path.join(workspace, "bridge.mjs")).href)
after(() => fs.rmSync(workspace, { recursive: true, force: true }))

const U = text => ({ role: "user", content: text })
const A = text => ({ role: "assistant", content: text })
const S = text => ({ role: "system", content: text })
const toolUseTail = () => ({ role: "assistant", content: [{ type: "text", text: "working" }, { type: "tool_use", id: "call_a", name: "Read", input: { path: "a" } }] })
const join = parts => parts.map(part => part?.text || "").join("")

test("assistantTextOf collects text blocks and refuses anything else", () => {
  assert.equal(assistantTextOf(A("abc")), "abc")
  assert.equal(assistantTextOf({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "ab")
  assert.equal(assistantTextOf({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "tool_use", id: "x", name: "f", input: {} }] }), null)
  assert.equal(assistantTextOf(A("")), "")
})

test("prefillRun locates the trailing text-only assistant run", () => {
  assert.deepEqual(prefillRun([U("1"), A("p1"), A("r1"), U("2"), A("p2")]), { runStart: 4, boundary: 3 })
  assert.deepEqual(prefillRun([U("1"), A("p")]), { runStart: 1, boundary: 0 })
  assert.deepEqual(prefillRun([A("r"), A("p")]), { runStart: 0, boundary: 0 })
  assert.equal(prefillRun([U("1"), A("r1"), U("2")]), null, "a user tail is not a prefill")
  assert.equal(prefillRun([U("1"), toolUseTail()]), null, "a tool_use tail is not a prefill")
})

test("trailingMessages keeps a prefill tail out of the replayed history", () => {
  const { history, messages } = trailingMessages({ messages: [U("1"), A("p1"), A("r1"), U("2"), A("p2")] })
  assert.deepEqual(history, [U("1"), A("p1"), A("r1")])
  assert.deepEqual(messages, [U("2"), A("p2")])
  const fresh = trailingMessages({ messages: [U("1"), A("p")] })
  assert.deepEqual(fresh.history, [])
  assert.deepEqual(fresh.messages, [U("1"), A("p")])
  const withSystem = trailingMessages({ messages: [S("sys"), U("1"), A("p1"), A("r1"), U("2"), A("p2")] })
  assert.deepEqual(withSystem.history, [U("1"), A("p1"), A("r1")], "a leading system message is promoted, not replayed")
  const normal = trailingMessages({ messages: [U("1"), A("r1"), U("2")] })
  assert.deepEqual(normal.history, [U("1"), A("r1")])
  assert.deepEqual(normal.messages, [U("2")])
})

test("the session ledger stays aligned with the client history across prefill turns", () => {
  // turn 1: a fresh prefill request. startTurn records the client messages and
  // recordAssistantResponse appends the reply.
  const t1 = trailingMessages({ messages: [U("one"), A("<story>")] })
  assert.deepEqual(t1.history, [])
  const ledger = [...t1.messages, A("first reply")]
  // turn 2: the client re-sends its history plus the next prefill. The patched
  // boundary must land exactly on the ledger, or the session would be retired.
  const t2 = trailingMessages({ messages: [...ledger, U("two"), A("<story> two")] })
  assert.deepEqual(t2.history, ledger, "cross-turn ledger alignment")
  ledger.push(U("two"), A("<story> two"), A("second reply"))
  // turn 3: a plain user turn (no prefill) keeps aligning with the ledger.
  const t3 = trailingMessages({ messages: [...ledger, U("three")] })
  assert.deepEqual(t3.history, ledger)
})

test("validateBody serves a prefill tail and rejects the unsupported shapes", () => {
  validateBody({ messages: [U("1"), A("p")] })
  validateBody({ messages: [U("1"), A("p1"), A("r1"), U("2"), A("p2")] })
  assert.throws(() => validateBody({ messages: [A("r"), A("p")] }), /no user turn to continue from/)
  assert.throws(() => validateBody({ messages: [U("1"), toolUseTail()] }), /not from the user or a tool-result/)
  assert.throws(
    () => validateBody({ messages: [U("1"), A("r1"), { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: "done" }] }, A("p")] }),
    /tool_result with an assistant prefill/,
  )
})

test("a trailing prefill run renders as a continuation carrier, not a system reminder", () => {
  process.env.AGY_BRIDGE_PREFILL_CARRIER_NOTE = "CARRIER-NOTE-MARKER"
  try {
    const text = join(renderTurnMessagesParts([U("stay aside"), A("<story>opening")]))
    assert.ok(text.includes("CARRIER-NOTE-MARKER"), "the carrier note is rendered")
    assert.ok(text.includes("<story>opening"), "the prefill fragment is rendered")
    assert.ok(!text.includes("system-reminder"), "the stock system-reminder wrap is replaced")
    const normal = join(renderTurnMessagesParts([U("1"), A("r1"), U("2")]))
    assert.ok(!normal.includes("CARRIER-NOTE-MARKER"), "a plain request renders without the carrier")
  } finally {
    delete process.env.AGY_BRIDGE_PREFILL_CARRIER_NOTE
  }
})

test("a fresh session's initial prompt carries the prefill carrier too", () => {
  process.env.AGY_BRIDGE_PREFILL_CARRIER_NOTE = "CARRIER-NOTE-MARKER"
  try {
    const text = join(renderInitialPromptParts({ messages: [U("one"), A("<story>opening")] }, null, true))
    assert.ok(text.includes("CARRIER-NOTE-MARKER"))
    assert.ok(text.includes("<story>opening"))
  } finally {
    delete process.env.AGY_BRIDGE_PREFILL_CARRIER_NOTE
  }
})

test("AGY_BRIDGE_PREFILL=0 restores the stock reject and the stock split", () => {
  process.env.AGY_BRIDGE_PREFILL = "0"
  try {
    assert.throws(() => validateBody({ messages: [U("1"), A("p")] }), /not from the user or a tool-result/)
    const { history, messages } = trailingMessages({ messages: [U("1"), A("p")] })
    assert.deepEqual(messages, [])
    assert.deepEqual(history, [U("1"), A("p")])
    // prefillRun itself is pure geometry and stays toggle-agnostic: the
    // callers (trailingMessages, validateBody, the renderer) gate on
    // prefillTailEnabled, so only their behavior changes with the toggle.
  } finally {
    delete process.env.AGY_BRIDGE_PREFILL
  }
})

test("the boundary transform is deterministic for identical requests", () => {
  const body = { messages: [U("1"), A("p1"), A("r1"), U("2"), A("p2")] }
  assert.deepEqual(trailingMessages(body), trailingMessages(body))
})
