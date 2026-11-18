// A spare agy: the next new conversation takes an agy already started and
// initialised (no session), so it skips agy's start. Sessions are never opened
// ahead: agy asks Google for the account at session/new.
//
// bun test ./spare.mjs

import { test } from "node:test"
import assert from "node:assert/strict"
import { MESSAGES_URL, baseBody, createBridgeKit, readSse, sleep } from "./testkit.mjs"

const SPARE_ON = { AGY_BRIDGE_SPARE: "1" }

async function withKit(options, fn) {
  const kit = await createBridgeKit({ ...options, env: { ...SPARE_ON, ...(options.env || {}) } })
  kit.defaultPrompt = async (agent) => {
    await agent.text("hello")
    return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 1 } }
  }
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

// Wait for a state, never a duration; the cap only bounds a hang.
async function until(what, check, capMs = 20_000) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > capMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

// Time to the first streamed text of one request.
async function ttft(send) {
  const started = performance.now()
  const response = await send()
  assert.equal(response.status, 200, await response.clone().text())
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ""
  let first = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
    if (first === null && text.includes("content_block_delta")) first = performance.now() - started
  }
  return Math.round(first)
}

const sessionsOn = (kit) => kit.acpLog.filter((entry) => entry.method === "session/new").map((entry) => entry.spawn)
const conversation = (n) => baseBody({ system: `conversation ${n}`, messages: [{ role: "user", content: `open ${n}` }] })

test("a second new conversation takes the warmed agy and skips agy's start", async () => {
  const INIT_MS = 1000
  await withKit({ initializeDelayMs: INIT_MS, sessionNewDelayMs: 3000 }, async (kit) => {
    const first = await ttft(() => kit.request(conversation(1)))
    // the spare is started after the first conversation's agy and initialised on its own
    await until("a spare agy initialised", () => kit.initialized === 2)
    const spawnsBefore = kit.acpSpawns.length
    const second = await ttft(() => kit.request(conversation(2)))
    console.log(`TTFT new conversation (agy start ${INIT_MS}ms, session/new 3000ms): first ${first}ms, second ${second}ms`)
    assert.equal(spawnsBefore, 2)
    // conversation 2 opened its session on the spare: spawn #1, not a new one
    assert.deepEqual(sessionsOn(kit).slice(0, 2), [0, 1])
    // agy's start is gone from it; half the start is room for a loaded machine
    assert.ok(second < first - INIT_MS / 2, `second ${second}ms, first ${first}ms`)
    // and another spare is warmed for the conversation after
    await until("the next spare", () => kit.acpSpawns.length === 3)
  })
})

test("a spare opens no session until a conversation takes it", async () => {
  await withKit({}, async (kit) => {
    await readSse(await kit.request(conversation(1)))
    await until("a spare agy initialised", () => kit.initialized === 2)
    assert.equal(kit.acpSpawns.length, 2)
    assert.deepEqual(kit.acpLog.filter((entry) => entry.spawn === 1).map((entry) => entry.method), ["initialize"])
  })
})

test("a spare belongs to its account: another account starts its own agy", async () => {
  await withKit({}, async (kit) => {
    await readSse(await kit.request(conversation(1)))
    await until("the default account's spare", () => kit.initialized === 2)
    const other = await kit.plugin.auth.loader(async () => ({ type: "oauth", metadata: { agyHome: "otheracct1" } }))
    await readSse(await other.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(conversation(2)) }))
    // spawn #1 is the default account's spare; the other account opened on a new agy
    assert.equal(sessionsOn(kit)[1], 2)
    assert.match(kit.acpSpawns[2].env.HOME ?? "", /otheracct1$/)
    assert.notEqual(kit.acpSpawns[1].env.HOME, kit.acpSpawns[2].env.HOME)
    // the default account's next conversation still takes its own spare
    await readSse(await kit.request(conversation(3)))
    assert.equal(sessionsOn(kit)[2], 1)
  })
})

test("an idle spare is stopped after the idle time", async () => {
  await withKit({ env: { AGY_BRIDGE_IDLE_MS: "60000" } }, async (kit) => {
    await readSse(await kit.request(conversation(1)))
    await until("a spare agy initialised", () => kit.initialized === 2)
    const spare = kit.acpSpawns[1].child
    kit.clock.advance(61_000)
    // the next request sweeps idle processes before it picks one
    await readSse(await kit.request(conversation(2)))
    assert.equal(spare.closed, true, "the idle spare was stopped")
    assert.notEqual(sessionsOn(kit)[1], 1)
  })
})

test("a spare is the first to go when the pool is full", async () => {
  await withKit({ env: { AGY_BRIDGE_MAX_PROCS: "3" } }, async (kit) => {
    await readSse(await kit.request(conversation(1)))
    await until("a spare agy initialised", () => kit.initialized === 2)
    const spare = kit.acpSpawns[1].child
    const other = await kit.plugin.auth.loader(async () => ({ type: "oauth", metadata: { agyHome: "otheracct1" } }))
    const third = await kit.plugin.auth.loader(async () => ({ type: "oauth", metadata: { agyHome: "otheracct2" } }))
    await readSse(await other.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(conversation(2)) }))
    // three agy now: two conversations and the spare, so no second spare
    assert.equal(kit.acpSpawns.length, 3)
    await readSse(await third.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(conversation(3)) }))
    assert.equal(spare.closed, true, "the spare made room")
    // both conversations kept their agy
    assert.equal(kit.acpSpawns[0].child.closed, false)
    assert.equal(kit.acpSpawns[2].child.closed, false)
  })
})

test("the host's exit stops a spare", async () => {
  await withKit({}, async (kit) => {
    await readSse(await kit.request(conversation(1)))
    await until("a spare agy initialised", () => kit.initialized === 2)
    kit.module.__agyTestReapOnExit()
    assert.equal(kit.acpSpawns[1].child.closed, true)
  })
})

test("AGY_BRIDGE_SPARE=0 starts no spare", async () => {
  await withKit({ env: { AGY_BRIDGE_SPARE: "0" } }, async (kit) => {
    await readSse(await kit.request(conversation(1)))
    await readSse(await kit.request(conversation(2)))
    await sleep(50)
    assert.equal(kit.acpSpawns.length, 2)
    assert.deepEqual(sessionsOn(kit), [0, 1])
  })
})
