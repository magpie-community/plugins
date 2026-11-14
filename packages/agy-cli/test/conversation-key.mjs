import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { after, test } from "node:test"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

// Expose private seams from an isolated copy, without adding production exports.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agy-convkey-test-"))
const entry = new URL("../index.mjs", import.meta.url)
let source = fs.readFileSync(entry, "utf8")
source = source.replace(/from "(\.\/[^"\n]+)"/g, (_, target) => `from ${JSON.stringify(new URL(target, entry).href)}`)
process.env.AGY_BRIDGE_STATE_FILE = path.join(workspace, "sessions.json")
process.env.HOME = workspace
fs.writeFileSync(
  path.join(workspace, "bridge.mjs"),
  source + "\nexport { conversationKey, stripVolatileOpening, stripVolatileSystem, isContinuedOpening, openingTextOf, sameInstructions, historyKey, takeParked, park, instructionsIdentity, Turn };\n",
)
const {
  conversationKey,
  stripVolatileOpening,
  stripVolatileSystem,
  isContinuedOpening,
  openingTextOf,
  sameInstructions,
  historyKey,
  takeParked,
  park,
  instructionsIdentity,
  Turn,
} = await import(pathToFileURL(path.join(workspace, "bridge.mjs")).href)
after(() => fs.rmSync(workspace, { recursive: true, force: true }))

function body({ system, first, rest = [], userId } = {}) {
  const messages = []
  if (first != null) messages.push(typeof first === "string" ? { role: "user", content: first } : first)
  messages.push(...rest)
  const out = { model: "agy-cli/test-model", messages }
  if (system != null) out.system = system
  if (userId != null) out.metadata = { user_id: userId }
  return out
}

const STABLE = "Please review the following project files and propose a short fix.\n"

test("stripVolatileSystem removes billing headers, cch tokens, and known clock lines", () => {
  const raw = [
    "x-anthropic-billing-header: cc_version=2.0; cc_entrypoint=cli; cch=deadbeef01;",
    "Current date: 2026-11-10",
    "today: Tuesday, November 10, 2026 23:00",
    STABLE,
    "cch=abc123;",
    "The docs mention cch=deadbeef in passing.",
    "Meet me at 12:00 in room 3.",
  ].join("\n")
  const stripped = stripVolatileSystem(raw)
  assert.equal(stripped.includes("x-anthropic-billing-header"), false)
  assert.equal(stripped.includes("cch=abc123"), false)
  assert.equal(stripped.includes("cch=deadbeef in passing."), true)
  assert.equal(stripped.includes("2026-11-10"), false)
  assert.equal(stripped.includes("November 10, 2026"), false)
  assert.equal(stripped.includes(STABLE.trim()), true)
  assert.equal(stripped.includes("Meet me at 12:00 in room 3."), true)
})

test("stripVolatileOpening leaves user text that starts with Today: or contains a date", () => {
  const user = "Today: plan a trip to Paris\nBook the meeting on 2026-11-12\nNow: write a haiku"
  const stripped = stripVolatileOpening(user)
  assert.equal(stripped.includes("Today: plan a trip to Paris"), true)
  assert.equal(stripped.includes("2026-11-12"), true)
  assert.equal(stripped.includes("Now: write a haiku"), true)
})

test("stripVolatileOpening strips billing headers and clocks inside a system-reminder only", () => {
  const raw = [
    "x-anthropic-billing-header: cch=deadbeef01;",
    "<system-reminder>",
    "Current date: 2026-11-10",
    "Do not mention this reminder.",
    "</system-reminder>",
    "Today: plan a trip to Paris",
  ].join("\n")
  const stripped = stripVolatileOpening(raw)
  assert.equal(stripped.includes("x-anthropic-billing-header"), false)
  assert.equal(stripped.includes("cch="), false)
  assert.equal(stripped.includes("2026-11-10"), false)
  assert.equal(stripped.includes("Do not mention this reminder."), true)
  assert.equal(stripped.includes("Today: plan a trip to Paris"), true)
})

