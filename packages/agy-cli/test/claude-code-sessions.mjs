// A Claude Code conversation keeps its agy session where Claude Code's own
// requests change around it (_paper_hands on X: 39% of a day's prompts
// opened a new session and replayed the history), and a replay that can't
// keep the whole conversation can be refused instead of sent short, with
// why a parked session wasn't taken in the log (NullBurn, plugins#1495).
//
// bun test ./claude-code-sessions.mjs

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { baseBody, continueWithToolResults, createBridgeKit, readSse } from "./testkit.mjs"

const promptText = (params) => (params?.prompt || []).map((part) => (part.type === "text" ? part.text : "")).join("")
const calls = (kit, method) => kit.acpLog.filter((entry) => entry.method === method)
const KIB = 1024

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cc-sessions-"))
after(() => fs.rmSync(root, { recursive: true, force: true }))

function captureStderr() {
  const rows = []
  const text = []
  const original = process.stderr.write
  process.stderr.write = function write(chunk, ...rest) {
    const line = String(chunk)
    if (line.startsWith("[agy-bridge] {")) {
      rows.push(JSON.parse(line.slice("[agy-bridge] ".length)))
      return true
    }
    if (line.startsWith("[agy-bridge] ")) {
      text.push(line)
      return true
    }
    return original.call(this, chunk, ...rest)
  }
  return { rows, text, restore: () => { process.stderr.write = original } }
}

