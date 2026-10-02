import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
const url = "https://api.factory.ai/api/llm/a/v1/messages"
const droid = "You are Droid, an AI software engineering agent built by Factory."

async function loaded() {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), ...init })
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { headers: { "content-type": "text/event-stream" } })
  }
  const auth = { type: "oauth", access: "factory-token", expires: Date.now() + 3_600_000, activeOrganizationId: "org_A" }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => {} } } })
  return { l: await hooks.auth.loader(async () => auth), seen }
}

test("adapts Claude Code metadata, preserving instructions, tool turns, images and capabilities", async () => {
  const { l, seen } = await loaded()
  const request = {
    model: "claude-sonnet-4-6",
    system: [
      { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.287.abc; cc_entrypoint=cli;" },
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Follow the user's coding instructions. Keep this byte-for-byte.", cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "user", content: [
        { type: "text", text: "<system-reminder>\n# Environment\nYou have been invoked in the following environment:\n - Primary working directory: /tmp/project\n</system-reminder>" },
        { type: "text", text: "<system-reminder>\nYou are powered by the model named Sonnet 4.6. The exact model ID is claude-sonnet-4-6. Assistant knowledge cutoff is January 2025.\n</system-reminder>" },
        { type: "text", text: "Explain Claude Code's environment. Do not rewrite this user instruction." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "image-data" } },
      ] },
      { role: "assistant", content: [{ type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "/tmp/project/proof.txt" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool_1", content: [{ type: "text", text: "You are powered by the model named — file content must stay unchanged." }], cache_control: { type: "ephemeral" } }] },
    ],
    tools: [{ name: "Read", input_schema: { type: "object", properties: { file_path: { type: "string" } } } }],
    metadata: { user_id: "caller" }, max_tokens: 256, thinking: { type: "adaptive" }, output_config: { effort: "high" }, stream: true,
    context_management: { edits: [] }, safeguards: [{ type: "dangerous_tool_use" }],
  }
  const res = await l.fetch(url, { method: "POST", headers: { "content-length": "1", "anthropic-version": "2023-06-01", "anthropic-beta": "client-beta", "x-api-key": "caller-key" }, body: JSON.stringify(request) })
  const sent = JSON.parse(seen[0].body)
  expect(sent.system[0]).toEqual({ ...request.system[1], text: droid })
  expect(sent.system[1]).toEqual(request.system[2])
  expect(sent.messages[0].content[0].text).toContain("Primary working directory: /tmp/project")
  expect(sent.messages[0].content[0].text).toContain("The session environment is:")
  expect(sent.messages[0].content[1].text).toContain("Current model name: Sonnet 4.6")
  expect(sent.messages[0].content[1].text).toContain("Model knowledge cutoff: January 2025.")
  expect(sent.messages[0].content.slice(2)).toEqual(request.messages[0].content.slice(2))
  expect(sent.messages.slice(1)).toEqual(request.messages.slice(1))
  for (const field of ["model", "tools", "metadata", "max_tokens", "thinking", "output_config", "stream", "context_management", "safeguards"]) expect(sent[field]).toEqual(request[field])
  expect(seen[0].headers.get("content-length")).toBeNull()
  expect(seen[0].headers.get("Authorization")).toBe("Bearer factory-token")
  expect(seen[0].headers.get("x-api-key")).toBe("placeholder")
  expect(seen[0].headers.get("anthropic-beta")).toBe("client-beta")
  expect(res.headers.get("content-type")).toBe("text/event-stream")
  expect(await res.text()).toBe('event: message_stop\ndata: {"type":"message_stop"}\n\n')
})

test("keeps native Droid requests byte-for-byte and adds its preamble to generic callers", async () => {
  const { l, seen } = await loaded()
  const body = '{ "model": "claude-sonnet-4-6", "system": [{"type":"text","text":' + JSON.stringify(droid) + '}], "messages": [{"role":"user","content":"OK"}] }'
  await l.fetch(url, { method: "POST", body })
  expect(seen[0].body).toBe(body)
  await l.fetch(url, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6", system: "Keep these exact instructions.", messages: [{ role: "user", content: "OK" }] }) })
  expect(JSON.parse(seen[1].body).system).toEqual([{ type: "text", text: droid }, { type: "text", text: "Keep these exact instructions." }])
})

test("handles SDK identity, request bodies and offset byte views without duplicating metadata", async () => {
  const { l, seen } = await loaded()
  const body = JSON.stringify({ model: "claude-sonnet-4-6", system: [{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }], messages: [{ role: "user", content: "OK" }] })
  const bytes = Buffer.from("unused" + body + "unused")
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset + 6, Buffer.byteLength(body))
  await l.fetch(url, { method: "POST", body: view })
  expect(JSON.parse(seen[0].body).system).toEqual([{ type: "text", text: droid }])
  await l.fetch(new Request(url, { method: "POST", body }))
  expect(seen[1].body).toBe(seen[0].body)
  await l.fetch(url, { method: "POST", body: seen[0].body })
  expect(seen[2].body).toBe(seen[0].body)
})

test("does not change OpenAI requests, malformed JSON or invalid system schemas", async () => {
  const { l, seen } = await loaded()
  const body = JSON.stringify({ model: "gpt-6-sol", instructions: droid, input: "OK" })
  await l.fetch("https://api.factory.ai/api/llm/o/v1/responses", { method: "POST", body })
  expect(seen[0].body).toBe(body)
  for (const body of ["not-json", JSON.stringify({ model: "claude-sonnet-4-6", system: {}, messages: [] }), JSON.stringify({ system: [{ type: "text", text: 123 }], messages: [] })]) {
    await l.fetch(url, { method: "POST", body })
    expect(seen.at(-1).body).toBe(body)
  }
})

test("recognizes Claude Code running within the Agent SDK", async () => {
  const { l, seen } = await loaded()
  await l.fetch(url, { method: "POST", body: JSON.stringify({
    system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "OK" }],
  }) })
  expect(JSON.parse(seen[0].body).system).toEqual([{ type: "text", text: droid, cache_control: { type: "ephemeral" } }])
})