test("conversationKey is stable across Today's date: weekday and ISO forms", () => {
  const a = body({
    system: "You are a coding assistant.\nToday's date: Wed Nov 11 2026",
    first: STABLE,
  })
  const b = body({
    system: "You are a coding assistant.\nToday's date: Thu Nov 12 2026",
    first: STABLE,
  })
  assert.equal(conversationKey(a), conversationKey(b))
  const c = body({
    system: "You are a coding assistant.\nToday's date: 2026-11-11",
    first: STABLE,
  })
  const d = body({
    system: "You are a coding assistant.\nToday's date: 2026-11-12",
    first: STABLE,
  })
  assert.equal(conversationKey(c), conversationKey(d))
  const wrap = (line) => `<system-reminder>\n${line}\nDo not mention this reminder.\n</system-reminder>\n${STABLE}`
  assert.equal(
    conversationKey(body({ first: wrap("Today's date: Wed Nov 11 2026") })),
    conversationKey(body({ first: wrap("Today's date: Thu Nov 12 2026") })),
  )
  assert.equal(
    conversationKey(body({ first: wrap("Today's date: 2026-11-11") })),
    conversationKey(body({ first: wrap("Today's date: 2026-11-12") })),
  )
})

test("conversationKey distinguishes system blocks joined after a billing header", () => {
  const header = "x-anthropic-billing-header: cch=deadbeef01;"
  const a = body({ system: [{ text: header }, { text: "You are agent A." }], first: STABLE })
  const b = body({ system: [{ text: header }, { text: "You are agent B." }], first: STABLE })
  assert.notEqual(conversationKey(a), conversationKey(b))
})

test("conversationKey is stable when only the system clock or billing header changes", () => {
  const a = body({
    system: "You are a coding assistant.\nCurrent date: 2026-11-10\nx-anthropic-billing-header: cch=aaa111;",
    first: STABLE + "File A contents.",
    userId: "user-1",
  })
  const b = body({
    system: "You are a coding assistant.\nCurrent date: 2026-11-11\nx-anthropic-billing-header: cch=bbb222;",
    first: STABLE + "File A contents.",
    userId: "user-1",
  })
  assert.equal(conversationKey(a), conversationKey(b))
})

test("conversationKey is stable when only an opening system-reminder clock or cch token changes", () => {
  const wrap = (clock, token) =>
    `x-anthropic-billing-header: ${token}\n<system-reminder>\nCurrent time: ${clock}\n</system-reminder>\n${STABLE}`
  const a = body({ first: wrap("2026-11-10T01:02:03Z", "cch=111aaa;") })
  const b = body({ first: wrap("2026-11-10T09:08:07Z", "cch=222bbb;") })
  assert.equal(conversationKey(a), conversationKey(b))
})

test("conversationKey stays the same after later assistant and user turns are attached", () => {
  const first = STABLE + "Please start with src/app.ts."
  const turn1 = body({ system: "Be concise.", first })
  const turn2 = body({
    system: "Be concise.",
    first,
    rest: [
      { role: "assistant", content: "I will inspect src/app.ts." },
      { role: "user", content: "Also check the tests." },
    ],
  })
  assert.equal(conversationKey(turn1), conversationKey(turn2))
})

test("conversationKey hashes the whole first message, so a shared 8 KiB prefix is not enough", () => {
  const log = "LOG " + "X".repeat(9000)
  const a = body({ system: "Same system", first: log + "\nQuestion A short" })
  const b = body({ system: "Same system", first: log + "\nQuestion B is a longer question than A" })
  assert.notEqual(conversationKey(a), conversationKey(b))
  // A flattened growing first message also changes the key (safer than sharing a prefix window).
  const opening = log + "\nQuestion A short"
  assert.notEqual(
    conversationKey(body({ first: opening })),
    conversationKey(body({ first: opening + "\n--- later flattened turn ---\nbeta suffix" })),
  )
})

test("conversationKey keeps user Today:/Now:/Date lines and in-message dates", () => {
  assert.notEqual(
    conversationKey(body({ first: "Today: plan a trip to Paris" })),
    conversationKey(body({ first: "Today: plan a trip to Rome" })),
  )
  assert.notEqual(
    conversationKey(body({ first: "Now: delete the staging database" })),
    conversationKey(body({ first: "Now: write a haiku" })),
  )
  assert.notEqual(
    conversationKey(body({ first: "Book the meeting on 2026-11-12" })),
    conversationKey(body({ first: "Book the meeting on 2026-12-25" })),
  )
  assert.notEqual(
    conversationKey(body({ first: "Time: pack for the flight" })),
    conversationKey(body({ first: "Time: unpack the boxes" })),
  )
  assert.notEqual(
    conversationKey(body({ first: "Date: book the hall" })),
    conversationKey(body({ first: "Date: cancel the hall" })),
  )
})

