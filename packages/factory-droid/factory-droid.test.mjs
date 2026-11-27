import { afterAll, beforeAll, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import plugin from "./opencode.mjs"

const bin = process.env.FACTORY_DROID_BIN
let hooks, opts
beforeAll(async () => {
  process.env.FACTORY_DROID_BIN = fileURLToPath(new URL("./test/fake-droid.mjs", import.meta.url))
  hooks = await plugin.server()
  opts = await hooks.auth.loader(async () => ({ type: "api", key: "test-key" }))
})
afterAll(() => {
  if (bin === undefined) delete process.env.FACTORY_DROID_BIN
  else process.env.FACTORY_DROID_BIN = bin
})
const send = (body, signal, headers) => opts.fetch(opts.baseURL + "/messages", {
  method: "POST", body: JSON.stringify({ model: "fake", messages: [{ role: "user", content: "hello" }], ...body }), signal, headers,
})
const events = (sse) => sse.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)))

test("ACP lists enabled models and checks local login", async () => {
  const models = await hooks.provider.models()
  await hooks.provider.warming()
  expect((await hooks.provider.models()).fake.name).toBe("Fake model")
  expect((await hooks.provider.models()).fake.variants).toEqual({ low: { effort: "low" } })
  expect(Object.keys(models)).not.toContain("locked")
  const login = await hooks.auth.methods[0].authorize()
  expect(await login.callback()).toMatchObject({ type: "success" })
  const saved = process.env.FACTORY_API_KEY
  try {
    process.env.FACTORY_API_KEY = "bad"
    expect(await login.callback()).toMatchObject({ type: "failed", error: "Authentication required" })
  } finally {
    if (saved === undefined) delete process.env.FACTORY_API_KEY
    else process.env.FACTORY_API_KEY = saved
  }
})
test("Messages through Request input retains model, image, text and usage", async () => {
  const r = await opts.fetch(new Request(opts.baseURL + "/messages", { method: "POST",
    body: JSON.stringify({ model: "fake", system: "be brief", messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "YQ==" } }, { type: "text", text: "hello" },
    ] }] }),
  }))
  expect(r.status).toBe(200)
  const m = await r.json()
  expect(m.content[0]).toEqual({ type: "thinking", thinking: "thinking" })
  expect(m.content[1].text).toMatch(/fake:.*be brief.*image\/pnghello/s)
  expect(m.content[1].text).not.toContain("foreign")
  expect(m.usage).toEqual({ input_tokens: 9, output_tokens: 4 })
  expect(m.stop_reason).toBe("end_turn")
})
test("reasoning effort is set after selecting the requested model", async () => {
  const response = await send({ output_config: { effort: "low" }, messages: [{ role: "user", content: "check effort" }] })
  expect(response.status).toBe(200)
})
test("an effort level the model does not offer is left to Droid", async () => {
  const response = await send({ output_config: { effort: "medium" }, messages: [{ role: "user", content: "unsupported effort" }] })
  expect(response.status).toBe(200)
  expect((await response.json()).content.at(-1).text).toContain("fake:")
})
test("an advertised effort must match the level Droid reports", async () => {
  const saved = process.env.FAKE_DROID_IGNORE_EFFORT
  process.env.FAKE_DROID_IGNORE_EFFORT = "1"
  try {
    const response = await send({ output_config: { effort: "low" } })
    expect(response.status).toBe(502)
    expect((await response.json()).error.message).toContain("did not apply the requested reasoning effort")
  } finally {
    if (saved === undefined) delete process.env.FAKE_DROID_IGNORE_EFFORT
    else process.env.FAKE_DROID_IGNORE_EFFORT = saved
  }
})
test("an effort level Droid does not know is reported as the client's error", async () => {
  const response = await send({ output_config: { effort: "__bogus__" }, messages: [{ role: "user", content: "unknown effort" }] })
  expect(response.status).toBe(400)
  expect((await response.json()).error.message).toContain("Invalid reasoning effort value")
})
test("a line Droid prints on stdout outside ACP is ignored", async () => {
  process.env.FAKE_DROID_NOTICE = "droid: a new version is available"
  try {
    const response = await send({ messages: [{ role: "user", content: "a notice on stdout" }] })
    expect(response.status).toBe(200)
    expect((await response.json()).content.at(-1).text).toContain("fake:")
  } finally { delete process.env.FAKE_DROID_NOTICE }
})
test("a line Droid prints on stdout that is not a JSON object is ignored", async () => {
  process.env.FAKE_DROID_NOTICE = "null"
  try {
    const response = await send({ messages: [{ role: "user", content: "a bare null on stdout" }] })
    expect(response.status).toBe(200)
  } finally { delete process.env.FAKE_DROID_NOTICE }
})
test("a prompt waits for Droid as long as Droid keeps sending output", async () => {
  const { connect } = await import("./acp.mjs")
  let chunks = 0
  const rpc = connect({ onUpdate: update => { if (update.content?.type === "text") chunks++ } })
  try {
    await rpc.initialize()
    const { sessionId } = await rpc.newSession()
    const result = await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "stream-then-end" }] }, 600)
    expect(result.stopReason).toBe("end_turn")
    expect(chunks).toBe(30)
  } finally { rpc.close() }
}, 8_000)
test("output while Droid waits for the client's tools does not start the prompt timeout", async () => {
  const { connect } = await import("./acp.mjs")
  const rpc = connect({})
  try {
    await rpc.initialize()
    const { sessionId } = await rpc.newSession()
    const prompt = rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "update-then-wait" }] }, 500).catch(error => error)
    rpc.waitForTools(true)
    await new Promise(resolve => setTimeout(resolve, 900))
    rpc.close()
    expect(await prompt).toMatchObject({ message: "Droid connection closed" })
  } finally { rpc.close() }
}, 8_000)
test("Claude Code replays inline instructions in order, including a trailing system message", async () => {
  const response = await send({ stream: true, system: "top", messages: [
    { role: "system", content: [{ type: "text", text: "first" }] },
    { role: "assistant", content: "past" },
    { role: "developer", content: "brief" },
    { role: "user", content: "PRs?" },
    { role: "system", content: "skill available" },
  ] })
  expect(response.status).toBe(200)
  const trace = events(await response.text())
  const reply = trace.filter(e => e.delta?.type === "text_delta").map(e => e.delta.text).join("")
  expect(reply).toContain("top\nsystem:\nfirst\nassistant:\npast\ndeveloper:\nbrief\nuser:\nPRs?\nsystem:\nskill available")
})
const report = { name: "report", input_schema: { type: "object" } }
const receipt = (call, value) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: value }] })

