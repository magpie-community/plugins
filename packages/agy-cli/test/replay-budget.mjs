// Tests for version-aware initial prompt budget (184,000 B on agy >= 1.5.14 vs
// 112 KiB on older agy) and opt-in overflow history seeding via session/new's
// _meta.antigravity.systemPrompt.append (AGY_BRIDGE_HISTORY_SEED=1).

import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

async function withKit(options, fn) {
  const kit = await createBridgeKit(options)
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

function bytes(text) {
  return Buffer.byteLength(text, "utf8")
}

function promptText(params) {
  return (params?.prompt || []).map((part) => (part.type === "text" ? part.text : "")).join("")
}

function prompts(kit) {
  return kit.acpLog.filter((entry) => entry.method === "session/prompt").map((entry) => promptText(entry.params))
}

function sessionNewCalls(kit) {
  return kit.acpLog.filter((entry) => entry.method === "session/new")
}

function sessionResumeCalls(kit) {
  return kit.acpLog.filter((entry) => entry.method === "session/resume")
}

function replyOk(kit) {
  kit.defaultPrompt = async (agent) => {
    await agent.text("ok")
    return { stopReason: "end_turn" }
  }
}

test("agy >= 1.5.14 sends a 160 KiB compaction-style initial prompt verbatim without clipping", async () => {
  await withKit({ agentVersion: "1.5.14" }, async (kit) => {
    replyOk(kit)
    const system = "SYS_HEAD " + "system policy line. ".repeat(900) + " SYS_TAIL"
    const summary = "SUMMARY_HEAD " + "kept tool output and working state line.\n".repeat(3300) + " SUMMARY_TAIL"
    const body = baseBody({
      system,
      metadata: { user_id: "modern-160k" },
      messages: [
        { role: "user", content: summary },
        { role: "user", content: "NEXT_STEP: continue from summary" },
      ],
    })
    const totalRaw = bytes(system) + bytes(summary)
    assert.ok(totalRaw > 140 * 1024 && totalRaw < 175 * 1024, `raw fixture is ${totalRaw} bytes`)
    const parsed = await readSse(await kit.request(body))
    assert.equal(parsed.stopReason, "end_turn")
    const prompt = prompts(kit).at(-1)
    assert.ok(bytes(prompt) > 112 * 1024 && bytes(prompt) <= 184_000, `prompt is ${bytes(prompt)} bytes`)
    assert.ok(prompt.includes("SUMMARY_HEAD") && prompt.includes("SUMMARY_TAIL"))
    assert.ok(prompt.includes("NEXT_STEP: continue from summary"))
    assert.ok(!prompt.includes("bytes omitted"), "summary must not be middle-clipped on agy 1.5.14")
    assert.equal(sessionNewCalls(kit).at(-1)?.params?._meta, undefined, "no systemPrompt.append by default")
  })
})

test("older agy (1.5.0) keeps the 112 KiB default budget on the same 160 KiB prompt", async () => {
  await withKit({ agentVersion: "1.5.0" }, async (kit) => {
    replyOk(kit)
    const system = "SYS_HEAD " + "system policy line. ".repeat(900) + " SYS_TAIL"
    const summary = "SUMMARY_HEAD " + "kept tool output and working state line.\n".repeat(3300) + " SUMMARY_TAIL"
    const body = baseBody({
      system,
      metadata: { user_id: "legacy-160k" },
      messages: [
        { role: "user", content: summary },
        { role: "user", content: "NEXT_STEP: continue from summary" },
      ],
    })
    const parsed = await readSse(await kit.request(body))
    assert.equal(parsed.stopReason, "end_turn")
    const prompt = prompts(kit).at(-1)
    assert.ok(bytes(prompt) <= 112 * 1024, `legacy prompt must stay <= 112 KiB, got ${bytes(prompt)}`)
    assert.ok(prompt.includes("bytes omitted"))
  })
})

test("agy >= 1.5.14 honors AGY_BRIDGE_MAX_PROMPT_BYTES override and clips > 184,000 B cleanly", async () => {
  await withKit({ agentVersion: "1.5.14", env: { AGY_BRIDGE_MAX_PROMPT_BYTES: String(64 * 1024) } }, async (kit) => {
    replyOk(kit)
    const big = "HISTORY_BLOCK " + "word ".repeat(30_000)
    const body = baseBody({
      metadata: { user_id: "override-64k" },
      messages: [
        { role: "user", content: "open" },
        { role: "assistant", content: big },
        { role: "user", content: "FINAL_ASK" },
      ],
    })
    await readSse(await kit.request(body))
    const prompt = prompts(kit).at(-1)
    assert.ok(bytes(prompt) <= 64 * 1024, `override prompt is ${bytes(prompt)} bytes`)
    assert.ok(prompt.includes("FINAL_ASK") && prompt.endsWith("</current_turn>"))
  })

  await withKit({ agentVersion: "1.5.14" }, async (kit) => {
    replyOk(kit)
    const messages = [{ role: "user", content: "ANCHOR_OPEN" }]
    for (let i = 0; i < 30; i++) {
      messages.push({ role: "assistant", content: `turn-${i} ` + "filler content line for replay. ".repeat(350) })
      messages.push({ role: "user", content: `follow-up-${i}` })
    }
    messages.push({ role: "user", content: "LATEST_ASK" })
    await readSse(await kit.request(baseBody({ metadata: { user_id: "modern-240k" }, messages })))
    const prompt = prompts(kit).at(-1)
    assert.ok(bytes(prompt) <= 184_000, `prompt is ${bytes(prompt)} bytes`)
    assert.ok(bytes(prompt) > 112 * 1024, `prompt should use modern budget, got ${bytes(prompt)}`)
    assert.ok(prompt.includes("ANCHOR_OPEN") && prompt.includes("LATEST_ASK"))
    assert.ok(prompt.includes("[... earlier conversation history omitted to fit ACP prompt budget ...]"))
    assert.ok(!prompt.includes("112 KiB"))
  })
})

test("AGY_BRIDGE_HISTORY_SEED=1 seeds overflowing multi-turn history into session/new and cloaks it", async () => {
  await withKit({
    agentVersion: "1.5.14",
    appendable: true,
    env: { AGY_BRIDGE_HISTORY_SEED: "1" },
  }, async (kit) => {
    replyOk(kit)
    const messages = [
      { role: "user", content: "EARLY_MARKER_0 You are Codex, a coding agent based on GPT-5" },
      { role: "assistant", content: "early-reply-0 " + "alpha beta gamma delta line.\n".repeat(1500) },
    ]
    for (let i = 1; i <= 6; i++) {
      messages.push({ role: "user", content: `USER_STEP_${i}` })
      messages.push({ role: "assistant", content: `ASSISTANT_STEP_${i} ` + "detail output line here.\n".repeat(1500) })
    }
    messages.push({ role: "user", content: "CURRENT_TASK_FINAL" })

    const parsed = await readSse(await kit.request(baseBody({ metadata: { user_id: "seed-multi" }, messages })))
    assert.equal(parsed.stopReason, "end_turn")

    const newParams = sessionNewCalls(kit).at(-1)?.params
    const append = newParams?._meta?.antigravity?.systemPrompt?.append || ""
    assert.ok(append.startsWith("<earlier_conversation_history>\n"), "overflow history seeded in session/new")
    assert.ok(append.includes("EARLY_MARKER_0"), "oldest overflow message moved to seed")
    assert.ok(!append.includes("based on GPT-5"), "seeded history is cloaked with outgoing()")
    assert.ok(append.includes("built on GPT-5"), "cloaked replacement preserved")
    assert.ok(append.endsWith("</earlier_conversation_history>"))

    const prompt = prompts(kit).at(-1)
    assert.ok(bytes(prompt) <= 184_000, `session/prompt stays within 184,000 B, got ${bytes(prompt)}`)
    assert.ok(prompt.includes("earlier conversation message(s) provided in session context"))
    assert.ok(prompt.includes("CURRENT_TASK_FINAL"))
    assert.ok(!prompt.includes("EARLY_MARKER_0"), "seeded message is not duplicated in session/prompt")
  })
})

test("AGY_BRIDGE_HISTORY_SEED=1 does not touch session/new when replay already fits in session/prompt", async () => {
  await withKit({
    agentVersion: "1.5.14",
    appendable: true,
    env: { AGY_BRIDGE_HISTORY_SEED: "1" },
  }, async (kit) => {
    replyOk(kit)
    const body = baseBody({
      metadata: { user_id: "seed-fits" },
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ],
    })
    await readSse(await kit.request(body))
    assert.equal(sessionNewCalls(kit).at(-1)?.params?._meta, undefined)
  })
})

