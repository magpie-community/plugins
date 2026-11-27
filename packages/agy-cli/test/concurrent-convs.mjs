// yetone/magpie#7223 (sevenqcx, DSH + agy-cli 0.1.99): with several DSH
// conversations running at once on one bridge, each dropped its live
// session every few seconds (drop_live "interrupted", history equal to
// expected) and replayed its history in a new one.
//
// Concurrency alone keeps the sessions (the first tests here). The cause was
// magpie's masking: its local model reads only what it can in a short wait,
// the rules mask the rest, and the model reads that text for a later request.
// A value an earlier message carried as written then goes as a placeholder,
// the history differs from what the session has (an "interrupted" drop is a
// steer whose history didn't match), and a changed first message changes
// the conversation's key too. Several conversations at once keep the local
// model behind, so it happened on nearly every step.

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

const NOTES = [
  "Time sampled while preparing turn 1, step 2: 2026-11-20T08:14:33+08:00[Asia/Shanghai]",
  "Time sampled while preparing turn 1, step 3: 2026-11-20T08:14:41+08:00[Asia/Shanghai]",
  "Time sampled while preparing turn 1, step 4: 2026-11-20T08:14:50+08:00[Asia/Shanghai]",
  "Time sampled while preparing turn 1, step 5: 2026-11-20T08:14:58+08:00[Asia/Shanghai]",
]

function stepper(name, steps) {
  return async (agent) => {
    for (let step = 0; step < steps; step++) await agent.tool("Read", { path: `/repo/${name}-${step}.txt` })
    await agent.text(`${name} done`)
    return { stopReason: "end_turn" }
  }
}

for (const mode of ["alternating", "overlapping"]) {
  test(`two conversations ${mode} on one bridge keep their own live sessions`, async () => {
    const stderr = captureStderr()
    const kit = await createBridgeKit({})
    try {
      kit.defaultPrompt = async (agent) => {
        const text = (agent.prompt || []).map((p) => p.text || "").join("")
        return stepper(text.includes("TASK-A") ? "a" : "b", NOTES.length)(agent)
      }
      const convs = ["A", "B"].map((name) => ({
        name,
        meta: { user_id: "dsh-main" },
        body: baseBody({ metadata: { user_id: "dsh-main" }, messages: [{ role: "user", content: `TASK-${name} read everything` }] }),
        parsed: null,
      }))
      const advance = async (conv, note) => {
        if (conv.parsed) {
          const call = conv.parsed.content.find((block) => block.type === "tool_use")
          assert.ok(call, `${conv.name}: ${JSON.stringify(conv.parsed)}`)
          conv.body = { ...conv.body, messages: [
            ...conv.body.messages,
            { role: "assistant", content: [call] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: `ok ${call.id}` }, { type: "text", text: note }] },
          ] }
        }
        conv.parsed = await readSse(await kit.request(conv.body))
      }
      for (let i = 0; i <= NOTES.length; i++) {
        if (mode === "alternating") {
          for (const conv of convs) await advance(conv, NOTES[i - 1])
        } else {
          await Promise.all(convs.map((conv) => advance(conv, NOTES[i - 1])))
        }
      }
      for (const conv of convs) assert.equal(conv.parsed.stopReason, "end_turn", `${conv.name}: ${JSON.stringify(conv.parsed)}`)
    } finally {
      await kit.dispose()
      stderr.restore()
    }
    const drops = stderr.lines.filter((row) => row.action === "drop_live")
    assert.deepEqual(drops, [], JSON.stringify(drops))
    const opened = stderr.lines.filter((row) => row.action === "session_new")
    assert.equal(opened.length, 2, JSON.stringify(opened))
  })
}

