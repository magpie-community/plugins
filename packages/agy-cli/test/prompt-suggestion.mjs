import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

const SUGGESTION_OPENING = "[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]"
const SUGGESTION = `${SUGGESTION_OPENING}\n\nSuggest a short next input. Or nothing.\nReply with ONLY the suggestion, no quotes or explanation.`
const IMAGE = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }
const ZERO_USAGE = { input_tokens: 0, output_tokens: 0 }
const user = (content) => ({ role: "user", content })
const text = (value) => ({ type: "text", text: value })
const prompts = (kit) => kit.acpLog.filter((entry) => entry.method === "session/prompt")

async function withKit(run) {
  const kit = await createBridgeKit({ agentVersion: "1.5.17", sessionResume: true, promptImages: true })
  const journal = []
  const original = process.stderr.write
  const prefix = "[agy-bridge] "
  process.stderr.write = function write(chunk, ...rest) {
    const line = String(chunk)
    if (line.startsWith(prefix)) journal.push(JSON.parse(line.slice(prefix.length)))
    return original.call(this, chunk, ...rest)
  }
  kit.defaultPrompt = async (agent) => {
    await agent.text("ACP reply")
    return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } }
  }
  try {
    await run(kit, journal)
  } finally {
    process.stderr.write = original
    await kit.dispose()
  }
}

async function assertEmptyResponse(response, model, stream) {
  assert.equal(response.status, 200)
  const stop = { stop_reason: "end_turn", stop_sequence: null }
  const message = { type: "message", role: "assistant", model, content: [], usage: ZERO_USAGE }
  if (stream) {
    assert.equal(response.headers.get("content-type"), "text/event-stream")
    const { events } = await readSse(response)
    const id = events[0]?.data.message?.id
    assert.match(id, /^msg_/)
    assert.deepEqual(events, [
      { event: "message_start", data: { type: "message_start", message: { ...message, id, stop_reason: null, stop_sequence: null } } },
      { event: "message_delta", data: { type: "message_delta", delta: stop, usage: ZERO_USAGE } },
      { event: "message_stop", data: { type: "message_stop" } },
    ])
  } else {
    assert.equal(response.headers.get("content-type"), "application/json")
    const actual = await response.json()
    assert.match(actual.id, /^msg_/)
    assert.deepEqual(actual, { ...message, ...stop, id: actual.id })
  }
}

for (const stream of [true, false]) {
  test(`an input suggestion (${stream ? "SSE" : "JSON"}) leaves the main ACP session intact`, async (t) => {
    await withKit(async (kit, journal) => {
      const headers = { "x-magpie-session": "claude:prompt-suggestion" }
      const body = baseBody({ messages: [user("opening sentinel")] })
      const first = await readSse(await kit.request(body, { headers }))
      assert.equal(first.stopReason, "end_turn")
      const firstPrompt = prompts(kit)[0]
      const firstSession = journal.find((row) => row.action === "session_new")
      const history = [...body.messages, { role: "assistant", content: first.content }]
      const acpLength = kit.acpLog.length
      const journalLength = journal.length
      const suggestionContent = stream ? [text("Context"), text(`\n${SUGGESTION}\n`)] : SUGGESTION
      const suggestion = await kit.request({ ...body, stream, messages: [...history, user(suggestionContent)] }, { headers })
      // Let even a real ACP-backed response finish before testing the next turn.
      await suggestion.clone().text()
      const suggestionAcp = kit.acpLog.slice(acpLength)
      const suggestionJournal = journal.slice(journalLength).filter((row) => row.event === "agy_bridge_session")

      const followUp = await readSse(await kit.request({ ...body, messages: [...history, user("new main input")] }, { headers }))
      const lastPrompt = prompts(kit).at(-1)
      const sessionEvents = journal.filter((row) => row.event === "agy_bridge_session")
      t.diagnostic(`main=${firstPrompt.params.sessionId}; next=${lastPrompt.params.sessionId}; actions=${sessionEvents.map((row) => row.action).join(",")}`)
      assert.equal(followUp.stopReason, "end_turn")
      assert.equal(lastPrompt.params.sessionId, firstPrompt.params.sessionId, "the main request must reuse the same ACP session")
      assert.deepEqual(lastPrompt.params.prompt, [text("new main input")], "ACP must receive only the new user input")
      assert.equal(kit.acpSpawns.length, 1)
      assert.equal(prompts(kit).length, 2)
      assert.deepEqual(suggestionAcp, [], "the suggestion must send no ACP messages")
      assert.deepEqual(sessionEvents.filter((row) => row.action !== "prompt").map((row) => row.action),
        ["session_new", "suggestion_skipped"])
      assert.deepEqual(suggestionJournal, [{
        event: "agy_bridge_session",
        host_epoch: firstSession.host_epoch,
        ts: kit.clock.now(),
        conv: firstSession.conv,
        action: "suggestion_skipped",
        reason: "prompt_suggestion",
      }])
      await assertEmptyResponse(suggestion, body.model, stream)
    })
  })
}

test("a suggestion on a cold bridge skips agy while count_tokens still counts it", async () => {
  await withKit(async (kit) => {
    const body = baseBody({ messages: [user([text(SUGGESTION), IMAGE])] })
    assert.ok(await kit.countTokens(body) > 0)
    const suggestion = await kit.request(body)
    assert.equal(kit.modelsSpawns.length, 0, "no model catalog process")
    assert.equal(kit.acpSpawns.length, 0, "no ACP process")
    assert.deepEqual(kit.acpLog, [])
    await assertEmptyResponse(suggestion, body.model, true)
  })
})

test("a quoted marker or a marker without the reply instruction is an ordinary user message", async () => {
  await withKit(async (kit, journal) => {
    const inputs = [`Explain this template: ${SUGGESTION}`, `${SUGGESTION_OPENING} What does this mode do?`,
      [text(SUGGESTION), text("What is this template for?")]]
    for (const content of inputs) {
      const reply = await readSse(await kit.request(baseBody({ messages: [user(content)] })))
      assert.equal(reply.stopReason, "end_turn")
      assert.deepEqual(reply.content, [text("ACP reply")])
    }
    assert.equal(prompts(kit).length, inputs.length)
    assert.ok(!journal.some((row) => row.action === "suggestion_skipped"))
  })
})
