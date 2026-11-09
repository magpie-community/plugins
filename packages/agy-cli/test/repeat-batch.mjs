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

test("prompt guard strips billing header and replaces Agent SDK identity in fetch and count_tokens", async () => {
  await withKit({}, async (kit) => {
    scriptedAgent(kit)
    const billing = "x-anthropic-billing-header: cc_version=2.1.0; cc_entrypoint=cli;"
    const identity = "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
    const body = baseBody({
      metadata: { user_id: "prompt-guard" },
      system: [
        { type: "text", text: billing },
        { type: "text", text: `${identity}\nFollow repo rules.` },
      ],
      messages: [{ role: "user", content: "hello" }],
    })
    const tokensWithHeader = await kit.countTokens(body)
    const tokensWithoutHeader = await kit.countTokens({
      ...body,
      system: [{ type: "text", text: "You are an AI coding assistant.\nFollow repo rules." }],
    })
    assert.equal(tokensWithHeader, tokensWithoutHeader)
    const parsed = await readSse(await kit.request(body))
    assert.equal(parsed.stopReason, "end_turn")
    const proc = [...kit.module.__agyTestAllProcs][0]
    const appended = proc?.instructions || ""
    assert.ok(!appended.includes("x-anthropic-billing-header"))
    assert.ok(!appended.includes("Claude Agent SDK"))
    assert.ok(appended.includes("You are an AI coding assistant."))
  })
})

test("output-cap notice is stripped and max_tokens automatically continues up to 3 times", async () => {
  await withKit({}, async (kit) => {
    let call = 0
    kit.prompts.push(
      async (agent) => {
        call++
        await agent.text("First part.")
        await agent.text("\n⚠ Your previous response was cut off because it exceeded the output token limit\nPlease continue from where you left off, keeping your response shorter\nRetries remaining: 3\n")
        return { stopReason: "max_tokens", usage: { inputTokens: 100, outputTokens: 20 } }
      },
      async (agent) => {
        call++
        await agent.text(" Second part.")
        return { stopReason: "end_turn", usage: { inputTokens: 120, outputTokens: 15 } }
      },
    )
    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "output-cap" } })))
    assert.equal(call, 2)
    assert.equal(parsed.stopReason, "end_turn")
    const text = parsed.content.filter((b) => b.type === "text").map((b) => b.text).join("")
    assert.equal(text, "First part. Second part.")
    assert.ok(!text.includes("exceeded the output token limit"))
  })
})

test("anti-ban isolation: passes --disable-telemetry and isolated --gemini-dir, intercepts built-in tools, soft-ban first chunk, and caps active turns", async () => {
  await withKit({ env: { AGY_BRIDGE_MAX_ACTIVE_TURNS: "2", AGY_BRIDGE_SPAWN_SPACING_MS: "40" } }, async (kit) => {
    // 1. Soft-ban first-chunk refusal banner is intercepted and surfaced as an error frame instead of normal assistant text.
    kit.prompts.push(async (agent) => {
      await agent.text("⚠ Your account access has been temporarily restricted")
      await agent.text(" due to unusual activity (VALIDATION_REQUIRED).\n")
      return { stopReason: "end_turn", usage: { inputTokens: 50, outputTokens: 15 } }
    })
    const softBanParsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "soft-ban-conv" } })))
    assert.equal(softBanParsed.content.length, 0, "soft-ban banner must not be emitted as assistant text")
    assert.ok(softBanParsed.error, "soft-ban banner must emit an SSE error frame")
    assert.match(softBanParsed.error.message, /forbidden|validation/i)
    const spawnArgs = kit.acpSpawns[0]?.args || []
    assert.ok(spawnArgs.includes("--disable-telemetry"), "agy acp must pass --disable-telemetry")
    assert.ok(spawnArgs.includes("--gemini-dir"), "agy acp must pass --gemini-dir")
    assert.ok(spawnArgs.includes("--app-data-dir") && spawnArgs.includes("agy"), "agy acp must pass --app-data-dir agy")

    // 2. Built-in agy tools (manage_task, list_resources, read_resource) are rejected if called over MCP.
    kit.prompts.push(async (agent) => {
      const reply = await agent.tool("manage_task", { Action: "list" })
      assert.match(reply?.error?.message || "", /built-in agy tool manage_task is disabled/)
      await agent.text("Handled rejected built-in tool.")
      return { stopReason: "end_turn", usage: { inputTokens: 50, outputTokens: 10 } }
    })
    const builtinParsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "builtin-intercept" } })))
    assert.equal(builtinParsed.stopReason, "end_turn")

    // 3. Active turn cap (2) rejects a 3rd concurrent in-flight generation with 503 while Measuring spawn spacing.
    let releaseA
    let releaseB
    const readyA = new Promise((resolve) => {
      kit.prompts.push(async (agent) => {
        await agent.text("stream A")
        resolve()
        await new Promise((r) => { releaseA = r })
        return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } }
      })
    })
    const readyB = new Promise((resolve) => {
      kit.prompts.push(async (agent) => {
        await agent.text("stream B")
        resolve()
        await new Promise((r) => { releaseB = r })
        return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } }
      })
    })
    const t0 = performance.now()
    const reqA = kit.request(baseBody({ metadata: { user_id: "active-A" } }))
    const reqB = kit.request(baseBody({ metadata: { user_id: "active-B" } }))
    await Promise.all([readyA, readyB])
    const elapsed = performance.now() - t0
    assert.ok(elapsed >= 30, `spawn spacing should space concurrent spawns (elapsed=${elapsed}ms)`)

    const resC = await kit.request(baseBody({ metadata: { user_id: "active-C" } }))
    assert.equal(resC.status, 503, "3rd concurrent active turn must be rejected with 503")
    const bodyC = await resC.json()
    assert.match(bodyC.error?.message || "", /2 turns are already active/)

    releaseA()
    releaseB()
    await Promise.all([reqA.then(readSse), reqB.then(readSse)])
  })
})