test("historyKey does not strip dates from later user or assistant messages", () => {
  const a = historyKey([
    { role: "user", content: STABLE },
    { role: "assistant", content: "Noted." },
    { role: "user", content: "Book the meeting on 2026-11-12" },
  ])
  const b = historyKey([
    { role: "user", content: STABLE },
    { role: "assistant", content: "Noted." },
    { role: "user", content: "Book the meeting on 2026-12-25" },
  ])
  assert.notEqual(a, b)
})

test("historyKey still ignores clock lines inside later system-reminder blocks", () => {
  const wrap = (date) =>
    STABLE + "\n<system-reminder>\nCurrent date: " + date + "\n</system-reminder>"
  const a = historyKey([
    { role: "user", content: STABLE },
    { role: "assistant", content: "Noted." },
    { role: "user", content: wrap("2026-11-12") },
  ])
  const b = historyKey([
    { role: "user", content: STABLE },
    { role: "assistant", content: "Noted." },
    { role: "user", content: wrap("2026-12-25") },
  ])
  assert.equal(a, b)
})

test("user prose that mentions cch= tokens is not collapsed by billing stripping", () => {
  assert.notEqual(
    conversationKey(body({ first: "the header used cch=aaa111 in the example" })),
    conversationKey(body({ first: "the header used cch=bbb222 in the example" })),
  )
})

test("conversationKey changes for a genuinely different first message or user id", () => {
  const base = body({ system: "S", first: STABLE, userId: "a" })
  assert.notEqual(conversationKey(base), conversationKey(body({ system: "S", first: STABLE + "other", userId: "a" })))
  assert.notEqual(conversationKey(base), conversationKey(body({ system: "S", first: STABLE, userId: "b" })))
  assert.notEqual(conversationKey(base), conversationKey(body({ system: "Other system", first: STABLE, userId: "a" })))
})

test("sameInstructions ignores volatile date and billing lines", () => {
  assert.equal(
    sameInstructions("Rules.\nCurrent date: 2026-11-10\n", "Rules.\nCurrent date: 2026-11-11\n"),
    true,
  )
  assert.equal(sameInstructions("Rules A", "Rules B"), false)
})

