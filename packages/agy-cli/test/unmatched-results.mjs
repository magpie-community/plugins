// Tool results that no live MCP call waits for, on a conversation whose agy
// session still holds a turn (X: tmr11235, agy-cli on magpie 0.1.4542,
// "409 agy bridge: no active MCP call matches these tool results"). The
// request carries its own whole tool round, so it is replayed into a fresh
// session; it never ends in that 409.

import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, continueWithToolResults, createBridgeKit, readSse, sleep } from "./testkit.mjs"

async function withKit(fn) {
  const kit = await createBridgeKit({})
  try { return await fn(kit) } finally { await kit.dispose() }
}

function promptText(entry) {
  return (entry.params?.prompt || []).map((part) => (part.type === "text" ? part.text : "")).join("")
}

function lastPrompt(kit) {
  return promptText(kit.acpLog.filter((entry) => entry.method === "session/prompt").at(-1))
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

// "TOOL" in the current turn asks for one Read and waits for its result;
// "HOLD" asks for one Read and never ends (a turn still waiting on its call);
// "REPLAYED" answers with plain text.
function script(kit) {
  kit.defaultPrompt = async (agent) => {
    const text = (agent.prompt || []).map((part) => (part.type === "text" ? part.text : "")).join("")
    const current = text.includes("<current_turn>") ? text.slice(text.lastIndexOf("<current_turn>")) : text
    if (current.includes("REAL RESULT") || current.includes("RESENT RESULT") || current.includes("RENAMED RESULT")) {
      await agent.text("replayed with the real result")
      return { stopReason: "end_turn" }
    }
    if (current.includes("HOLD")) {
      await agent.tool("Read", { path: `/warm/${agent.index}` })
      await agent.waitCancel()
      return { stopReason: "cancelled" }
    }
    if (current.includes("TOOL")) {
      await agent.tool("Read", { path: `/repo/${agent.index}.txt` })
      await agent.text("after tool")
      return { stopReason: "end_turn" }
    }
    await agent.text(`answer ${agent.index}`)
    return { stopReason: "end_turn" }
  }
}

async function failure(response) {
  return response.status === 200 ? "" : `HTTP ${response.status}: ${await response.text()}`
}

// Pi's cache warmer (iamhucong on #1051): while a tool runs, Pi sends the
// previous request again, on the same session, to keep the prompt cache
// warm. It doesn't carry the tool round the client is running, so the bridge
// takes it as the conversation moving on and starts a turn for it. The real
// result then comes for a call of the replaced turn.
test("a real tool result after a sibling request replaced its turn is replayed, not 409", async () => {
  await withKit(async (kit) => {
    script(kit)
    const body = baseBody({ metadata: { user_id: "pi-warm" }, messages: [{ role: "user", content: "TOOL start" }] })
    const first = await readSse(await kit.request(body))
    assert.equal(first.stopReason, "tool_use")
    // the warm request: the same input, one token, the conversation's own
    // earlier step ("HOLD" makes its turn wait on a call of its own)
    const warm = { ...body, max_tokens: 1, messages: [{ role: "user", content: "TOOL start" },
      { role: "assistant", content: [{ type: "text", text: "earlier" }] }, { role: "user", content: "HOLD warm" }] }
    const warmed = await readSse(await kit.request(warm))
    assert.equal(warmed.stopReason, "tool_use")
    await sleep(20)
    const real = continueWithToolResults(body, first, () => "REAL RESULT")
    const response = await kit.request(real)
    assert.equal(response.status, 200, await failure(response))
    const parsed = await readSse(response)
    assert.equal(parsed.stopReason, "end_turn")
    assert.equal(parsed.content.find((block) => block.type === "text")?.text, "replayed with the real result")
    assert.ok(lastPrompt(kit).includes("REAL RESULT"), "the replay carries the request's own result")
  })
})

// A client that resends a tool round it already sent (a retry after its
// stream was cut, an editor that keeps the round in a rewritten history)
// while the turn it fed is waiting on a later call the client never saw.
test("a resent tool round whose turn has moved past it is replayed, not 409", async () => {
  await withKit(async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/one" })
      await agent.tool("Read", { path: "/two" })
      await agent.waitCancel()
      return { stopReason: "cancelled" }
    })
    script(kit)
    const body = baseBody({ metadata: { user_id: "resent" }, messages: [{ role: "user", content: "TOOL start" }] })
    const first = await readSse(await kit.request(body))
    assert.equal(first.stopReason, "tool_use")
    const second = continueWithToolResults(body, first, () => "first result")
    const next = await readSse(await kit.request(second))
    assert.equal(next.stopReason, "tool_use", "agy asked for its second read")
    // The client edits the first round's result and sends it again; the
    // turn waits on /two, whose call the client's history doesn't have.
    const resent = continueWithToolResults(body, first, () => "RESENT RESULT")
    resent.messages[1] = { role: "assistant", content: [{ type: "text", text: "edited" }, ...resent.messages[1].content.filter((b) => b.type === "tool_use").map((b) => ({ ...b, id: "toolu_resent_round_000000" }))] }
    resent.messages[2] = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_resent_round_000000", content: "RESENT RESULT" }] }
    const response = await kit.request(resent)
    assert.equal(response.status, 200, await failure(response))
    const parsed = await readSse(response)
    assert.equal(parsed.content.find((block) => block.type === "text")?.text, "replayed with the real result")
  })
})

