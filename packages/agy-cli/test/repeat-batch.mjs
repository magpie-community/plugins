// magpie-agy regressions for the fixes merged on top of PR #8 that the
// upstream suites do not cover: execOnce timeouts (A3), model limits (A5),
// agy re-discovery (A6), the no-progress repeat limit (A7), the 30 ms tool
// batch (A9), layout_flip diagnostics (A11), pool pressure on detached tool
// turns and compaction forks (A15), and the 112 KiB initial prompt budget (A16).
//
// Run: node --experimental-vm-modules --test test-repeat-batch.mjs
// Everything goes through the real index.mjs entry points; see testkit.mjs.

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import {
  baseBody, continueWithToolResults, createBridgeKit, readSse, sleep, tick,
} from "./testkit.mjs"

async function withKit(options, fn) {
  const kit = await createBridgeKit(options)
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

function promptText(params) {
  return (params?.prompt || []).map((part) => (part.type === "text" ? part.text : "")).join("")
}

function prompts(kit) {
  return kit.acpLog.filter((entry) => entry.method === "session/prompt").map((entry) => promptText(entry.params))
}

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

// A prompt script keyed by the text the bridge sent: "TOOL" asks for one Read
// and waits for its MCP reply; everything else answers with plain text.
function scriptedAgent(kit, replies = {}) {
  kit.defaultPrompt = async (agent) => {
    const text = promptText({ prompt: agent.prompt })
    for (const [marker, reply] of Object.entries(replies)) {
      if (text.includes(marker)) {
        await agent.text(reply)
        return { stopReason: "end_turn" }
      }
    }
    const current = text.includes("<current_turn>") ? text.slice(text.lastIndexOf("<current_turn>")) : text
    if (current.includes("TOOL")) {
      await agent.tool("Read", { path: `/repo/${agent.index}.txt` })
      await agent.text("after tool")
      return { stopReason: "end_turn" }
    }
    await agent.text(`answer ${agent.index}`)
    return { stopReason: "end_turn" }
  }
}

async function errorOf(response) {
  return { status: response.status, retry: response.headers.get("x-should-retry"), body: await response.json() }
}

// ---------------------------------------------------------------- A3 execOnce

test("A3: execOnce resolves on its deadline even when the killed child never closes", async () => {
  await withKit({ modelsBehavior: { hang: true } }, async (kit) => {
    const execOnce = kit.module.__agyTestExecOnce
    const started = performance.now()
    const pending = execOnce(kit.agyPath, ["models"], { timeoutMs: 50 })
    // A grandchild keeps the pipes open: the kill does not produce "close".
    for (const child of kit.children) child.kill = () => true
    // Bound the wait ourselves: the old defect leaves this promise pending forever.
    let guard
    const result = await Promise.race([pending, new Promise((resolve) => {
      guard = setTimeout(() => resolve({ hung: true }), 2_000)
    })])
    clearTimeout(guard)
    assert.notEqual(result.hung, true, "execOnce never resolved after its deadline")
    const elapsed = performance.now() - started
    assert.equal(result.timedOut, true)
    assert.equal(result.code, null)
    assert.equal(result.err, null)
    assert.ok(elapsed < 1_000, `execOnce took ${Math.round(elapsed)}ms after a 50ms deadline`)
  })
})

// ------------------------------------------------------------------ A5 limit

test("A5: models() reports per-family limits next to the upstream image capabilities", async () => {
  await withKit({}, async (kit) => {
    const models = await kit.models()
    assert.deepEqual(models["gemini-4-argon"].limit, { context: 1048576, output: 65536 })
    assert.deepEqual(models["gemini-3.8-flash"].limit, { context: 1048576, output: 65536 })
    // Claude and GPT-OSS limits are checked once a session offers them (catalog.mjs).
    assert.equal(models["claude-opus-5-5"], undefined, "no session has offered Claude yet")
    assert.equal(models["gemini-4-argon"].capabilities?.input?.image, true, "acb image capability must stay")
    assert.equal(models["gemini-4-argon"].reasoning, true)
  })
})

// ------------------------------------------------------- A6 agy re-discovery

test("A6: findAgy searches again when PATH changes instead of keeping the first hit", async () => {
  await withKit({ agyPath: null }, async (kit) => {
    const findAgy = kit.module.__agyTestFindAgy
    assert.equal(findAgy(), null)
    const first = kit.makeFakeAgy("first")
    // agyCandidates on win32 only matches agy.exe/.cmd/.bat names.
    assert.equal(path.basename(first), process.platform === "win32" ? "agy.exe" : "agy")
    kit.env.PATH = path.dirname(first)
    assert.equal(findAgy(), first)
    const second = kit.makeFakeAgy("second")
    kit.env.PATH = path.dirname(second)
    assert.equal(findAgy(), second, "a cached path from the old PATH was reused")
    fs.rmSync(second)
    kit.env.PATH = path.dirname(first)
    assert.equal(findAgy(), first)
  })
})

test("A6b: an agy removed after it was found is not found again", async () => {
  // magpie's sign-in asks whether agy is there and installs it when not;
  // a cached path to a removed agy answered yes and the sign-in failed
  // with ENOENT spawning it (magpie's container, 11-15)
  await withKit({ agyPath: null }, async (kit) => {
    const findAgy = kit.module.__agyTestFindAgy
    const agy = kit.makeFakeAgy("gone")
    kit.env.PATH = path.dirname(agy)
    assert.equal(findAgy(), agy)
    fs.rmSync(agy)
    assert.equal(findAgy(), null, "the removed agy's cached path was handed out")
  })
})

// ------------------------------------------------ A7 no-progress repeat limit

async function pendingToolTurn(kit, body) {
  const parsed = await readSse(await kit.request(body))
  assert.equal(parsed.stopReason, "tool_use")
  return parsed
}

function unmatchedRound(body, { answerId = "toolu_unmatched", callId = "toolu_unmatched" } = {}) {
  return {
    ...body,
    messages: [
      ...body.messages,
      { role: "assistant", content: [{ type: "text", text: "a different recorded response" },
        { type: "tool_use", id: callId, name: "Read", input: { path: "/elsewhere" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: answerId, content: "UNMATCHED RESULT" }] },
    ],
  }
}

test("A7: the third unmatched repeat against a quiet turn replays the request's own tool round", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit, { "UNMATCHED RESULT": "replayed from history" })
    const body = baseBody({ metadata: { user_id: "repeat-replay" }, messages: [{ role: "user", content: "TOOL start" }] })
    await pendingToolTurn(kit, body)
    const unmatched = unmatchedRound(body)
    for (const attempt of [1, 2]) {
      const response = await kit.request(unmatched)
      assert.equal(response.status, 409, `attempt ${attempt} must stay 409`)
      assert.equal(response.headers.get("x-should-retry"), null)
      await response.text()
    }
    assert.equal(kit.acpSpawns.length, 1, "the first two attempts must not start a process")
    const third = await readSse(await kit.request(unmatched))
    assert.equal(third.stopReason, "end_turn")
    assert.equal(third.content.find((block) => block.type === "text")?.text, "replayed from history")
    assert.equal(kit.acpSpawns.length, 2, "the replay runs on a fresh process")
    assert.ok(prompts(kit).at(-1).includes("UNMATCHED RESULT"))
  })
})

// A routing group served the held call's result on another provider, whose
// own tool round then failed back to agy-cli (#1051).
function movedOnRound(body, first, foreignId) {
  const use = first.content.find((block) => block.type === "tool_use")
  return {
    ...body,
    messages: [
      ...body.messages,
      { role: "assistant", content: [use] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "answered elsewhere" }] },
      { role: "assistant", content: [{ type: "text", text: "another provider's step" },
        { type: "tool_use", id: foreignId, name: "Read", input: { path: "/other" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: foreignId, content: "FOREIGN RESULT" }] },
    ],
  }
}

test("A7: a turn the conversation went on without is replayed at the first unmatched request (#1051)", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit, { "FOREIGN RESULT": "replayed after the group came back" })
    const body = baseBody({ metadata: { user_id: "moved-on" }, messages: [{ role: "user", content: "TOOL start" }] })
    const first = await pendingToolTurn(kit, body)
    const response = await kit.request(movedOnRound(body, first, "toolu_01AbCdEfGhIjKlMnOpQrStUv"))
    assert.equal(response.status, 200, response.status === 200 ? "" : await response.text())
    const parsed = await readSse(response)
    assert.equal(parsed.stopReason, "end_turn")
    assert.equal(parsed.content.find((block) => block.type === "text")?.text, "replayed after the group came back")
    assert.equal(kit.acpSpawns.length, 2, "the replay runs on a fresh process")
  })
})

test("A7: a later round with the bridge's own id shape is not taken as the conversation moving on (#1051)", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit)
    const body = baseBody({ metadata: { user_id: "moved-on-own-shape" }, messages: [{ role: "user", content: "TOOL start" }] })
    const first = await pendingToolTurn(kit, body)
    const response = await kit.request(movedOnRound(body, first, "toolu_0123456789abcdef01234567"))
    assert.equal(response.status, 409)
    await response.text()
    assert.equal(kit.acpSpawns.length, 1)
  })
})

test("A7: a third repeat that cannot be replayed ends in a terminal 400 with attempts and turn_id", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit)
    const body = baseBody({ metadata: { user_id: "repeat-terminal" }, messages: [{ role: "user", content: "TOOL start" }] })
    await pendingToolTurn(kit, body)
    // The result answers an ID that its own assistant message never issued.
    const broken = unmatchedRound(body, { answerId: "toolu_answer", callId: "toolu_other" })
    const statuses = []
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await kit.request(broken)
      statuses.push(response.status)
      await response.text()
    }
    assert.deepEqual(statuses, [409, 409])
    const terminal = await errorOf(await kit.request(broken))
    assert.equal(terminal.status, 400)
    assert.equal(terminal.retry, "false")
    assert.equal(terminal.body.error.code, "tool_history_incomplete")
    assert.equal(terminal.body.error.attempts, 3)
    assert.match(terminal.body.error.turn_id, /^turn_[0-9a-f]+$/)
    assert.equal(kit.acpSpawns.length, 1, "an unreplayable round never starts a process")
  })
})

// ---------------------------------------------------------- A9 30 ms batch

test("A9: tool calls agy issues across adjacent event-loop turns leave in one response", async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.toolsAcrossTicks([["Read", { path: "/a" }], ["Read", { path: "/b" }], ["Read", { path: "/c" }]])
      await agent.text("done")
      return { stopReason: "end_turn" }
    })
    const body = baseBody({ metadata: { user_id: "batch" } })
    const first = await readSse(await kit.request(body))
    assert.equal(first.stopReason, "tool_use")
    assert.deepEqual(first.content.filter((block) => block.type === "tool_use").map((block) => block.input.path), ["/a", "/b", "/c"])
    const final = await readSse(await kit.request(continueWithToolResults(body, first)))
    assert.equal(final.stopReason, "end_turn")
  })
})

// ------------------------------------- A9b a batching call split by the client

const BATCH_TOOL = {
  name: "tool_call",
  description: "Run several tools in one call.",
  input_schema: { type: "object", properties: { calls: { type: "array", items: { type: "object" } } }, required: ["calls"] },
}