test("AGY_BRIDGE_HISTORY_SEED=1 seeds oversized compaction prefix in multi-user opening turn", async () => {
  await withKit({
    agentVersion: "1.5.14",
    appendable: true,
    env: { AGY_BRIDGE_HISTORY_SEED: "1" },
  }, async (kit) => {
    replyOk(kit)
    const hugeSummary = "COMPACTION_HEAD\n" + "preserved file analysis and decisions line.\n".repeat(5200) + "\nCOMPACTION_TAIL"
    assert.ok(bytes(hugeSummary) > 200_000)
    const body = baseBody({
      metadata: { user_id: "seed-compaction" },
      messages: [
        { role: "user", content: hugeSummary },
        { role: "user", content: "EXECUTE_PLAN_NOW" },
      ],
    })
    const parsed = await readSse(await kit.request(body))
    assert.equal(parsed.stopReason, "end_turn")

    const append = sessionNewCalls(kit).at(-1)?.params?._meta?.antigravity?.systemPrompt?.append || ""
    assert.ok(append.includes("COMPACTION_HEAD") && append.includes("COMPACTION_TAIL"))
    const prompt = prompts(kit).at(-1)
    assert.ok(bytes(prompt) <= 184_000)
    assert.ok(prompt.includes("earlier context message(s) provided in session context"))
    assert.ok(prompt.includes("EXECUTE_PLAN_NOW"))
    assert.ok(!prompt.includes("COMPACTION_HEAD"), "seeded summary is not duplicated in session/prompt")
  })
})