test("forced tool choice restricts the MCP manifest and requires a call", async () => {
  const messages = [{ role: "user", content: "call report" }]
  const body = { tools: [{ name: "other", input_schema: { type: "object" } }, report], tool_choice: { type: "tool", name: "report" }, messages }
  const first = await (await send(body)).json()
  expect(first.content[0].name).toBe("report")
  messages.push({ role: "assistant", content: first.content }, receipt(first.content[0], "received"))
  const end = await send(body)
  expect(end.status).toBe(502)
  expect((await end.json()).error.message).toContain("without calling the required tool")
})

test("two sequential tools return to the same native prompt and retries preserve IDs", async () => {
  const tools = [report], messages = [{ role: "user", content: "two calls" }]
  const response = await send({ tools, messages, stream: true })
  const trace = events(await response.text())
  expect(trace.at(-2).delta.stop_reason).toBe("tool_use")
  const call = trace.find(e => e.content_block?.type === "tool_use").content_block
  call.input = JSON.parse(trace.find(e => e.delta?.type === "input_json_delta").delta.partial_json)
  expect(call).toMatchObject({ name: "report", input: { word: "lime" } })
  messages.push({ role: "assistant", content: [call] }, receipt(call, "orchid"))
  const step = await (await send({ tools, messages })).json()
  expect(step.content[0]).toMatchObject({ type: "tool_use", name: "report", input: { word: "orchid" } })
  expect(step.content[0].id).not.toBe(call.id)
  expect(await (await send({ tools, messages })).json()).toEqual(step)
  const next = step.content[0]
  const wrong = [...messages.slice(0, -1), receipt({ id: "wrong-call" }, "orchid")]
  expect((await send({ tools, messages: wrong })).status).toBe(400)
  const conflict = [...messages.slice(0, -1), receipt(call, "different")]
  expect((await send({ tools, messages: conflict })).status).toBe(409)
  messages.push({ role: "assistant", content: [next] }, receipt(next, "complete"))
  messages.at(-1).content[0].is_error = true
  const simultaneous = await Promise.all([send({ tools, messages }), send({ tools, messages })])
  expect(simultaneous.map(r => r.status).sort()).toEqual([200, 409])
  const end = await simultaneous.find(r => r.ok).json()
  expect(end.stop_reason).toBe("end_turn")
  expect(end.content[0].text).toContain('MCP returned {"content":[{"type":"text","text":"complete"}],"isError":true}')
  expect(await (await send({ tools, messages })).json()).toEqual(end)
})