// Hermes Agent runs tool_call({calls: [a, b, c]}) and writes it into its
// history as three tool_calls of one entry each, the first under the bridge's
// id and the others under ids of its own, each with a result (plugins#1150).
function splitByClient(body, first, results) {
  const use = first.content.find((block) => block.type === "tool_use")
  const ids = [use.id, "call_0a1b2c3d4e5f", "call_6a7b8c9d0e1f"]
  return {
    ...body,
    messages: [
      ...body.messages,
      { role: "assistant", content: use.input.calls.map((entry, index) => ({ type: "tool_use", id: ids[index], name: use.name, input: { calls: [entry] } })) },
      { role: "user", content: ids.map((id, index) => ({ type: "tool_result", tool_use_id: id, content: results[index] })) },
    ],
  }
}

test("A9b: a batching call the client split into one call per entry is one result for agy (#1150)", async () => {
  await withKit({}, async (kit) => {
    let reply
    const calls = [{ name: "web_search", arguments: { q: "a" } }, { name: "web_search", arguments: { q: "b" } }, { name: "terminal", arguments: { cmd: "c" } }]
    kit.prompts.push(async (agent) => {
      reply = await agent.tool("tool_call", { calls })
      await agent.text("done")
      return { stopReason: "end_turn" }
    })
    const body = baseBody({ metadata: { user_id: "split" }, tools: [BATCH_TOOL] })
    const first = await readSse(await kit.request(body))
    assert.equal(first.stopReason, "tool_use")
    const response = await kit.request(splitByClient(body, first, ["result a", "result b", "result c"]))
    const status = response.status
    const final = status === 200 ? await readSse(response) : await response.text()
    assert.equal(status, 200, typeof final === "string" ? final : "")
    assert.equal(final.stopReason, "end_turn")
    const text = (reply?.result?.content ?? reply?.content ?? []).map((part) => part.text).join("\n")
    assert.match(text, /result a[\s\S]*result b[\s\S]*result c/)
  })
})

test("A9b: separate calls the bridge made are never folded into one (#1150)", async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.tools([["tool_call", { calls: [{ name: "x" }] }], ["tool_call", { calls: [{ name: "y" }] }]])
      await agent.text("done")
      return { stopReason: "end_turn" }
    })
    const body = baseBody({ metadata: { user_id: "apart" }, tools: [BATCH_TOOL] })
    const first = await readSse(await kit.request(body))
    assert.equal(first.content.filter((block) => block.type === "tool_use").length, 2)
    const final = await readSse(await kit.request(continueWithToolResults(body, first)))
    assert.equal(final.stopReason, "end_turn")
  })
})

// ------------------------------------------------- A10 canonical system rule

test("A10: only the opening system prefix is lifted, so a trailing system context keeps the key across turns", async () => {
  await withKit({}, async (kit) => {
    const canonicalBody = kit.module.__agyTestCanonicalBody
    const conversationKey = kit.module.__agyTestConversationKey
    const inline = { system: "base", messages: [{ role: "system", content: [{ type: "text", text: "opening" }] },
      { role: "user", content: "hi" }] }
    const lifted = canonicalBody(inline)
    assert.equal(lifted.system, "base\n\nopening")
    assert.deepEqual(lifted.messages, [{ role: "user", content: "hi" }])
    assert.equal(canonicalBody(lifted), lifted, "canonicalBody is idempotent")
    const hoisted = { system: "base\nopening", messages: [{ role: "user", content: "hi" }] }
    assert.equal(conversationKey(inline), conversationKey(hoisted), "both layouts share one key")
    // Claude Code: a trailing SessionStart context on turn one, an assistant on turn two.
    const turn1 = { system: "S", messages: [{ role: "user", content: "one" }, { role: "system", content: "SessionStart ctx" }] }
    const turn2 = { ...turn1, messages: [...turn1.messages, { role: "assistant", content: "reply" },
      { role: "user", content: "two" }, { role: "system", content: "prompt ctx" }] }
    assert.equal(canonicalBody(turn1), turn1)
    assert.equal(canonicalBody(turn2), turn2, "a system message after the first user stays turn content")
    assert.equal(conversationKey(turn1), conversationKey(turn2))
  })
})

// --------------------------------------------------------- A11 layout_flip

async function flipLayouts(kit) {
  scriptedAgent(kit)
  const hook = "Opening hook context."
  const inline = baseBody({ metadata: { user_id: "layout" }, system: "base system",
    messages: [{ role: "system", content: hook }, { role: "user", content: "hello" }] })
  const first = await readSse(await kit.request(inline))
  const hoisted = { ...inline, system: `base system\n${hook}`, messages: [
    { role: "user", content: "hello" },
    { role: "assistant", content: first.content.map((block) => ({ type: "text", text: block.text })) },
    { role: "user", content: "again" },
  ] }
  const second = await readSse(await kit.request(hoisted))
  assert.equal(second.stopReason, "end_turn")
  assert.equal(kit.acpSpawns.length, 1, "both layouts belong to one conversation")
}

test("A11: layout_flip stays silent by default", async () => {
  const stderr = captureStderr()
  try {
    await withKit({}, flipLayouts)
  } finally {
    stderr.restore()
  }
  assert.equal(stderr.lines.filter((row) => row.action === "layout_flip").length, 0)
})

test("A11: AGY_BRIDGE_EVENTS=verbose reports layout_flip with a req_id and no content", async () => {
  const stderr = captureStderr()
  try {
    await withKit({ env: { AGY_BRIDGE_EVENTS: "verbose" } }, flipLayouts)
  } finally {
    stderr.restore()
  }
  const flips = stderr.lines.filter((row) => row.action === "layout_flip")
  assert.equal(flips.length, 1)
  assert.equal(flips[0].layout, "hoisted")
  assert.match(flips[0].req_id, /^req_[0-9a-f]{8}$/)
  assert.ok(!JSON.stringify(flips).includes("hello") && !JSON.stringify(flips).includes("Opening hook"))
})

// ------------------------------------------------- #1058 session_new rows

test("#1058: a new agy session says why the live one was not reused, with no content", async () => {
  const stderr = captureStderr()
  try {
    await withKit({}, async (kit) => {
      scriptedAgent(kit)
      const first = baseBody({ metadata: { user_id: "why-new" }, system: "base system",
        messages: [{ role: "user", content: "hello secret" }] })
      const one = await readSse(await kit.request(first))
      const reply = { role: "assistant", content: one.content.map((block) => ({ type: "text", text: block.text })) }
      const second = { ...first, messages: [...first.messages, reply, { role: "user", content: "again" }] }
      const two = await readSse(await kit.request(second))
      assert.equal(kit.acpSpawns.length, 1, "the second turn continues the live session")
      const changed = { ...second, system: "a different system",
        messages: [...second.messages, { role: "assistant", content: two.content.map((block) => ({ type: "text", text: block.text })) },
          { role: "user", content: "third" }] }
      await readSse(await kit.request(changed))
    })
  } finally {
    stderr.restore()
  }
  const rows = stderr.lines.filter((row) => row.action === "session_new")
  assert.deepEqual(rows.map((row) => row.reason), ["no_live", "no_live"],
    "a changed system prompt is a different conversation key, so it starts with no live session")
  assert.notEqual(rows[0].conv, rows[1].conv)
  assert.ok(!JSON.stringify(rows).includes("secret") && !JSON.stringify(rows).includes("system"))
})

// ------------------------------------------------------- A15 pool pressure

test("A15: a full pool evicts the oldest long-detached tool turn instead of answering 503, and that conversation replays later", async () => {
  const env = { AGY_BRIDGE_MAX_PROCS: "2", AGY_BRIDGE_DETACHED_EVICT_MS: "30000" }
  const stderr = captureStderr()
  try {
    await withKit({ env }, async (kit) => {
      scriptedAgent(kit)
      const convA = baseBody({ metadata: { user_id: "pool-a" }, messages: [{ role: "user", content: "TOOL a" }] })
      const convB = baseBody({ metadata: { user_id: "pool-b" }, messages: [{ role: "user", content: "TOOL b" }] })
      const convC = baseBody({ metadata: { user_id: "pool-c" }, messages: [{ role: "user", content: "plain c" }] })
      const pendingA = await pendingToolTurn(kit, convA)
      kit.clock.advance(1_000)
      await pendingToolTurn(kit, convB)

      // Both turns detached only moments ago: the pool is genuinely busy.
      const busy = await errorOf(await kit.request(convC))
      assert.equal(busy.status, 503)
      assert.match(busy.body.error.message, /2 agy processes are running/)

      kit.clock.advance(30_000)
      const served = await readSse(await kit.request(convC))
      assert.equal(served.stopReason, "end_turn", "pool pressure must evict instead of 503")
      const evicted = stderr.lines.filter((row) => row.action === "evicted" && row.reason === "pool_pressure_detached")
      assert.equal(evicted.length, 1)

      // A's client returns with its real result: replayed on a new process.
      const spawnsBefore = kit.acpSpawns.length
      const resumed = await readSse(await kit.request(continueWithToolResults(convA, pendingA, () => "RESULT FOR A")))
      assert.equal(resumed.stopReason, "end_turn")
      assert.equal(kit.acpSpawns.length, spawnsBefore + 1)
      assert.ok(prompts(kit).at(-1).includes("RESULT FOR A"))
      assert.ok(prompts(kit).at(-1).includes("<conversation_history>"))
    })
  } finally {
    stderr.restore()
  }
})

test("A15: a compacted or shortened history of the same conversation forks the detached tool turn instead of 503", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit)
    const opening = { role: "user", content: "start D" }
    const body = baseBody({ metadata: { user_id: "compact" }, messages: [opening] })
    const first = await readSse(await kit.request(body))
    assert.equal(first.stopReason, "end_turn")
    const withTool = { ...body, messages: [opening,
      { role: "assistant", content: [{ type: "text", text: first.content[0].text }] },
      { role: "user", content: "TOOL second" }] }
    await pendingToolTurn(kit, withTool)

    // Compaction rewrote the assistant prefix; same length, different content.
    const compacted = { ...body, messages: [opening,
      { role: "assistant", content: "summary of the earlier work" },
      { role: "user", content: "continue after compaction" }] }
    const forked = await readSse(await kit.request(compacted))
    assert.equal(forked.stopReason, "end_turn")

    // Then a shorter history than the turn's base: still a fork, never a 503.
    await pendingToolTurn(kit, { ...compacted, messages: [...compacted.messages,
      { role: "assistant", content: forked.content.map((block) => ({ type: "text", text: block.text })) },
      { role: "user", content: "TOOL third" }] })
    const shorter = await kit.request({ ...body, messages: [opening, { role: "user", content: "only this" }] })
    assert.equal(shorter.status, 200, await shorter.clone().text())
    assert.equal((await readSse(shorter)).stopReason, "end_turn")
  })
})

// --------------------------------------------------- A16 112 KiB prompt budget

function bytes(text) {
  return Buffer.byteLength(text, "utf8")
}