const png = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=" } }
const gif = { type: "image", source: { type: "base64", media_type: "image/gif", data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" } }

test("conversationKey includes first-message images, so different pictures do not share a key", () => {
  const caption = { role: "user", content: [{ type: "text", text: "compare pictures " }, png, { type: "text", text: " and " }, gif] }
  const swapped = { role: "user", content: [{ type: "text", text: "compare pictures " }, gif, { type: "text", text: " and " }, png] }
  const same = { role: "user", content: [{ type: "text", text: "compare pictures " }, png, { type: "text", text: " and " }, gif] }
  assert.equal(conversationKey(body({ first: caption })), conversationKey(body({ first: same })))
  assert.notEqual(conversationKey(body({ first: caption })), conversationKey(body({ first: swapped })))
  const continued = body({
    first: caption,
    rest: [
      { role: "assistant", content: "They differ." },
      { role: "user", content: "recall the pictures" },
    ],
  })
  assert.equal(conversationKey(body({ first: caption })), conversationKey(continued))
})

function continuedProc(first, assistant = "done", images) {
  const opening = typeof first === "string" ? { role: "user", content: first } : first
  const proc = {
    openingText: openingTextOf(opening),
    expectedMessages: [opening, { role: "assistant", content: assistant }],
  }
  if (images !== undefined) proc.openingImages = images
  return proc
}

test("isContinuedOpening requires the full previous opening, not a shared prefix", () => {
  const first = { role: "user", content: STABLE + "step one" }
  const grown = { role: "user", content: STABLE + "step one\n\nassistant: done\n\nstep two is longer than four chars" }
  const proc = continuedProc(first, "done")
  assert.equal(isContinuedOpening(proc, first), false)
  assert.equal(isContinuedOpening(proc, grown), true)
  assert.equal(isContinuedOpening(proc, { role: "user", content: "totally different task" }), false)
  assert.equal(isContinuedOpening({ openingText: "" }, grown), false)
  // A longer independent prompt that only shares a prefix is not a continuation,
  // even when it starts on a new line or extends the same sentence.
  assert.equal(isContinuedOpening(proc, { role: "user", content: STABLE + "step one and also the tests please" }), false)
  assert.equal(isContinuedOpening(proc, { role: "user", content: STABLE + "step one\nand also the tests please" }), false)
  assert.equal(isContinuedOpening(continuedProc(first, "ok"), { role: "user", content: STABLE + "step one\n\nokay, also look at the tests" }), false)
  const log = "LOG " + "X".repeat(9000)
  const chatA = { role: "user", content: log + "\nQuestion A short" }
  const chatB = { role: "user", content: log + "\nQuestion B is a longer question than A" }
  assert.equal(isContinuedOpening(continuedProc(chatA, "done"), chatB), false)
  // A 12-character reply must still end on a line boundary; a same-line
  // prefix extension is not a continuation.
  const longReply = "abcdefghijkl"
  assert.equal(longReply.length, 12)
  assert.equal(
    isContinuedOpening(continuedProc(first, longReply), {
      role: "user",
      content: STABLE + "step one\n\nassistant: " + longReply + "nop independent text",
    }),
    false,
  )
  assert.equal(
    isContinuedOpening(continuedProc(first, longReply), {
      role: "user",
      content: STABLE + "step one\n\nassistant: " + longReply + "\n\nstep two is longer than four chars",
    }),
    true,
  )
})

test("isContinuedOpening keeps first-message images in the continuation identity", () => {
  const first = { role: "user", content: [{ type: "text", text: STABLE + "compare pictures" }, png] }
  const grownSame = {
    role: "user",
    content: [
      { type: "text", text: STABLE + "compare pictures\n\nassistant: done\n\nwhat changed" },
      png,
    ],
  }
  const grownOther = {
    role: "user",
    content: [
      { type: "text", text: STABLE + "compare pictures\n\nassistant: done\n\nwhat changed" },
      gif,
    ],
  }
  const proc = continuedProc(first, "done")
  // openingImages is taken from the first expected message when not stored.
  assert.equal(isContinuedOpening(proc, grownSame), true)
  assert.equal(isContinuedOpening(proc, grownOther), false)
})

test("takeParked uses the same instruction stripping, so a clock change still resumes", () => {
  const convKey = "test-parked-key"
  const history = [{ role: "user", content: STABLE }, { role: "assistant", content: "ok" }]
  park({
    convKey,
    sessionId: "sess-parked",
    expectedMessages: history,
    instructions: "Rules.\nCurrent date: 2026-11-10\n",
    workDir: "/tmp/agy-park-test",
    hasSentFirstTurn: true,
    historyInvalid: false,
    turn: null,
    dead: false,
    canPark() { return true },
  })
  const resumed = takeParked(convKey, {
    workDir: "/tmp/agy-park-test",
    instructions: "Rules.\nCurrent date: 2026-11-11\n",
    history,
  })
  assert.ok(resumed, "clock-only change must still take the parked session")
  assert.equal(resumed.sessionId, "sess-parked")
  assert.equal(
    instructionsIdentity("Rules.\nCurrent date: 2026-11-10\n"),
    instructionsIdentity("Rules.\nCurrent date: 2026-11-11\n"),
  )
})

async function withKit(options, fn) {
  const kit = await createBridgeKit(options)
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

function promptSessions(kit) {
  return kit.acpLog
    .filter((entry) => entry.method === "session/prompt")
    .map((entry) => entry.params?.sessionId || entry.sessionId)
}

function promptEntries(kit) {
  return kit.acpLog.filter((entry) => entry.method === "session/prompt")
}

function promptText(entry) {
  const parts = entry?.params?.prompt || []
  return parts.map((part) => (part?.type === "text" ? part.text || "" : "")).join("")
}

test("stripVolatileOpening is linear even with many unclosed system-reminder tags", () => {
  const unclosed = "<system-reminder>\n".repeat(20_000)
  const text = unclosed + "<system-reminder>\nToday's date: Wed Nov 11 2026\nKeep me.\n</system-reminder>\nuser text"
  const started = Date.now()
  const stripped = stripVolatileOpening(text)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 500, `expected <500ms for 20k unclosed tags, took ${elapsed}ms`)
  assert.equal(stripped.includes("Today's date:"), false)
  assert.equal(stripped.includes("Wed Nov 11 2026"), false)
  assert.equal(stripped.includes("Keep me."), true)
  assert.equal(stripped.includes("user text"), true)
})

test("stripVolatileOpening is linear when no system-reminder is ever closed", () => {
  const clock = "Today's date: Wed Nov 11 2026\n"
  const text = ("<system-reminder>\n" + clock).repeat(20_000) + "user text"
  const started = Date.now()
  const stripped = stripVolatileOpening(text)
  const elapsed = Date.now() - started
  assert.ok(elapsed < 500, `expected <500ms for 20k never-closed tags, took ${elapsed}ms`)
  assert.equal(stripped.includes("Today's date:"), true, "clocks in unclosed tags must stay")
  assert.equal(stripped.includes("user text"), true)
})

test("conversationKey stays stable when İ precedes a dated system-reminder", () => {
  const wrap = (n, date) =>
    "İ".repeat(n) + `<system-reminder>\nToday's date: ${date}\nKeep me.\n</system-reminder>\n${STABLE}`
  for (const n of [4, 200]) {
    const a = wrap(n, "Wed Nov 11 2026")
    const b = wrap(n, "Thu Nov 12 2026")
    const stripped = stripVolatileOpening(a)
    assert.equal(stripped.includes("Today's date:"), false, `date must be stripped after ${n} İ`)
    assert.equal(stripped.includes("Wed Nov 11 2026"), false)
    assert.equal(stripped.includes("Keep me."), true)
    assert.equal(stripped.startsWith("İ".repeat(n)), true)
    assert.equal(
      conversationKey(body({ first: a })),
      conversationKey(body({ first: b })),
      `key must stay stable across a date change after ${n} İ`,
    )
  }
  const iso = (n, date) =>
    "İ".repeat(n) + `<system-reminder>\nToday's date: ${date}\nKeep me.\n</system-reminder>\n${STABLE}`
  assert.equal(
    conversationKey(body({ first: iso(4, "2026-11-11") })),
    conversationKey(body({ first: iso(4, "2026-11-12") })),
  )
  assert.equal(
    conversationKey(body({ first: iso(200, "2026-11-11") })),
    conversationKey(body({ first: iso(200, "2026-11-12") })),
  )
})

test("two chats that share an 8 KiB first-message prefix get distinct fake agy sessions", async () => {
  await withKit({}, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      await agent.text("ok")
      return { stopReason: "end_turn" }
    }
    const log = "LOG " + "X".repeat(9000)
    const system = "You are a test agent."
    const chatA = baseBody({
      system,
      messages: [{ role: "user", content: log + "\nQuestion A short" }],
    })
    const chatB = baseBody({
      system,
      messages: [{ role: "user", content: log + "\nQuestion B is a longer question than A" }],
    })
    const first = await readSse(await kit.request(chatA))
    assert.equal(first.stopReason, "end_turn")
    const second = await readSse(await kit.request(chatB))
    assert.equal(second.stopReason, "end_turn")
    const sessions = promptSessions(kit)
    assert.equal(sessions.length, 2, `expected two prompts, got ${JSON.stringify(sessions)}`)
    assert.notEqual(sessions[0], sessions[1], `chat B must get its own session, got ${JSON.stringify(sessions)}`)
  })
})

