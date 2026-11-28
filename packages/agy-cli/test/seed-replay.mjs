// A replay bigger than one prompt goes in over several, each but the last
// cancelled before the model answers it, instead of being cut to 112 KiB
// (yayoi_no_yume on X: the model saw the newest turns only, and the context
// shown was 8% until another model showed 100-180%).
//
// bun test ./seed-replay.mjs

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { pathToFileURL } from "node:url"
import { INDEX_FILE, baseBody, createBridgeKit, readSse } from "./testkit.mjs"

// the helpers, from the same index.mjs the kit loads (AGY_BRIDGE_TEST_INDEX
// runs these tests on an older copy); its own imports stay the package's
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-seed-replay-test-"))
const entry = new URL("../index.mjs", import.meta.url)
let source = fs.readFileSync(INDEX_FILE, "utf8")
source = source.replace(/from "(\.\/[^"\n]+)"/g, (_, target) =>
  `from ${JSON.stringify(new URL(target, entry).href)}`)
fs.writeFileSync(path.join(workspace, "bridge.mjs"), source + "\nexport const seedHelpers = typeof splitPromptParts === \"function\" ? { splitPromptParts, maxReplayBytes, seedsHistory } : null;\n")
const { seedHelpers } = await import(pathToFileURL(path.join(workspace, "bridge.mjs")).href)
const { splitPromptParts, maxReplayBytes, seedsHistory } = seedHelpers || {}
after(() => fs.rmSync(workspace, { recursive: true, force: true }))

const KIB = 1024
const ONE_PROMPT = 112 * KIB
const CONTINUES = "[This message continues in the next one.]"
const OMITTED = "earlier conversation history omitted"
const bytes = (text) => Buffer.byteLength(text, "utf8")
const promptText = (params) => (params?.prompt || []).map((part) => (part.type === "text" ? part.text : "")).join("")
const prompts = (kit) => kit.acpLog.filter((entry) => entry.method === "session/prompt").map((entry) => promptText(entry.params))
const cancels = (kit) => kit.acpLog.filter((entry) => entry.method === "session/cancel").length

async function withKit(options, fn) {
  const kit = await createBridgeKit({ agentVersion: "1.5.17", ...options })
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

// As real agy: a prompt that is cancelled ends "cancelled"; one that says it
// continues is what the bridge cancels. `answerSeeds` is a cancel that came
// too late: agy answers the part anyway.
function agent(kit, { answerSeeds = false, usage } = {}) {
  kit.defaultPrompt = async (agent) => {
    const text = promptText({ prompt: agent.prompt })
    if (text.endsWith(CONTINUES)) {
      if (answerSeeds) {
        await agent.text("SEED-REPLY-LEAKED")
        return { stopReason: "end_turn" }
      }
      await agent.waitCancel()
      return { stopReason: "cancelled" }
    }
    await agent.text("FINAL ANSWER")
    return { stopReason: "end_turn", ...(usage ? { usage } : {}) }
  }
}

// A conversation of ~`kib` KiB with a numbered marker in every turn.
function longConversation(kib, label = "conv") {
  const filler = "history filler line with some words in it. ".repeat(220)
  const messages = [{ role: "user", content: `ANCHOR opening request ${label}` }]
  let index = 0
  while (bytes(JSON.stringify(messages)) < kib * KIB) {
    messages.push({ role: "assistant", content: [{ type: "text", text: `MARK-${index} start ${filler} MARK-${index} end` }] })
    messages.push({ role: "user", content: `follow-up ${index}` })
    index++
  }
  messages.push({ role: "assistant", content: "NEWEST assistant reply" })
  messages.push({ role: "user", content: "LATEST INSTRUCTION: list every MARK" })
  return { messages, marks: index }
}

test("a replay of ~400 KiB goes in whole over several prompts, the history ones cancelled", async () => {
  await withKit({}, async (kit) => {
    agent(kit)
    const { messages, marks } = longConversation(400)
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "seed-whole" }, messages })))
    assert.equal(parsed.stopReason, "end_turn")
    assert.equal(parsed.content.map((block) => block.text || "").join(""), "FINAL ANSWER")
    const sent = prompts(kit)
    assert.ok(sent.length >= 4, `${sent.length} prompts`)
    for (const [i, text] of sent.entries()) {
      assert.ok(bytes(text) <= ONE_PROMPT, `prompt ${i} is ${bytes(text)} bytes, over one prompt`)
    }
    const all = sent.join("\n")
    for (let i = 0; i < marks; i++) {
      assert.ok(all.includes(`MARK-${i} start`) && all.includes(`MARK-${i} end`), `MARK-${i} went in whole`)
    }
    assert.ok(!all.includes(OMITTED), "nothing was left out")
    assert.ok(!all.includes("bytes of this history block omitted"), "no block was clipped")
    assert.ok(sent[0].includes("ANCHOR opening request"))
    assert.ok(sent.at(-1).endsWith("</current_turn>"), "the last prompt is the real one")
    assert.ok(sent.at(-1).includes("LATEST INSTRUCTION: list every MARK"))
    assert.ok(sent.slice(0, -1).every((text) => text.endsWith(CONTINUES)), "each history prompt says it goes on")
    assert.ok(sent.slice(1).every((text) => text.startsWith("[Continued from the previous message.]")))
    assert.ok(cancels(kit) >= sent.length - 1, `${cancels(kit)} cancels for ${sent.length - 1} history prompts`)
    // all in one session
    assert.equal(new Set(kit.acpLog.filter((e) => e.method === "session/prompt").map((e) => e.params.sessionId)).size, 1)
  })
})