test("A16: a replay of more than 128 KiB of history stays within 112 KiB and keeps its closing tags", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit)
    const big = (label) => `${label} head ` + "history filler line with some words. ".repeat(500) + ` ${label} tail`
    const messages = [{ role: "user", content: "ANCHOR opening request" }]
    // 20 blocks of about 19 KiB: still about 165 KiB after each is clipped to 8 KiB.
    for (let index = 0; index < 20; index++) {
      messages.push({ role: "assistant", content: [{ type: "text", text: big(`assistant-${index}`) }] })
      messages.push({ role: "user", content: `user follow-up ${index}` })
    }
    messages.push({ role: "assistant", content: [{ type: "text", text: "NEWEST assistant reply" }] })
    messages.push({ role: "user", content: "LATEST INSTRUCTION: summarize everything" })
    const body = baseBody({ metadata: { user_id: "budget" }, messages })
    assert.ok(bytes(JSON.stringify(messages)) > 128 * 1024, "fixture must exceed agy's 128 KiB cut")
    const parsed = await readSse(await kit.request(body))
    assert.equal(parsed.stopReason, "end_turn")
    const prompt = prompts(kit).at(-1)
    assert.ok(bytes(prompt) <= 112 * 1024, `initial prompt is ${bytes(prompt)} bytes`)
    assert.ok(prompt.includes("</conversation_history>\n\n<current_turn>\nLATEST INSTRUCTION: summarize everything\n</current_turn>"))
    assert.ok(prompt.endsWith("</current_turn>"))
    assert.ok(prompt.includes("ANCHOR opening request"), "the anchor message is kept")
    assert.ok(prompt.includes("NEWEST assistant reply"), "the newest history is kept")
    assert.ok(prompt.includes("[... earlier conversation history omitted to fit ACP 112 KiB prompt budget ...]"))
    assert.ok(!prompt.includes("belongs to an earlier turn that is already done"), "non-loop replay adds no loop handoff note")
    assert.ok(prompt.includes("bytes of this history block omitted"), "oversized history blocks keep only head and tail")
    assert.ok(prompt.includes('Never output "[tool call ...]" text'))
  })
})

test("A16: an oversized current tool result keeps its head and tail and the frame stays intact", async () => {
  await withKit({ env: { AGY_BRIDGE_MAX_PROMPT_BYTES: String(64 * 1024) } }, async (kit) => {
    scriptedAgent(kit, { "RESULT HEAD": "handled" })
    const huge = "RESULT HEAD " + "x".repeat(200 * 1024) + " RESULT TAIL"
    const body = baseBody({ metadata: { user_id: "budget-current" }, messages: [
      { role: "user", content: "TOOL read it" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_big", name: "Read", input: { path: "/big" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_big", content: huge }] },
    ] })
    const parsed = await readSse(await kit.request(body))
    assert.equal(parsed.stopReason, "end_turn")
    const prompt = prompts(kit).at(-1)
    assert.ok(bytes(prompt) <= 64 * 1024, `initial prompt is ${bytes(prompt)} bytes`)
    assert.ok(prompt.includes("RESULT HEAD") && prompt.includes("RESULT TAIL"))
    assert.ok(prompt.includes("</conversation_history>") && prompt.endsWith("\n</current_turn>"))
  })
})

test("A16: a short replay is rendered unchanged", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit)
    const body = baseBody({ metadata: { user_id: "budget-small" }, messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ] })
    await readSse(await kit.request(body))
    const prompt = prompts(kit).at(-1)
    assert.ok(prompt.includes("<conversation_history>\nHuman: first\nAssistant: reply\n"))
    assert.ok(!prompt.includes("omitted"))
    await tick()
    await sleep(0)
  })
})

test("A16: mid tool loop, a trimmed replay keeps the user prompt that started the loop (#1053)", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit)
    const big = (label) => `${label} head ` + "tool output line with some words. ".repeat(560) + ` ${label} tail`
    const messages = [
      { role: "user", content: "ANCHOR opening request" },
      { role: "assistant", content: "ANCHOR reply" },
      { role: "user", content: "TASK START: rename parseConfig to loadConfig everywhere" },
    ]
    // 16 tool steps of about 19 KiB each: about 130 KiB even after each result is clipped to 8 KiB.
    for (let index = 0; index < 16; index++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `toolu_step${index}`, name: "Read", input: { path: `/repo/${index}.txt` } }] })
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_step${index}`, content: big(`step-${index}`) }] })
    }
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "toolu_last", name: "Read", input: { path: "/repo/last.txt" } }] })
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_last", content: "LAST RESULT" }] })
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "budget-task" }, messages })))
    assert.equal(parsed.stopReason, "end_turn")
    const prompt = prompts(kit).at(-1)
    assert.ok(bytes(prompt) <= 112 * 1024, `initial prompt is ${bytes(prompt)} bytes`)
    assert.ok(prompt.includes("ANCHOR opening request"), "the anchor message is kept")
    assert.ok(prompt.includes("Human: TASK START: rename parseConfig to loadConfig everywhere"), "the loop's prompt is kept")
    assert.ok(prompt.includes("step-15 tail") && prompt.includes("LAST RESULT"), "the newest steps are kept")
    assert.ok(!prompt.includes("step-0 head"), "the oldest step gave way")
    const note = "[... earlier conversation history omitted to fit ACP 112 KiB prompt budget ...]"
    assert.equal(prompt.split(note).length - 1, 2, "one note before the pinned prompt, one after it")
    assert.ok(prompt.indexOf("ANCHOR opening request") < prompt.indexOf("TASK START") &&
      prompt.indexOf("TASK START") < prompt.indexOf("step-15 tail"), "the kept history stays in order")
  })
})

test("A16: a replay that fits the budget keeps every big history block whole (#1055)", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit)
    // One 20 KiB tool result and one 20 KiB tool-call input: over the 12 KiB
    // block clip, while the whole replay is far under 112 KiB.
    const big = (label) => `${label} head ` + "file line with some words. ".repeat(380) + ` ${label} MIDDLE ` +
      "file line with some words. ".repeat(380) + ` ${label} tail`
    const messages = [
      { role: "user", content: "TOOL read and write it" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { path: "/repo/a.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read", content: big("result") }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_write", name: "Write", input: { path: "/repo/b.txt", content: big("input") } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_write", content: "written" }] },
      { role: "assistant", content: "done" },
      { role: "user", content: "LATEST: and now?" },
    ]
    assert.ok(bytes(JSON.stringify(messages)) < 64 * 1024, "fixture must fit the budget")
    await readSse(await kit.request(baseBody({ metadata: { user_id: "budget-fits" }, messages })))
    const prompt = prompts(kit).at(-1)
    assert.ok(prompt.includes("result MIDDLE") && prompt.includes("input MIDDLE"), "big blocks are kept whole")
    assert.ok(!prompt.includes("omitted"), "nothing is clipped or dropped")
    assert.ok(!prompt.includes("truncated_arguments"))
  })
})

test("A16: mid tool loop, the pinned prompt is the user's task, not a Claude Code note after it (#1055)", async () => {
  for (const meta of [
    "<system-reminder>\nThe date has changed. Today's date is now 2026-11-13.\n</system-reminder>",
    [{ type: "text", text: "[Request interrupted by user for tool use]" }],
    "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages.</local-command-caveat>\n<local-command-stdout>Set model to gemini</local-command-stdout>",
  ]) {
    await withKit({}, async (kit) => {
      scriptedAgent(kit)
      const big = (label) => `${label} head ` + "tool output line with some words. ".repeat(560) + ` ${label} tail`
      const messages = [
        { role: "user", content: "ANCHOR opening request" },
        { role: "assistant", content: "ANCHOR reply" },
        { role: "user", content: [{ type: "text", text: "<system-reminder>context</system-reminder>" }, { type: "text", text: "TASK START: rename parseConfig to loadConfig everywhere" }] },
      ]
      for (let index = 0; index < 16; index++) {
        messages.push({ role: "assistant", content: [{ type: "tool_use", id: `toolu_step${index}`, name: "Read", input: { path: `/repo/${index}.txt` } }] })
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_step${index}`, content: big(`step-${index}`) }] })
        if (index === 1) messages.push({ role: "user", content: meta })
      }
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: "toolu_last", name: "Read", input: { path: "/repo/last.txt" } }] })
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_last", content: "LAST RESULT" }] })
      const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "budget-task-meta" }, messages })))
      assert.equal(parsed.stopReason, "end_turn")
      const prompt = prompts(kit).at(-1)
      assert.ok(bytes(prompt) <= 112 * 1024, `initial prompt is ${bytes(prompt)} bytes`)
      assert.ok(prompt.includes("TASK START: rename parseConfig to loadConfig everywhere"), `the loop's prompt is kept past ${JSON.stringify(meta).slice(0, 40)}`)
      const noteText = typeof meta === "string" ? meta : meta[0].text
      assert.ok(!prompt.includes(noteText), "the note is not pinned as the loop's task")
      assert.ok(prompt.includes("step-15 tail") && prompt.includes("LAST RESULT"), "the newest steps are kept")
    })
  }
})

test("A16: mid tool loop, DeepSeek Harness runtime metadata after a tool result does not displace the user's task", async () => {
  const metaSamples = [
    "Time sampled while preparing turn 19, step 1: 2026-11-13T15:24:33+08:00[Asia/Shanghai]\nBrowser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.\nElapsed since the preceding model-visible message: 12m 17s.",
    "Time sampled while preparing turn 19, step 5: 2026-11-13T15:35:00+08:00[Asia/Shanghai]\nElapsed since the preceding step context: 10m 2s.",
    "Time sampled while preparing turn 1, step 1: 2026-11-13T08:00:00Z",
    "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\ncwd: /repo\nmode: default",
    "Current runtime context: none. Earlier runtime-context snapshots no longer apply.",
    "You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.",
    "Repeated tool call detected:\n- tool: Read\n- consecutive_calls: 5\n- arguments: {\"path\":\"a\"}\nThe repeated calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.",
    "The user switched this session to plan mode.",
    "The user switched this session back to the default mode.",
  ]
  const big = (label) => `${label} head ` + "tool output line with some words. ".repeat(560) + ` ${label} tail`
  for (const meta of metaSamples) {
    await withKit({}, async (kit) => {
      scriptedAgent(kit)
      const messages = [
        { role: "user", content: "ANCHOR opening request" },
        { role: "assistant", content: "ANCHOR reply" },
        { role: "user", content: "TASK START: rename parseConfig to loadConfig everywhere" },
      ]
      for (let index = 0; index < 16; index++) {
        messages.push({ role: "assistant", content: [{ type: "tool_use", id: `toolu_dsh_meta_${index}`, name: "Read", input: { path: `/repo/${index}.txt` } }] })
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_dsh_meta_${index}`, content: big(`step-${index}`) }] })
        if (index === 1) messages.push({ role: "user", content: meta })
      }
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: "toolu_dsh_meta_last", name: "Read", input: { path: "/repo/last.txt" } }] })
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_dsh_meta_last", content: "LAST RESULT" }] })
      const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "dsh-meta" }, messages })))
      assert.equal(parsed.stopReason, "end_turn")
      const prompt = prompts(kit).at(-1)
      assert.ok(bytes(prompt) <= 112 * 1024, `initial prompt is ${bytes(prompt)} bytes`)
      assert.ok(prompt.includes("TASK START: rename parseConfig to loadConfig everywhere"), `kept past ${meta.slice(0, 40)}`)
      assert.ok(!prompt.includes(meta), "the note is not pinned as the loop's task")
      assert.ok(prompt.includes("LAST RESULT"))
    })
  }
})

test("A16: mid tool loop with an opening handoff note and DeepSeek Harness companions keeps the whole user turn and marks the opening turn done", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit)
    const big = (label) => `${label} head ` + "tool output line with some words. ".repeat(560) + ` ${label} tail`
    const handoff = "[Handoff · part 5]\n" + "Morning summary line. ".repeat(700) +
      "\n## Progress\n### In progress\n- Earlier task: draft the release summary\n\nYou were in the middle of a turn. Go on with it now from where you stopped."
    const realPrompt = "REAL TASK: fix the race condition in the session router and summarize what changed"
    const skillCompanion = '<skill_content name="router">\n# Router conventions\nKeep existing exports.\n</skill_content>'
    const timeCompanion = "Time sampled while preparing turn 19, step 1: 2026-11-13T15:24:33+08:00[Asia/Shanghai]\nBrowser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.\nElapsed since the preceding model-visible message: 12m 17s."
    const messages = [
      { role: "user", content: handoff },
      { role: "assistant", content: "Turn 1 reply: release summary drafted." },
      { role: "user", content: "Follow-up question from midday" },
      { role: "assistant", content: "Turn 2 reply: midday question answered." },
      { role: "user", content: realPrompt },
      { role: "user", content: skillCompanion },
      { role: "user", content: timeCompanion },
    ]
    const midLoopMeta = [
      "Time sampled while preparing turn 19, step 5: 2026-11-13T15:35:00+08:00[Asia/Shanghai]\nElapsed since the preceding step context: 10m 2s.",
      "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\ncwd: /repo",
      "The user switched this session back to the default mode.",
      "Repeated tool call detected:\n- tool: Read\n- consecutive_calls: 5\n- arguments: {\"path\":\"/repo/a.txt\"}\nThe repeated calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.",
    ]
    for (let index = 0; index < 16; index++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `toolu_dsh_${index}`, name: "Read", input: { path: `/repo/${index}.txt` } }] })
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_dsh_${index}`, content: big(`step-${index}`) }] })
      if (index < midLoopMeta.length) messages.push({ role: "user", content: midLoopMeta[index] })
    }
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "toolu_dsh_last", name: "Read", input: { path: "/repo/last.txt" } }] })
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_dsh_last", content: "LAST RESULT" }] })
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "dsh-handoff" }, messages })))
    assert.equal(parsed.stopReason, "end_turn")
    const prompt = prompts(kit).at(-1)
    assert.ok(bytes(prompt) <= 112 * 1024, `initial prompt is ${bytes(prompt)} bytes`)
    assert.ok(prompt.includes("[Handoff · part 5]"), "opening anchor stays present")
    assert.ok(prompt.includes(`Human: ${realPrompt}`), "real Turn 19 user prompt stays pinned")
    assert.ok(prompt.includes("Router conventions"), "skill companion in the same turn stays attached")
    const between = prompt.slice(prompt.indexOf(realPrompt), prompt.indexOf("Router conventions"))
    assert.ok(!between.includes("omitted"), "no omission note is inserted inside a kept user turn")
    assert.ok(prompt.includes("The opening message above, and any resume note in it, belongs to an earlier turn that is already done."),
      "omitted history disambiguates prior handoff note from active loop")
    assert.ok(prompt.includes("LAST RESULT"), "current turn result stays intact")
  })
})

