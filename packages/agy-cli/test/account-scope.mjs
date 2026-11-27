// An agy runs under one account's sign-in, so one account's request never
// goes on in another account's agy (Archivemylife on X: two Google accounts,
// each added with "Add another Google account", were used up and reset
// together). Before, a request of account B whose flattened opening went on
// from account A's conversation, or whose tool ids were A's pending calls,
// was answered in A's agy: with A's credentials, A's quota and A's 429.
//
// bun test ./account-scope.mjs

import { test } from "node:test"
import assert from "node:assert/strict"
import { MESSAGES_URL, baseBody, continueWithToolResults, createBridgeKit, readSse } from "./testkit.mjs"

async function withKit(fn) {
  const kit = await createBridgeKit({})
  try { return await fn(kit) } finally { await kit.dispose() }
}

function promptText(entry) {
  return (entry.params?.prompt || []).map((part) => (part.type === "text" ? part.text : "")).join("")
}

// "TOOL" asks for one Read and goes on once its result is in; a replayed
// round answers "replayed"; anything else is answered with the spawn's number.
function script(kit) {
  kit.defaultPrompt = async (agent) => {
    const text = promptText({ params: { prompt: agent.prompt } })
    const current = text.includes("<current_turn>") ? text.slice(text.lastIndexOf("<current_turn>")) : text
    if (current.includes("B RESULT")) {
      await agent.text("replayed")
      return { stopReason: "end_turn" }
    }
    if (current.includes("TOOL")) {
      await agent.tool("Read", { path: "/repo/a.txt" })
      await agent.text("after tool")
      return { stopReason: "end_turn" }
    }
    await agent.text("done")
    return { stopReason: "end_turn" }
  }
}

const prompts = (kit) => kit.acpLog.filter((entry) => entry.method === "session/prompt")
const homeOf = (kit, spawn) => kit.acpSpawns[spawn].env.HOME ?? ""

async function accountB(kit) {
  return kit.plugin.auth.loader(async () => ({ type: "oauth", metadata: { agyHome: "accountb1" } }))
}

const OPENING = "Please review the following project files and propose a short fix.\nstep one"
const GROWN = OPENING + "\n\nassistant: done\n\nstep two is longer than four chars"

test("a continued opening goes on in its own account's agy only", async () => {
  await withKit(async (kit) => {
    script(kit)
    await readSse(await kit.request(baseBody({ messages: [{ role: "user", content: OPENING }] })))
    assert.equal(prompts(kit).length, 1)
    assert.equal(prompts(kit)[0].spawn, 0)
    const b = await accountB(kit)
    const response = await b.fetch(MESSAGES_URL, { method: "POST",
      body: JSON.stringify(baseBody({ messages: [{ role: "user", content: GROWN }] })) })
    await readSse(response)
    const second = prompts(kit).at(-1)
    assert.notEqual(second.spawn, 0, "account B's request went on in account A's agy")
    assert.match(homeOf(kit, second.spawn), /accountb1$/)
    assert.notEqual(homeOf(kit, second.spawn), homeOf(kit, 0))
  })
})

test("the same account's continued opening still goes on in its live agy", async () => {
  await withKit(async (kit) => {
    script(kit)
    await readSse(await kit.request(baseBody({ messages: [{ role: "user", content: OPENING }] })))
    await readSse(await kit.request(baseBody({ messages: [{ role: "user", content: GROWN }] })))
    assert.equal(kit.acpSpawns.length, 1)
    assert.deepEqual(prompts(kit).map((entry) => entry.spawn), [0, 0])
  })
})

test("another account's tool results never feed this account's pending call", async () => {
  await withKit(async (kit) => {
    script(kit)
    const body = baseBody({ messages: [{ role: "user", content: "TOOL start" }] })
    const first = await readSse(await kit.request(body))
    assert.equal(first.stopReason, "tool_use")
    const b = await accountB(kit)
    const response = await b.fetch(MESSAGES_URL, { method: "POST",
      body: JSON.stringify(continueWithToolResults(body, first, () => "B RESULT")) })
    const parsed = await readSse(response)
    assert.equal(parsed.content.find((block) => block.type === "text")?.text, "replayed",
      "account B's results resolved account A's call")
    const last = prompts(kit).at(-1)
    assert.notEqual(last.spawn, 0)
    assert.match(homeOf(kit, last.spawn), /accountb1$/)
  })
})