// The steps after a steer: a client that adds a line of its own beside every
// tool result (read as the user steering) was steered in its live session on
// one step and dropped on the next, so the session was replayed every other
// step.
for (const conversations of [1, 2]) {
  test(`a steer beside every tool result stays in the live session (${conversations} conversation${conversations > 1 ? "s" : ""})`, async () => {
    const stderr = captureStderr()
    const kit = await createBridgeKit({})
    const STEPS = 4
    try {
      const names = new Map()
      const stepsDone = new Map()
      kit.defaultPrompt = async (agent) => {
        const text = (agent.prompt || []).map((p) => p.text || "").join("")
        if (!names.has(agent.sessionId)) names.set(agent.sessionId, text.includes("TASK-A") ? "a" : "b")
        const name = names.get(agent.sessionId)
        const done = Math.max(stepsDone.get(agent.sessionId) || 0, (text.match(/keep going \d+/g) || []).length)
        for (let step = done; step < STEPS; step++) {
          await agent.tool("Read", { path: `/repo/${name}-${step}.txt` })
          stepsDone.set(agent.sessionId, step + 1)
          // agy stops its step when the bridge cancels it for a steer
          await new Promise((resolve) => setTimeout(resolve, 30))
          if (agent.cancelPending) return { stopReason: "cancelled" }
        }
        await agent.text(`${name} done`)
        return { stopReason: "end_turn" }
      }
      const convs = ["A", "B"].slice(0, conversations).map((name) => ({
        name,
        body: baseBody({ metadata: { user_id: "dsh-main" }, messages: [{ role: "user", content: `TASK-${name} read everything` }] }),
        parsed: null,
      }))
      for (const conv of convs) conv.parsed = await readSse(await kit.request(conv.body))
      for (let i = 0; i < STEPS; i++) {
        for (const conv of convs) {
          if (conv.parsed.stopReason !== "tool_use") continue
          const call = conv.parsed.content.find((block) => block.type === "tool_use")
          conv.body = { ...conv.body, messages: [
            ...conv.body.messages,
            { role: "assistant", content: conv.parsed.content.filter((block) => block.type === "tool_use" || (block.type === "text" && block.text)) },
            { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: `ok ${call.id}` }, { type: "text", text: `keep going ${i}` }] },
          ] }
          conv.parsed = await readSse(await kit.request(conv.body))
        }
      }
    } finally {
      await kit.dispose()
      stderr.restore()
    }
    const drops = stderr.lines.filter((row) => row.action === "drop_live")
    assert.deepEqual(drops, [], JSON.stringify(drops))
    const opened = stderr.lines.filter((row) => row.action === "session_new")
    assert.equal(opened.length, conversations, JSON.stringify(opened))
  })
}

// yetone/magpie#7223: magpie's masking reads a text with its local model
// only when the model keeps up. Under load it masks with its rules alone and
// the model reads the text for a later request, so a value an earlier
// message carried as written goes as a {{KIND_xxxxxxxx}} placeholder from
// then on. The history is the same one; the live session holds.
const MASKED = {
  "Alice Johnson": "{{NAME_mfrgg2lq}}",
  "alice@example.org": "{{EMAIL_nb2hi4dt}}",
}
const maskFrom = (text, values) => values.reduce((out, value) => out.split(value).join(MASKED[value]), text)
const maskMessages = (messages, values) => messages.map((message) => {
  if (typeof message.content === "string") return { ...message, content: maskFrom(message.content, values) }
  return { ...message, content: message.content.map((block) => {
    if (block.type === "text") return { ...block, text: maskFrom(block.text, values) }
    if (block.type === "tool_result" && typeof block.content === "string") return { ...block, content: maskFrom(block.content, values) }
    return block
  }) }
})

async function runMasked({ conversations, steer, edit }) {
  const stderr = captureStderr()
  const kit = await createBridgeKit({})
  const STEPS = 4
  try {
    const names = new Map()
    const stepsDone = new Map()
    kit.defaultPrompt = async (agent) => {
      const text = (agent.prompt || []).map((p) => p.text || "").join("")
      if (!names.has(agent.sessionId)) names.set(agent.sessionId, text.includes("TASK-A") ? "a" : "b")
      const name = names.get(agent.sessionId)
      for (let step = stepsDone.get(agent.sessionId) || 0; step < STEPS; step++) {
        await agent.tool("Read", { path: `/repo/${name}-${step}.txt` })
        stepsDone.set(agent.sessionId, step + 1)
        await new Promise((resolve) => setTimeout(resolve, 30))
        if (agent.cancelPending) return { stopReason: "cancelled" }
      }
      await agent.text(`${name} done`)
      return { stopReason: "end_turn" }
    }
    const convs = ["A", "B"].slice(0, conversations).map((name) => ({
      name,
      // as the client keeps it: values as written
      messages: [{ role: "user", content: `TASK-${name} read everything for Alice Johnson, then mail alice@example.org` }],
      parsed: null,
    }))
    // what masking makes of the client's history on each request: the
    // first goes with the rules alone, later ones as the model read more
    const masked = (messages, step) => maskMessages(messages, ["alice@example.org", ...step >= 1 ? ["Alice Johnson"] : []])
    for (const conv of convs) {
      conv.parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "dsh-main" }, messages: masked(conv.messages, 0) })))
    }
    for (let i = 0; i < STEPS; i++) {
      for (const conv of convs) {
        if (conv.parsed.stopReason !== "tool_use") continue
        const call = conv.parsed.content.find((block) => block.type === "tool_use")
        conv.messages = [
          ...conv.messages,
          { role: "assistant", content: conv.parsed.content.filter((block) => block.type === "tool_use" || (block.type === "text" && block.text)) },
          { role: "user", content: [
            { type: "tool_result", tool_use_id: call.id, content: `ok ${call.id} owner Alice Johnson` },
            ...steer ? [{ type: "text", text: `keep going ${i}` }] : [],
          ] },
        ]
        let messages = masked(conv.messages, i + 1)
        if (edit && i >= 1) messages = [{ ...messages[0], content: messages[0].content + " (edited)" }, ...messages.slice(1)]
        conv.parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "dsh-main" }, messages })))
      }
    }
    return {
      drops: stderr.lines.filter((row) => row.action === "drop_live"),
      opened: stderr.lines.filter((row) => row.action === "session_new"),
      stops: convs.map((conv) => conv.parsed.stopReason),
    }
  } finally {
    await kit.dispose()
    stderr.restore()
  }
}

