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