test("adapts the complete model reminder without a marketing name", async () => {
  const { l, seen } = await loaded()
  await l.fetch(url, { method: "POST", body: JSON.stringify({
    messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>\nYou are powered by the model custom-model.\n</system-reminder>" }] }],
  }) })
  expect(JSON.parse(seen[0].body).messages[0].content[0].text).toBe("<system-reminder>\nCurrent model: custom-model.\n</system-reminder>")
})

test("adapts complete environment reminders with nested additional working directories", async () => {
  const { l, seen } = await loaded()
  const reminder = "<system-reminder>\n# Environment\nYou have been invoked in the following environment:\n - Primary working directory: /tmp/project\n - Additional working directories:\n  - /extra/one\n  - /extra/two\n - Platform: darwin\n</system-reminder>"
  const pasted = reminder + "\nPlease explain these directories."
  const body = JSON.stringify({ messages: [{ role: "user", content: [
    { type: "text", text: reminder, cache_control: { type: "ephemeral" } },
    { type: "text", text: pasted },
  ] }] })
  for (const endpoint of [url, url + "/count_tokens"]) {
    await l.fetch(endpoint, { method: "POST", body })
    expect(JSON.parse(seen.at(-1).body).messages[0].content).toEqual([
      { type: "text", text: reminder.replace("# Environment", "# Runtime context").replace("You have been invoked in the following environment:", "The session environment is:"), cache_control: { type: "ephemeral" } },
      { type: "text", text: pasted },
    ])
  }
})

test("explains an Anthropic 403 without claiming these clients are always refused", async () => {
  const { l } = await loaded()
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "Model unavailable for this organization" } }), { status: 403 })
  const res = await l.fetch(url, { method: "POST", body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "OK" }] }) })
  expect(res.status).toBe(403)
  const message = (await res.json()).error.message
  expect(message).toStartWith("Model unavailable for this organization — Factory refused")
  expect(message).toContain("OpenAI and Anthropic")
  expect(message).toContain("regional provider availability")
  expect(message).not.toContain("are sent as the agent sent them")
})