async function withKit(options, fn) {
  const kit = await createBridgeKit({ agentVersion: "1.5.17", ...options })
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

function answer(kit, text) {
  kit.prompts.push(async (agent) => {
    await agent.text(text)
    return { stopReason: "end_turn" }
  })
}

// Claude Code 2.1.327's shapes: the opening folder in the system prompt's
// environment block, and after a Bash `cd` a system message that says the
// new folder and the old one. magpie's X-Magpie-Work-Dir names the newest.
const envUpdate = (now, was) => ({ role: "system", content: [{ type: "text",
  text: `# Environment update\n - Primary working directory: ${now} (was ${was})` }] })

test("a Bash cd in Claude Code keeps the conversation's agy session, and going back up too", async () => {
  const proj = fs.mkdtempSync(path.join(root, "proj-"))
  const sub = path.join(proj, "sub")
  fs.mkdirSync(sub)
  const system = [
    { type: "text", text: "You are Claude Code, a test build." },
    { type: "text", text: `# Environment\n - Primary working directory: ${proj}\n - Is a git repository: false` },
  ]
  const headers = (dir) => ({ headers: { "x-magpie-session": "cc-cd-1", "x-magpie-work-dir": encodeURIComponent(dir) } })
  const captured = captureStderr()
  try {
    await withKit({}, async (kit) => {
      let cdResult = null
      kit.prompts.push(async (agent) => {
        cdResult = await agent.tool("Read", { file_path: path.join(proj, "notes.txt") })
        await agent.text("in sub now")
        return { stopReason: "end_turn" }
      })
      let body = baseBody({ system, messages: [{ role: "user", content: "go into sub" }] })
      let parsed = await readSse(await kit.request(body, headers(proj)))
      assert.equal(parsed.stopReason, "tool_use")
      const session = calls(kit, "session/new")[0]?.params
      assert.ok(session)

      // the cd's result, then Claude Code's environment update
      body = continueWithToolResults(body, parsed)
      body = { ...body, messages: [...body.messages, envUpdate(sub, proj)] }
      parsed = await readSse(await kit.request(body, headers(sub)))
      assert.equal(parsed.stopReason, "end_turn")
      assert.match(parsed.content.map((block) => block.text || "").join(""), /in sub now/)

      answer(kit, "listed sub")
      body = { ...body, messages: [...body.messages, { role: "assistant", content: [{ type: "text", text: "in sub now" }] },
        { role: "user", content: "list it" }] }
      parsed = await readSse(await kit.request(body, headers(sub)))
      assert.equal(parsed.stopReason, "end_turn")

      answer(kit, "back up")
      body = { ...body, messages: [...body.messages, { role: "assistant", content: [{ type: "text", text: "listed sub" }] },
        envUpdate(proj, sub), { role: "user", content: "and back up" }] }
      parsed = await readSse(await kit.request(body, headers(proj)))
      assert.equal(parsed.stopReason, "end_turn")

      assert.equal(kit.acpSpawns.length, 1, "one agy for the whole conversation")
      assert.equal(calls(kit, "session/new").length, 1, "a cd opened a new session")
      const prompts = calls(kit, "session/prompt")
      assert.ok(prompts.every((entry) => entry.params.sessionId === prompts[0].params.sessionId))
      assert.ok(prompts.slice(1).every((entry) => !promptText(entry.params).includes("<conversation_history>")),
        "the history was replayed")
      // the model still reads where it is now, from the conversation
      // the model still reads where it is now, from the conversation: the
      // cd's update with its result, the way back in the next prompt
      assert.ok(JSON.stringify(cdResult).includes(`Primary working directory: ${sub} (was ${proj})`), JSON.stringify(cdResult))
      assert.ok(promptText(prompts.at(-1).params).includes(`Primary working directory: ${proj} (was ${sub})`))
      assert.ok(!captured.rows.some((row) => row.action === "drop_live"), JSON.stringify(captured.rows.filter((row) => row.action === "drop_live")))
    })
  } finally {
    captured.restore()
  }
})

test("two conversations that open alike in two folders keep sessions of their own", async () => {
  const a = fs.mkdtempSync(path.join(root, "a-"))
  const b = fs.mkdtempSync(path.join(root, "b-"))
  await withKit({}, async (kit) => {
    answer(kit, "A")
    answer(kit, "B")
    for (const dir of [a, b]) {
      const body = baseBody({ system: `# Environment\n - Primary working directory: ${dir}`, messages: [{ role: "user", content: "same opening" }] })
      const parsed = await readSse(await kit.request(body, { headers: { "x-magpie-work-dir": encodeURIComponent(dir) } }))
      assert.equal(parsed.stopReason, "end_turn")
    }
    assert.equal(calls(kit, "session/new").length, 2)
  })
})

// A conversation of ~`kib` KiB.
function longConversation(kib) {
  const filler = "history filler line with some words in it. ".repeat(220)
  const messages = [{ role: "user", content: "ANCHOR opening request" }]
  let index = 0
  while (Buffer.byteLength(JSON.stringify(messages)) < kib * KIB) {
    messages.push({ role: "assistant", content: [{ type: "text", text: `MARK-${index} ${filler}` }] })
    messages.push({ role: "user", content: `follow-up ${index}` })
    index++
  }
  messages.push({ role: "assistant", content: "NEWEST assistant reply" })
  messages.push({ role: "user", content: "LATEST INSTRUCTION" })
  return messages
}

function seedingAgent(kit) {
  kit.defaultPrompt = async (agent) => {
    if (promptText({ prompt: agent.prompt }).endsWith("[This message continues in the next one.]")) {
      await agent.waitCancel()
      return { stopReason: "cancelled" }
    }
    await agent.text("FINAL ANSWER")
    return { stopReason: "end_turn" }
  }
}

test("AGY_BRIDGE_STRICT_REPLAY refuses a replay that would leave history out, before sending anything", async () => {
  const captured = captureStderr()
  try {
    await withKit({ env: { AGY_BRIDGE_STRICT_REPLAY: "1", AGY_BRIDGE_MAX_REPLAY_BYTES: String(240 * KIB) } }, async (kit) => {
      seedingAgent(kit)
      const response = await kit.request(baseBody({ metadata: { user_id: "strict-over" }, messages: longConversation(500) }))
      assert.equal(response.status, 400)
      assert.equal(response.headers.get("x-should-retry"), "false")
      const error = (await response.json()).error
      assert.equal(error.type, "invalid_request_error")
      assert.equal(error.code, "context_length_exceeded")
      assert.match(error.message, /^prompt is too long: /)
      assert.doesNotMatch(error.message, /agy 1\.5\.17 or newer/, "this agy takes a replay over several prompts")
      assert.equal(calls(kit, "session/prompt").length, 0, "a shortened prompt went to agy")
      const refused = captured.rows.find((row) => row.action === "replay_refused")
      assert.ok(refused && refused.messages_after < refused.messages_before, JSON.stringify(refused))

      // what fits goes in whole, strict or not
      const fits = await readSse(await kit.request(baseBody({ metadata: { user_id: "strict-fits" }, messages: longConversation(150) })))
      assert.equal(fits.stopReason, "end_turn")
      const replay = captured.rows.find((row) => row.action === "replay" && row.messages_before > 0)
      assert.equal(replay.messages_after, replay.messages_before)
      assert.equal(replay.seeded, true)
    })
  } finally {
    captured.restore()
  }
})

test("an agy too old to take a replay over several prompts is named: strict refuses, otherwise one warning", async () => {
  const captured = captureStderr()
  try {
    await withKit({ agentVersion: "1.5.10", env: { AGY_BRIDGE_STRICT_REPLAY: "1" } }, async (kit) => {
      seedingAgent(kit)
      const response = await kit.request(baseBody({ metadata: { user_id: "old-strict" }, messages: longConversation(200) }))
      assert.equal(response.status, 400)
      assert.match((await response.json()).error.message, /agy 1\.5\.10 takes one prompt only, agy 1\.5\.17 or newer/)
    })
    await withKit({ agentVersion: "1.5.10" }, async (kit) => {
      seedingAgent(kit)
      for (const user of ["old-a", "old-b"]) {
        const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: user }, messages: longConversation(200) })))
        assert.equal(parsed.stopReason, "end_turn")
      }
      const replay = captured.rows.filter((row) => row.action === "replay" && row.messages_before > 0).at(-1)
      assert.equal(replay.seeded, false)
      assert.equal(replay.agy_version, "1.5.10")
      const warnings = captured.text.filter((line) => line.includes("1.5.17 or newer"))
      assert.equal(warnings.length, 1, captured.text.join(""))
    })
  } finally {
    captured.restore()
  }
})