test("a changed history or different client account cannot answer a pending tool", async () => {
  const messages = [{ role: "user", content: "call report" }]
  const body = { tools: [report], messages }
  const first = await (await send(body)).json()
  const call = first.content[0]
  messages.push({ role: "assistant", content: [call] }, receipt(call, "peach"))
  const other = await hooks.auth.loader(() => ({ type: "api", key: "other-key" }))
  const foreign = await other.fetch(opts.baseURL + "/messages", { body: JSON.stringify({ model: "fake", ...body }) })
  expect((await foreign.json()).content.at(-1).text).toContain('"tool_result":')
  const branch = [{ role: "user", content: "a different starting point" }, ...messages.slice(1)]
  expect((await (await send({ ...body, messages: branch })).json()).content.at(-1).text).toContain('"tool_result":')
  expect((await (await send(body)).json()).content[0].text).toContain("MCP returned")
})

test("an exact session follow-up sends only the new user message", async () => {
  const headers = { "x-magpie-session": "claude:pr-session" }
  const messages = [{ role: "user", content: "original-question" }]
  const first = await (await send({ messages }, undefined, headers)).json()
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: "followup" })
  const next = await (await send({ messages }, undefined, headers)).json()
  expect(next.content.at(-1).text).toBe("fake:\nuser:\nfollowup")
  messages.push({ role: "assistant", content: next.content }, { role: "user", content: "crash-now" })
  expect((await send({ messages }, undefined, headers)).status).toBe(502)
})

test("Claude Code content blocks, disabled thinking and a local token estimate", async () => {
  const body = { model: "fake", thinking: { type: "disabled" }, messages: [{ role: "user", content: [
    { type: "tool_addition", tool: {} }, { type: "tool_removal", name: "old" },
    { type: "tool_result", tool_use_id: "tool_old", content: [{ type: "tool_reference", tool_name: "Read" }] },
    { type: "search_result", source: "source", title: "Found", content: [{ type: "text", text: "value" }] },
    { type: "document", source: { type: "base64", media_type: "text/plain", data: "aGVsbG8=" } },
  ] }] }
  const msg = await (await send(body)).json()
  expect(msg.content.map(b => b.type)).toEqual(["text"])
  expect(msg.content[0].text).toContain("Loaded tool: ReadFound source\nvaluehello")
  const prev = process.env.FACTORY_DROID_BIN
  try {
    process.env.FACTORY_DROID_BIN = "/missing/droid"
    const r = await opts.fetch(opts.baseURL + "/messages/count_tokens?beta=true", { body: JSON.stringify(body) })
    expect(r.status).toBe(200)
    expect((await r.json()).input_tokens).toBeGreaterThan(1)
  } finally { process.env.FACTORY_DROID_BIN = prev }
})
test("ACP, input and process errors reach the caller", async () => {
  expect((await send({ messages: [] })).status).toBe(400)
  const bad = await hooks.auth.loader(() => ({ type: "api", key: "bad" }))
  expect((await bad.fetch(opts.baseURL + "/messages", { body: JSON.stringify({ model: "fake", messages: [{ role: "user", content: "hi" }] }) })).status).toBe(401)
  const crashed = await send({ messages: [{ role: "user", content: "crash-now" }] })
  expect(crashed.status).toBe(502)
  const stream = await send({ stream: true, messages: [{ role: "user", content: "fail-now" }] })
  expect(events(await stream.text()).at(-1)).toMatchObject({ type: "error", error: { message: "Prompt failed" } })
})
test("aborting a pending prompt and cancelling a response body both finish", async () => {
  const body = { stream: true, messages: [{ role: "user", content: "wait-until-abort" }] }
  const abort = new AbortController()
  const r = await send(body, abort.signal)
  abort.abort()
  expect(events(await r.text()).at(-1).type).toBe("error")
  const other = await send(body)
  await other.body.cancel()
})

