// yetone/magpie#7223, again on 0.1.106 (sevenqcx): DSH runs of many tool
// steps still dropped the live session on nearly every step, history 398 ==
// expected 398, history_matches false, nothing else changed. 0.1.100 let a
// value sent as written go as a placeholder later. These are the drifts it
// missed, each one masking makes as its local model catches up:
//
// - a value under one placeholder, then under another (a kind found late,
//   or a span drawn wider);
// - one value masked late while another goes back to as written;
// - the model's own text in the pending step, which the client writes back
//   masked again, so it differs from the raw answer the session recorded.
//
// A drop now logs where the histories first differ, with no text.

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

const STEPS = 4

// mask(text, step) is what masking makes of the client's text on request
// step; speak(name, step) is the text the model writes before its call.
// opening adds to each conversation's first message; extra(messages, i)
// is what something between the client and magpie makes of request i's
// messages, which the client never stores.
async function run({ conversations = 1, steer = false, mask, speak, edit, canon, opening = "", extra }) {
  const stderr = captureStderr()
  const kit = await createBridgeKit({})
  try {
    const names = new Map()
    const stepsDone = new Map()
    kit.defaultPrompt = async (agent) => {
      const text = (agent.prompt || []).map((p) => p.text || "").join("")
      if (!names.has(agent.sessionId)) names.set(agent.sessionId, text.includes("TASK-A") ? "a" : "b")
      const name = names.get(agent.sessionId)
      for (let step = stepsDone.get(agent.sessionId) || 0; step < STEPS; step++) {
        if (speak) await agent.text(speak(name, step))
        await agent.tool("Read", { path: `/repo/${name}-${step}.txt` })
        stepsDone.set(agent.sessionId, step + 1)
        await new Promise((resolve) => setTimeout(resolve, 30))
        if (agent.cancelPending) return { stopReason: "cancelled" }
      }
      await agent.text(`${name} done`)
      return { stopReason: "end_turn" }
    }
    const masked = (messages, step) => messages.map((message) => {
      if (typeof message.content === "string") return { ...message, content: mask(message.content, step) }
      return { ...message, content: message.content.map((block) => {
        if (block.type === "text") return { ...block, text: mask(block.text, step) }
        if (block.type === "tool_result" && typeof block.content === "string") return { ...block, content: mask(block.content, step) }
        return block
      }) }
    })
    const convs = ["A", "B"].slice(0, conversations).map((name) => ({
      name,
      // as the client keeps it: values as written
      messages: [{ role: "user", content: `TASK-${name} read everything for Alice Johnson, then mail alice@example.org with key sk_w3axCByTQgK1Px9zQ at commit 4f2a9c1e7b3d5a6f${opening}` }],
      parsed: null,
    }))
    for (const conv of convs) {
      conv.parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "dsh-main" }, messages: masked(conv.messages, 0) })))
    }
    for (let i = 0; i < STEPS; i++) {
      for (const conv of convs) {
        if (conv.parsed.stopReason !== "tool_use") continue
        const call = conv.parsed.content.find((block) => block.type === "tool_use")
        conv.messages = [
          ...conv.messages,
          // the client keeps the answer with magpie's placeholders restored
          { role: "assistant", content: conv.parsed.content
            .filter((block) => block.type === "tool_use" || (block.type === "text" && block.text))
            .map((block) => block.type === "text" ? { ...block, text: unmask(block.text) }
              : canon ? { ...block, input: canon(block.input) } : block) },
          { role: "user", content: [
            { type: "tool_result", tool_use_id: call.id, content: `ok ${call.id} owner Alice Johnson` },
            ...steer ? [{ type: "text", text: `keep going ${i}` }] : [],
          ] },
        ]
        let messages = masked(conv.messages, i + 1)
        if (edit && i >= 1) messages = [{ ...messages[0], content: messages[0].content.replace("read everything", "read nothing") }, ...messages.slice(1)]
        if (extra) messages = extra(messages, i)
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

const VALUES = {
  "{{NAME_mfrgg2lq}}": "Alice Johnson",
  "{{PERSON_k5zq3wae}}": "Alice Johnson",
  "{{EMAIL_nb2hi4dt}}": "alice@example.org",
}
const unmask = (text) => Object.entries(VALUES).reduce((out, [p, v]) => out.split(p).join(v), text)
const swap = (text, pairs) => pairs.reduce((out, [from, to]) => out.split(from).join(to), text)

const DRIFTS = {
  // the name goes as NAME first, then as PERSON once the model reads it
  "a value under another placeholder later": (text, step) =>
    swap(text, [["Alice Johnson", step >= 2 ? "{{PERSON_k5zq3wae}}" : "{{NAME_mfrgg2lq}}"]]),
  // the email goes masked by the rules first and as written later, while
  // the name goes as written first and masked later
  "one value masked later while another goes back to as written": (text, step) =>
    swap(text, step >= 2
      ? [["Alice Johnson", "{{NAME_mfrgg2lq}}"]]
      : [["alice@example.org", "{{EMAIL_nb2hi4dt}}"]]),
  // the same placeholder later without its braces, as a model writes it
  // back and magpie still reads it
  "a placeholder written back mangled": (text, step) =>
    swap(text, [["Alice Johnson", step >= 2 ? "NAME_mfrgg2lq" : "{{NAME_mfrgg2lq}}"]]),
  // a key goes as a made-up key of its own form once masking knows it
  "a key sent as a made-up key of its own form later": (text, step) =>
    swap(text, step >= 2 ? [["sk_w3axCByTQgK1Px9zQ", "sk_h7qmRDpXKcZ4Lb2tW"]] : []),
}

for (const [name, mask] of Object.entries(DRIFTS)) {
  for (const conversations of [1, 2]) {
    for (const steer of [false, true]) {
      test(`${name} keeps the live session (${conversations} conversation${conversations > 1 ? "s" : ""}${steer ? ", steered" : ""})`, async () => {
        const { drops, opened, stops } = await run({ conversations, steer, mask })
        assert.deepEqual(drops, [], JSON.stringify(drops))
        assert.equal(opened.length, conversations, JSON.stringify(opened))
        assert.deepEqual(stops, Array(conversations).fill("end_turn"))
      })
    }
  }
}

// The model writes the placeholder it was given; the client keeps the
// value, and masking sends it back under the kind it knows by then.
for (const steer of [false, true]) {
  test(`the pending step's own text written back masked again keeps the live session${steer ? " (steered)" : ""}`, async () => {
    const { drops, opened, stops } = await run({
      steer,
      speak: (_name, step) => `Reading part ${step} for {{NAME_mfrgg2lq}}.`,
      mask: (text, step) => swap(text, [["Alice Johnson", step >= 1 ? "{{PERSON_k5zq3wae}}" : "{{NAME_mfrgg2lq}}"]]),
    })
    assert.deepEqual(drops, [], JSON.stringify(drops))
    assert.equal(opened.length, 1, JSON.stringify(opened))
    assert.deepEqual(stops, ["end_turn"])
  })
}

// A client that fills a call's defaults in (Claude Code's replace_all:
// false) is matched on the pending step's own call ids; masking drift in
// the history before it, and in the step's own text, keeps the session.
test("a call written back with its defaults filled in, beside masking drift, keeps the steered session", async () => {
  const { drops, opened, stops } = await run({
    steer: true,
    canon: (input) => ({ ...input, limit: 2000 }),
    speak: (_name, step) => `Reading part ${step} for {{NAME_mfrgg2lq}}.`,
    mask: (text, step) => swap(text, [["Alice Johnson", step >= 1 ? "{{PERSON_k5zq3wae}}" : "{{NAME_mfrgg2lq}}"]]),
  })
  assert.deepEqual(drops, [], JSON.stringify(drops))
  assert.equal(opened.length, 1, JSON.stringify(opened))
  assert.deepEqual(stops, ["end_turn"])
})

for (const steer of [false, true]) {
  test(`an earlier message really changed still drops, and the log says where with no text${steer ? " (steered)" : ""}`, async () => {
    const { drops } = await run({ steer, edit: true, mask: DRIFTS["a value under another placeholder later"] })
    assert.deepEqual(drops.map((row) => row.reason), [steer ? "interrupted" : "history_mismatch"], JSON.stringify(drops))
    const [drop] = drops
    assert.equal(drop.history_matches, false)
    assert.deepEqual(
      { index: drop.first_diff.index, role: drop.first_diff.role, block: drop.first_diff.block, field: drop.first_diff.field, masked: drop.first_diff.masked },
      { index: 0, role: "user", block: 0, field: "text", masked: false },
      JSON.stringify(drop.first_diff))
    assert.equal(drop.first_diff.from_end, drop.history - 1)
    assert.equal(drop.first_diff.offset, "TASK-A read ".length)
    assert.equal(drop.first_diff.differing_messages, 1)
    assert.ok(drop.first_diff.masked_messages >= 1, JSON.stringify(drop.first_diff))
    const row = JSON.stringify(drop)
    for (const text of ["TASK-A", "read nothing", "read everything", "Alice", "NAME_", "PERSON_", "/repo/"]) {
      assert.ok(!row.includes(text), `${text} in ${row}`)
    }
  })
}


// Not masking: a value that changed with no placeholder on either side, or
// an id without a key's head that changed to one of the same form, is a
// real edit, and the session still starts again.
const EDITS = {
  "a word changed next to a placeholder": (text, step) =>
    swap(text, step >= 2 ? [["Alice Johnson", "{{NAME_mfrgg2lq}}"], ["then mail", "then call"]] : [["Alice Johnson", "{{NAME_mfrgg2lq}}"]]),
  "a commit id changed to one of the same form": (text, step) =>
    swap(text, step >= 2 ? [["4f2a9c1e7b3d5a6f", "9e1b7d3c5a2f4e8d"]] : []),
}
for (const [name, mask] of Object.entries(EDITS)) {
  test(`${name} still starts a new session`, async () => {
    const { drops } = await run({ mask })
    assert.deepEqual(drops.map((row) => row.reason), ["history_mismatch"], JSON.stringify(drops))
    assert.equal(drops[0].first_diff.masked, false, JSON.stringify(drops[0].first_diff))
  })
}


// yetone/magpie#7223 on 0.1.108 (sevenqcx): a value masked where it is
// glued to other text (CJK, or a '_', '-' or '.') is one word as written
// and a placeholder and the rest as masked, and that drift dropped the
// session. The text beside the placeholder is the same on both sides.
const GLUED = " 张三的电话 alice123-project alice123.local Secret_v4lu3xq9"
const GLUED_DRIFTS = {
  "a value glued to CJK text masked later": (text, step) =>
    swap(text, step >= 2 ? [["张三", "{{PERSON_k5zq3wae}}"]] : []),
  "a value glued to '-' and '.' masked later": (text, step) =>
    swap(text, step >= 2 ? [["alice123", "{{USER_mfrgg2lq}}"]] : []),
  "a value glued after '_' masked later": (text, step) =>
    swap(text, step >= 2 ? [["v4lu3xq9", "{{SECRET_nb2hi4dt}}"]] : []),
  "a glued value under another placeholder later": (text, step) =>
    swap(text, [["张三", step >= 2 ? "{{NAME_mfrgg2lq}}" : "{{PERSON_k5zq3wae}}"]]),
}
for (const [name, mask] of Object.entries(GLUED_DRIFTS)) {
  for (const steer of [false, true]) {
    test(`${name} keeps the live session${steer ? " (steered)" : ""}`, async () => {
      const { drops, opened, stops } = await run({ steer, mask, opening: GLUED })
      assert.deepEqual(drops, [], JSON.stringify(drops))
      assert.equal(opened.length, 1, JSON.stringify(opened))
      assert.deepEqual(stops, ["end_turn"])
    })
  }
}

// What 0.1.108 held stays: text beside a placeholder that changed is a
// real edit, glued or not.
const GLUED_EDITS = {
  "a CJK word changed beside a glued placeholder": (text, step) =>
    swap(text, step >= 2 ? [["张三的电话", "{{PERSON_k5zq3wae}}的手机"]] : []),
  "a word changed after a glued placeholder's '-'": (text, step) =>
    swap(text, step >= 2 ? [["alice123-project", "{{USER_mfrgg2lq}}-product"]] : []),
  "a word changed before a glued placeholder's '_'": (text, step) =>
    swap(text, step >= 2 ? [["Secret_v4lu3xq9", "Token_{{SECRET_nb2hi4dt}}"]] : []),
}
for (const [name, mask] of Object.entries(GLUED_EDITS)) {
  test(`${name} still starts a new session`, async () => {
    const { drops } = await run({ mask, opening: GLUED })
    assert.deepEqual(drops.map((row) => row.reason), ["history_mismatch"], JSON.stringify(drops))
    assert.equal(drops[0].first_diff.masked, false, JSON.stringify(drops[0].first_diff))
  })
}

// yetone/magpie#7223 on 0.1.108: a proxy between DSH and magpie
// (billion-context's nudge) added text after one step's tool result, for
// that request only. The step read as steered, and the next request, whose
// history goes on without the text, as history_mismatch (block_count 2 to
// 1). Nothing here keys on the proxy's words.
const NUDGE = "[some-proxy] Your previous response ended without a tool call. Continue now."
const NUDGES = {
  "in the tool result's message": (messages) => [...messages.slice(0, -1),
    { ...messages.at(-1), content: [...messages.at(-1).content, { type: "text", text: NUDGE }] }],
  "as a user message of its own": (messages) => [...messages, { role: "user", content: NUDGE }],
}
for (const [where, add] of Object.entries(NUDGES)) {
  for (const steer of [false, true]) {
    test(`text a proxy added for one request ${where} keeps the live session${steer ? " (steered)" : ""}`, async () => {
      const { drops, opened, stops } = await run({
        steer,
        mask: (text) => text,
        extra: (messages, i) => i === 1 ? add(messages) : messages,
      })
      assert.deepEqual(drops, [], JSON.stringify(drops))
      assert.equal(opened.length, 1, JSON.stringify(opened))
      assert.deepEqual(stops, ["end_turn"])
    })
  }
}

// Only text that is gone: a step's text the client later sends changed
// (not cut short), or text cut from an earlier step than the newest, is a
// changed history.
test("text after a step's result that comes back changed still starts a new session", async () => {
  const { drops } = await run({
    mask: (text) => text,
    extra: (messages, i) => {
      if (i !== 1 && i !== 2) return messages
      const text = i === 1 ? "look at part two first" : "look at part three first"
      const at = i === 1 ? messages.length - 1 : messages.length - 3
      return messages.map((message, index) => index !== at ? message
        : { ...message, content: [...message.content, { type: "text", text }] })
    },
  })
  assert.ok(drops.length >= 1, JSON.stringify(drops))
  assert.equal(drops[0].first_diff.masked, false, JSON.stringify(drops[0].first_diff))
})

test("text cut from an earlier step than the newest still starts a new session", async () => {
  const { drops } = await run({
    steer: true,
    mask: (text) => text,
    // the steer of step 0 is gone from the history from step 2 on
    extra: (messages, i) => i < 2 ? messages : messages.map((message, index) => index !== 2 ? message
      : { ...message, content: message.content.filter((block) => block.type !== "text") }),
  })
  assert.ok(drops.length >= 1, JSON.stringify(drops))
})

// yetone/magpie#7223 on 0.1.108: a new session for a changed history
// between turns (session_new, reason history) said nothing of where, and
// first_diff compared messages as sent while the history key reads a run of
// one role's messages as one row, its texts joined. A user message sent as
// two that read the same was reported as the difference.
test("session_new for a changed history says where, as the history key reads it, with no text", async () => {
  const stderr = captureStderr()
  const kit = await createBridgeKit({})
  try {
    kit.defaultPrompt = async (agent) => {
      await agent.text("REPLY-TEXT here")
      return { stopReason: "end_turn" }
    }
    const body = (messages) => baseBody({ metadata: { user_id: "dsh-main" }, messages })
    const u0 = { role: "user", content: "TASK-H open the notes" }
    const first = await readSse(await kit.request(body([u0])))
    const a0 = { role: "assistant", content: [{ type: "text", text: first.content.map((block) => block.text || "").join("") }] }
    const u1 = { role: "user", content: "TASK-H now the second part" }
    const second = await readSse(await kit.request(body([u0, a0, u1])))
    const a1 = { role: "assistant", content: [{ type: "text", text: second.content.map((block) => block.text || "").join("") }] }
    // the client sends its second message as two that read the same, and
    // its second reply changed
    const split = [{ role: "user", content: "TASK-H now the " }, { role: "user", content: "second part" }]
    const edited = { role: "assistant", content: [{ type: "text", text: "REPLY-EDITED" }] }
    await readSse(await kit.request(body([u0, a0, ...split, edited, { role: "user", content: "TASK-H third" }])))
    const rows = stderr.lines.filter((row) => row.action === "session_new")
    assert.equal(rows.length, 2, JSON.stringify(rows))
    const row = rows[1]
    assert.equal(row.reason, "history")
    assert.ok(a1.content[0].text.includes("REPLY-TEXT"))
    assert.deepEqual(
      { index: row.first_diff?.index, from_end: row.first_diff?.from_end, role: row.first_diff?.role, field: row.first_diff?.field, masked: row.first_diff?.masked, differing: row.first_diff?.differing_messages },
      { index: 3, from_end: 0, role: "assistant", field: "text", masked: false, differing: 1 },
      JSON.stringify(row.first_diff))
    for (const text of ["TASK-H", "REPLY", "second part"]) {
      assert.ok(!JSON.stringify(row).includes(text), `${text} in ${JSON.stringify(row)}`)
    }
  } finally {
    await kit.dispose()
    stderr.restore()
  }
})