test("AGY_BRIDGE_HISTORY_SEED_MAX_BYTES caps seeded payload cleanly", async () => {
  await withKit({
    agentVersion: "1.5.14",
    appendable: true,
    env: {
      AGY_BRIDGE_HISTORY_SEED: "1",
      AGY_BRIDGE_MAX_PROMPT_BYTES: String(24 * 1024),
      AGY_BRIDGE_HISTORY_SEED_MAX_BYTES: String(32 * 1024),
    },
  }, async (kit) => {
    replyOk(kit)
    const messages = [{ role: "user", content: "SEED_ANCHOR" }]
    for (let i = 0; i < 8; i++) {
      messages.push({ role: "assistant", content: `blk-${i} ` + "seed overflow line.\n".repeat(600) })
      messages.push({ role: "user", content: `u-${i}` })
    }
    messages.push({ role: "user", content: "FINAL_TURN" })
    await readSse(await kit.request(baseBody({ metadata: { user_id: "seed-cap" }, messages })))
    const append = sessionNewCalls(kit).at(-1)?.params?._meta?.antigravity?.systemPrompt?.append || ""
    assert.ok(bytes(append) > 0 && bytes(append) <= 32 * 1024, `seed is ${bytes(append)} bytes`)
    assert.ok(append.startsWith("<earlier_conversation_history>\n"))
    assert.ok(append.endsWith("</earlier_conversation_history>"))
  })
})

test("session/resume omits _meta.systemPrompt.append for a seeded session so agy retains the seed", async () => {
  await withKit({
    agentVersion: "1.5.14",
    appendable: true,
    sessionResume: true,
    env: {
      AGY_BRIDGE_SYSTEM_APPEND: "1",
      AGY_BRIDGE_HISTORY_SEED: "1",
      AGY_BRIDGE_MAX_PROMPT_BYTES: String(24 * 1024),
      AGY_BRIDGE_MAX_PROCS: "1",
    },
  }, async (kit) => {
    replyOk(kit)
    const hugeSummary = "RESUME_SEED_HEAD\n" + "context line.\n".repeat(3000) + "\nRESUME_SEED_TAIL"
    const firstMessages = [
      { role: "user", content: hugeSummary },
      { role: "user", content: "turn one" },
    ]
    await readSse(await kit.request(baseBody({
      system: "Client instructions.",
      metadata: { user_id: "seed-resume" },
      messages: firstMessages,
    })))
    const firstAppend = sessionNewCalls(kit).at(-1)?.params?._meta?.antigravity?.systemPrompt?.append || ""
    assert.ok(firstAppend.includes("Client instructions.") && firstAppend.includes("RESUME_SEED_HEAD"))

    // Evict via LRU with a second conversation so the first conversation parks and resumes.
    await readSse(await kit.request(baseBody({
      system: "Other instructions.",
      metadata: { user_id: "seed-resume-evictor" },
      messages: [{ role: "user", content: "evict" }],
    })))
    const nextMessages = [
      ...firstMessages,
      { role: "assistant", content: "ok" },
      { role: "user", content: "turn two" },
    ]
    await readSse(await kit.request(baseBody({
      system: "Client instructions.",
      metadata: { user_id: "seed-resume" },
      messages: nextMessages,
    })))
    const resume = sessionResumeCalls(kit).at(-1)
    assert.ok(resume, "expected session/resume after idle eviction")
    assert.equal(resume.params._meta, undefined, "session/resume must omit _meta to preserve seeded systemPrompt.append")
  })
})
