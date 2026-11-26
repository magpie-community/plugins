// A conversation keeps its agy session across a bridge restart in the
// middle of a tool loop (chet030714 and xuanbo1889245 on X). magpie
// recycles a plugin host that holds too much memory, and updates restart
// it; the next tool result then reached a bridge with no live session,
// and the whole history went into a new one (since 0.1.139 up to the
// model's window, ~1.8 MB for flash) where a resume sends one result.
//
// Each test drives a fake agy (testkit) through a Claude Code shaped
// conversation and counts session/new, session/resume and prompt bytes.
//
// bun test ./session-continuity.mjs

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { baseBody, continueWithToolResults, createBridgeKit, readSse } from "./testkit.mjs"

const promptText = (params) => (params?.prompt || []).map((part) => (part.type === "text" ? part.text : "")).join("")
const bytes = (text) => Buffer.byteLength(text, "utf8")
const calls = (kit, method) => kit.acpLog.filter((entry) => entry.method === method)
const promptBytes = (kit) => calls(kit, "session/prompt").map((entry) => bytes(promptText(entry.params)))

// ~60 KB of earlier conversation (one prompt, no seeds): what a replay
// sends again, against a few hundred bytes for a resumed step
const OPENING = "OPENING-MARK " + "earlier work on the project, read and discussed at length. ".repeat(1000)

// Two bridges (an old host and the one after a recycle) sharing one state
// folder, as magpie's hosts share the user's.
async function withRestart(options, fn) {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), "agy-continuity-"))
  const env = { XDG_STATE_HOME: path.join(shared, "state"), ...(options.env || {}) }
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
    fs.rmSync(shared, { recursive: true, force: true })
  }
}

// The old host goes: magpie ends it and its agy with it (reapOnExit), with
// no turn finished and nothing parked on the way out.
async function hostGone(kit) {
  await kit.finishChildren()
}

function toolLoop(kit, steps, final = "loop done") {
  let sessionId = null
  kit.prompts.push(async (agent) => {
    sessionId = agent.sessionId
    for (const step of steps) await agent.tool("Read", { path: step })
    await agent.text(final)
    return { stopReason: "end_turn" }
  })
  return () => sessionId
}

function answer(kit, text) {
  kit.prompts.push(async (agent) => {
    await agent.text(text)
    return { stopReason: "end_turn" }
  })
}

const opening = (extra = {}) => baseBody({ messages: [{ role: "user", content: OPENING }], ...extra })

test("a tool loop cut by a host restart goes on in its own session with only the new results", async () => {
  await withRestart({}, async (start) => {
    const a = await start()
    const sessionOf = toolLoop(a, ["/a", "/b", "/c"])
    let body = opening()
    let parsed = await readSse(await a.request(body))
    assert.equal(parsed.stopReason, "tool_use")
    body = continueWithToolResults(body, parsed)
    parsed = await readSse(await a.request(body))
    assert.equal(parsed.stopReason, "tool_use", "the second step comes from the live session")
    const session = sessionOf()
    assert.ok(session)
    await hostGone(a)

    const b = await start()
    answer(b, "went on after the restart")
    body = continueWithToolResults(body, parsed, () => "RESULT-AFTER-RESTART")
    parsed = await readSse(await b.request(body))
    assert.equal(parsed.stopReason, "end_turn")
    assert.match(parsed.content.map((block) => block.text || "").join(""), /went on after the restart/)
    assert.equal(calls(b, "session/new").length, 0, "a new session replays the whole conversation")
    const resumes = calls(b, "session/resume")
    assert.equal(resumes.length, 1)
    assert.equal(resumes[0].params.sessionId, session)
    const sent = calls(b, "session/prompt").map((entry) => promptText(entry.params))
    assert.equal(sent.length, 1, "one prompt, no seeded replay")
    assert.match(sent[0], /RESULT-AFTER-RESTART/)
    assert.doesNotMatch(sent[0], /OPENING-MARK/, "the opening is in the session already")
    assert.ok(bytes(sent[0]) < 4096, `the resumed prompt is ${bytes(sent[0])} bytes`)

    // and the conversation goes on in that session, turn after turn
    answer(b, "second turn")
    body = { ...body, messages: [...body.messages, { role: "assistant", content: [{ type: "text", text: "went on after the restart" }] },
      { role: "user", content: "and now the next thing" }] }
    parsed = await readSse(await b.request(body))
    assert.equal(parsed.stopReason, "end_turn")
    assert.equal(calls(b, "session/new").length, 0)
    assert.equal(calls(b, "session/resume").length, 1)
    assert.ok(promptBytes(b).every((size) => size < 4096), `prompts: ${promptBytes(b)}`)
  })
})