test("the same chat with only a system clock change reuses the fake agy session", async () => {
  await withKit({}, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      await agent.text("ok")
      return { stopReason: "end_turn" }
    }
    const firstMsg = STABLE + "Please start with src/app.ts."
    const turn1 = baseBody({
      system: "You are a test agent.\nCurrent date: 2026-11-10",
      messages: [{ role: "user", content: firstMsg }],
    })
    const parsed = await readSse(await kit.request(turn1))
    assert.equal(parsed.stopReason, "end_turn")
    const turn2 = baseBody({
      system: "You are a test agent.\nCurrent date: 2026-11-11",
      messages: [
        { role: "user", content: firstMsg },
        { role: "assistant", content: parsed.content?.map?.((b) => b.text).join("") || "ok" },
        { role: "user", content: "continue" },
      ],
    })
    const again = await readSse(await kit.request(turn2))
    assert.equal(again.stopReason, "end_turn")
    const sessions = promptSessions(kit)
    assert.equal(sessions.length, 2, `expected two prompts, got ${JSON.stringify(sessions)}`)
    assert.equal(sessions[0], sessions[1], `clock-only change must reuse the session, got ${JSON.stringify(sessions)}`)
  })
})

test("a flattened growing first message reuses the live fake agy session", async () => {
  await withKit({}, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      await agent.text("ok")
      return { stopReason: "end_turn" }
    }
    const opening = STABLE + "step one"
    const first = await readSse(await kit.request(baseBody({
      system: "You are a test agent.",
      messages: [{ role: "user", content: opening }],
    })))
    assert.equal(first.stopReason, "end_turn")
    const reply = first.content?.map?.((b) => b.text).join("") || "ok"
    const grown = opening + "\n\nassistant: " + reply + "\n\nstep two is longer than four chars"
    const second = await readSse(await kit.request(baseBody({
      system: "You are a test agent.",
      messages: [{ role: "user", content: grown }],
    })))
    assert.equal(second.stopReason, "end_turn")
    const sessions = promptSessions(kit)
    assert.equal(sessions.length, 2, `expected two prompts, got ${JSON.stringify(sessions)}`)
    assert.equal(sessions[0], sessions[1], `flattened growth must reuse the session, got ${JSON.stringify(sessions)}`)
    // The key still changes; reuse is via isContinuedOpening, not a shared key.
    assert.notEqual(
      conversationKey(body({ system: "You are a test agent.", first: opening })),
      conversationKey(body({ system: "You are a test agent.", first: grown })),
    )
  })
})