test("A16: mid tool loop keeps a multi-message user turn whole without an omission marker inside it", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit)
    const big = (label) => `${label} head ` + "tool output line with some words. ".repeat(560) + ` ${label} tail`
    const messages = [
      { role: "user", content: "ANCHOR opening request" },
      { role: "assistant", content: "ANCHOR reply" },
      { role: "user", content: "USER PART 1: inspect group handler" },
      { role: "user", content: "Time sampled while preparing turn 2, step 1: 2026-11-13T15:24:33Z" },
      { role: "user", content: "USER PART 2: fix the null check and report back" },
    ]
    for (let index = 0; index < 16; index++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `toolu_multi_${index}`, name: "Read", input: { path: `/repo/${index}.txt` } }] })
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_multi_${index}`, content: big(`multi-${index}`) }] })
    }
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "toolu_multi_last", name: "Read", input: { path: "/repo/last.txt" } }] })
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_multi_last", content: "LAST RESULT" }] })
    await readSse(await kit.request(baseBody({ metadata: { user_id: "multi-user" }, messages })))
    const prompt = prompts(kit).at(-1)
    assert.ok(bytes(prompt) <= 112 * 1024, `initial prompt is ${bytes(prompt)} bytes`)
    assert.ok(prompt.includes("Human: USER PART 1: inspect group handler"))
    assert.ok(prompt.includes("Human: USER PART 2: fix the null check and report back"))
    const between = prompt.slice(prompt.indexOf("USER PART 1"), prompt.indexOf("USER PART 2"))
    assert.ok(between.includes("Time sampled while preparing turn 2, step 1"))
    assert.ok(!between.includes("omitted"), "meta message between user parts leaves the run contiguous")
  })
})

test("A16: mid tool loop keeps both the loop-opening prompt and a mid-loop user steer", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit)
    const big = (label) => `${label} head ` + "tool output line with some words. ".repeat(560) + ` ${label} tail`
    const messages = [
      { role: "user", content: "ANCHOR opening request" },
      { role: "assistant", content: "ANCHOR reply" },
      { role: "user", content: "LOOP OPENER: refactor group router" },
    ]
    for (let index = 0; index < 4; index++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `toolu_steer_a_${index}`, name: "Read", input: { path: `/repo/a${index}.txt` } }] })
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_steer_a_${index}`, content: big(`sa-${index}`) }] })
    }
    messages.push({ role: "user", content: "MID LOOP STEER: keep backward-compatible exports" })
    messages.push({ role: "user", content: "Time sampled while preparing turn 2, step 5: 2026-11-13T15:35:00Z" })
    for (let index = 0; index < 14; index++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `toolu_steer_b_${index}`, name: "Read", input: { path: `/repo/b${index}.txt` } }] })
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_steer_b_${index}`, content: big(`sb-${index}`) }] })
    }
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "toolu_steer_last", name: "Read", input: { path: "/repo/last.txt" } }] })
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_steer_last", content: "LAST RESULT" }] })
    await readSse(await kit.request(baseBody({ metadata: { user_id: "loop-steer" }, messages })))
    const prompt = prompts(kit).at(-1)
    assert.ok(bytes(prompt) <= 112 * 1024, `initial prompt is ${bytes(prompt)} bytes`)
    assert.ok(prompt.includes("Human: LOOP OPENER: refactor group router"), "loop opener is kept")
    assert.ok(prompt.includes("Human: MID LOOP STEER: keep backward-compatible exports"), "mid-loop steer is kept")
    assert.ok(prompt.indexOf("LOOP OPENER") < prompt.indexOf("MID LOOP STEER"))
  })
})

test("A16: turn-1 oversized tool loop does not mark its own opening handoff as already done", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit)
    const big = (label) => `${label} head ` + "tool output line with some words. ".repeat(560) + ` ${label} tail`
    const messages = [
      {
        role: "user",
        content: "[Handoff · part 5]\nCarry on this task.\n\nYou were in the middle of a turn. Go on with it now from where you stopped.",
      },
      { role: "user", content: "Time sampled while preparing turn 1, step 1: 2026-11-13T08:19:00Z" },
    ]
    for (let index = 0; index < 16; index++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `toolu_t1_${index}`, name: "Read", input: { path: `/repo/${index}.txt` } }] })
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_t1_${index}`, content: big(`t1-${index}`) }] })
    }
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "toolu_t1_last", name: "Read", input: { path: "/repo/last.txt" } }] })
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_t1_last", content: "LAST RESULT" }] })
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "turn1-handoff" }, messages })))
    assert.equal(parsed.stopReason, "end_turn")
    const prompt = prompts(kit).at(-1)
    assert.ok(bytes(prompt) <= 112 * 1024, `initial prompt is ${bytes(prompt)} bytes`)
    assert.ok(prompt.includes("[Handoff · part 5]"), "opening handoff stays pinned")
    assert.ok(prompt.includes("LAST RESULT"), "current result stays present")
    assert.ok(!prompt.includes("already done"), "must not tell the model turn-1 opening handoff is already done")
  })
})