test("a restart on every step of a long loop never replays, and every step stays small", async () => {
  await withRestart({}, async (start) => {
    let kit = await start()
    toolLoop(kit, ["/s0"])
    let body = opening()
    let parsed = await readSse(await kit.request(body))
    assert.equal(parsed.stopReason, "tool_use")
    const sizes = []
    for (let step = 1; step <= 4; step++) {
      await hostGone(kit)
      kit = await start()
      toolLoop(kit, [`/s${step}`])
      body = continueWithToolResults(body, parsed, () => `result of step ${step - 1}`)
      parsed = await readSse(await kit.request(body))
      assert.equal(parsed.stopReason, "tool_use", `step ${step}`)
      assert.equal(calls(kit, "session/new").length, 0, `step ${step} opened a new session`)
      assert.equal(calls(kit, "session/resume").length, 1, `step ${step}`)
      sizes.push(...promptBytes(kit))
    }
    assert.ok(sizes.every((size) => size < 4096), `prompt bytes per restart: ${sizes}`)
  })
})

test("parallel conversations and a subagent each resume their own session after a restart", async () => {
  await withRestart({}, async (start) => {
    const a = await start()
    const convs = [
      { headers: { "x-magpie-session": "claude:main-1" }, label: "MAIN" },
      { headers: { "x-magpie-session": "claude:other-2" }, label: "OTHER" },
      { headers: { "x-magpie-session": "claude:main-1", "x-magpie-subagent": "task-1" }, label: "SUB" },
    ]
    for (const conv of convs) {
      conv.sessionOf = toolLoop(a, [`/${conv.label}`])
      conv.body = opening({ messages: [{ role: "user", content: `${conv.label} ${OPENING}` }] })
      conv.parsed = await readSse(await a.request(conv.body, { headers: conv.headers }))
      assert.equal(conv.parsed.stopReason, "tool_use", conv.label)
    }
    const sessions = convs.map((conv) => conv.sessionOf())
    assert.equal(new Set(sessions).size, 3)
    await hostGone(a)

    const b = await start()
    for (const conv of convs) {
      answer(b, `${conv.label} done`)
      const body = continueWithToolResults(conv.body, conv.parsed)
      const parsed = await readSse(await b.request(body, { headers: conv.headers }))
      assert.equal(parsed.stopReason, "end_turn", conv.label)
      assert.match(parsed.content.map((block) => block.text || "").join(""), new RegExp(`${conv.label} done`))
    }
    assert.equal(calls(b, "session/new").length, 0)
    assert.deepEqual(calls(b, "session/resume").map((entry) => entry.params.sessionId), sessions)
    assert.ok(promptBytes(b).every((size) => size < 4096), `prompts: ${promptBytes(b)}`)
  })
})