test("the next turn continues in the seeded session with the new messages only", async () => {
  await withKit({}, async (kit) => {
    agent(kit)
    const { messages } = longConversation(300)
    const body = baseBody({ metadata: { user_id: "seed-next" }, messages })
    await readSse(await kit.request(body))
    const first = prompts(kit).length
    const next = baseBody({ metadata: { user_id: "seed-next" }, messages: [...messages,
      { role: "assistant", content: [{ type: "text", text: "FINAL ANSWER" }] },
      { role: "user", content: "SECOND QUESTION" }] })
    const parsed = await readSse(await kit.request(next))
    assert.equal(parsed.stopReason, "end_turn")
    const sent = prompts(kit).slice(first)
    assert.equal(sent.length, 1)
    assert.ok(sent[0].includes("SECOND QUESTION") && !sent[0].includes("MARK-0"), sent[0].slice(0, 200))
    assert.equal(kit.acpSpawns.length, 1)
  })
})

test("a history part agy answers anyway (a late cancel) says nothing to the client", async () => {
  await withKit({}, async (kit) => {
    agent(kit, { answerSeeds: true })
    const { messages } = longConversation(300)
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "seed-late" }, messages })))
    assert.equal(parsed.stopReason, "end_turn")
    assert.equal(parsed.content.map((block) => block.text || "").join(""), "FINAL ANSWER")
  })
})

test("history past the replay budget is still left out, and the model is told", async () => {
  await withKit({ env: { AGY_BRIDGE_MAX_REPLAY_BYTES: String(240 * KIB) } }, async (kit) => {
    agent(kit)
    const { messages } = longConversation(500)
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "seed-over" }, messages })))
    assert.equal(parsed.stopReason, "end_turn")
    const sent = prompts(kit)
    assert.ok(sent.length >= 2)
    for (const text of sent) assert.ok(bytes(text) <= ONE_PROMPT)
    const all = sent.join("\n")
    assert.ok(bytes(all) <= 240 * KIB + 2 * KIB, `${bytes(all)} bytes went in`)
    assert.ok(all.includes(OMITTED), "the model is told history was left out")
    assert.ok(all.includes("ANCHOR opening request") && all.includes("NEWEST assistant reply"))
  })
})

test("a pasted 300 KiB message in a live session goes in whole too", async () => {
  await withKit({}, async (kit) => {
    agent(kit)
    const opening = [{ role: "user", content: "hello" }]
    await readSse(await kit.request(baseBody({ metadata: { user_id: "seed-paste" }, messages: opening })))
    const first = prompts(kit).length
    const log = "PASTE-HEAD\n" + "log line with a few words in it\n".repeat(10_000) + "PASTE-TAIL"
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "seed-paste" }, messages: [...opening,
      { role: "assistant", content: [{ type: "text", text: "FINAL ANSWER" }] },
      { role: "user", content: log }] })))
    assert.equal(parsed.stopReason, "end_turn")
    const sent = prompts(kit).slice(first)
    assert.ok(sent.length >= 3, `${sent.length} prompts`)
    for (const text of sent) assert.ok(bytes(text) <= ONE_PROMPT)
    const all = sent.map((text) => text.replace(/^\[Continued from the previous message\.\]\n/, "")
      .replace(/\n\[This message continues in the next one\.\]$/, "")).join("")
    assert.ok(all.includes("PASTE-HEAD") && all.includes("PASTE-TAIL"))
    assert.equal(all.split("log line with a few words in it\n").length - 1, 10_000, "every line went in")
  })
})

