import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

// An update can leave both hosts serving requests with the same parked index.
async function withSharedState(fn) {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), "agy-park-reread-"))
  const stateFile = path.join(shared, "magpie-agy-bridge", "sessions.json")
  const kits = []
  const start = async ({ env, ...options } = {}) => {
    const kit = await createBridgeKit({ agentVersion: "1.5.17", sessionResume: true, ...options,
      env: { ...env, XDG_STATE_HOME: shared } })
    kits.push(kit)
    return kit
  }
  const entries = () => JSON.parse(fs.readFileSync(stateFile, "utf8")).entries
  try {
    await fn(start, entries)
  } finally {
    for (const kit of kits.reverse()) await kit.dispose().catch(() => {})
    fs.rmSync(shared, { recursive: true, force: true })
  }
}

const OPENING = "ORIGINAL-OPENING: review the existing work"
const FIRST_REPLY = "ORIGINAL-REPLY: here is what I found"
const TAIL = "NEW-TAIL: go on with the next part"
const opening = (content = OPENING) => baseBody({ messages: [{ role: "user", content }] })

async function complete(kit, body, reply) {
  kit.prompts.push(async (agent) => {
    await agent.text(reply)
    return { stopReason: "end_turn" }
  })
  const parsed = await readSse(await kit.request(body))
  assert.equal(parsed.stopReason, "end_turn")
  assert.equal(parsed.content.map((block) => block.text || "").join(""), reply)
  return { ...body, messages: [...body.messages, { role: "assistant", content: parsed.content }] }
}

const withUser = (body, content) => ({ ...body, messages: [...body.messages, { role: "user", content }] })

async function assertResumes(kit, history, sessionId) {
  const start = kit.acpLog.length
  await complete(kit, withUser(history, TAIL), "continued")
  const calls = kit.acpLog.slice(start)
  assert.deepEqual(calls.filter(({ method }) => method === "session/resume").map(({ params }) => params.sessionId), [sessionId])
  assert.equal(calls.filter(({ method }) => method === "session/new").length, 0)
  const prompts = calls.filter(({ method }) => method === "session/prompt")
  assert.equal(prompts.length, 1, "the resumed turn sends no seed prompts")
  const text = prompts[0].params.prompt.map((part) => part.type === "text" ? part.text : "").join("")
  assert.ok(text.includes(TAIL))
  for (const message of history.messages) {
    const earlier = typeof message.content === "string" ? [message.content] : message.content.map((part) => part.text)
    for (const priorText of earlier) assert.ok(!text.includes(priorText), "the resumed prompt repeats an earlier message")
  }
}

test("a host finds a conversation parked after it first loaded the index", async () => {
  await withSharedState(async (start, entries) => {
    const a = await start()
    const b = await start()
    await complete(b, opening("unrelated conversation"), "answered elsewhere")
    assert.equal(entries().length, 1)

    const history = await complete(a, opening(), FIRST_REPLY)
    const parked = entries().at(-1)
    assert.equal(parked.sessionId, a.acpLog.find(({ method }) => method === "session/prompt").params.sessionId)
    await a.finishChildren()

    await assertResumes(b, history, parked.sessionId)
  })
})

test("a host uses a newer parked checkpoint when it has an older one in memory", async () => {
  await withSharedState(async (start, entries) => {
    const a = await start()
    let history = await complete(a, opening(), FIRST_REPLY)
    const older = entries()[0]
    const b = await start()
    // Completing another conversation loads the old checkpoint without taking it.
    await complete(b, opening("unrelated conversation"), "answered elsewhere")

    a.clock.advance(1000)
    history = await complete(a, withUser(history, "SECOND-REQUEST: check the details"), "SECOND-REPLY: details checked")
    const newer = entries().find(({ key }) => key === older.key)
    assert.equal(newer.sessionId, older.sessionId)
    assert.ok(newer.at > older.at)
    assert.notEqual(newer.historyHash, older.historyHash)
    await a.finishChildren()

    await assertResumes(b, history, newer.sessionId)
  })
})

test("the earliest conversation is still resumable after parking 40 conversations", async () => {
  await withSharedState(async (start, entries) => {
    // Keep the idle-process limit from retiring and re-parking a conversation.
    const a = await start({ env: { AGY_BRIDGE_MAX_PROCS: "40" } })
    const history = await complete(a, opening(), FIRST_REPLY)
    const first = entries()[0]
    for (let i = 1; i < 40; i++) {
      a.clock.advance(1000)
      await complete(a, opening(`separate conversation ${i}`), "answered")
    }
    await a.finishChildren()

    const b = await start({ clockStart: a.clock.now() })
    await assertResumes(b, history, first.sessionId)
    assert.equal(entries().length, 40)
  })
})