test("a Codex step of parallel calls cut by a restart resumes with both results only", async () => {
  await withRestart({}, async (start) => {
    const headers = { "x-magpie-session": "codex:thread-7" }
    const a = await start()
    let session = null
    a.prompts.push(async (agent) => {
      session = agent.sessionId
      await agent.tools([["Read", { path: "/src/a.go" }], ["Read", { path: "/src/b.go" }]])
      await agent.text("unreachable")
      return { stopReason: "end_turn" }
    })
    let body = opening({ system: "You are Codex, a coding agent. Follow the repository's AGENTS.md." })
    let parsed = await readSse(await a.request(body, { headers }))
    assert.equal(parsed.content.filter((block) => block.type === "tool_use").length, 2)
    await hostGone(a)

    const b = await start()
    answer(b, "both read")
    body = continueWithToolResults(body, parsed, (_block, index) => `PARALLEL-RESULT-${index}`)
    parsed = await readSse(await b.request(body, { headers }))
    assert.equal(parsed.stopReason, "end_turn")
    assert.equal(calls(b, "session/new").length, 0)
    assert.deepEqual(calls(b, "session/resume").map((entry) => entry.params.sessionId), [session])
    const sent = calls(b, "session/prompt").map((entry) => promptText(entry.params))
    assert.equal(sent.length, 1)
    assert.match(sent[0], /PARALLEL-RESULT-0[\s\S]*PARALLEL-RESULT-1/)
    assert.doesNotMatch(sent[0], /OPENING-MARK/)
    assert.ok(bytes(sent[0]) < 4096, `the resumed prompt is ${bytes(sent[0])} bytes`)
  })
})

test("a model switch after a mid-loop restart keeps the resumed session", async () => {
  await withRestart({}, async (start) => {
    const a = await start()
    const sessionOf = toolLoop(a, ["/a"])
    let body = opening()
    let parsed = await readSse(await a.request(body))
    await hostGone(a)

    const b = await start()
    answer(b, "first")
    body = continueWithToolResults(body, parsed)
    parsed = await readSse(await b.request(body))
    assert.equal(parsed.stopReason, "end_turn")
    answer(b, "on another model")
    body = { ...body, model: "agy-cli/gemini-3.8-flash-low", messages: [...body.messages,
      { role: "assistant", content: [{ type: "text", text: "first" }] }, { role: "user", content: "same thing, faster model" }] }
    parsed = await readSse(await b.request(body))
    assert.equal(parsed.stopReason, "end_turn")
    assert.equal(calls(b, "session/new").length, 0)
    assert.deepEqual(calls(b, "session/resume").map((entry) => entry.params.sessionId), [sessionOf()])
  })
})

test("a request whose history doesn't go on from the parked step still opens a new session", async () => {
  await withRestart({}, async (start) => {
    const a = await start()
    toolLoop(a, ["/a"])
    const body = opening()
    const parsed = await readSse(await a.request(body))
    await hostGone(a)

    const b = await start()
    answer(b, "replayed")
    // the client rewrote its opening (a compaction): not the parked session
    const edited = continueWithToolResults({ ...body, messages: [{ role: "user", content: `${OPENING} (edited)` }] }, parsed)
    const out = await readSse(await b.request(edited))
    assert.equal(out.stopReason, "end_turn")
    assert.equal(calls(b, "session/resume").length, 0)
    assert.equal(calls(b, "session/new").length, 1)
  })
})

test("a loop the bridge gave up on (its call answered with an error) is not resumed mid-step", async () => {
  await withRestart({ env: { AGY_BRIDGE_TOOL_TIMEOUT_MS: "300" } }, async (start) => {
    const a = await start()
    toolLoop(a, ["/a"])
    const body = opening()
    const parsed = await readSse(await a.request(body))
    assert.equal(parsed.stopReason, "tool_use")
    // no result for longer than the wait: the bridge stops that agy, and
    // agy was told the call failed, so its session has moved on
    await new Promise((resolve) => setTimeout(resolve, 900))
    await hostGone(a)

    const b = await start()
    answer(b, "replayed")
    const out = await readSse(await b.request(continueWithToolResults(body, parsed)))
    assert.equal(out.stopReason, "end_turn")
    assert.equal(calls(b, "session/resume").length, 0)
    assert.equal(calls(b, "session/new").length, 1)
  })
})