test("the usage estimate for a seeded replay is the whole conversation, not the part one prompt held", async () => {
  await withKit({}, async (kit) => {
    agent(kit)
    const { messages } = longConversation(400)
    const body = baseBody({ metadata: { user_id: "seed-usage" }, messages })
    const whole = await kit.countTokens(body)
    const parsed = await readSse(await kit.request(body))
    const input = (parsed.usage?.input_tokens || 0) + (parsed.usage?.cache_read_input_tokens || 0) + (parsed.usage?.cache_creation_input_tokens || 0)
    assert.ok(input >= whole * 0.9, `usage says ${input} input tokens for a ${whole}-token conversation`)
  })
})

test("a client that leaves mid-seed gets the whole history again next time, never a half-seeded session", async () => {
  await withKit({}, async (kit) => {
    const controller = new AbortController()
    let seen = 0
    kit.defaultPrompt = async (agent) => {
      const text = promptText({ prompt: agent.prompt })
      if (text.endsWith(CONTINUES)) {
        if (++seen === 2) controller.abort()
        await agent.waitCancel()
        return { stopReason: "cancelled" }
      }
      await agent.text("FINAL ANSWER")
      return { stopReason: "end_turn" }
    }
    const { messages } = longConversation(400)
    const body = baseBody({ metadata: { user_id: "seed-abort" }, messages })
    await kit.request(body, { signal: controller.signal }).then((r) => r.text()).catch(() => {})
    const before = kit.acpLog.filter((e) => e.method === "session/prompt")
    assert.ok(before.length >= 2 && before.length < 4, `${before.length} prompts before the client left`)
    assert.ok(!before.some((e) => promptText(e.params).endsWith("</current_turn>")), "the real prompt never went")
    seen = 0
    const parsed = await readSse(await kit.request(body))
    assert.equal(parsed.stopReason, "end_turn")
    const after = kit.acpLog.filter((e) => e.method === "session/prompt").slice(before.length)
    assert.ok(after.length >= 4, `${after.length} prompts on the retry`)
    assert.ok(promptText(after[0].params).includes("ANCHOR opening request"), "the retry starts from the top")
    const first = new Set(before.map((e) => e.params.sessionId))
    assert.ok(after.every((e) => !first.has(e.params.sessionId)), "the half-seeded session is not continued")
  })
})

test("an agy older than 1.5.17 gets one prompt of 112 KiB, as before", async () => {
  await withKit({ agentVersion: "1.5.16" }, async (kit) => {
    agent(kit)
    const { messages } = longConversation(300)
    await readSse(await kit.request(baseBody({ metadata: { user_id: "seed-old" }, messages })))
    const sent = prompts(kit)
    assert.equal(sent.length, 1)
    assert.ok(bytes(sent[0]) <= ONE_PROMPT && sent[0].includes(OMITTED))
  })
})

test("splitPromptParts keeps every byte, in order, within the limit, and never splits a character", () => {
  assert.ok(seedHelpers, "index.mjs has the seed helpers")
  const text = "开头\n" + "中文内容和 emoji 😀 混在一起的一行。\n".repeat(9000) + "结尾"
  const image = { type: "image", data: "AAAA", mimeType: "image/png" }
  const chunks = splitPromptParts([{ type: "text", text }, image, { type: "text", text: "after the image" }], 64 * KIB)
  assert.ok(chunks.length > 4)
  let joined = ""
  for (const [i, chunk] of chunks.entries()) {
    const own = chunk.filter((part) => part.type === "text").map((part) => part.text).join("")
    assert.ok(bytes(own) <= 64 * KIB, `chunk ${i} is ${bytes(own)} bytes`)
    assert.ok(!own.includes("\uFFFD"))
    if (i < chunks.length - 1) assert.ok(own.endsWith("\n" + CONTINUES), `chunk ${i} ends at a line's end`)
    joined += own.replace(/^\[Continued from the previous message\.\]\n/, "").replace(/\n\[This message continues in the next one\.\]$/, "")
  }
  assert.equal(joined, text + "after the image")
  assert.equal(chunks.flat().filter((part) => part.type === "image").length, 1)
})

test("the replay budget follows the model's window", () => {
  assert.ok(seedHelpers, "index.mjs has the seed helpers")
  assert.equal(maxReplayBytes("gemini-3.8-flash-low"), Math.min(4 * 1024 * KIB, (1048576 - 65536 - 32768) * 2))
  assert.equal(maxReplayBytes("claude-sonnet-4-6-thinking"), (250000 - 64000 - 32768) * 2)
  assert.equal(maxReplayBytes("some-new-model"), 384 * KIB)
  assert.equal(seedsHistory("1.5.17"), true)
  assert.equal(seedsHistory("1.6.0"), true)
  assert.equal(seedsHistory("1.5.16"), false)
  assert.equal(seedsHistory(null), false)
})
