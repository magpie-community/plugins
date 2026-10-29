import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

// ZCode embeds this paragraph, with unindented bullets, in a larger system
// prompt. Its values stay; only the three fixed client phrases change.
const env = "# Environment\nYou have been invoked in the following environment:\n- Primary working directory: /tmp/project\n- Is a git repository: no\n- Platform: darwin\n- Shell: zsh\n- OS Version: darwin 27.0.0 arm64\n- You are powered by the model named magpie/factory/kimi-k3.\n"
const adapted = "# Runtime context\nThe session environment is:\n- Primary working directory: /tmp/project\n- Is a git repository: no\n- Platform: darwin\n- Shell: zsh\n- OS Version: darwin 27.0.0 arm64\n- Current model name: magpie/factory/kimi-k3.\n"
const prefix = "Keep these instructions.\n\n"

async function loaded() {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), ...init })
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } })
  }
  const auth = { type: "oauth", access: "factory-token", expires: Date.now() + 3_600_000, activeOrganizationId: "org_A" }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => { throw new Error("credential writes disabled") } } } })
  return { l: await hooks.auth.loader(async () => auth), seen }
}

test("Responses instructions: adapts a complete embedded paragraph and is idempotent", () => {
  const path = "/api/llm/o/v1/responses"
  const instructions = prefix + env + "\n# Context management\nKeep the context."
  const body = JSON.stringify({ model: "gpt-6-luna", instructions, input: [{ role: "user", content: "OK" }] })
  const out = JSON.parse(_internal.droidBody(path, body))
  expect(out.instructions).toBe(_internal.DROID_LINE + "\n" + prefix + adapted + "\n# Context management\nKeep the context.")
  expect(out.input).toEqual([{ role: "user", content: "OK" }])
  const once = JSON.stringify(out)
  expect(_internal.droidBody(path, once)).toBe(once)
})

test("Chat: adapts the first system prompt and later system messages, leaving other roles alone", () => {
  const path = "/api/llm/o/v1/chat/completions"
  const later = "Later system.\n\n" + env
  const messages = [
    { role: "system", content: prefix + env },
    { role: "system", content: later },
    { role: "user", content: "User quote:\n\n" + env },
    { role: "assistant", content: "Assistant quote:\n\n" + env },
    { role: "tool", content: "# Environment\n- Platform: darwin" },
  ]
  const body = JSON.stringify({ model: "kimi-k3", messages, max_tokens: 32 })
  const out = JSON.parse(_internal.droidBody(path, body))
  expect(out.messages[0].content).toBe(_internal.DROID_LINE + "\n" + prefix + adapted)
  expect(out.messages[1].content).toBe("Later system.\n\n" + adapted)
  expect(out.messages.slice(2)).toEqual(messages.slice(2))
  const once = JSON.stringify(out)
  expect(_internal.droidBody(path, once)).toBe(once)
})

test("Messages: adapts system blocks after the prompt and keeps user/assistant blocks and values", async () => {
  const { l, seen } = await loaded()
  const system = [
    { type: "text", text: prefix + env, cache_control: { type: "ephemeral" } },
    { type: "text", text: env, cache_control: { type: "ephemeral" } },
  ]
  const messages = [
    { role: "user", content: [{ type: "text", text: "User quote:\n\n" + env }] },
    { role: "assistant", content: [{ type: "text", text: "Assistant quote:\n\n" + env }] },
  ]
  const request = { model: "claude-sonnet-4-6", system, messages }
  const url = "https://api.factory.ai/api/llm/a/v1/messages"
  await l.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) })
  const sent = JSON.parse(seen[0].body)
  expect(sent.system[0]).toEqual({ type: "text", text: _internal.DROID_LINE })
  expect(sent.system[1]).toEqual({ ...system[0], text: prefix + adapted })
  expect(sent.system[2]).toEqual({ ...system[1], text: adapted })
  expect(sent.messages).toEqual(messages)
  const once = seen[0].body
  await l.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: once })
  expect(seen[1].body).toBe(once)
})

test("leaves fenced, quoted, incomplete, partly given and non-system copies alone", () => {
  const path = "/api/llm/o/v1/responses"
  const partly = env.replace("- Shell: zsh\n", "").replace("- OS Version: darwin 27.0.0 arm64\n", "")
  const inputs = [
    "Reference:\n\n```\n\n" + env + "```",
    "Reference:\n\n~~~\n\n" + env + "~~~",
    // a complete paragraph, blank lines on both sides, inside a fence
    "Reference:\n\n```\n\n" + env + "\n```",
    "Reference:\n\n> " + env.replace(/\n/g, "\n> "),
    prefix + env.replace("- You are powered by the model named magpie/factory/kimi-k3.\n", ""),
    prefix + partly,
    "Reference:\n" + env,
  ]
  for (const instructions of inputs) {
    const body = JSON.stringify({ model: "gpt-6-luna", instructions, input: [{ role: "user", content: "OK" }] })
    const out = JSON.parse(_internal.droidBody(path, body))
    expect(out.instructions).toBe(_internal.DROID_LINE + "\n" + instructions)
  }
})

test("supports the ZCode plugin's environment without a Shell line", () => {
  const path = "/api/llm/o/v1/responses"
  const withoutShell = env.replace("- Shell: zsh\n", "")
  const expected = adapted.replace("- Shell: zsh\n", "")
  const body = JSON.stringify({ model: "gpt-6-luna", instructions: prefix + withoutShell, input: [] })
  expect(JSON.parse(_internal.droidBody(path, body)).instructions).toBe(_internal.DROID_LINE + "\n" + prefix + expected)
})