test("a Claude Code tool result and trailing instructions reach the same Droid turn", async () => {
  const other = { name: "unrelated", input_schema: { type: "object" } }
  const tools = [report, other], messages = [{ role: "user", content: "tool and steer" }]
  const first = await (await send({ tools, messages })).json()
  const call = first.content[0]
  const user = receipt(call, "real receipt")
  user.content.push({ type: "text", text: "answer in French" })
  messages.push({ role: "assistant", content: first.content }, user,
    { role: "system", content: [{ type: "tool_addition", tool: {} }, { type: "text", text: "use one line" }] })
  const body = { tools: [other, { ...report, cache_control: { type: "ephemeral" } }], messages }
  const reply = await (await send(body)).json()
  expect(reply.content[0].text).toContain('MCP returned {"content":[{"type":"text","text":"real receipt"}],"isError":false}')
  expect(reply.content[0].text).toEndWith("\nuser:\nanswer in French\nsystem:\nuse one line")
  const retry = await (await send(body)).json()
  expect(retry.id).toBe(reply.id)
})

test("updated tool schemas replay with the new manifest", async () => {
  const messages = [{ role: "user", content: "get a report" }]
  const first = await (await send({ tools: [report], messages })).json()
  messages.push({ role: "assistant", content: first.content }, receipt(first.content[0], "schema updated"))
  const other = { name: "replacement", input_schema: { type: "object" } }
  const change = await (await send({ tools: [other], messages })).json()
  expect(change.content.at(-1).text).toContain('"tool_result":')
  expect(change.content.at(-1).text).toContain("schema updated")
  // Finish the original branch.
  expect((await (await send({ tools: [report], messages })).json()).content[0].text).toContain("MCP returned")
})

for (const resume of [false, true]) {
  test(`an abandoned tool releases its process and accepts one late result via ${resume ? "resume" : "replay"}`, async () => {
    const { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { basename, join } = await import("node:path")
    const { workspaceReleased } = await import("./acp.mjs")
    const variables = ["FAKE_DROID_RESUME", "FAKE_DROID_WORKSPACE", "XDG_CACHE_HOME", "FACTORY_HOME_OVERRIDE"]
    const before = variables.map(k => process.env[k])
    const root = mkdtempSync(join(tmpdir(), "droid-abandoned-"))
    if (resume) process.env.FAKE_DROID_RESUME = "1"
    else delete process.env.FAKE_DROID_RESUME
    const marker = join(root, "workspace")
    process.env.FAKE_DROID_WORKSPACE = marker
    process.env.XDG_CACHE_HOME = process.env.FACTORY_HOME_OVERRIDE = root
    const ledger = join(root, "magpie", "factory-droid", "sessions")
    const entries = () => readdirSync(ledger).map(f => JSON.parse(readFileSync(join(ledger, f), "utf8")))
    try {
      const tools = [report], headers = { "x-magpie-session": "late-result" }
      const messages = [{ role: "user", content: "original tool request" }]
      const follow = (user, stream = false) => send({ tools, stream, messages: [...messages, user] }, undefined, headers)
      const first = await (await send({ tools, messages }, undefined, headers)).json()
      expect(first.stop_reason).toBe("tool_use")
      const call = first.content[0]
      const workspace = readFileSync(marker, "utf8")
      expect(existsSync(workspace)).toBe(true)
      const old = resume && entries().find(e => e.pending?.includes(call.id))
      if (resume) expect(old.dir).toBe(basename(workspace))
      messages.push({ role: "assistant", content: first.content })
      const alternate = await follow({ role: "user", content: "Continue without the result." })
      expect((await alternate.json()).stop_reason).toBe("tool_use")
      await workspaceReleased(basename(workspace))
      expect(existsSync(workspace)).toBe(false)

      const attempts = ["first result", "different result"]
      const responses = await Promise.all(attempts.map(value => follow(receipt(call, value), true)))
      expect(responses.map(r => r.status).sort()).toEqual([200, 409])
      const accepted = responses.findIndex(r => r.ok)
      const reader = responses[accepted].body.getReader()
      const [start] = events(new TextDecoder().decode((await reader.read()).value))
      await reader.cancel()
      const answer = await (await follow(receipt(call, attempts[accepted]))).json()
      expect(answer.id).toBe(start.message.id)
      expect(answer.stop_reason).toBe("end_turn")
      expect(answer.content.at(-1).text).toContain(attempts[accepted])
      const retry = await (await follow(receipt(call, attempts[accepted]))).json()
      expect(retry.id).toBe(answer.id)
      expect(retry.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
      expect((await follow(receipt(call, "another result"))).status).toBe(409)
      if (resume) {
        expect(entries().find(e => e.dir === old.dir)).toMatchObject({ id: old.id })
        expect(entries().some(e => e.pending?.includes(call.id))).toBe(false)
      } else {
        expect(answer.content.at(-1).text).toContain('"tool_result":')
      }
    } finally {
      variables.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i] })
      rmSync(root, { recursive: true, force: true })
    }
  }, 10_000)
}