test("an independent prompt that only extends the previous opening gets its own session", async () => {
  await withKit({}, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      await agent.text("ok")
      return { stopReason: "end_turn" }
    }
    const opening = STABLE + "Review README"
    const first = await readSse(await kit.request(baseBody({
      system: "You are a test agent.",
      messages: [{ role: "user", content: opening }],
    })))
    assert.equal(first.stopReason, "end_turn")
    const other = opening + " and tests in detail please"
    const second = await readSse(await kit.request(baseBody({
      system: "You are a test agent.",
      messages: [{ role: "user", content: other }],
    })))
    assert.equal(second.stopReason, "end_turn")
    const sessions = promptSessions(kit)
    assert.equal(sessions.length, 2, `expected two prompts, got ${JSON.stringify(sessions)}`)
    assert.notEqual(sessions[0], sessions[1], `phrase extension must not reuse the session, got ${JSON.stringify(sessions)}`)
  })
})

test("a reused flattened session sends only the new turn, not earlier openings or replies", async () => {
  await withKit({}, async (kit) => {
    const replies = ["reply-one-ok", "reply-two-ok", "reply-three-ok"]
    let n = 0
    kit.defaultPrompt = async (agent) => {
      await agent.text(replies[n++] || "ok")
      return { stopReason: "end_turn" }
    }
    const opening = STABLE + "step one"
    const first = await readSse(await kit.request(baseBody({
      system: "You are a test agent.",
      messages: [{ role: "user", content: opening }],
    })))
    assert.equal(first.stopReason, "end_turn")
    const reply1 = first.content?.map?.((b) => b.text).join("") || replies[0]
    const grown2 = opening + "\n\nassistant: " + reply1 + "\n\nstep two is longer than four chars"
    const second = await readSse(await kit.request(baseBody({
      system: "You are a test agent.",
      messages: [{ role: "user", content: grown2 }],
    })))
    assert.equal(second.stopReason, "end_turn")
    const reply2 = second.content?.map?.((b) => b.text).join("") || replies[1]
    const grown3 = grown2 + "\n\nassistant: " + reply2 + "\n\nstep three is also a new turn"
    const third = await readSse(await kit.request(baseBody({
      system: "You are a test agent.",
      messages: [{ role: "user", content: grown3 }],
    })))
    assert.equal(third.stopReason, "end_turn")
    const prompts = promptEntries(kit)
    assert.equal(prompts.length, 3, `expected three prompts, got ${prompts.length}`)
    const sessions = prompts.map((entry) => entry.params?.sessionId || entry.sessionId)
    assert.equal(sessions[0], sessions[1], `second turn must reuse the session, got ${JSON.stringify(sessions)}`)
    assert.equal(sessions[1], sessions[2], `third turn must reuse the session, got ${JSON.stringify(sessions)}`)
    const texts = prompts.map(promptText)
    const sizes = texts.map((text) => Buffer.byteLength(text, "utf8"))
    assert.equal(texts[1].includes("step two is longer than four chars"), true)
    assert.equal(texts[1].includes("step one"), false, `second prompt resent the opening: ${JSON.stringify(texts[1])}`)
    assert.equal(texts[1].includes(reply1), false, `second prompt resent the first reply: ${JSON.stringify(texts[1])}`)
    assert.equal(texts[1].includes(STABLE.trim()), false)
    assert.equal(texts[2].includes("step three is also a new turn"), true)
    assert.equal(texts[2].includes("step one"), false, `third prompt resent the opening: ${JSON.stringify(texts[2])}`)
    assert.equal(texts[2].includes("step two is longer than four chars"), false, `third prompt resent step two: ${JSON.stringify(texts[2])}`)
    assert.equal(texts[2].includes(reply1), false)
    assert.equal(texts[2].includes(reply2), false)
    assert.ok(sizes[1] < sizes[0], `second prompt (${sizes[1]}) should be smaller than the initial prompt (${sizes[0]})`)
    assert.ok(sizes[2] < sizes[0], `third prompt (${sizes[2]}) should stay smaller than the initial prompt (${sizes[0]})`)
    assert.ok(Math.abs(sizes[2] - sizes[1]) < 80, `prompt sizes must not grow quadratically: ${JSON.stringify(sizes)}`)
  })
})

