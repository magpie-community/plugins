import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

const SUGGESTION_OPENING = "[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]"
const SUGGESTION = `${SUGGESTION_OPENING}\n\nSuggest a short next input. Or nothing.\nReply with ONLY the suggestion, no quotes or explanation.`
// Claude Code 2.1.316's own template, byte for byte as its binary holds
// it (a template literal; the \u escapes are its own)
const CLAUDE_CODE_SUGGESTION = `[SUGGESTION MODE: Suggest what the user might naturally type next into Claude Code.]

FIRST: Look at the user's recent messages and original request.

Your job is to predict what THEY would type - not what you think they should do.

THE TEST: Would they think "I was just about to type that"?

EXAMPLES:
User asked "fix the bug and run tests", bug is fixed \u2192 "run the tests"
After code written \u2192 "try it out"
Claude offers options \u2192 suggest the one the user would likely pick, based on conversation
Claude asks to continue \u2192 "yes" or "go ahead"
Task complete, obvious follow-up \u2192 "commit this" or "push it"
After error or misunderstanding \u2192 silence (let them assess/correct)

Be specific: "run the tests" beats "continue".

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- Claude-voice ("Let me...", "I'll...", "Here's...")
- New ideas they didn't ask about
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Stay silent if a suggestion could be unsafe or inappropriate \u2014 including any sensitive topic (security incidents, credentials, harm, private data). Even when the user is doing legitimate security or cybersecurity work, do not predict potentially unsafe actions.

Format: 2-12 words, match the user's style. Or nothing.

Reply with ONLY the suggestion, no quotes or explanation.`
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

for (const stream of [true, false]) {
  test(`Claude Code's own suggestion template (${stream ? "SSE" : "JSON"}) reaches no agy`, async () => {
    await withKit(async (kit, journal) => {
      const headers = { "x-magpie-session": "claude:prompt-suggestion-literal" }
      const body = baseBody({ messages: [user("opening sentinel")] })
      const first = await readSse(await kit.request(body, { headers }))
      const history = [...body.messages, { role: "assistant", content: first.content }]
      const acpLength = kit.acpLog.length
      const suggestion = await kit.request({ ...body, stream, messages: [...history, user(CLAUDE_CODE_SUGGESTION)] }, { headers })
      assert.deepEqual(kit.acpLog.slice(acpLength), [], "the suggestion must send no ACP messages")
      assert.ok(journal.some((row) => row.action === "suggestion_skipped"))
      await assertEmptyResponse(suggestion, body.model, stream)
    })
  })
}