test("a disconnected result is recovered once, with per-step session and cache counters", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const saved = process.env.FACTORY_HOME_OVERRIDE
  const home = mkdtempSync(join(tmpdir(), "droid-test-home-"))
  try {
    process.env.FACTORY_HOME_OVERRIDE = home
    const body = { tools: [report], messages: [{ role: "user", content: "meter steps" }] }
    const first = await (await send(body)).json()
    expect(first.usage).toEqual({ input_tokens: 100, output_tokens: 12, cache_read_input_tokens: 50, cache_creation_input_tokens: 9 })
    body.messages.push({ role: "assistant", content: first.content }, receipt(first.content[0], "returned once"))
    const broken = await send({ ...body, stream: true })
    await broken.body.cancel()
    const retry = await send({ ...body, stream: true })
    const trace = events(await retry.text())
    expect(trace[0].message.id).toBeString()
    expect(trace.at(-2).usage).toEqual({ input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 70 })
    const duplicate = await (await send(body)).json()
    expect(duplicate.id).toBe(trace[0].message.id)
    expect(duplicate.content[0].text).toContain("MCP returned")
    expect(duplicate.usage).toEqual({ input_tokens: 0, output_tokens: 0 })
  } finally {
    if (saved === undefined) delete process.env.FACTORY_HOME_OVERRIDE
    else process.env.FACTORY_HOME_OVERRIDE = saved
    rmSync(home, { recursive: true, force: true })
  }
})

test("the quota card reads the key's regional Factory limits without invoking Droid", async () => {
  const real = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url, init) => {
    urls.push(url)
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-key")
    if (urls.length === 1) return Response.json({ region: "eu" })
    return Response.json({ limits: {
      standard: { fiveHour: { usedPercent: 24, windowEnd: 1791763200000 } },
      core: { weekly: { usedPercent: 73 } },
    }, extraUsageBalanceCents: 1250 })
  }
  try {
    const card = await hooks.auth.usage(() => ({ type: "api", key: "test-key" }))
    expect(urls).toEqual(["https://api.factory.ai/api/cli/whoami", "https://api.eu.factory.ai/api/billing/limits"])
    expect(card.windows).toMatchObject([{ name: "5 hours", used: 24, resetsAt: "2026-10-12T00:00:00.000Z" },
      { name: "Droid Core · 7 days", used: 73 }, { name: "Extra usage", display: "$12.50" }])
    globalThis.fetch = () => Response.json({}, { status: 401 })
    expect((await hooks.auth.usage(() => ({ type: "api", key: "invalid" }))).error).toContain("HTTP 401")
  } finally { globalThis.fetch = real }
})

test("an interrupted ACP process after delivery can replay only the same receipt", async () => {
  const messages = [{ role: "user", content: "fail after receipt" }]
  const body = { tools: [report], messages }
  const first = await (await send(body)).json()
  messages.push({ role: "assistant", content: first.content }, receipt(first.content[0], "orchid"))
  expect((await send(body)).status).toBe(502)
  const wrong = [...messages.slice(0, -1), receipt(first.content[0], "indigo")]
  expect((await send({ ...body, messages: wrong })).status).toBe(409)
  const restored = await (await send(body)).json()
  expect(restored.content.at(-1).text).toContain("orchid")
  expect(restored.stop_reason).toBe("end_turn")
})