test("two metadata.user_id values that share a flattened opening do not share a session", async () => {
  await withKit({}, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      await agent.text("ok")
      return { stopReason: "end_turn" }
    }
    const opening = STABLE + "step one"
    const first = await readSse(await kit.request(baseBody({
      system: "You are a test agent.",
      metadata: { user_id: "alice" },
      messages: [{ role: "user", content: opening }],
    })))
    assert.equal(first.stopReason, "end_turn")
    const reply = first.content?.map?.((b) => b.text).join("") || "ok"
    const grown = opening + "\n\nassistant: " + reply + "\n\nstep two is longer than four chars"
    const second = await readSse(await kit.request(baseBody({
      system: "You are a test agent.",
      metadata: { user_id: "bob" },
      messages: [{ role: "user", content: grown }],
    })))
    assert.equal(second.stopReason, "end_turn")
    const sessions = promptSessions(kit)
    assert.equal(sessions.length, 2, `expected two prompts, got ${JSON.stringify(sessions)}`)
    assert.notEqual(sessions[0], sessions[1], `different user_id values must not share a session, got ${JSON.stringify(sessions)}`)
  })
})

test("a 12-character reply prefix on the same line does not reuse the session", async () => {
  await withKit({}, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      await agent.text("abcdefghijkl")
      return { stopReason: "end_turn" }
    }
    const opening = STABLE + "step one"
    const first = await readSse(await kit.request(baseBody({
      system: "You are a test agent.",
      messages: [{ role: "user", content: opening }],
    })))
    assert.equal(first.stopReason, "end_turn")
    const reply = first.content?.map?.((b) => b.text).join("") || "abcdefghijkl"
    assert.ok(reply.length >= 12, `expected a long reply, got ${JSON.stringify(reply)}`)
    const other = opening + "\n\nassistant: " + reply + "nop independent text that only shares a prefix"
    const second = await readSse(await kit.request(baseBody({
      system: "You are a test agent.",
      messages: [{ role: "user", content: other }],
    })))
    assert.equal(second.stopReason, "end_turn")
    const sessions = promptSessions(kit)
    assert.equal(sessions.length, 2, `expected two prompts, got ${JSON.stringify(sessions)}`)
    assert.notEqual(sessions[0], sessions[1], `a same-line long-reply prefix must not reuse the session, got ${JSON.stringify(sessions)}`)
  })
})