test("drops an empty or whitespace-only string system", async () => {
  const { l, seen } = await loaded()
  for (const system of ["", " \n\t", [{ type: "text", text: "" }]]) {
    await l.fetch(url, { method: "POST", body: JSON.stringify({ system, messages: [{ role: "user", content: "OK" }] }) })
    expect(JSON.parse(seen.at(-1).body).system).toEqual([{ type: "text", text: droid }])
  }
})

test("preserves a native Droid string system without duplicating the preamble", async () => {
  const { l, seen } = await loaded()
  for (const system of [droid, droid + "\nKeep the user's instructions."]) {
    const body = JSON.stringify({ system, messages: [{ role: "user", content: "OK" }] })
    await l.fetch(url, { method: "POST", body })
    expect(seen.at(-1).body).toBe(body)
  }
})

test("preserves pasted reminders with user text outside the complete block", async () => {
  const { l, seen } = await loaded()
  const reminders = [
    "<system-reminder>\n# Environment\nYou have been invoked in the following environment:\n - Platform: linux\n</system-reminder>",
    "<system-reminder>\nYou are powered by the model named Sonnet 4.6.\n</system-reminder>",
    "<system-reminder>\nYou are powered by the model custom-model.\n</system-reminder>",
  ]
  const texts = reminders.flatMap((r) => [r + "\nPlease explain this pasted reminder.", r.replace("</system-reminder>", ""), "Please explain:\n" + r])
  await l.fetch(url, { method: "POST", body: JSON.stringify({
    messages: [{ role: "user", content: texts.map((text) => ({ type: "text", text })) }],
  }) })
  expect(JSON.parse(seen[0].body).messages[0].content).toEqual(texts.map((text) => ({ type: "text", text })))
})

test("removes duplicate exact Droid identities while retaining the first block's metadata", async () => {
  const { l, seen } = await loaded()
  const identity = { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } }
  const native = { type: "text", text: droid }
  const instructions = { type: "text", text: "Keep all task instructions." }
  for (const system of [[identity, native, instructions], [native, identity, instructions], [native, native, instructions]]) {
    await l.fetch(url, { method: "POST", body: JSON.stringify({ system, messages: [{ role: "user", content: "OK" }] }) })
    expect(JSON.parse(seen.at(-1).body).system).toEqual([{ ...system[0], text: droid }, instructions])
  }
})

test("adapts token-counting requests consistently with Messages and leaves other paths alone", async () => {
  const { l, seen } = await loaded()
  const body = JSON.stringify({ system: "Count these instructions.", messages: [{ role: "user", content: "OK" }] })
  await l.fetch(url, { method: "POST", body })
  await l.fetch(url + "/count_tokens", { method: "POST", body })
  expect(seen[1].body).toBe(seen[0].body)
  expect(seen[1].headers.get("content-length")).toBeNull()
  await l.fetch("https://api.factory.ai/api/llm/a/v1/models", { method: "POST", body })
  expect(seen[2].body).toBe(body)
})

test("adapts MiniMax M2.7 on the Anthropic route while keeping its provider and options", async () => {
  const { l, seen } = await loaded()
  const options = { model: "minimax-m2.7", messages: [{ role: "user", content: "OK" }], max_tokens: 32, stream: true }
  await l.fetch(url, { method: "POST", body: JSON.stringify({ ...options, system: "You are OpenCode." }) })
  expect(JSON.parse(seen[0].body)).toEqual({ ...options, system: [{ type: "text", text: droid }, { type: "text", text: "You are OpenCode." }] })
  expect(seen[0].headers.get("x-api-provider")).toBe("fireworks")
})

test("retains large integer tokens byte-for-byte in an unmodified native Droid request", async () => {
  const { l, seen } = await loaded()
  const body = '{"system":[{"type":"text","text":' + JSON.stringify(droid) + '}],"messages":[{"role":"assistant","content":[{"type":"tool_use","id":"call_1","name":"Read","input":{"id":12345678901234567890}}]}]}'
  await l.fetch(url, { method: "POST", body })
  expect(seen[0].body).toBe(body)
})