test("older Droid versions replay the receipt and instructions in order", async () => {
  const saved = process.env.FAKE_DROID_NO_STEER
  process.env.FAKE_DROID_NO_STEER = "1"
  try {
    const messages = [{ role: "user", content: "old version" }]
    const body = { tools: [report], messages }
    const first = await (await send(body)).json()
    const user = receipt(first.content[0], "orchid")
    messages.push({ role: "assistant", content: first.content }, user, { role: "developer", content: "uppercase" })
    const end = await (await send(body)).json()
    expect(end.content.at(-1).text).toContain("orchid\ndeveloper:\nuppercase")
    messages.pop()
    const conflict = [...messages.slice(0, -1), receipt(first.content[0], "different")]
    expect((await send({ tools: [report], messages: conflict })).status).toBe(409)
    expect((await (await send(body)).json()).content[0].text).toContain("MCP returned")
  } finally {
    if (saved === undefined) delete process.env.FAKE_DROID_NO_STEER
    else process.env.FAKE_DROID_NO_STEER = saved
  }
})

test("a stale settings file cannot mask ACP usage or charge it twice when disk catches up", async () => {
  const { sessionMeter } = await import("./usage.mjs")
  const { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const home = mkdtempSync(join(tmpdir(), "droid-usage-"))
  const saved = process.env.FACTORY_HOME_OVERRIDE
  process.env.FACTORY_HOME_OVERRIDE = home
  try {
    const dir = join(home, ".factory", "sessions", realpathSync(home).replace(/[\\/:]/g, "-"))
    mkdirSync(dir, { recursive: true })
    const write = (inputTokens, outputTokens) => writeFileSync(join(dir, "s.settings.json"), JSON.stringify({ tokenUsage: { inputTokens, outputTokens } }))
    const meter = sessionMeter(home, "s")
    write(12, 3)
    meter.begin()
    expect(await meter.read()).toMatchObject({ inputTokens: 12, outputTokens: 3 })
    meter.begin()
    expect(await meter.read({ inputTokens: 7, outputTokens: 4 })).toMatchObject({ inputTokens: 7, outputTokens: 4 })
    write(19, 7)
    expect(await meter.read({ inputTokens: 7, outputTokens: 4 })).toMatchObject({ inputTokens: 0, outputTokens: 0 })
    meter.begin()
    setTimeout(() => write(24, 9), 25)
    expect(await meter.read()).toMatchObject({ inputTokens: 5, outputTokens: 2 })
  } finally {
    if (saved === undefined) delete process.env.FACTORY_HOME_OVERRIDE
    else process.env.FACTORY_HOME_OVERRIDE = saved
    rmSync(home, { recursive: true, force: true })
  }
})

test("parallel calls accept reversed results with preceding instructions and reject partial or duplicate results", async () => {
  const tools = [report], messages = [{ role: "user", content: "parallel tools" }]
  const trace = events(await (await send({ tools, messages, stream: true })).text())
  const calls = trace.filter(e => e.content_block?.type === "tool_use").map(e => ({
    ...e.content_block, input: JSON.parse(trace.find(t => t.index === e.index && t.delta?.type === "input_json_delta").delta.partial_json),
  }))
  expect(calls).toHaveLength(2)
  const blocks = calls.map(c => receipt(c, c.input.word).content[0]).reverse()
  const follow = content => send({ tools, messages: [...messages, { role: "assistant", content: calls }, { role: "user", content }] })
  expect((await follow(blocks.slice(1))).status).toBe(400)
  expect((await follow([blocks[0], blocks[0]])).status).toBe(400)
  const result = await (await follow([{ type: "text", text: "answer briefly" }, ...blocks])).json()
  expect(result.content[0].text).toContain('MCP returned {"content":[{"type":"text","text":"lime"},{"type":"text","text":"pear"}]}')
  expect(result.content[0].text).toContain("answer briefly")
})

test("changing the model or header effort reuses the live session, and prefill stays in the current turn", async () => {
  const headers = { "x-magpie-session": "switch-prefill" }
  const messages = [{ role: "user", content: "remember this old input" }]
  const first = await (await send({ model: "old", system: "You are powered by the model old.", messages }, undefined, headers)).json()
  messages.push({ role: "assistant", content: first.content }, { role: "user", content: "check effort" })
  const system = "You are powered by the model fake."
  const next = await (await send({ system, messages, output_config: { effort: "high" } }, undefined, { ...headers, "x-magpie-effort": "low" })).json()
  expect(next.content.at(-1).text).toBe("fake:\nSystem instructions:\nYou are powered by the model fake.\nuser:\ncheck effort")
  messages.push({ role: "assistant", content: next.content }, { role: "user", content: "write" }, { role: "assistant", content: "Once upon" })
  const prefilled = await (await send({ system, messages }, undefined, { ...headers, "x-magpie-effort": "low" })).json()
  expect(prefilled.content.at(-1).text).toContain("Return only the continuation.\nOnce upon")
  messages.push({ role: "assistant", content: prefilled.content }, { role: "user", content: "finish" })
  expect((await (await send({ system, messages }, undefined, { ...headers, "x-magpie-effort": "low" })).json()).content.at(-1).text).toBe("fake:\nuser:\nfinish")
})

test("replay keeps instructions, latest user input and tool pairs together", async () => {
  const { prepare, replayPrompt } = await import("./messages.mjs")
  const prior = process.env.FACTORY_DROID_REPLAY_BYTES
  try {
    process.env.FACTORY_DROID_REPLAY_BYTES = "125"
    const b = { model: "fake", system: "policy", messages: [
      { role: "user", content: "old".repeat(100) }, { role: "developer", content: "keep me" },
      { role: "assistant", content: "past" }, { role: "user", content: "current" },
      { role: "assistant", content: [{ type: "tool_use", id: "t", name: "read", input: {} }] }, receipt({ id: "t" }, "result"),
    ] }
    const replay = replayPrompt(b, prepare(b)).map(p => p.text).join("")
    for (const word of ["policy", "omitted", "keep me", "current", "tool_use", "tool_result", "result"]) expect(replay).toContain(word)
    expect(replay).not.toContain("oldold")
  } finally {
    if (prior === undefined) delete process.env.FACTORY_DROID_REPLAY_BYTES
    else process.env.FACTORY_DROID_REPLAY_BYTES = prior
  }
})

test("quota routing follows the verified Factory pools and prepaid extra usage", async () => {
  const { _internal } = await import("../factory/index.mjs")
  const { accountQuota } = await import("./quota.mjs")
  const real = globalThis.fetch
  try {
    const limits = { standard: { weekly: { usedPercent: 100 } }, core: { weekly: { usedPercent: 10 } } }
    for (const extraUsageAllowed of [false, true]) {
      globalThis.fetch = async () => Response.json({ limits, extraUsageAllowed, extraUsageBalanceCents: 100 })
      const { windows } = await accountQuota("for-test", "us")
      expect(windows[0].models).toEqual(_internal.MODELS.filter(m => !_internal.CORE.includes(m.id)).map(m => m.id))
      expect(windows[1].models).toEqual(_internal.CORE)
      expect(windows.slice(0, 2).map(w => !!w.aside)).toEqual([extraUsageAllowed, extraUsageAllowed])
    }
  } finally { globalThis.fetch = real }
})

test("Magpie search returns native sources and multipart image edits return generated bytes", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const before = process.env.FACTORY_HOME_OVERRIDE
  const home = mkdtempSync(join(tmpdir(), "droid-output-"))
  try {
    process.env.FACTORY_HOME_OVERRIDE = home
    expect(await hooks.search.droid.execute({ query: "native search", count: 1 }, { getAuth: () => ({ type: "api", key: "test-key" }) }))
      .toEqual([{ title: "First result", url: "https://example.org/one", text: "First snippet." }])
    const form = new FormData()
    form.set("model", "droid-image")
    form.set("prompt", "edit")
    form.set("image", new Blob([Buffer.from("89504e470d0a1a0a00", "hex")], { type: "image/png" }), "ref.png")
    const uri = opts.baseURL + "/images/edits"
    const edit = await opts.fetch(new Request(uri, { method: "POST", body: form }))
    expect(edit.status).toBe(200)
    expect((await edit.json()).data[0].b64_json).toBe("iVBORw0KGgoA")
    expect((await opts.fetch(uri, { body: JSON.stringify({ model: "droid-image", prompt: "edit" }) })).status).toBe(400)
  } finally {
    if (before === undefined) delete process.env.FACTORY_HOME_OVERRIDE
    else process.env.FACTORY_HOME_OVERRIDE = before
    rmSync(home, { recursive: true, force: true })
  }
})