test("A16: a tool loop opened by a meta-only notification neither pins a prior turn's prompt nor marks an active Human request", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit)
    const big = (label) => `${label} head ` + "tool output line with some words. ".repeat(560) + ` ${label} tail`
    const messages = [
      { role: "user", content: "ANCHOR opening request" },
      { role: "assistant", content: "ANCHOR reply" },
      { role: "user", content: "OLD TASK 2 (already done)" },
      { role: "assistant", content: "done 2" },
      { role: "user", content: "<task-notification><status>completed</status><summary>worker finished</summary></task-notification>" },
    ]
    for (let index = 0; index < 16; index++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `toolu_meta_loop_${index}`, name: "Read", input: { path: `/repo/${index}.txt` } }] })
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_meta_loop_${index}`, content: big(`ml-${index}`) }] })
    }
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "toolu_meta_loop_last", name: "Read", input: { path: "/repo/last.txt" } }] })
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_meta_loop_last", content: "LAST RESULT" }] })
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "meta-opened-loop" }, messages })))
    assert.equal(parsed.stopReason, "end_turn")
    const prompt = prompts(kit).at(-1)
    assert.ok(bytes(prompt) <= 112 * 1024, `initial prompt is ${bytes(prompt)} bytes`)
    assert.ok(!prompt.includes("OLD TASK 2 (already done)"), "must not pin an already-completed earlier turn")
    assert.ok(!prompt.includes("belongs to an earlier turn that is already done"),
      "must not emit opening-done note when no active-loop user task is pinned")
    assert.ok(prompt.includes("LAST RESULT"))
  })
})

test("A16: when a tight budget cannot fit the loop-opening prompt, the opening-done note is omitted", async () => {
  await withKit({ env: { AGY_BRIDGE_MAX_PROMPT_BYTES: String(8 * 1024) } }, async (kit) => {
    scriptedAgent(kit)
    const hugeOpener = "HUGE OPENER " + "x".repeat(8 * 1024)
    const messages = [
      { role: "user", content: "ANCHOR opening request" },
      { role: "assistant", content: "ANCHOR reply" },
      { role: "user", content: hugeOpener },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_tight_0", name: "Read", input: { path: "/repo/0.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_tight_0", content: "step 0 output" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_tight_last", name: "Read", input: { path: "/repo/last.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_tight_last", content: "y".repeat(4 * 1024) + " LAST RESULT" }] },
    ]
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "tight-opener" }, messages })))
    assert.equal(parsed.stopReason, "end_turn")
    const prompt = prompts(kit).at(-1)
    assert.ok(bytes(prompt) <= 8 * 1024, `initial prompt is ${bytes(prompt)} bytes`)
    assert.ok(prompt.includes("ANCHOR opening request"), "anchor fits tight room")
    assert.ok(!prompt.includes("HUGE OPENER"), "oversized opener did not fit")
    assert.ok(!prompt.includes("belongs to an earlier turn that is already done"),
      "must not emit opening-done note when opener did not fit")
    assert.ok(prompt.includes("LAST RESULT"))
  })
})

test("A16: under a tight budget, a mid-loop user steer beats an opening meta companion", async () => {
  await withKit({ env: { AGY_BRIDGE_MAX_PROMPT_BYTES: String(8 * 1024) } }, async (kit) => {
    scriptedAgent(kit)
    const bigReminder = "<system-reminder>" + "r".repeat(4200) + "</system-reminder>"
    const steer = "MID LOOP STEER: keep backward-compatible exports " + "s".repeat(900)
    const messages = [
      { role: "user", content: "ANCHOR opening request" },
      { role: "assistant", content: "ANCHOR reply" },
      { role: "user", content: "LOOP OPENER: refactor group router" },
      { role: "user", content: bigReminder },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_ts_0", name: "Read", input: { path: "/repo/0.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ts_0", content: "z".repeat(4000) }] },
      { role: "user", content: steer },
      { role: "user", content: "Time sampled while preparing turn 2, step 2: 2026-11-13T15:35:00Z" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_ts_last", name: "Read", input: { path: "/repo/last.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_ts_last", content: "y".repeat(3000) + " LAST RESULT" }] },
    ]
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "tight-steer" }, messages })))
    assert.equal(parsed.stopReason, "end_turn")
    const prompt = prompts(kit).at(-1)
    assert.ok(bytes(prompt) <= 8 * 1024, `initial prompt is ${bytes(prompt)} bytes`)
    assert.ok(prompt.includes("Human: LOOP OPENER: refactor group router"), "loop opener is kept")
    assert.ok(prompt.includes("Human: MID LOOP STEER: keep backward-compatible exports"), "mid-loop steer beats opening reminder")
    assert.ok(!prompt.includes(bigReminder), "oversized opening reminder gave way to fit the steer")
    assert.ok(prompt.includes("LAST RESULT"))
  })
})

// #896: agy reports the run to its vendor unless it is told not to; the flag
// is passed only to an agy whose own acp --help lists it.
const TELEMETRY_HELP = "Usage of acp:\n  --disable-telemetry\n    \tdisable telemetry (default false)\n"

test("#896: an agy whose acp --help lists --disable-telemetry starts with telemetry off", async () => {
  await withKit({ acpHelp: TELEMETRY_HELP }, async (kit) => {
    scriptedAgent(kit)
    const reply = await readSse(await kit.request(baseBody({ metadata: { user_id: "telemetry-listed" },
      messages: [{ role: "user", content: "hello" }] })))
    assert.equal(reply.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1)
    assert.ok(kit.acpSpawns[0].args.includes("--disable-telemetry"), kit.acpSpawns[0].args.join(" "))
  })
})

test("#896: an agy without the flag is never given it, and AGY_BRIDGE_TELEMETRY=1 keeps agy's own default", async () => {
  for (const options of [{}, { acpHelp: TELEMETRY_HELP, env: { AGY_BRIDGE_TELEMETRY: "1" } }]) {
    await withKit(options, async (kit) => {
      scriptedAgent(kit)
      const reply = await readSse(await kit.request(baseBody({ metadata: { user_id: "telemetry-unlisted" },
        messages: [{ role: "user", content: "hello" }] })))
      assert.equal(reply.stopReason, "end_turn")
      assert.ok(!kit.acpSpawns[0].args.includes("--disable-telemetry"), kit.acpSpawns[0].args.join(" "))
    })
  }
})

// ----------------------------------------------- agy's error marker (#1052)

function markerAgent(kit, chunks) {
  kit.defaultPrompt = async (agent) => {
    for (const chunk of chunks) await agent.text(chunk)
    return { stopReason: "end_turn" }
  }
}

function replyText(parsed) {
  return parsed.content.filter((block) => block.type === "text").map((block) => block.text).join("")
}

function sseError(text) {
  const line = text.split("\n").findLast((item) => item.startsWith("data:"))
  return JSON.parse(line.slice(5)).error
}

test("#1052: the model quoting agy's error marker mid-reply does not end a healthy turn", async () => {
  for (const chunks of [
    ["agy prints `⚠ Agent execution terminated due to error.` when a turn fails;", " the real cause is in its log."],
    ["The log ends with:\n\n```\n⚠ Agent execution terminated due to error.\n", "```\n\nThat line comes from agy."],
    ["Quoted: \n⚠ Agent execution ", "terminated due to error.\n", "and the reply goes on."],
  ]) {
    await withKit({}, async (kit) => {
      markerAgent(kit, chunks)
      const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "marker-quoted" },
        messages: [{ role: "user", content: "why did my agy turn stop?" }] })))
      assert.equal(parsed.error, null)
      assert.equal(parsed.stopReason, "end_turn")
      assert.equal(replyText(parsed), chunks.join(""))
    })
  }
})

test("#1052: agy's own marker at the end of the prompt still fails the turn", async () => {
  for (const chunks of [
    ["partial before failure", "\n⚠ Agent execution terminated due to error.\n"],
    ["partial before failure\n⚠ Agent execution ", "terminated due to error.", "\n"],
  ]) {
    await withKit({}, async (kit) => {
      markerAgent(kit, chunks)
      const response = await kit.request(baseBody({ metadata: { user_id: "marker-real" },
        messages: [{ role: "user", content: "hello" }] }))
      const text = await response.text()
      assert.match(text, /agy stopped the turn because of an error/)
      assert.ok(!text.includes("Agent execution terminated"), "the marker never reaches the client")
      assert.ok(text.includes("partial before failure"), "text before the marker is kept")
    })
  }
})

test("#1124: agy's retry banner after an empty first call never reaches the client", async () => {
  // The reporter's turn: thinking, agy's banner, thinking again, then the retry's text.
  const banner = "\n⚠ Model produced invalid output."
  for (const [steps, want] of [
    [[["thought", "stay quiet"], ["text", banner], ["thought", "suggest one"], ["text", "梳理一下事件完整时间线"]], "梳理一下事件完整时间线"],
    [[["text", banner + "\n"], ["text", "the retry's answer"]], "the retry's answer"],
    [[["text", "\n⚠ Model produced "], ["text", "invalid output."], ["text", "\nretry"]], "retry"],
    [[["text", banner]], ""],
  ]) {
    await withKit({}, async (kit) => {
      kit.defaultPrompt = async (agent) => {
        for (const [kind, text] of steps) await agent[kind](text)
        return { stopReason: "end_turn" }
      }
      const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "retry-banner" },
        messages: [{ role: "user", content: "suggest" }] })))
      assert.equal(parsed.error, null)
      assert.equal(parsed.stopReason, "end_turn")
      assert.equal(replyText(parsed), want)
    })
  }
})

test("#1124: the model quoting the retry banner mid-line keeps it", async () => {
  const chunks = ["agy printed `⚠ Model produced invalid output.` and", " then retried."]
  await withKit({}, async (kit) => {
    markerAgent(kit, chunks)
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "retry-quoted" },
      messages: [{ role: "user", content: "what did agy print?" }] })))
    assert.equal(parsed.error, null)
    assert.equal(replyText(parsed), chunks.join(""))
  })
})

// #892: agy's output cap, as it reaches the reply: agy's three-line notice and
// then the model's answer, still in the same turn.
const CAP_HEAD = "\n⚠ Your previous response was cut off because it exceeded the output token limit\n"
const CAP_TAIL = "Please continue from where you left off, keeping your response shorter\n"
const CAP_RETRIES = "Retries remaining: 3\n"
const CAP_NOTICE = CAP_HEAD + CAP_TAIL + CAP_RETRIES

test("#892: agy's output-cap notice never reaches the client", async () => {
  const answer = "the rest of the answer"
  for (const [chunks, want] of [
    [[CAP_NOTICE + answer], answer],
    [[CAP_NOTICE, answer], answer],
    [[CAP_HEAD.slice(0, 20), CAP_HEAD.slice(20) + CAP_TAIL, CAP_RETRIES, answer], answer],
    [[CAP_NOTICE.slice(0, 150), CAP_NOTICE.slice(150) + answer], answer],
    [[CAP_HEAD, answer], answer],
    [[CAP_NOTICE], ""],
    [[CAP_HEAD + answer], answer],
  ]) {
    await withKit({}, async (kit) => {
      markerAgent(kit, chunks)
      const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "cap-notice" },
        messages: [{ role: "user", content: "write the long answer" }] })))
      assert.equal(parsed.error, null)
      assert.equal(parsed.stopReason, "end_turn")
      assert.equal(replyText(parsed), want)
    })
  }
})

test("#892: the model quoting the output-cap notice mid-line keeps it", async () => {
  const chunks = ["agy prints `⚠ Your previous response was cut off because it exceeded the output token limit`", " when it retries."]
  await withKit({}, async (kit) => {
    markerAgent(kit, chunks)
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "cap-quoted" },
      messages: [{ role: "user", content: "what did agy print?" }] })))
    assert.equal(parsed.error, null)
    assert.equal(replyText(parsed), chunks.join(""))
  })
})

// #1136: agy 1.5.8's own words, byte for byte from the reporter's Codex rollout.
const EOF_ATTEMPT = (n) => `\n⚠ API error (attempt ${n}): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": EOF`
const NETWORK = "\n⚠ There was a network issue connecting to the server, please try again.\n"

test("#1136: agy's attempt banners before a retry that works never reach the client", async () => {
  const three = EOF_ATTEMPT(1) + "\n" + EOF_ATTEMPT(2) + "\n" + EOF_ATTEMPT(3)
  const answer = "已拿到两张 `3420×1966` 全窗口无损截图"
  for (const steps of [
    // The reporter's turn A: the last banner has no newline before the thought.
    [["text", three], ["thought", "look again"], ["text", "\n" + answer]],
    [["text", EOF_ATTEMPT(1).slice(0, 30)], ["text", EOF_ATTEMPT(1).slice(30)], ["text", "\n" + answer]],
    [["text", "\n⚠ API err"], ["text", "or (attempt 2): EOF\n"], ["text", answer]],
  ]) {
    await withKit({}, async (kit) => {
      kit.defaultPrompt = async (agent) => {
        for (const [kind, text] of steps) await agent[kind](text)
        return { stopReason: "end_turn" }
      }
      const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "attempt-banner" },
        messages: [{ role: "user", content: "screenshot" }] })))
      assert.equal(parsed.error, null)
      assert.equal(parsed.stopReason, "end_turn")
      assert.equal(replyText(parsed), answer)
    })
  }
})

test("#1136, #1151: agy's network, credit and 429 endings fail the turn", async () => {
  for (const [chunks, want, kind] of [
    // Turn B: one attempt, then agy gives up. The attempt's detail names why.
    [[EOF_ATTEMPT(1) + "\n" + NETWORK], /EOF/, "api_error"],
    // Turn C: the ending alone, split mid-marker.
    [[NETWORK.slice(0, 20), NETWORK.slice(20)], /network issue connecting/, "api_error"],
    [["partial\n⚠ Your AI credits ", "balance is too low to continue.\n"], /credits balance is too low/, "rate_limit_error"],
    // #1151: agy 1.5.9's ending after every retry got 429, split mid-marker.
    [["partial\n⚠ RESOURCE_EXHAU", "STED (code 429): Resource has been exhausted (e.g. check quota).\n"], /quota or rate limit reached: RESOURCE_EXHAUSTED \(code 429\)/, "rate_limit_error"],
    [["\n⚠ RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).\n"], /quota or rate limit reached/, "rate_limit_error"],
  ]) {
    await withKit({}, async (kit) => {
      markerAgent(kit, chunks)
      const response = await kit.request(baseBody({ metadata: { user_id: "network-end" },
        messages: [{ role: "user", content: "hello" }] }))
      const text = await response.text()
      assert.match(text, want)
      assert.ok(text.includes(kind), `${kind} in ${text.slice(-400)}`)
      assert.ok(!text.includes("⚠"), "no banner reaches the client")
    })
  }
})

// #1201: agy 1.5.9 passes a banned account's Google 403 through as the reply.
const BANNED = "\n⚠ PERMISSION_DENIED (code 403): This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.\n"

test("#1201: agy's banned-account ending fails the stream as no-retry permission error", async () => {
  await withKit({}, async (kit) => {
    markerAgent(kit, [BANNED.slice(0, 63), BANNED.slice(63)])
    const response = await kit.request(baseBody({ metadata: { user_id: "banned-end" },
      messages: [{ role: "user", content: "hello" }] }))
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("x-should-retry"), null)
    const error = sseError(text)
    assert.equal(error.type, "permission_error")
    assert.equal(error.status, 403)
    assert.equal(error.noRetry, true)
    assert.match(error.message, /disabled this account's access[\s\S]*Terms of Service[\s\S]*appeal/)
    assert.ok(!text.includes("⚠"), "no banner reaches the client")
  })
})