// Claude Code names its model in the system prompt ("You are powered by
// the model agy-cli/…"), so /model rewrites that line. agy switches models
// inside a session (session/set_model): the line alone must not make the
// conversation a new one and replay it (chet030714 on X, hydrogen ⇄ neon).
test("a Claude Code model switch, which rewrites the system prompt's model line, keeps the session", async () => {
  await withRestart({}, async (start) => {
    const kit = await start()
    const system = (model) => `You are Claude Code, Anthropic's official CLI for Claude.\n\n# Environment\n - Platform: darwin\n\nYou are powered by the model ${model}.\n\nAssistant knowledge cutoff is January 2025.`
    let session = null
    kit.prompts.push(async (agent) => {
      session = agent.sessionId
      await agent.text("first")
      return { stopReason: "end_turn" }
    })
    let body = opening({ model: "agy-cli/gemini-4-argon[1m]", system: system("agy-cli/gemini-4-argon[1m]") })
    let parsed = await readSse(await kit.request(body))
    assert.equal(parsed.stopReason, "end_turn")
    answer(kit, "on another model")
    body = { ...body, model: "agy-cli/gemini-3.8-flash-low", system: system("agy-cli/gemini-3.8-flash-low"), messages: [...body.messages,
      { role: "assistant", content: [{ type: "text", text: "first" }] }, { role: "user", content: "same thing, faster model" }] }
    parsed = await readSse(await kit.request(body))
    assert.equal(parsed.stopReason, "end_turn")
    assert.equal(calls(kit, "session/new").length, 1, "the switch opened a new session and replayed the conversation")
    const prompts = calls(kit, "session/prompt")
    assert.equal(prompts.at(-1).params.sessionId, session)
    assert.doesNotMatch(promptText(prompts.at(-1).params), /OPENING-MARK/)
    assert.ok(calls(kit, "session/set_model").length + calls(kit, "session/set_config_option").length >= 1, "the model is switched in place")

    // and after a restart the parked session is still found
    await hostGone(kit)
    const b = await start()
    answer(b, "after restart")
    body = { ...body, system: system("agy-cli/gemini-4-argon[1m]"), model: "agy-cli/gemini-4-argon[1m]", messages: [...body.messages,
      { role: "assistant", content: [{ type: "text", text: "on another model" }] }, { role: "user", content: "back to the big one" }] }
    parsed = await readSse(await b.request(body))
    assert.equal(parsed.stopReason, "end_turn")
    assert.equal(calls(b, "session/new").length, 0)
    assert.deepEqual(calls(b, "session/resume").map((entry) => entry.params.sessionId), [session])
  })
})

test("a session parked before the model line left the key is still resumed after the update", async () => {
  await withRestart({}, async (start) => {
    const system = `You are Claude Code, Anthropic's official CLI for Claude.\n\nYou are powered by the model agy-cli/gemini-4-argon[1m].`
    // the host before the update keyed conversations with the model line
    const old = await start({ indexTransform: (source) => {
      const from = "return stripMagpiePlaceholderNotice(legacy ? s : stripAgentModelLines(s))"
      assert.ok(source.includes(from))
      return source.replace(from, "return stripMagpiePlaceholderNotice(s)").replace("legacyConvKey: legacyConvKey !== convKey ? legacyConvKey : \"\",", "")
    } })
    let session = null
    old.prompts.push(async (agent) => {
      session = agent.sessionId
      await agent.text("first")
      return { stopReason: "end_turn" }
    })
    let body = opening({ system })
    assert.equal((await readSse(await old.request(body))).stopReason, "end_turn")
    await hostGone(old)

    const b = await start()
    answer(b, "after the update")
    body = { ...body, messages: [...body.messages, { role: "assistant", content: [{ type: "text", text: "first" }] }, { role: "user", content: "go on" }] }
    assert.equal((await readSse(await b.request(body))).stopReason, "end_turn")
    assert.equal(calls(b, "session/new").length, 0, "the update replayed a parked conversation")
    assert.deepEqual(calls(b, "session/resume").map((entry) => entry.params.sessionId), [session])
  })
})