test("a reused flattened session also sends user messages after the first", async () => {
  await withKit({}, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      await agent.text("ok")
      return { stopReason: "end_turn" }
    }
    const opening = STABLE + "step one"
    const first = await readSse(await kit.request(baseBody({
      system: "You are a test agent.",
      messages: [{ role: "user", content: opening }],
    })))
    assert.equal(first.stopReason, "end_turn")
    const reply = first.content?.map?.((b) => b.text).join("") || "ok"
    const grown = opening + "\n\nassistant: " + reply + "\n\nstep two is longer than four chars"
    const second = await readSse(await kit.request(baseBody({
      system: "You are a test agent.",
      messages: [
        { role: "user", content: grown },
        { role: "user", content: "and also the extra note after the flattened opening" },
      ],
    })))
    assert.equal(second.stopReason, "end_turn")
    const prompts = promptEntries(kit)
    assert.equal(prompts.length, 2)
    const sessions = prompts.map((entry) => entry.params?.sessionId || entry.sessionId)
    assert.equal(sessions[0], sessions[1], `must reuse the session, got ${JSON.stringify(sessions)}`)
    const text = promptText(prompts[1])
    assert.equal(text.includes("step two is longer than four chars"), true, `missing new turn: ${JSON.stringify(text)}`)
    assert.equal(text.includes("and also the extra note after the flattened opening"), true, `dropped the trailing user message: ${JSON.stringify(text)}`)
    assert.equal(text.includes("step one"), false, `resent the opening: ${JSON.stringify(text)}`)
    assert.equal(text.includes(reply), false, `resent the first reply: ${JSON.stringify(text)}`)
  })
})

test("a reused flattened session keeps a new document on the grown first message", async () => {
  await withKit({}, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      await agent.text("ok")
      return { stopReason: "end_turn" }
    }
    const opening = STABLE + "step one"
    const first = await readSse(await kit.request(baseBody({
      system: "You are a test agent.",
      messages: [{ role: "user", content: opening }],
    })))
    assert.equal(first.stopReason, "end_turn")
    const reply = first.content?.map?.((b) => b.text).join("") || "ok"
    const grown = {
      role: "user",
      content: [
        { type: "text", text: opening + "\n\nassistant: " + reply + "\n\nstep two is longer than four chars" },
        { type: "document", title: "notes.txt", source: { type: "text", data: "document body unique-xyz" } },
      ],
    }
    const second = await readSse(await kit.request(baseBody({
      system: "You are a test agent.",
      messages: [grown],
    })))
    assert.equal(second.stopReason, "end_turn")
    const prompts = promptEntries(kit)
    assert.equal(prompts.length, 2)
    const sessions = prompts.map((entry) => entry.params?.sessionId || entry.sessionId)
    assert.equal(sessions[0], sessions[1], `must reuse the session, got ${JSON.stringify(sessions)}`)
    const text = promptText(prompts[1])
    assert.equal(text.includes("step two is longer than four chars"), true, `missing new turn: ${JSON.stringify(text)}`)
    assert.equal(text.includes("document body unique-xyz"), true, `dropped the new document: ${JSON.stringify(text)}`)
    assert.equal(text.includes("step one"), false, `resent the opening: ${JSON.stringify(text)}`)
  })
})

// plugins#1137: a tool loop of screenshots kept every request body and
// copied each image whole into the history key on every round-trip.
function screenshotHistory(data) {
  return [
    { role: "user", content: "look" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "view_image", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [
      { type: "text", text: "shot" },
      { type: "image", source: { type: "base64", media_type: "image/png", data } },
    ] }] },
  ]
}

test("historyKey keys a tool_result image by its hash, not its bytes", () => {
  const data = "A".repeat(200_000)
  const key = historyKey(screenshotHistory(data))
  assert.ok(key.length < 2_000, `key is ${key.length} chars`)
  assert.ok(!key.includes("AAAAAAAAAAAAAAAA"))
  assert.notEqual(key, historyKey(screenshotHistory("B".repeat(200_000))))
  assert.equal(key, historyKey(screenshotHistory(data)))
})

test("a turn lets go of each earlier request body once the next one arrives", () => {
  const proc = { estimatePromptTokens: () => 100 }
  const turn = new Turn(proc, [{ role: "user", content: "hi" }])
  const bodies = [1, 2, 3].map((n) => ({ messages: screenshotHistory("C".repeat(n)) }))
  const steps = bodies.map((body) => {
    const step = turn.registerResponse(body)
    step.contentSnapshot = () => []
    return step
  })
  assert.equal(steps[0].body, null)
  assert.equal(steps[0].contentSnapshot, null)
  assert.equal(steps[1].body, null)
  assert.equal(steps[2].body, bodies[2], "the current step keeps its body for a late prompt")
  assert.equal(typeof steps[2].contentSnapshot, "function")
  assert.equal(turn.responseSteps.length, 3)
})