test("#1201: agy's banned-account ending fails a non-stream request as a no-retry HTTP 403", async () => {
  await withKit({}, async (kit) => {
    markerAgent(kit, [BANNED.slice(0, 63), BANNED.slice(63)])
    const response = await kit.request(baseBody({ metadata: { user_id: "banned-json" },
      messages: [{ role: "user", content: "hello" }], stream: false }))
    const body = await response.json()
    assert.equal(response.status, 403)
    assert.equal(response.headers.get("x-should-retry"), "false")
    assert.equal(body.error.type, "permission_error")
    assert.match(body.error.message, /disabled this account's access[\s\S]*Terms of Service[\s\S]*appeal/)
    assert.ok(!JSON.stringify(body).includes("⚠"), "no banner reaches the client")
  })
})

test("#1201: the model quoting the banned-account ending with more text after keeps it", async () => {
  const chunks = [BANNED.slice(0, 40), BANNED.slice(40) + "That line is agy's, not mine."]
  await withKit({}, async (kit) => {
    markerAgent(kit, chunks)
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "banned-quoted" },
      messages: [{ role: "user", content: "what did agy print?" }] })))
    assert.equal(parsed.error, null)
    assert.equal(parsed.stopReason, "end_turn")
    assert.equal(replyText(parsed), chunks.join(""))
  })
})

// kidgpt on X (11-16, Windows 11, Claude Code in VS Code, gemini-3.8-flash):
// Google's 403 VALIDATION_REQUIRED on a model call reaches agy 1.5.9 as
// "Verification Required" (CustomUserErrorMessageFromHTTPError), which it
// ends the reply with, and the client got that bare line as the answer.
const VERIFY = "\n⚠ Verification Required\n"

function agyLogOf(kit) {
  const args = kit.acpSpawns.at(-1).args
  return args[args.indexOf("--log-file") + 1]
}

test("agy's Verification Required ending fails the stream as a no-retry 403 that says how to verify", async () => {
  await withKit({}, async (kit) => {
    markerAgent(kit, [VERIFY.slice(0, 9), VERIFY.slice(9)])
    const response = await kit.request(baseBody({ metadata: { user_id: "verify-end" },
      messages: [{ role: "user", content: "hello" }] }))
    const text = await response.text()
    const error = sseError(text)
    assert.equal(error.type, "permission_error")
    assert.equal(error.status, 403)
    assert.equal(error.noRetry, true)
    assert.match(error.message, /this Google account needs to be verified: open the Antigravity app, or run `agy` in a terminal/)
    assert.ok(!text.includes("⚠"), "no banner reaches the client")
  })
})

test("agy's Verification Required ending carries the link agy logged, as a non-stream HTTP 403", async () => {
  const link = "https://accounts.google.com/signin/continue?sarp=1&scc=1&plt=AKgnsbv"
  await withKit({}, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      fs.appendFileSync(agyLogOf(kit), `E1116 21:03:11.120000 6120 errorreport.go:224] agent executor error: generating and executing: PERMISSION_DENIED (code 403): Verify your account to continue. validation_url: ${link.replace(/&/g, "\\u0026")}\n`)
      await agent.text(VERIFY)
      return { stopReason: "end_turn" }
    }
    const response = await kit.request(baseBody({ metadata: { user_id: "verify-json" },
      messages: [{ role: "user", content: "hello" }], stream: false }))
    const body = await response.json()
    assert.equal(response.status, 403)
    assert.equal(response.headers.get("x-should-retry"), "false")
    assert.equal(body.error.type, "permission_error")
    assert.ok(body.error.message.includes(`this Google account needs to be verified: open ${link} in a browser`), body.error.message)
  })
})

test("the model quoting the Verification Required ending with more text after keeps it", async () => {
  const chunks = ["agy said\n⚠ Verification", " Required\nThat line is agy's, not mine."]
  await withKit({}, async (kit) => {
    markerAgent(kit, chunks)
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "verify-quoted" },
      messages: [{ role: "user", content: "what did agy print?" }] })))
    assert.equal(parsed.error, null)
    assert.equal(replyText(parsed), chunks.join(""))
  })
})

// @Airan_FS on X (11-17): an account out of its own quota got agy's
// ending as the whole reply, and magpie never asked the next account. The
// line is Google's words with the time until the quota is back.
const QUOTA_LINE = "⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h18m40s."
const QUOTA = "\n" + QUOTA_LINE + "\n"

test("agy's Individual quota reached ending fails the turn as a rate limit with its reset", async () => {
  for (const chunks of [
    [QUOTA],
    [QUOTA.slice(0, 12), QUOTA.slice(12, 40), QUOTA.slice(40)],
    [QUOTA_LINE],
    ["\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 6d2h."],
  ]) {
    await withKit({}, async (kit) => {
      markerAgent(kit, chunks)
      const response = await kit.request(baseBody({ metadata: { user_id: "quota-end" },
        messages: [{ role: "user", content: "hello" }] }))
      const text = await response.text()
      const error = sseError(text)
      assert.equal(error.type, "rate_limit_error")
      assert.equal(error.message, "agy bridge: Antigravity quota reached: " + chunks.join("").trim().replace(/^⚠ /, ""))
      assert.ok(!text.includes("⚠"), "no banner reaches the client")
      assert.ok(!text.includes("text_delta"), "nothing of it went as the reply")
    })
  }
})

test("agy's Individual quota reached ending after words the model wrote keeps them and fails the turn", async () => {
  await withKit({}, async (kit) => {
    markerAgent(kit, ["Let me look", QUOTA.slice(0, 30), QUOTA.slice(30)])
    const response = await kit.request(baseBody({ metadata: { user_id: "quota-partial" },
      messages: [{ role: "user", content: "hello" }] }))
    const text = await response.text()
    const parsed = await readSse(new Response(text))
    assert.equal(replyText(parsed), "Let me look")
    assert.equal(sseError(text).type, "rate_limit_error")
    assert.match(sseError(text).message, /Resets in 1h18m40s\.$/)
  })
})

test("agy's Individual quota reached ending fails a non-stream request as an HTTP 429", async () => {
  await withKit({}, async (kit) => {
    markerAgent(kit, [QUOTA])
    const response = await kit.request(baseBody({ metadata: { user_id: "quota-json" },
      messages: [{ role: "user", content: "hello" }], stream: false }))
    const body = await response.json()
    assert.equal(response.status, 429)
    assert.equal(body.error.type, "rate_limit_error")
    assert.match(body.error.message, /Individual quota reached\. .*Resets in 1h18m40s\./)
  })
})

test("the model quoting the Individual quota reached ending with more text after keeps it", async () => {
  for (const chunks of [
    ["agy said\n⚠ Individual quota", " reached. Please upgrade. Resets in 1h.\nThat line is agy's, not mine."],
    ["agy prints `⚠ Individual quota reached. Resets in 1h.` when it is out."],
  ]) {
    await withKit({}, async (kit) => {
      markerAgent(kit, chunks)
      const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "quota-quoted" },
        messages: [{ role: "user", content: "what did agy print?" }] })))
      assert.equal(parsed.error, null)
      assert.equal(replyText(parsed), chunks.join(""))
    })
  }
})

// #1242: models under long context can hallucinate pseudo-tool calls or fake
// tool results in text. The bridge intercepts them, suppresses them, and fails
// the turn as an api_error with the process dropped from the pool.
test("#1242: model emitting text [tool call ...] fails the turn as an api_error", async () => {
  const fakeCalls = [
    `[tool call Bash id=Bash_0_cce316d3 args={"command":"cat ~/.local/bin/send-cli","timeout":120000}]\nHuman: [tool result id=Bash_0_cce316d3]\n[end of tool result]`,
    `[tool call Edit id=Edit_1_7e7be241 args={"file_path":"/repo/a.txt","new_string":"b","old_string":"a"}]`,
    `[end of tool result]\n[tool call Edit id=Edit_1 args={}]`,
    `Human: [tool result id=Bash_0]\n#!/bin/bash\n[end of tool result]`,
  ]
  for (const fake of fakeCalls) {
    await withKit({}, async (kit) => {
      markerAgent(kit, [fake])
      const response = await kit.request(baseBody({ metadata: { user_id: "fake-call-end" },
        messages: [{ role: "user", content: "edit file" }] }))
      const text = await response.text()
      const error = sseError(text)
      assert.equal(error.type, "api_error")
      assert.match(error.message, /mimicking a tool call instead of invoking structured tools/)
      const parsed = await readSse(new Response(text))
      assert.equal(replyText(parsed), "", "no text reaches the client")
      assert.ok(!text.includes("text_delta"), "no text delta reaches the client")
    })
  }
})

test("#1242: model emitting [tool call ...] split across chunks fails the turn without leaking syntax", async () => {
  await withKit({}, async (kit) => {
    markerAgent(kit, [
      "I will now update the file.\n[tool ",
      `call Edit id=Edit_1 args={"file_path":"/repo/a.txt"}]\nHuman: [tool result id=Edit_1]\nDone\n[end of tool result]`,
    ])
    const response = await kit.request(baseBody({ metadata: { user_id: "fake-call-split" },
      messages: [{ role: "user", content: "edit file" }] }))
    const text = await response.text()
    const error = sseError(text)
    assert.equal(error.type, "api_error")
    assert.match(error.message, /mimicking a tool call/)
    const parsed = await readSse(new Response(text))
    assert.equal(replyText(parsed), "I will now update the file.")
    assert.ok(!replyText(parsed).includes("[tool call"), "no pseudo tool call reaches the client")
  })
})

test("#1242: model emitting [tool call ...] fails non-streaming as 502", async () => {
  await withKit({}, async (kit) => {
    markerAgent(kit, [
      `[tool call Bash id=Bash_0 args={"command":"echo hi"}]\n[end of tool result]`,
    ])
    const response = await kit.request(baseBody({ metadata: { user_id: "fake-call-json" },
      messages: [{ role: "user", content: "run command" }], stream: false }))
    const body = await response.json()
    assert.equal(response.status, 502)
    assert.equal(body.error.type, "api_error")
    assert.match(body.error.message, /mimicking a tool call/)
  })
})

test("#1151: the model quoting the 429 ending with more text after keeps it", async () => {
  const chunks = ["agy ended with\n⚠ RESOURCE_EXHAUSTED (code 429): Resource has", " been exhausted (e.g. check quota).\nThat line is agy's, not mine."]
  await withKit({}, async (kit) => {
    markerAgent(kit, chunks)
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "exhausted-quoted" },
      messages: [{ role: "user", content: "what did agy print?" }] })))
    assert.equal(parsed.error, null)
    assert.equal(replyText(parsed), chunks.join(""))
  })
})

test("#1136: the model quoting an attempt banner or the network ending mid-line keeps it", async () => {
  const chunks = ["agy printed `⚠ API error (attempt 1): EOF` and later", " `⚠ There was a network issue connecting to the server, please try again.` too."]
  await withKit({}, async (kit) => {
    markerAgent(kit, chunks)
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "attempt-quoted" },
      messages: [{ role: "user", content: "what did agy print?" }] })))
    assert.equal(parsed.error, null)
    assert.equal(replyText(parsed), chunks.join(""))
  })
})

