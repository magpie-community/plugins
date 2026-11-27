// @chet030714 on X (agy-cli 0.1.110): one image described per request,
// non-streaming, no tools, took tens of seconds to minutes, while a chat on
// the same machine answered in seconds. Each such request is a new
// conversation, and the bridge started an agy for each: agy boots its
// backend on a process's first session/new (it signs in and asks Google for
// the account, models and settings: ~3s measured with agy 1.5.14, far
// longer over a slow proxy), and a later session/new in the same agy took
// ~7ms. A stateless request now opens its session in an idle agy that
// answered one; streaming and tool requests still get an agy of their own.
//
// bun test ./stateless-reuse.mjs

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

async function withKit(options, fn) {
  const kit = await createBridgeKit({ sessionClose: true, promptImages: true, ...options })
  kit.defaultPrompt = async (agent) => {
    await agent.text("a cat")
    return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } }
  }
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

const IMAGE = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }

// what the reporter sends: one message with an image, stream false, no tools
const describe = (n) => baseBody({
  stream: false, tools: undefined,
  system: "Describe the image.",
  messages: [{ role: "user", content: [IMAGE, { type: "text", text: `image ${n}` }] }],
})

async function answer(kit, body) {
  const response = await kit.request(body)
  const text = await response.text()
  assert.equal(response.status, 200, text)
  return JSON.parse(text)
}

const sessionSpawns = (kit) => kit.acpLog.filter((entry) => entry.method === "session/new").map((entry) => entry.spawn)

test("stateless requests one after another open their sessions in one agy", async () => {
  await withKit({}, async (kit) => {
    for (let n = 1; n <= 4; n++) {
      const reply = await answer(kit, describe(n))
      assert.equal(reply.content.find((block) => block.type === "text")?.text, "a cat")
    }
    // old code: [0, 1, 2, 3], one agy started for each image
    assert.deepEqual(sessionSpawns(kit), [0, 0, 0, 0])
    assert.equal(kit.acpSpawns.length, 1)
    // each earlier session is closed, so agy holds one at a time
    const closed = kit.acpLog.filter((entry) => entry.method === "session/close").map((entry) => entry.params.sessionId)
    assert.deepEqual(closed, ["fake-session-1", "fake-session-2", "fake-session-3"])
    // every prompt went to the session opened for it
    const prompts = kit.acpLog.filter((entry) => entry.method === "session/prompt").map((entry) => entry.params.sessionId)
    assert.deepEqual(prompts, ["fake-session-1", "fake-session-2", "fake-session-3", "fake-session-4"])
  })
})

test("the same stateless request sent again reuses its own agy", async () => {
  await withKit({}, async (kit) => {
    await answer(kit, describe(1))
    await answer(kit, describe(1))
    assert.deepEqual(sessionSpawns(kit), [0, 0])
    assert.equal(kit.acpSpawns.length, 1)
  })
})

test("a stateless request while the idle agy's donor is busy gets an agy of its own", async () => {
  await withKit({}, async (kit) => {
    await answer(kit, describe(1))
    let release
    const held = new Promise((resolve) => { release = resolve })
    kit.prompts[1] = async (agent) => {
      await held
      await agent.text("slow")
      return { stopReason: "end_turn" }
    }
    // request 2 takes the idle agy and holds it; request 3 finds none idle
    const second = answer(kit, describe(2))
    while (kit.acpLog.filter((entry) => entry.method === "session/prompt").length < 2) await new Promise((r) => setTimeout(r, 5))
    await answer(kit, describe(3))
    release()
    await second
    assert.deepEqual(sessionSpawns(kit), [0, 0, 1])
  })
})

test("streaming and tool requests still get an agy of their own", async () => {
  await withKit({}, async (kit) => {
    await answer(kit, describe(1))
    // a chat UI's stream
    await readSse(await kit.request(baseBody({ tools: undefined, messages: [{ role: "user", content: "stream me" }] })))
    // an agent's request with tools, not streamed
    await answer(kit, baseBody({ stream: false, messages: [{ role: "user", content: "with tools" }] }))
    assert.deepEqual(sessionSpawns(kit), [0, 1, 2])
  })
})

test("an agy a conversation went on in is never taken", async () => {
  await withKit({}, async (kit) => {
    const first = describe(1)
    const reply = await answer(kit, first)
    // the same conversation's second turn, still without tools or a stream
    await answer(kit, {
      ...first,
      messages: [...first.messages, { role: "assistant", content: reply.content }, { role: "user", content: "and its colour?" }],
    })
    await answer(kit, describe(2))
    assert.deepEqual(sessionSpawns(kit), [0, 1])
  })
})

test("a follow-up to a conversation whose agy was taken replays its history", async () => {
  await withKit({}, async (kit) => {
    const first = describe(1)
    const reply = await answer(kit, first)
    await answer(kit, describe(2))
    const followUp = await answer(kit, {
      ...first,
      messages: [...first.messages, { role: "assistant", content: reply.content }, { role: "user", content: "and its colour?" }],
    })
    assert.equal(followUp.content.find((block) => block.type === "text")?.text, "a cat")
    assert.deepEqual(sessionSpawns(kit), [0, 0, 1])
  })
})

test("AGY_BRIDGE_STATELESS_REUSE=0 starts an agy for each", async () => {
  await withKit({ env: { AGY_BRIDGE_STATELESS_REUSE: "0" } }, async (kit) => {
    await answer(kit, describe(1))
    await answer(kit, describe(2))
    assert.deepEqual(sessionSpawns(kit), [0, 1])
  })
})

test("the session row names each start-up step, and the prompt row the time to first output", async () => {
  const captured = captureStderr()
  try {
    await withKit({}, async (kit) => {
      await answer(kit, describe(1))
      await answer(kit, describe(2))
    })
  } finally {
    captured.restore()
  }
  const sessions = captured.lines.filter((row) => row.event === "agy_bridge_session")
  const opened = sessions.filter((row) => row.action === "session_new")
  assert.equal(opened.length, 2, JSON.stringify(sessions))
  for (const key of ["initialize_ms", "session_ms", "set_model_ms"]) assert.equal(typeof opened[0][key], "number", key)
  assert.equal(opened[1].reason, "stateless_reuse")
  assert.equal(opened[1].reused, true)
  assert.equal(opened[1].initialize_ms, undefined)
  assert.equal(typeof opened[1].session_ms, "number")
  const prompts = sessions.filter((row) => row.action === "prompt")
  assert.equal(prompts.length, 2)
  for (const row of prompts) {
    assert.equal(typeof row.ttft_ms, "number")
    assert.equal(typeof row.prompt_ms, "number")
  }
})