test("an evicted completed session resumes once with only the new prompt", async () => {
  const { mkdtempSync, readdirSync, readFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const vars = ["FAKE_DROID_RESUME", "XDG_CACHE_HOME"]
  const saved = vars.map(k => process.env[k])
  const cache = mkdtempSync(join(tmpdir(), "droid-checkpoint-"))
  process.env.XDG_CACHE_HOME = cache
  process.env.FAKE_DROID_RESUME = "1"
  try {
    const headers = { "x-magpie-session": "durable-session" }
    const messages = [{ role: "user", content: "old original question" }]
    const first = await (await send({ messages }, undefined, headers)).json()
    const dir = join(cache, "magpie", "factory-droid", "sessions")
    const [file] = readdirSync(dir)
    const stored = readFileSync(join(dir, file), "utf8")
    expect(stored).not.toContain("old original question")
    expect(stored).not.toContain("test-key")
    for (let i = 0; i < 9; i++) await (await send({}, undefined, { "x-magpie-session": "eviction-" + i })).json()
    messages.push({ role: "assistant", content: first.content }, { role: "user", content: "after resume" })
    const next = await (await send({ messages }, undefined, headers)).json()
    expect(next.content.at(-1).text).toBe("fake:\nuser:\nafter resume")
    expect(readdirSync(dir)).not.toContain(file)
  } finally {
    vars.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i] })
    rmSync(cache, { recursive: true, force: true })
  }
})