// Two bridges sharing a state folder, as a plugin host and the one after it.
async function withRestart(options, fn) {
  const shared = fs.mkdtempSync(path.join(root, "restart-"))
  const env = { XDG_STATE_HOME: path.join(shared, "state") }
  const kits = []
  const start = async (more = {}) => {
    const kit = await createBridgeKit({ agentVersion: "1.5.17", sessionResume: true, ...options, ...more, env })
    kits.push(kit)
    return kit
  }
  try {
    return await fn(start)
  } finally {
    for (const kit of kits.reverse()) await kit.dispose().catch(() => {})
  }
}

const sessionRow = (rows) => rows.filter((row) => row.event === "agy_bridge_session" && row.action === "session_new").at(-1)

test("the session row says why a parked session was not taken", async () => {
  const opening = { role: "user", content: "PARK opening" }
  const second = (reply) => baseBody({ messages: [opening, { role: "assistant", content: [{ type: "text", text: reply }] },
    { role: "user", content: "next" }] })
  const captured = captureStderr()
  try {
    // no entry: a host that never had this conversation
    await withKit({ sessionResume: true, env: { XDG_STATE_HOME: path.join(root, "empty-state") } }, async (kit) => {
      answer(kit, "ok")
      assert.equal((await readSse(await kit.request(second("first reply")))).stopReason, "end_turn")
      assert.equal(sessionRow(captured.rows).park_miss, "none")
    })

    // the history differs from what the parked session holds
    await withRestart({}, async (start) => {
      const a = await start()
      answer(a, "first reply")
      assert.equal((await readSse(await a.request(baseBody({ messages: [opening] })))).stopReason, "end_turn")
      await a.finishChildren()
      const b = await start()
      answer(b, "ok")
      assert.equal((await readSse(await b.request(second("an edited reply")))).stopReason, "end_turn")
      const row = sessionRow(captured.rows)
      assert.equal(row.park_miss, "history", JSON.stringify(row))
      assert.equal(row.parked, false)
    })

    // the entry matched but agy's session/resume failed
    await withRestart({}, async (start) => {
      const a = await start()
      answer(a, "first reply")
      assert.equal((await readSse(await a.request(baseBody({ messages: [opening] })))).stopReason, "end_turn")
      await a.finishChildren()
      const b = await start({ sessionResumeError: { code: -32603, message: "no such session" } })
      answer(b, "ok")
      assert.equal((await readSse(await b.request(second("first reply")))).stopReason, "end_turn")
      const row = sessionRow(captured.rows)
      assert.equal(row.parked, true, JSON.stringify(row))
      assert.equal(row.resumed, false)
      assert.equal(row.resume_failed, "rpc_-32603")
      assert.equal(calls(b, "session/new").length, 1)
    })
  } finally {
    captured.restore()
  }
})