// Lmohn39 on X (11-14): pi through agy-cli never answered. Antigravity gave
// every try the bare 429 it answers a turned-away system prompt with, and
// agy retried it in the same turn, a banner each time, before its 429
// ending. The first such banner ends the turn, with the same error.
const REFUSED_ATTEMPT = (n) => `\n⚠ API error (attempt ${n}): RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).`

test("Lmohn39: a try answered with the bare 429 ends the turn at once, not after agy's retries", async () => {
  const PI = "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code."
  for (const [system, chunks, want, kind] of [
    // the banner's line still open while agy waits to try again
    [PI, [REFUSED_ATTEMPT(1)], /answered 429 to this system prompt: RESOURCE_EXHAUSTED \(code 429\).*pi's default system prompt/, "invalid_request_error"],
    [PI, [REFUSED_ATTEMPT(1).slice(0, 40), REFUSED_ATTEMPT(1).slice(40) + "\n"], /answered 429 to this system prompt/, "invalid_request_error"],
    ["You are a test agent.", ["partial", REFUSED_ATTEMPT(1)], /quota or rate limit reached: RESOURCE_EXHAUSTED \(code 429\).*not a quota/, "rate_limit_error"],
  ]) {
    await withKit({}, async (kit) => {
      let tries = 0
      kit.defaultPrompt = async (agent) => {
        tries++
        for (const chunk of chunks) await agent.text(chunk)
        // agy waits, then tries again: never, here
        await new Promise(() => {})
      }
      const reply = kit.request(baseBody({ metadata: { user_id: "refused-attempt" }, system,
        messages: [{ role: "user", content: "hello" }] })).then((response) => response.text())
      const text = await Promise.race([reply, sleep(5_000).then(() => "still waiting after 5s")])
      assert.equal(tries, 1)
      assert.match(text, want)
      assert.ok(text.includes(kind), `${kind} in ${text.slice(-400)}`)
      assert.ok(!text.includes("⚠"), "no banner reaches the client")
    })
  }
})

test("Lmohn39: a try that fails another way still waits for agy's next one", async () => {
  await withKit({}, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      await agent.text("\n⚠ API error (attempt 1): UNAVAILABLE (code 503): try again.")
      await agent.text("\nanswer")
      return { stopReason: "end_turn" }
    }
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "other-attempt" },
      messages: [{ role: "user", content: "hello" }] })))
    assert.equal(parsed.error, null)
    assert.equal(replyText(parsed), "answer")
  })
})

// ---------------------------------------------------------------- one opening, several models at once

// magpie's "Test models" sends every model the same smallest request, four at a
// time: {"model":…,"max_tokens":16,"messages":[{"role":"user","content":"hi"}]}.
// Those share one conversation key, so all but the first were turned away with
// "this conversation still has an unfinished response" (swang20201 on X: one ✓,
// three ✗). Each is a conversation of its own and gets an agy of its own.
test("the same opening sent to several models at once is answered for each", async () => {
  const ids = ["claude-opus-5-5", "gemini-4-argon", "claude-sonnet-5-5", "gemini-3.8-flash"]
  await withKit({ offeredModels: [
    ["gemini-4-argon-high", "Gemini 4 Argon (High)"], ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
    ["claude-opus-5-5-high", "Claude Opus 5.5 (High)"], ["claude-sonnet-5-5-high", "Claude Sonnet 5.5 (High)"],
  ] }, async (kit) => {
    let arrived = 0
    let release
    const allIn = new Promise((resolve) => { release = resolve })
    kit.defaultPrompt = async (agent) => {
      // every prompt is held until the last one is in: they overlap, as on a real agy
      if (++arrived === ids.length) release()
      await Promise.race([allIn, sleep(2_000)])
      await agent.text(`answer ${agent.index}`)
      return { stopReason: "end_turn" }
    }
    const responses = await Promise.all(ids.map((model) =>
      kit.request({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] })))
    const results = await Promise.all(responses.map(async (response) =>
      response.status === 200 ? readSse(response) : { status: response.status, text: await response.text() }))
    for (const [i, result] of results.entries()) {
      assert.equal(result.status, undefined, `${ids[i]}: ${result.text}`)
      assert.equal(result.stopReason, "end_turn", ids[i])
    }
    assert.equal(arrived, ids.length)
  })
})

// ------------------------------------------- #1166 machine customizations

test("#1166: an agy whose acp --help lists the flag starts without the machine's own skills, asked once", async () => {
  await withKit({ acpHelp: "Usage of acp:\n  --include-default-customizations\n    \tload the default customizations (default true)\n" }, async (kit) => {
    scriptedAgent(kit)
    for (const user of ["custom-a", "custom-b"]) {
      const reply = await readSse(await kit.request(baseBody({ metadata: { user_id: user }, messages: [{ role: "user", content: "hello " + user } ] })))
      assert.equal(reply.stopReason, "end_turn")
    }
    assert.equal(kit.acpSpawns.length, 2, "two conversations, two processes")
    for (const spawn of kit.acpSpawns) assert.ok(spawn.args.includes("--include-default-customizations=false"), spawn.args.join(" "))
    assert.equal(kit.helpSpawns.length, 1, "acp --help is asked once per agy binary")
  })
})

test("#1166: an agy without the flag is never given it, so it still starts", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit)
    const reply = await readSse(await kit.request(baseBody({ metadata: { user_id: "custom-old" }, messages: [{ role: "user", content: "hello old" }] })))
    assert.equal(reply.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1)
    assert.ok(!kit.acpSpawns[0].args.some((arg) => arg.startsWith("--include-default-customizations") || arg === "--gemini-dir"), kit.acpSpawns[0].args.join(" "))
  })
})

const GEMINI_DIR_HELP = "Usage of acp:\n  --gemini-dir\n    \tPath where Gemini files are stored (default .gemini)\n  --include-default-customizations\n    \tInclude default customizations (default true)\n"

test("#1166: an agy whose acp --help lists --gemini-dir runs in the bridge's own folder, kept across conversations", async () => {
  await withKit({ acpHelp: GEMINI_DIR_HELP }, async (kit) => {
    scriptedAgent(kit)
    for (const user of ["home-a", "home-b"]) {
      const reply = await readSse(await kit.request(baseBody({ metadata: { user_id: user }, messages: [{ role: "user", content: "hello " + user }] })))
      assert.equal(reply.stopReason, "end_turn")
    }
    const own = path.join(kit.env.XDG_STATE_HOME, "magpie-agy-bridge", "agy-home")
    assert.equal(kit.acpSpawns.length, 2)
    for (const spawn of kit.acpSpawns) {
      const at = spawn.args.indexOf("--gemini-dir")
      assert.ok(at >= 0 && spawn.args[at + 1] === own, spawn.args.join(" "))
    }
    assert.ok(fs.statSync(own).isDirectory(), "the folder is made before agy starts")
    assert.equal(kit.helpSpawns.length, 1, "acp --help is asked once for both flags")
  })
})

test("#1165: with agy's sign-in in a file under ~/.gemini (no keyring, Docker), agy stays on that folder", async () => {
  await withKit({ acpHelp: GEMINI_DIR_HELP }, async (kit) => {
    const token = path.join(kit.env.HOME, ".gemini", "antigravity-cli", "antigravity-oauth-token")
    fs.mkdirSync(path.dirname(token), { recursive: true })
    fs.writeFileSync(token, "{}", { mode: 0o600 })
    scriptedAgent(kit)
    const reply = await readSse(await kit.request(baseBody({ metadata: { user_id: "file-token" }, messages: [{ role: "user", content: "hello" }] })))
    assert.equal(reply.stopReason, "end_turn")
    assert.ok(!kit.acpSpawns[0].args.includes("--gemini-dir"), kit.acpSpawns[0].args.join(" "))
    assert.ok(kit.acpSpawns[0].args.includes("--include-default-customizations=false"))
  })
})

test("assistant tail with thinking+text blocks is accepted while thinking+tool_use is still rejected", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit)
    const accepted = await kit.request(baseBody({
      metadata: { user_id: "thinking-tail-ok" },
      messages: [
        { role: "user", content: "summarize" },
        { role: "assistant", content: [
          { type: "thinking", thinking: "internal reasoning" },
          { type: "text", text: "partial reply" },
        ] },
      ],
    }))
    assert.equal(accepted.status, 200, await accepted.clone().text())
    const parsed = await readSse(accepted)
    assert.equal(parsed.stopReason, "end_turn")
    assert.ok(prompts(kit).at(-1).includes("partial reply"))

    const rejected = await errorOf(await kit.request(baseBody({
      metadata: { user_id: "thinking-tail-tool" },
      messages: [
        { role: "user", content: "read file" },
        { role: "assistant", content: [
          { type: "thinking", thinking: "need Read" },
          { type: "tool_use", id: "toolu_tail", name: "Read", input: { path: "/a" } },
        ] },
      ],
    })))
    assert.equal(rejected.status, 400)
    assert.match(rejected.body.error.message, /not from the user or a tool-result/)
  })
})

test("live tool-turn drop logs drop_live and carries exact reason into session_new", async () => {
  const stderr = captureStderr()
  try {
    await withKit({}, async (kit) => {
      scriptedAgent(kit)
      const body1 = baseBody({ metadata: { user_id: "drop-reason" }, messages: [{ role: "user", content: "TOOL read" }] })
      const first = await readSse(await kit.request(body1))
      assert.equal(first.stopReason, "tool_use")
      const call = first.content.find((block) => block.type === "tool_use")
      const tampered = baseBody({
        metadata: { user_id: "drop-reason" },
        messages: [
          { role: "user", content: "ALTERED opening" },
          { role: "assistant", content: [call] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "ok" }] },
        ],
      })
      const second = await readSse(await kit.request(tampered))
      assert.equal(second.stopReason, "end_turn")
    })
  } finally {
    stderr.restore()
  }
  const drops = stderr.lines.filter((row) => row.action === "drop_live")
  assert.equal(drops.length, 1)
  assert.equal(drops[0].reason, "history_mismatch")
  const sessionNews = stderr.lines.filter((row) => row.action === "session_new")
  assert.equal(sessionNews.at(-1)?.reason, "history_mismatch")
})

test("A16: oversized history[0] cannot evict the newest history reply before <current_turn>", async () => {
  await withKit({ env: { AGY_BRIDGE_MAX_PROMPT_BYTES: String(16 * 1024) } }, async (kit) => {
    scriptedAgent(kit)
    const hugeOpening = Array.from({ length: 4 }, (_, i) => ({
      type: "text",
      text: `ANCHOR-${i} ` + "a".repeat(3 * 1024),
    }))
    const messages = [{ role: "user", content: hugeOpening }]
    for (let i = 0; i < 6; i++) {
      messages.push({ role: "assistant", content: `mid reply ${i} ` + "m".repeat(512) })
      messages.push({ role: "user", content: `mid user ${i}` })
    }
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: "NEWEST HEAD " + "n".repeat(2 * 1024) },
        { type: "text", text: "t".repeat(4 * 1024) + " NEWEST TAIL" },
      ],
    })
    messages.push({ role: "user", content: "CURRENT QUESTION" })
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "anchor-vs-tail" }, messages })))
    assert.equal(parsed.stopReason, "end_turn")
    const prompt = prompts(kit).at(-1)
    assert.ok(bytes(prompt) <= 16 * 1024, `initial prompt is ${bytes(prompt)} bytes`)
    assert.ok(prompt.includes("ANCHOR-0"), "opening anchor head is kept")
    assert.ok(prompt.includes("NEWEST HEAD") && prompt.includes("NEWEST TAIL"), "newest history turn keeps head and tail")
    assert.ok(prompt.includes("<current_turn>\nCURRENT QUESTION\n</current_turn>"))
  })
})

