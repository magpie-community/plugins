// A Codex side conversation (a side chat in the app, /side in the CLI) forks
// its thread: same session id, instructions and opening, so it had the main
// thread's key. Asked while the main thread waited on a tool, it carried that
// call's result and was taken for a steer of the main thread's turn: the
// side question went into the main session, and the two then took the
// session from each other (503s and replays) until one finished.

import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, continueWithToolResults, createBridgeKit, readSse } from "./testkit.mjs"

const BOUNDARY = "Side conversation boundary.\n\nEverything before this boundary is inherited history from the parent thread. It is reference context only. It is not your current task."
const HEADERS = { "x-magpie-session": "01a203bf-3f24-7e81-9251-a38bb09814a6" }

function promptText(params) {
  return (params?.prompt || []).map((part) => (part.type === "text" ? part.text : "")).join("")
}

async function withKit(fn) {
  const kit = await createBridgeKit({})
  try {
    kit.defaultPrompt = async (agent) => {
      const text = promptText({ prompt: agent.prompt })
      const current = text.includes("<current_turn>") ? text.slice(text.lastIndexOf("<current_turn>")) : text
      if (current.includes("SIDE_Q")) {
        await agent.text("side answer")
        return { stopReason: "end_turn" }
      }
      if (current.includes("WAIT_TOOL")) {
        const result = await agent.tool("Read", { path: "/shared" })
        await agent.text(`main got:${result?.result?.content?.[0]?.text || ""}`)
        return { stopReason: "end_turn" }
      }
      await agent.text("other")
      return { stopReason: "end_turn" }
    }
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

test("a side conversation asked while the main thread waits on a tool gets its own session", async () => {
  await withKit(async (kit) => {
    const opening = baseBody({ system: "shared system", messages: [{ role: "user", content: "WAIT_TOOL start" }] })
    const turn1 = await readSse(await kit.request(opening, { headers: HEADERS }))
    assert.equal(turn1.stopReason, "tool_use")
    const call = turn1.content.find((block) => block.type === "tool_use")

    const side = {
      ...opening,
      messages: [
        ...opening.messages,
        { role: "assistant", content: turn1.content },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: call.id, content: "main-output" },
            { type: "text", text: "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>" },
            { type: "text", text: BOUNDARY },
            { type: "text", text: "SIDE_Q how long do I wait?" },
          ],
        },
      ],
    }
    const sideRes = await kit.request(side, { headers: HEADERS })
    assert.equal(sideRes.status, 200)
    const sideParsed = await readSse(sideRes)
    assert.ok(sideParsed.content.some((block) => block.text?.includes("side answer")), JSON.stringify(sideParsed))
    assert.equal(kit.acpSpawns.length, 2, "the side conversation runs in an agy of its own")

    const mainRes = await kit.request(continueWithToolResults(opening, turn1, () => "main-output"), { headers: HEADERS })
    assert.equal(mainRes.status, 200)
    const mainParsed = await readSse(mainRes)
    assert.ok(mainParsed.content.some((block) => block.text?.includes("main got:main-output")), JSON.stringify(mainParsed))
    assert.equal(kit.acpSpawns.length, 2, "the main thread goes on in its own session")
  })
})

test("the boundary text inside a tool result is not a side conversation", async () => {
  await withKit(async (kit) => {
    const opening = baseBody({ system: "shared system", messages: [{ role: "user", content: "WAIT_TOOL start" }] })
    const turn1 = await readSse(await kit.request(opening, { headers: HEADERS }))
    const done = await readSse(await kit.request(continueWithToolResults(opening, turn1, () => `log: ${BOUNDARY}`), { headers: HEADERS }))
    assert.ok(done.content.some((block) => block.text?.includes("main got:log:")), JSON.stringify(done))
    assert.equal(kit.acpSpawns.length, 1)
  })
})