// #1412: a client that renames the bridge's tool_use ids and also rewrites an
// earlier message (Droid prunes an old image) before sending the result.
test("renamed ids with an earlier message rewritten are replayed, not 409 (#1412)", async () => {
  await withKit(async (kit) => {
    script(kit)
    const body = baseBody({ metadata: { user_id: "renamed" }, messages: [
      { role: "user", content: "look at this" },
      { role: "assistant", content: [{ type: "text", text: "seen" }] },
      { role: "user", content: "TOOL go" },
    ] })
    const first = await readSse(await kit.request(body))
    assert.equal(first.stopReason, "tool_use")
    const renamed = continueWithToolResults(body, first, () => "RENAMED RESULT")
    for (const block of renamed.messages.at(-2).content) if (block.type === "tool_use") block.id = "call_renamed_1"
    for (const block of renamed.messages.at(-1).content) if (block.type === "tool_result") block.tool_use_id = "call_renamed_1"
    renamed.messages[1] = { role: "assistant", content: [{ type: "text", text: "seen (pruned)" }] }
    const response = await kit.request(renamed)
    assert.equal(response.status, 200, await failure(response))
    const parsed = await readSse(response)
    assert.equal(parsed.content.find((block) => block.type === "text")?.text, "replayed with the real result")
  })
})

// A response still streaming from the held turn is not taken away: the
// request is told to try again (503), not a 409 it would give up on.
test("unmatched results while the held turn streams are busy (503), and the stream is kept", async () => {
  await withKit(async (kit) => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/a" })
      await agent.text("streaming")
      await gate
      await agent.text(" done")
      return { stopReason: "end_turn" }
    })
    script(kit)
    const body = baseBody({ metadata: { user_id: "attached" }, messages: [{ role: "user", content: "TOOL start" }] })
    const first = await readSse(await kit.request(body))
    const live = kit.request(continueWithToolResults(body, first, () => "live result"))
    await sleep(30)
    const bogus = continueWithToolResults(body, first, () => "other")
    for (const block of bogus.messages.at(-2).content) if (block.type === "tool_use") block.id = "toolu_other_round_0000000"
    for (const block of bogus.messages.at(-1).content) if (block.type === "tool_result") block.tool_use_id = "toolu_other_round_0000000"
    const busy = await kit.request(bogus)
    const status = busy.status
    await busy.text()
    release()
    const kept = await readSse(await live)
    assert.equal(status, 503)
    assert.equal(kept.content.map((block) => block.text || "").join(""), "streaming done")
  })
})

// A round the request itself can't replay (a result for a call its own
// history never made) is refused at once with a 400 that stops retries, and
// the turn the conversation holds is left alone.
test("an unreplayable round is a terminal 400 and leaves the held turn alone", async () => {
  await withKit(async (kit) => {
    script(kit)
    const capture = captureStderr()
    try {
      const body = baseBody({ metadata: { user_id: "broken" }, messages: [{ role: "user", content: "TOOL start" }] })
      const first = await readSse(await kit.request(body))
      const broken = continueWithToolResults(body, first, () => "x")
      for (const block of broken.messages.at(-1).content) if (block.type === "tool_result") block.tool_use_id = "toolu_never_issued_000000"
      const response = await kit.request(broken)
      assert.equal(response.status, 400)
      assert.equal(response.headers.get("x-should-retry"), "false")
      assert.equal((await response.json()).error.code, "tool_history_incomplete")
      assert.equal(kit.acpSpawns.length, 1)
      // the held turn still takes its real result
      const real = await readSse(await kit.request(continueWithToolResults(body, first, () => "fine")))
      assert.equal(real.stopReason, "end_turn")
      assert.equal(kit.acpSpawns.length, 1)
    } finally { capture.restore() }
  })
})
