// plugins#1592 (ninago4nina, agy-cli 0.1.144): a single-turn request with
// no history and no tools, sent through magpie again and again, dropped
// its agy every time as a lost history:
//   {"action":"session_new","reason":"history","fresh":true,"spare":true,
//    "history":0,"first_diff":{"index":0,"from_end":1,
//    "field":"missing_actual","rows":2,...}}
// magpie streams every request it translates, so the client's stream:false
// reached the bridge as a stream, and the stateless reuse (0.1.112) never
// applied. The same opening sent again is a new conversation, not a history
// the live session lost: it now opens a session of its own in that idle agy.
//
// bun test ./same-opening.mjs

import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

function captureStderr() {
  const lines = []
  const original = process.stderr.write
  process.stderr.write = function write(chunk, ...rest) {
    const text = String(chunk)
    if (text.startsWith("[agy-bridge] ")) {
      lines.push(JSON.parse(text.slice("[agy-bridge] ".length)))
      return true
    }
    return original.call(this, chunk, ...rest)
  }
  return { lines, restore: () => { process.stderr.write = original } }
}

const sessionRows = (lines) => lines.filter((row) => row.event === "agy_bridge_session" && row.action === "session_new")
const calls = (kit, method) => kit.acpLog.filter((entry) => entry.method === method)

// the reporter's request as magpie hands it on: one user message, no
// tools, streamed (magpie's translate path streams), gemini-4-neon-low
const single = () => baseBody({
  model: "agy-cli/gemini-4-neon-low",
  tools: undefined,
  messages: [{ role: "user", content: "Reply with OK" }],
})

async function withKit(options, fn) {
  const kit = await createBridgeKit({ sessionClose: true, ...options })
  kit.defaultPrompt = async (agent) => {
    await agent.thought("The user wants OK.")
    await agent.text("OK")
    return { stopReason: "end_turn", usage: { inputTokens: 2172, outputTokens: 26, thoughtTokens: 24 } }
  }
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

for (const spare of ["0", "1"]) {
  test(`the same single-turn request sent again opens a session in its own agy (spares ${spare === "1" ? "on" : "off"})`, async () => {
    const captured = captureStderr()
    try {
      await withKit({ env: { AGY_BRIDGE_SPARE: spare } }, async (kit) => {
        for (let i = 0; i < 3; i++) {
          const out = await readSse(await kit.request(single()))
          assert.equal(out.content.find((block) => block.type === "text")?.text, "OK")
        }
        // one agy answered all three, each in a session of its own
        assert.deepEqual(calls(kit, "session/new").map((entry) => entry.spawn), [0, 0, 0])
        assert.equal(calls(kit, "session/close").length, 2)
      })
    } finally {
      captured.restore()
    }
    const rows = sessionRows(captured.lines)
    assert.equal(rows.length, 3)
    assert.equal(rows[0].reason, "no_live")
    for (const row of rows.slice(1)) {
      // a new conversation, not a lost history: no diff, and no agy dropped
      assert.equal(row.reason, "fresh_after_first", JSON.stringify(row))
      assert.equal(row.first_diff, undefined, JSON.stringify(row))
      assert.equal(row.reused, true, JSON.stringify(row))
      assert.equal(row.spare, false, JSON.stringify(row))
    }
  })
}

test("a conversation that went on, then opened again from its start, keeps its agy", async () => {
  const captured = captureStderr()
  try {
    await withKit({}, async (kit) => {
      const body = single()
      const first = await readSse(await kit.request(body))
      await readSse(await kit.request({
        ...body,
        messages: [...body.messages, { role: "assistant", content: first.content }, { role: "user", content: "and again" }],
      }))
      await readSse(await kit.request(single()))
      assert.deepEqual(calls(kit, "session/new").map((entry) => entry.spawn), [0, 0])
    })
  } finally {
    captured.restore()
  }
  const rows = sessionRows(captured.lines)
  assert.equal(rows.at(-1).reason, "fresh_after_first")
  assert.equal(rows.at(-1).first_diff, undefined)
})

test("an agy that can't close a session isn't given a second one while it holds a conversation", async () => {
  await withKit({ sessionClose: false }, async (kit) => {
    const body = single()
    const first = await readSse(await kit.request(body))
    await readSse(await kit.request({
      ...body,
      messages: [...body.messages, { role: "assistant", content: first.content }, { role: "user", content: "and again" }],
    }))
    await readSse(await kit.request(single()))
    // a single turn's agy still is
    await readSse(await kit.request(single()))
    assert.deepEqual(calls(kit, "session/new").map((entry) => entry.spawn), [0, 1, 1])
  })
})

test("a request with tools still gets an agy of its own when its opening is sent again", async () => {
  await withKit({}, async (kit) => {
    const body = baseBody({ messages: [{ role: "user", content: "with tools" }] })
    await readSse(await kit.request(body))
    await readSse(await kit.request(body))
    assert.deepEqual(calls(kit, "session/new").map((entry) => entry.spawn), [0, 1])
  })
})

test("a history that really differs is still a history drop with its diff", async () => {
  const captured = captureStderr()
  try {
    await withKit({}, async (kit) => {
      const body = single()
      await readSse(await kit.request(body))
      await readSse(await kit.request({
        ...body,
        messages: [...body.messages, { role: "assistant", content: "something else" }, { role: "user", content: "next" }],
      }))
    })
  } finally {
    captured.restore()
  }
  const rows = sessionRows(captured.lines)
  assert.equal(rows.at(-1).reason, "history")
  assert.ok(rows.at(-1).first_diff)
})

