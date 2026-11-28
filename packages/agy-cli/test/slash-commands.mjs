// agy reads a command name anywhere in a prompt as the user running that
// command (/learn, /plan, …, and a session's own), so the bridge defuses it
// in everything it hands agy, and gives a tool call's arguments back as the
// prompt had them (plugins#1294).
import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

const FAST_WAIT = { AGY_BRIDGE_TOOL_LIST_WAIT_MS: "200" }
const LINUX = { platform: "linux" }

async function withKit(options, fn) {
  const kit = await createBridgeKit({ ...options, env: { ...FAST_WAIT, ...(options.env || {}) } })
  kit.defaultPrompt = async (agent) => {
    await agent.text("ok")
    return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 1 } }
  }
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

const promptTexts = (kit) =>
  kit.acpLog
    .filter((entry) => entry.method === "session/prompt")
    .map((entry) => entry.params.prompt.map((p) => p.text || "").join(""))

test("defuses /learn, /plan, and /grill-me in system instructions, history, notices, and current turn", async () => {
  await withKit(LINUX, async (kit) => {
    const body = baseBody({
      system: "Skills:\n- learn: when the user directly invokes /learn or /skill:learn in Pi\n- /plan and /grill-me\n- path /path/to/learn and https://example.com/learn",
      messages: [
        { role: "user", content: "Earlier I mentioned /learn in passing" },
        { role: "assistant", content: "Understood." },
        { role: "user", content: "<system-reminder>Do not run /plan automatically</system-reminder>\nCheck /learn and /grill-me now." },
      ],
    })
    const parsed = await readSse(await kit.request(body))
    assert.equal(parsed.error, null, JSON.stringify(parsed.error))

    const prompts = promptTexts(kit)
    assert.equal(prompts.length, 1)
    const sent = prompts[0]
    assert.match(sent, /invokes \/\u2060learn or \/skill:learn/)
    assert.match(sent, /- \/\u2060plan and \/\u2060grill-me/)
    assert.match(sent, /\/path\/to\/learn and https:\/\/example\.com\/learn/)
    assert.match(sent, /Earlier I mentioned \/\u2060learn in passing/)
    assert.match(sent, /Do not run \/\u2060plan automatically/)
    assert.match(sent, /Check \/\u2060learn and \/\u2060grill-me now\./)
    assert.doesNotMatch(sent, /(^|\s)\/(learn|plan|grill-me)(?=$|\s)/)
  })
})

test("also defuses extra slash commands advertised via available_commands_update", async () => {
  await withKit({
    ...LINUX,
    availableCommands: [
      { name: "plan", description: "Plan" },
      { name: "grill-me", description: "Grill" },
      { name: "learn", description: "Learn" },
      { name: "custom-cmd", description: "Custom" },
    ],
  }, async (kit) => {
    const body = baseBody({
      system: "Use /custom-cmd or /learn when asked.",
      messages: [{ role: "user", content: "Run /custom-cmd" }],
    })
    const parsed = await readSse(await kit.request(body))
    assert.equal(parsed.error, null, JSON.stringify(parsed.error))

    const prompts = promptTexts(kit)
    assert.equal(prompts.length, 1)
    assert.match(prompts[0], /Use \/\u2060custom-cmd or \/\u2060learn when asked\./)
    assert.match(prompts[0], /Run \/\u2060custom-cmd/)
  })
})

const TOOL = { name: "Edit", input_schema: { type: "object", properties: { file_path: { type: "string" }, old_string: { type: "string" } }, required: ["file_path", "old_string"] } }

test("a tool call copied from a defused prompt reaches the client as the file has it, and the session goes on", async () => {
  await withKit({ ...LINUX, availableCommands: [{ name: "learn" }, { name: "custom-cmd" }] }, async (kit) => {
    let seen = null
    kit.prompts.push(async (agent) => {
      seen = agent.prompt.map((p) => p.text || "").join("")
      // the model copies the line as it read it, word joiner and all
      await agent.tool("Edit", { file_path: "/repo/NOTES.md", old_string: "Run /\u2060custom-cmd then /\u2060learn" })
      await agent.text("done")
      return { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 1 } }
    })
    const body = baseBody({ tools: [TOOL], messages: [{ role: "user", content: "In NOTES.md, the line is: Run /custom-cmd then /learn" }] })
    const first = await readSse(await kit.request(body))
    assert.equal(first.error, null, JSON.stringify(first.error))
    assert.match(seen, /Run \/\u2060custom-cmd then \/\u2060learn/)
    const call = first.content.find((item) => item.type === "tool_use")
    assert.deepEqual(call.input, { file_path: "/repo/NOTES.md", old_string: "Run /custom-cmd then /learn" })

    const next = await readSse(await kit.request({
      ...body,
      messages: [
        ...body.messages,
        { role: "assistant", content: [call] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "edited" }] },
      ],
    }))
    assert.equal(next.error, null, JSON.stringify(next.error))
    assert.equal(next.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1, "the tool_result goes on in the live session, no replay")
  })
})

test("a replay too big for one prompt is defused in every part, the session's own commands too", async () => {
  await withKit({ ...LINUX, agentVersion: "1.5.17", availableCommands: [{ name: "custom-cmd" }] }, async (kit) => {
    const CONTINUES = "[This message continues in the next one.]"
    kit.defaultPrompt = async (agent) => {
      const text = agent.prompt.map((p) => p.text || "").join("")
      if (text.endsWith(CONTINUES)) {
        await agent.waitCancel()
        return { stopReason: "cancelled" }
      }
      await agent.text("ok")
      return { stopReason: "end_turn" }
    }
    const filler = "history filler line with some words in it. ".repeat(220)
    const messages = [{ role: "user", content: "Opening: run /custom-cmd and /plan" }]
    for (let i = 0; i < 40; i++) {
      messages.push({ role: "assistant", content: [{ type: "text", text: `step ${i} ${filler} then /custom-cmd` }] })
      messages.push({ role: "user", content: `next ${i} /learn` })
    }
    messages.push({ role: "assistant", content: "last" })
    messages.push({ role: "user", content: "Now /custom-cmd" })
    const parsed = await readSse(await kit.request(baseBody({ messages })))
    assert.equal(parsed.error, null, JSON.stringify(parsed.error))
    const sent = promptTexts(kit)
    assert.ok(sent.length >= 2, `${sent.length} prompts: the replay went in parts`)
    for (const [i, text] of sent.entries()) {
      assert.doesNotMatch(text, /(^|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000])\/(custom-cmd|plan|learn)(?=$|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000])/, `prompt ${i}`)
    }
    assert.match(sent[0], /Opening: run \/⁠custom-cmd and \/⁠plan/)
    assert.match(sent.at(-1), /Now \/⁠custom-cmd/)
  })
})