test("#1165: a folder AGY_BRIDGE_GEMINI_DIR names is used even with a file sign-in", async () => {
  await withKit({ acpHelp: GEMINI_DIR_HELP }, async (kit) => {
    const named = path.join(kit.env.HOME, "named-agy")
    kit.env.AGY_BRIDGE_GEMINI_DIR = named
    const token = path.join(kit.env.HOME, ".gemini", "antigravity-cli", "antigravity-oauth-token")
    fs.mkdirSync(path.dirname(token), { recursive: true })
    fs.writeFileSync(token, "{}")
    scriptedAgent(kit)
    await readSse(await kit.request(baseBody({ metadata: { user_id: "file-token-named" }, messages: [{ role: "user", content: "hello" }] })))
    const args = kit.acpSpawns[0].args
    assert.equal(args[args.indexOf("--gemini-dir") + 1], named, args.join(" "))
  })
})

test("#1166: AGY_BRIDGE_GEMINI_DIR=default leaves agy on the machine's own folder", async () => {
  await withKit({ acpHelp: GEMINI_DIR_HELP, env: { AGY_BRIDGE_GEMINI_DIR: "default" } }, async (kit) => {
    scriptedAgent(kit)
    const reply = await readSse(await kit.request(baseBody({ metadata: { user_id: "home-default" }, messages: [{ role: "user", content: "hello" }] })))
    assert.equal(reply.stopReason, "end_turn")
    assert.ok(!kit.acpSpawns[0].args.includes("--gemini-dir"), kit.acpSpawns[0].args.join(" "))
    assert.ok(kit.acpSpawns[0].args.includes("--include-default-customizations=false"))
  })
})

test("forked session or subagent carrying an ancestor tool_use does not hit conflicting duplicate result or hijack parent", async () => {
  await withKit({}, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      const text = promptText({ prompt: agent.prompt })
      const current = text.includes("<current_turn>") ? text.slice(text.lastIndexOf("<current_turn>")) : text
      if (current.includes("Side conversation boundary")) {
        await agent.text("side answer")
        return { stopReason: "end_turn" }
      }
      if (current.includes("TWOSTEP")) {
        await agent.tool("Read", { path: "/a" })
        await agent.tool("Read", { path: "/b" })
        await agent.text("parent done")
        return { stopReason: "end_turn" }
      }
      await agent.text("fallback")
      return { stopReason: "end_turn" }
    }
    const parentHeaders = { "x-magpie-session": "codex:parent-1" }
    const sideHeaders = { "x-magpie-session": "codex:side-1" }
    const opening = baseBody({ system: "shared system", messages: [{ role: "user", content: "TWOSTEP fork" }] })
    const turn1 = await readSse(await kit.request(opening, { headers: parentHeaders }))
    assert.equal(turn1.stopReason, "tool_use")
    const call1 = turn1.content.find((block) => block.type === "tool_use")

    const step2Body = continueWithToolResults(opening, turn1, () => "real-step-1")
    const turn2 = await readSse(await kit.request(step2Body, { headers: parentHeaders }))
    assert.equal(turn2.stopReason, "tool_use")

    const sideBody = {
      ...opening,
      messages: [
        ...opening.messages,
        { role: "assistant", content: turn1.content },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: call1.id, content: "aborted" },
            { type: "text", text: "Side conversation boundary. Answer this." },
          ],
        },
      ],
    }
    const sideRes = await kit.request(sideBody, { headers: sideHeaders })
    assert.equal(sideRes.status, 200, "forked side session must not return 409 conflicting duplicate result")
    const sideParsed = await readSse(sideRes)
    assert.equal(sideParsed.stopReason, "end_turn")
    assert.ok(sideParsed.content.some((block) => block.text?.includes("side answer")))

    const parentFinal = await readSse(await kit.request(continueWithToolResults(step2Body, turn2, () => "real-step-2"), { headers: parentHeaders }))
    assert.equal(parentFinal.stopReason, "end_turn")
    assert.ok(parentFinal.content.some((block) => block.text?.includes("parent done")))
  })
})

test("forked subagent arriving before parent answers its pending tool call leaves parent's call intact", async () => {
  await withKit({}, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      const text = promptText({ prompt: agent.prompt })
      const current = text.includes("<current_turn>") ? text.slice(text.lastIndexOf("<current_turn>")) : text
      if (current.includes("NEW_TASK")) {
        await agent.text("child done")
        return { stopReason: "end_turn" }
      }
      if (current.includes("WAIT_TOOL")) {
        const result = await agent.tool("Read", { path: "/shared" })
        await agent.text(`parent got:${result?.result?.content?.[0]?.text || ""}`)
        return { stopReason: "end_turn" }
      }
      await agent.text("other")
      return { stopReason: "end_turn" }
    }
    const parentHeaders = { "x-magpie-session": "codex:parent-2" }
    const childHeaders = { "x-magpie-session": "codex:child-2", "x-magpie-subagent": "sub-2" }
    const opening = baseBody({ system: "shared system", messages: [{ role: "user", content: "WAIT_TOOL start" }] })
    const turn1 = await readSse(await kit.request(opening, { headers: parentHeaders }))
    assert.equal(turn1.stopReason, "tool_use")
    const call1 = turn1.content.find((block) => block.type === "tool_use")

    const childBody = {
      ...opening,
      messages: [
        ...opening.messages,
        { role: "assistant", content: turn1.content },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: call1.id, content: "aborted" },
            { type: "text", text: "NEW_TASK child prompt" },
          ],
        },
      ],
    }
    const childRes = await kit.request(childBody, { headers: childHeaders })
    assert.equal(childRes.status, 200)
    const childParsed = await readSse(childRes)
    assert.equal(childParsed.stopReason, "end_turn")

    const parentRes = await kit.request(continueWithToolResults(opening, turn1, () => "parent-real-output"), { headers: parentHeaders })
    assert.equal(parentRes.status, 200)
    const parentParsed = await readSse(parentRes)
    assert.equal(parentParsed.stopReason, "end_turn")
    assert.ok(parentParsed.content.some((block) => block.text?.includes("parent got:parent-real-output")))
  })
})

test("forked session without trailing tool_result does not supersede parent's active tool turn via lineage_fork", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit, { "side question": "side reply" })
    const parentHeaders = { "x-magpie-session": "codex:parent-3" }
    const sideHeaders = { "x-magpie-session": "codex:side-3" }
    const first = baseBody({ system: "shared system", messages: [{ role: "user", content: "hello" }] })
    const done1 = await readSse(await kit.request(first, { headers: parentHeaders }))
    assert.equal(done1.stopReason, "end_turn")

    const parentTurn2 = {
      ...first,
      messages: [...first.messages, { role: "assistant", content: done1.content }, { role: "user", content: "TOOL second" }],
    }
    const pending = await readSse(await kit.request(parentTurn2, { headers: parentHeaders }))
    assert.equal(pending.stopReason, "tool_use")

    const sideBody = {
      ...first,
      messages: [...first.messages, { role: "assistant", content: done1.content }, { role: "user", content: "side question" }],
    }
    const sideParsed = await readSse(await kit.request(sideBody, { headers: sideHeaders }))
    assert.equal(sideParsed.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 2, "side session starts its own process without killing parent")

    const parentRes = await kit.request(continueWithToolResults(parentTurn2, pending, () => "ok"), { headers: parentHeaders })
    assert.equal(parentRes.status, 200)
    assert.equal((await readSse(parentRes)).stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 2, "parent finishes on its original process without replay")
  })
})

test("synthetic magpie-<24hex> session id is ignored for flattened continuation while subagent scope still isolates", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit, {
      "first turn": "first reply",
      "second turn": "second reply",
      "child turn": "child reply",
    })
    const opening = "shared opening context\nfirst turn"
    const turn1 = baseBody({ system: "shared system", messages: [{ role: "user", content: opening }] })
    const done1 = await readSse(await kit.request(turn1, { headers: { "x-magpie-session": "magpie-0123456789abcdef01234567" } }))
    assert.equal(done1.stopReason, "end_turn")

    const flattenedTurn2 = baseBody({
      system: "shared system",
      messages: [{ role: "user", content: `${opening}\n\nassistant: first reply\n\nsecond turn` }],
    })
    const done2 = await readSse(await kit.request(flattenedTurn2, { headers: { "x-magpie-session": "magpie-fedcba9876543210fedcba98" } }))
    assert.equal(done2.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1, "synthetic magpie session hashes must not prevent continuing live proc")

    const subagentTurn = baseBody({
      system: "shared system",
      messages: [{ role: "user", content: "child turn" }],
    })
    const doneSub = await readSse(await kit.request(subagentTurn, {
      headers: { "x-magpie-session": "magpie-0123456789abcdef01234567", "x-magpie-subagent": "collab_spawn" },
    }))
    assert.equal(doneSub.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 2, "x-magpie-subagent still isolates even when x-magpie-session is synthetic")
  })
})

test("unscoped parent and scoped subagent do not collide on shared ancestor tool_use_id", async () => {
  await withKit({}, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      const text = promptText({ prompt: agent.prompt })
      const current = text.includes("<current_turn>") ? text.slice(text.lastIndexOf("<current_turn>")) : text
      if (current.includes("SUBAGENT_ASK")) {
        await agent.text("subagent ok")
        return { stopReason: "end_turn" }
      }
      if (current.includes("UNSCOPED_WAIT")) {
        const result = await agent.tool("Read", { path: "/unscoped" })
        await agent.text(`parent:${result?.result?.content?.[0]?.text || ""}`)
        return { stopReason: "end_turn" }
      }
      await agent.text("other")
      return { stopReason: "end_turn" }
    }
    const opening = baseBody({ system: "shared system", messages: [{ role: "user", content: "UNSCOPED_WAIT start" }] })
    const turn1 = await readSse(await kit.request(opening))
    assert.equal(turn1.stopReason, "tool_use")
    const call1 = turn1.content.find((block) => block.type === "tool_use")

    const subRes = await kit.request({
      ...opening,
      messages: [
        ...opening.messages,
        { role: "assistant", content: turn1.content },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: call1.id, content: "aborted" },
            { type: "text", text: "SUBAGENT_ASK run" },
          ],
        },
      ],
    }, { headers: { "x-magpie-session": "codex:sub-only", "x-magpie-subagent": "collab_spawn" } })
    assert.equal(subRes.status, 200)
    assert.equal((await readSse(subRes)).stopReason, "end_turn")

    const parentRes = await kit.request(continueWithToolResults(opening, turn1, () => "parent-ok"))
    assert.equal(parentRes.status, 200)
    const parentParsed = await readSse(parentRes)
    assert.equal(parentParsed.stopReason, "end_turn")
    assert.ok(parentParsed.content.some((block) => block.text?.includes("parent:parent-ok")))
  })
})

test("fetchInput Request headers preserve x-magpie-session isolation", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit, { "hello": "reply" })
    const body = baseBody({ system: "shared system", messages: [{ role: "user", content: "hello" }] })
    const req1 = new Request("agy://local/v1/messages", { method: "POST", headers: { "x-magpie-session": "req-1" }, body: JSON.stringify(body) })
    const req2 = new Request("agy://local/v1/messages", { method: "POST", headers: { "x-magpie-session": "req-2" }, body: JSON.stringify(body) })
    assert.equal((await readSse(await kit.fetch(req1))).stopReason, "end_turn")
    assert.equal((await readSse(await kit.fetch(req2))).stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 2)
  })
})