test("matching a long live history does not serialize all its rows at once", async () => {
  // Count individual stringify results inside the bridge's isolated VM.
  const kit = await createBridgeKit({ indexTransform: source => source + `
    export function measureHistoryMatch(expected, actual) {
      const stringify = JSON.stringify
      let largest = 0
      try {
        JSON.stringify = (...args) => {
          const s = stringify(...args)
          largest = Math.max(largest, s?.length || 0)
          return s
        }
        const matches = Proc.prototype.matchesHistory.call({ expectedMessages: expected }, actual)
        return { matches, largest }
      } finally {
        JSON.stringify = stringify
      }
    }` })
  try {
    const text = "x".repeat(32 * 1024)
    const rows = Array.from({ length: 128 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user", content: text + i,
    }))
    const { matches, largest } = kit.module.measureHistoryMatch(rows, structuredClone(rows))
    assert.ok(matches)
    assert.ok(largest < 2 * text.length, `materialized a ${largest}-character string for 128 rows`)
  } finally {
    await kit.dispose()
  }
})

test("parked history digests keep the previous canonical JSON format", async () => {
  await withSharedState(async (start, entries) => {
    const kit = await start()
    const text = 'quotes " and newline\n羽'
    await complete(kit, opening(text), FIRST_REPLY)
    const rows = [ [ "user", text ], [ "assistant", FIRST_REPLY ] ].map(([role, value]) => ({
      content: [{ text: value, type: "text" }], role,
    }))
    const oldDigest = createHash("sha256").update(JSON.stringify(rows)).digest("hex")
    assert.equal(entries()[0].historyHash, oldDigest)
    assert.equal(entries()[0].historyHashSansInputs, oldDigest)
  })
})

test("sameHistory and historyDigest agree with historyKey across shape and length cases", async () => {
  const kit = await createBridgeKit({
    indexTransform: (source) => source + "\nexport { sameHistory, historyKey, historyDigest }\n",
  })
  try {
    const base = [
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      { role: "user", content: "second question" },
      { role: "assistant", content: [{ type: "text", text: "second answer" }] },
    ]
    const cases = [
      ["equal history", base, structuredClone(base), true],
      [
        "middle edit",
        base,
        [base[0], { role: "assistant", content: [{ type: "text", text: "edited answer" }] }, base[2], base[3]],
        false,
      ],
      ["shorter history", base, base.slice(0, 2), false],
      ["longer history", base, [...base, { role: "user", content: "extra trailing turn" }], false],
      [
        "fork",
        base,
        [...base.slice(0, 3), { role: "assistant", content: [{ type: "text", text: "different branch" }] }],
        false,
      ],
      [
        "same-role run split in two",
        [{ role: "user", content: "hello world" }, { role: "assistant", content: "ok" }],
        [{ role: "user", content: "hello " }, { role: "user", content: "world" }, { role: "assistant", content: "ok" }],
        true,
      ],
      ["whitespace-only trailing row", base, [...base, { role: "user", content: " \n\t " }], true],
      ["whitespace-only row alone matches empty", [{ role: "user", content: " \n\t " }], [], true],
      [
        "whitespace-only role switch splits same-role run",
        [{ role: "user", content: "hello" }, { role: "assistant", content: "  " }, { role: "user", content: "world" }],
        [{ role: "user", content: "hello" }, { role: "user", content: "world" }],
        false,
      ],
      [
        "tool_use and tool_result with renumbered ids and undefined field",
        [
          { role: "assistant", content: [{ type: "tool_use", id: "call_a", name: "Read", input: { path: "a.js" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_a", content: "ok" }] },
        ],
        [
          { role: "assistant", content: [{ type: "tool_use", id: "call_b", name: "Read", input: { path: "a.js", extra: undefined } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_b", content: "ok" }] },
        ],
        true,
      ],
    ]
    for (const [name, expected, actual, want] of cases) {
      const got = kit.module.sameHistory(expected, actual)
      const oracle = kit.module.historyKey(expected) === kit.module.historyKey(actual)
      assert.equal(got, oracle, `${name}: sameHistory disagreed with historyKey`)
      assert.equal(got, want, `${name}: unexpected match result`)
      for (const msgs of [expected, actual]) {
        assert.equal(
          kit.module.historyDigest(msgs),
          createHash("sha256").update(kit.module.historyKey(msgs)).digest("hex"),
          `${name}: historyDigest disagreed with historyKey`,
        )
      }
    }
  } finally {
    await kit.dispose()
  }
})