test("an evicted tool call resumes its native session with the completed result", async () => {
  const { mkdtempSync, readdirSync, readFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const variables = ["FAKE_DROID_RESUME", "XDG_CACHE_HOME", "FACTORY_HOME_OVERRIDE"]
  const before = variables.map(k => process.env[k])
  const root = mkdtempSync(join(tmpdir(), "droid-held-checkpoint-"))
  process.env.FAKE_DROID_RESUME = "1"
  process.env.XDG_CACHE_HOME = process.env.FACTORY_HOME_OVERRIDE = root
  const parked = []
  const ledger = join(root, "magpie", "factory-droid", "sessions")
  const entries = () => readdirSync(ledger).map(f => JSON.parse(readFileSync(join(ledger, f))))
  try {
    for (let i = 0; i < 9; i++) {
      const messages = [{ role: "user", content: "tool task " + i }]
      const headers = { "x-magpie-session": "held-" + i }
      const first = await (await send({ tools: [report], messages }, undefined, headers)).json()
      messages.push({ role: "assistant", content: first.content }, receipt(first.content[0], "violet"))
      parked.push({ messages, headers, id: first.content[0].id })
    }
    const { messages, headers, id } = parked[0]
    const old = entries().find(e => e.pending?.includes(id))
    const next = await (await send({ tools: [report], messages }, undefined, headers)).json()
    expect(next.stop_reason).toBe("end_turn")
    expect(next.content.at(-1).text).toContain("violet")
    expect(entries().find(e => e.dir === old.dir)).toMatchObject({ id: old.id })
    expect(entries().some(e => e.pending?.includes(id))).toBe(false)
  } finally {
    variables.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i] })
    rmSync(root, { recursive: true, force: true })
  }
})

test("native image calls use exactly the references submitted with this request", async () => {
  const { spawnSync } = await import("node:child_process")
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const root = mkdtempSync(join(tmpdir(), "droid-image-input-"))
  const manifest = join(root, "references.json")
  try {
    const selected = join(root, "reference-1.png")
    writeFileSync(manifest, JSON.stringify([selected]))
    const hook = fileURLToPath(new URL("./image-guard.mjs", import.meta.url))
    const check = references => spawnSync(process.execPath, [hook, manifest], {
      input: JSON.stringify({ tool_input: { prompt: "edit", references } }),
    }).status
    expect(check([selected])).toBe(0)
    expect(check([])).toBe(2)
    expect(check([join(root, "other.png")])).toBe(2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