for (const conversations of [1, 2]) {
  for (const steer of [false, true]) {
    test(`a value masked later in an earlier message keeps the live session (${conversations} conversation${conversations > 1 ? "s" : ""}${steer ? ", steered" : ""})`, async () => {
      const { drops, opened, stops } = await runMasked({ conversations, steer })
      assert.deepEqual(drops, [], JSON.stringify(drops))
      assert.equal(opened.length, conversations, JSON.stringify(opened))
      assert.deepEqual(stops, Array(conversations).fill("end_turn"))
    })
  }
}

test("an earlier message really changed still starts a new session, masked values or not", async () => {
  const { drops } = await runMasked({ conversations: 1, steer: false, edit: true })
  assert.deepEqual(drops.map((row) => row.reason), ["history_mismatch"], JSON.stringify(drops))
})
// DSH opens every session with the same notice ("The user changed the
// approval policy ...") before the user's own request, and names the
// session's folder after it. Two sessions in two folders had one key (system
// and first message alike), shared one agy, and each one's request was
// refused with 503 "this conversation still has an unfinished response"
// while the other's response ran. The folder is part of the key.
test("two DSH sessions with the same opening notice in different folders get their own agy", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const dirs = ["A", "B"].map((name) => fs.mkdtempSync(path.join(os.tmpdir(), `agy-dsh-${name}-`)))
  const stderr = captureStderr()
  const kit = await createBridgeKit({})
  try {
    kit.defaultPrompt = async (agent) => {
      const text = (agent.prompt || []).map((p) => p.text || "").join("")
      return stepper(text.includes("TASK-A") ? "a" : "b", 2)(agent)
    }
    const notice = { role: "user", content: [{ type: "text", text: 'The user changed the approval policy from "ask the user for approval" to "never ask the user for approval".' }] }
    const convs = ["A", "B"].map((name, i) => ({
      name,
      body: baseBody({ metadata: { user_id: "dsh-main" }, messages: [
        notice,
        { role: "user", content: `Current working directory: "${dirs[i]}".\nTASK-${name} read everything` },
      ] }),
      parsed: null,
    }))
    const advance = async (conv) => {
      if (conv.parsed) {
        const call = conv.parsed.content.find((block) => block.type === "tool_use")
        assert.ok(call, `${conv.name}: ${JSON.stringify(conv.parsed)}`)
        conv.body = { ...conv.body, messages: [
          ...conv.body.messages,
          { role: "assistant", content: [call] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: `ok ${call.id}` }] },
        ] }
      }
      const response = await kit.request(conv.body)
      assert.equal(response.status, 200, `${conv.name}: ${response.status} ${response.status === 200 ? "" : await response.clone().text()}`)
      conv.parsed = await readSse(response)
    }
    for (let i = 0; i <= 2; i++) await Promise.all(convs.map(advance))
    for (const conv of convs) assert.equal(conv.parsed.stopReason, "end_turn", `${conv.name}: ${JSON.stringify(conv.parsed)}`)
  } finally {
    await kit.dispose()
    stderr.restore()
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
  }
  const drops = stderr.lines.filter((row) => row.action === "drop_live")
  assert.deepEqual(drops, [], JSON.stringify(drops))
  const opened = stderr.lines.filter((row) => row.action === "session_new")
  assert.equal(opened.length, 2, JSON.stringify(opened))
})
