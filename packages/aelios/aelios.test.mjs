// Runs the hook the way magpie's gateway calls it, against an Aelios faked
// with fetch: no server, no key of anyone's and no network.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { flush, onRequest, onResponse, reset } from "./aelios.hooks.mjs"

const realFetch = globalThis.fetch
const KEY = "synthetic-aelios-key"
const PATCH = "<memory>synthetic recalled fact</memory>"
const calls = []
let routes = {}

function mock(extra = {}) {
  routes = {
    "/v1/hook/recall": () => Response.json({ memory: "injected", patch: PATCH, recall_id: "rcl_1", remember: "none" }),
    "/v1/hook/record": () => Response.json({ recorded: true, exchange_id: "gw_req_1", completion: "complete" }),
    ...extra,
  }
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ url: String(url), path, init, body })
    if (!routes[path]) throw new Error(`unexpected ${path}`)
    return routes[path](body, init)
  }
}
const of = (path) => calls.filter((c) => c.path === path)
const hang = (_body, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))

function ctx(protocol, extra = {}) {
  const reports = []
  const c = {
    protocol, model: "claude-opus-4-5", stream: true, path: "/v1/messages", origin: "local", agent: "claude-code",
    session: "session-a", cwd: "/tmp/x", query: "", state: {}, signal: new AbortController().signal,
    report: (code, bytes) => reports.push(bytes === undefined ? [code] : [code, bytes]),
    ...extra,
    options: { serverUrl: "https://aelios.example.workers.dev", apiKey: KEY, ...extra.options },
  }
  return [c, reports]
}

beforeEach(() => reset())
afterEach(() => { globalThis.fetch = realFetch; calls.length = 0 })

const anthropicString = () => ({ model: "claude-opus-4-5", stream: true, system: "sys", tools: [{ name: "Bash", input_schema: {} }], tool_choice: { type: "auto" },
  messages: [{ role: "user", content: "earlier" }, { role: "assistant", content: "ok" }, { role: "user", content: "Where do I live?" }] })
const anthropicArray = () => ({ model: "claude-opus-4-5", stream: true,
  messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>env</system-reminder>" }, { type: "text", text: "Where do I live?", cache_control: { type: "ephemeral" } }] }] })
const chat = () => ({ model: "gpt-5", stream: false, tools: [{ type: "function", function: { name: "f", parameters: {} } }], tool_choice: "auto",
  messages: [{ role: "system", content: "sys" }, { role: "user", content: "Where do I live?" }] })
const responsesString = () => ({ model: "gpt-5", stream: true, instructions: "x", input: "Where do I live?" })
const responsesArray = () => ({ model: "gpt-5", stream: true, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Where do I live?" }] }] })
const anthropicTool = () => ({ model: "claude-opus-4-5", stream: true, messages: [
  { role: "user", content: "Fix it" },
  { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.ts b.ts" }] },
] })

test("the shipped entry is a Bun hook, not middleware, and has no main", async () => {
  const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json()
  expect(pkg.name).toBe("@magpie-community/gateway-aelios")
  expect(pkg.main).toBeUndefined()
  expect(pkg.exports).toBeUndefined()
  expect(pkg.magpie.middleware).toBeUndefined()
  expect(pkg.magpie.gateway).toBeUndefined()
  expect(pkg.magpie.hooks).toBe("./aelios.hooks.mjs")
  expect(pkg.files).toEqual(["aelios.hooks.mjs", "slim.mjs", "README.md"])
  const entry = await import(pkg.magpie.hooks)
  expect(entry.onRequest).toBe(onRequest)
  expect(entry.onResponse).toBe(onResponse)
})

const placements = [
  ["anthropic", "messages string", anthropicString, (b) => b.messages[2].content, (v) => expect(v).toBe(`Where do I live?\n\n${PATCH}`)],
  ["anthropic", "messages array", anthropicArray, (b) => b.messages[0].content, (v) => expect(v).toEqual([
    { type: "text", text: "<system-reminder>env</system-reminder>" },
    { type: "text", text: "Where do I live?", cache_control: { type: "ephemeral" } },
    { type: "text", text: PATCH },
  ])],
  ["chat", "chat", chat, (b) => b.messages[1].content, (v) => expect(v).toBe(`Where do I live?\n\n${PATCH}`)],
  ["responses", "responses string input", responsesString, (b) => b.input, (v) => expect(v).toBe(`Where do I live?\n\n${PATCH}`)],
  ["responses", "responses array input", responsesArray, (b) => b.input[0].content, (v) => expect(v).toEqual([
    { type: "input_text", text: "Where do I live?" }, { type: "input_text", text: PATCH }])],
]

for (const [protocol, name, make, pick, check] of placements) {
  test(`${name}: memory goes after the last user message; model, stream and tools stay`, async () => {
    mock()
    const original = make()
    const [c, reports] = ctx(protocol)
    const out = await onRequest(structuredClone(original), c)
    expect(out).toBeDefined()
    check(pick(out))
    // what the host would roll back on
    for (const key of ["model", "stream", "tools", "tool_choice"]) expect(JSON.stringify(out[key])).toBe(JSON.stringify(original[key]))
    // everything before the last message is untouched
    if (original.messages) expect(out.messages.slice(0, -1)).toEqual(original.messages.slice(0, -1))
    expect(reports).toEqual([["ready", Buffer.byteLength(PATCH)]])
    const [call] = of("/v1/hook/recall")
    expect(call.url).toBe("https://aelios.example.workers.dev/v1/hook/recall")
    expect(call.init.method).toBe("POST")
    expect(call.init.redirect).toBe("error")
    expect(call.init.headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(call.body.protocol).toBe({ anthropic: "messages", chat: "chat", responses: "responses" }[protocol])
    expect(call.body.model).toBe("claude-opus-4-5")
    expect(call.body.agent).toBe("claude-code")
    expect(call.body.session).toBe("session-a")
    // slimmed: no system prompt or instructions travel
    expect(JSON.stringify(call.body.body)).not.toContain('"sys"')
    expect(call.body.body.system).toBeUndefined()
    expect(call.body.body.instructions).toBeUndefined()
    expect(c.state.aelios.slimmed).toEqual(call.body.body)
  })
}

test("identity and a server path prefix are passed through", async () => {
  mock({ "/base/v1/hook/recall": () => Response.json({ memory: "empty", patch: "" }) })
  const [c, reports] = ctx("anthropic", { options: { serverUrl: "https://a.example/base/", identity: "magpie-test" } })
  expect(await onRequest(anthropicString(), c)).toBeUndefined()
  expect(of("/base/v1/hook/recall")[0].body.identity).toBe("magpie-test")
  expect(reports).toEqual([["empty"]])
})

test("the key can come from AELIOS_API_KEY or a named variable", async () => {
  mock()
  process.env.AELIOS_TEST_KEY = "from-env"
  try {
    const [c] = ctx("chat", { options: { apiKey: undefined, apiKeyEnv: "AELIOS_TEST_KEY" } })
    await onRequest(chat(), c)
    expect(of("/v1/hook/recall")[0].init.headers.Authorization).toBe("Bearer from-env")
  } finally {
    delete process.env.AELIOS_TEST_KEY
  }
})

test("no key: nothing is sent", async () => {
  mock()
  const [c, reports] = ctx("chat", { options: { apiKey: undefined, apiKeyEnv: "AELIOS_NOT_SET_ANYWHERE" } })
  expect(await onRequest(chat(), c)).toBeUndefined()
  expect(calls).toHaveLength(0)
  expect(reports).toEqual([["unauthorized"]])
})

test("a tool step sends no recall, and onResponse records it", async () => {
  mock()
  const [c, reports] = ctx("anthropic", { options: { record: true } })
  const req = anthropicTool()
  expect(await onRequest(structuredClone(req), c)).toBeUndefined()
  expect(calls).toHaveLength(0)
  expect(reports).toEqual([["skipped"]])
  const reply = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-4-5-20260101", content: [{ type: "text", text: "Two files." }], stop_reason: "end_turn" }
  onResponse(reply, { ...c, success: true, request: req })
  await flush()
  const [rec] = of("/v1/hook/record")
  expect(rec.body).toEqual({
    protocol: "messages", model: "claude-opus-4-5", agent: "claude-code", session: "session-a",
    body: c.state.aelios.slimmed, reply, success: true, upstream_model: "claude-opus-4-5-20260101",
  })
  expect(rec.body.body.messages[2].content).toEqual([{ type: "tool_result", content: "" }])
  expect(reports.at(-1)[0]).toBe("ready")
})

test("record is off by default: onResponse sends nothing", async () => {
  mock()
  const [c] = ctx("chat")
  await onRequest(chat(), c)
  calls.length = 0
  onResponse({ choices: [{ message: { role: "assistant", content: "Paris" } }] }, { ...c, success: true })
  await flush()
  expect(calls).toHaveLength(0)
})

test("a failed reply is still recorded, with success false", async () => {
  mock()
  const [c] = ctx("chat", { options: { record: true } })
  await onRequest(chat(), c)
  onResponse(null, { ...c, success: false })
  await flush()
  const [rec] = of("/v1/hook/record")
  expect(rec.body.success).toBe(false)
  expect(rec.body.reply).toBeNull()
})

test("a turn with a secret in it is not recorded", async () => {
  mock()
  const [c, reports] = ctx("chat", { options: { record: true } })
  const req = { ...chat(), messages: [{ role: "user", content: "my api_key = sk-abcdefghijklmnopqrstu please store it" }] }
  await onRequest(req, c)
  onResponse({ choices: [{ message: { role: "assistant", content: "ok" } }] }, { ...c, success: true })
  await flush()
  expect(of("/v1/hook/record")).toHaveLength(0)
  expect(reports.at(-1)).toEqual(["skipped"])
  // and a secret in the reply too
  const [c2] = ctx("chat", { options: { record: true } })
  await onRequest(chat(), c2)
  onResponse({ choices: [{ message: { role: "assistant", content: "use ghp_abcdefghijklmnopqrstuvwxyz0123" } }] }, { ...c2, success: true })
  await flush()
  expect(of("/v1/hook/record")).toHaveLength(0)
})

test("a record that fails is not retried and changes nothing", async () => {
  mock({ "/v1/hook/record": () => new Response("down", { status: 503 }) })
  const [c, reports] = ctx("chat", { options: { record: true } })
  await onRequest(chat(), c)
  expect(onResponse({ choices: [] }, { ...c, success: true })).toBeUndefined()
  await flush()
  expect(of("/v1/hook/record")).toHaveLength(1)
  expect(reports.at(-1)).toEqual(["unavailable"])
})

for (const origin of ["gateway-key", "remote", undefined]) {
  test(`origin ${origin}: nothing is sent unless allowRemote`, async () => {
    mock()
    const [c, reports] = ctx("chat", { origin, options: { record: true } })
    expect(await onRequest(chat(), c)).toBeUndefined()
    onResponse({ choices: [] }, { ...c, success: true })
    await flush()
    expect(calls).toHaveLength(0)
    expect(reports[0]).toEqual(["skipped"])

    const [c2] = ctx("chat", { origin, options: { record: true, allowRemote: true } })
    expect(await onRequest(chat(), c2)).toBeDefined()
    onResponse({ choices: [] }, { ...c2, success: true })
    await flush()
    expect(of("/v1/hook/recall")).toHaveLength(1)
    expect(of("/v1/hook/record")).toHaveLength(1)
  })
}

test("magpie-key, magpie's own key on this computer, counts as the owner's", async () => {
  mock()
  const [c] = ctx("chat", { origin: "magpie-key" })
  expect(await onRequest(chat(), c)).toBeDefined()
})

test("agents limits which agents are handled", async () => {
  mock()
  const [c, reports] = ctx("chat", { agent: "codex", options: { agents: ["claude-code"], record: true } })
  expect(await onRequest(chat(), c)).toBeUndefined()
  onResponse({ choices: [] }, { ...c, success: true })
  await flush()
  expect(calls).toHaveLength(0)
  expect(reports).toEqual([["skipped"]])
  const [c2] = ctx("chat", { agent: "claude-code", options: { agents: ["claude-code"] } })
  expect(await onRequest(chat(), c2)).toBeDefined()
  const [c3] = ctx("chat", { agent: "codex", options: { agents: [] } })
  expect(await onRequest(chat(), c3)).toBeDefined()
})

test("no serverUrl: nothing is sent", async () => {
  mock()
  const [c, reports] = ctx("chat", { options: { serverUrl: undefined, record: true } })
  expect(await onRequest(chat(), c)).toBeUndefined()
  onResponse({ choices: [] }, { ...c, success: true })
  await flush()
  expect(calls).toHaveLength(0)
  expect(reports).toEqual([["skipped"]])
})

test("gemini is skipped", async () => {
  mock()
  const [c, reports] = ctx("gemini")
  expect(await onRequest({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }, c)).toBeUndefined()
  expect(calls).toHaveLength(0)
  expect(reports).toEqual([["skipped"]])
  expect(c.state.aelios).toBeUndefined()
})

test("a Responses request that continues server-side state is skipped", async () => {
  mock()
  const [c, reports] = ctx("responses")
  expect(await onRequest({ ...responsesString(), previous_response_id: "resp_1" }, c)).toBeUndefined()
  expect(calls).toHaveLength(0)
  expect(reports).toEqual([["skipped"]])
})

test("recall off: no recall request", async () => {
  mock()
  const [c] = ctx("chat", { options: { recall: false } })
  expect(await onRequest(chat(), c)).toBeUndefined()
  expect(calls).toHaveLength(0)
})

test("bad options throw invalid (the host rolls back) without the key in the error", async () => {
  mock()
  for (const options of [
    { serverUrl: "http://aelios.example.com" },
    { serverUrl: "https://user:pw@aelios.example.com" },
    { serverUrl: "https://aelios.example.com/?k=1" },
    { serverUrl: "https://aelios.example.com/#x" },
    { serverUrl: "not a url" },
    { requestTimeoutMs: 10 },
    { requestTimeoutMs: 9001 },
    { record: "yes" },
    { agents: "claude-code" },
    { gatewayTimeoutMs: 50 },
  ]) {
    const [c, reports] = ctx("chat", { options })
    let error
    try { await onRequest(chat(), c) } catch (e) { error = e }
    expect(error?.message).toBe("Aelios invalid")
    expect(String(error?.stack)).not.toContain(KEY)
    expect(reports).toEqual([["invalid"]])
  }
  // plain http is fine on this machine
  const [c] = ctx("chat", { options: { serverUrl: "http://127.0.0.1:8787" } })
  routes["/v1/hook/recall"] = () => Response.json({ memory: "empty", patch: "" })
  await onRequest(chat(), c)
  expect(of("/v1/hook/recall")[0].url).toBe("http://127.0.0.1:8787/v1/hook/recall")
  expect(calls).toHaveLength(1)
})

const answers = [
  ["401", () => new Response("", { status: 401 }), "unauthorized", true],
  ["403", () => new Response("", { status: 403 }), "unbound", false],
  ["memory off", () => Response.json({ memory: "off" }), "unbound", false],
  ["memory empty", () => Response.json({ memory: "empty", patch: "" }), "empty", false],
  ["memory skipped", () => Response.json({ memory: "skipped" }), "skipped", false],
  ["memory stateful", () => Response.json({ memory: "stateful" }), "skipped", false],
  ["memory unavailable", () => Response.json({ memory: "unavailable", patch: "" }), "unavailable", false],
  ["400", () => new Response("", { status: 400 }), "invalid", false],
  ["not JSON", () => new Response("<html>", { status: 200 }), "invalid", false],
  ["too large", () => new Response("x".repeat((256 << 10) + 1), { status: 200 }), "invalid", false],
]
for (const [name, answer, code, backsOff] of answers) {
  test(`${name}: ${code}, the request goes on as it came${backsOff ? ", and recall backs off" : ""}`, async () => {
    mock({ "/v1/hook/recall": answer })
    const [c, reports] = ctx("chat")
    const req = chat()
    expect(await onRequest(structuredClone(req), c)).toBeUndefined()
    expect(reports).toEqual([[code]])
    const [c2] = ctx("chat")
    await onRequest(chat(), c2)
    expect(of("/v1/hook/recall")).toHaveLength(backsOff ? 1 : 2)
  })
}

const failures = [
  ["a timeout", hang],
  ["a 500", () => new Response("", { status: 500 })],
  ["a 502", () => new Response("", { status: 502 })],
  ["a 404 (Aelios without hook endpoints)", () => new Response("Not found", { status: 404 })],
  ["a refused connection", () => { throw new TypeError("connect ECONNREFUSED") }],
]
for (const [name, answer] of failures) {
  test(`${name}: unavailable, passes through, backs off, then tries again`, async () => {
    mock({ "/v1/hook/recall": answer })
    const options = { requestTimeoutMs: 50, recallBackoffMs: 150 }
    const [c, reports] = ctx("chat", { options })
    expect(await onRequest(chat(), c)).toBeUndefined()
    expect(reports).toEqual([["unavailable"]])
    // in backoff: nothing sent
    const [c2, reports2] = ctx("chat", { options })
    expect(await onRequest(chat(), c2)).toBeUndefined()
    expect(of("/v1/hook/recall")).toHaveLength(1)
    expect(reports2).toEqual([["unavailable"]])
    // after it: asked again, and a healthy answer is used
    await Bun.sleep(170)
    routes["/v1/hook/recall"] = () => Response.json({ memory: "injected", patch: PATCH })
    const [c3, reports3] = ctx("chat", { options })
    expect(await onRequest(chat(), c3)).toBeDefined()
    expect(of("/v1/hook/recall")).toHaveLength(2)
    expect(reports3[0][0]).toBe("ready")
  })
}

test("the hook's own deadline ends before the host's (default 1000 ms)", async () => {
  mock({ "/v1/hook/recall": hang })
  const [c] = ctx("chat", { options: { requestTimeoutMs: 9000, gatewayTimeoutMs: 200 } })
  const started = Date.now()
  await onRequest(chat(), c)
  expect(Date.now() - started).toBeLessThan(400)
})

test("a client that cancels does not trip the backoff", async () => {
  mock({ "/v1/hook/recall": hang })
  const ac = new AbortController()
  const [c, reports] = ctx("chat", { signal: ac.signal })
  const pending = onRequest(chat(), c)
  setTimeout(() => ac.abort(), 10)
  expect(await pending).toBeUndefined()
  expect(reports).toEqual([])
  routes["/v1/hook/recall"] = () => Response.json({ memory: "injected", patch: PATCH })
  const [c2] = ctx("chat")
  expect(await onRequest(chat(), c2)).toBeDefined()
  expect(of("/v1/hook/recall")).toHaveLength(2)
})

test("only the seven codes magpie accepts are reported, with no content", async () => {
  const allowed = new Set(["ready", "empty", "unbound", "unauthorized", "unavailable", "invalid", "skipped"])
  const seen = []
  for (const [, answer] of [...answers, ...failures.slice(1)]) {
    reset()
    mock({ "/v1/hook/recall": answer })
    const [c, reports] = ctx("chat", { options: { record: true } })
    await onRequest(chat(), c)
    onResponse({ choices: [{ message: { content: "x" } }] }, { ...c, success: true })
    await flush()
    seen.push(...reports)
  }
  expect(seen.length).toBeGreaterThan(0)
  for (const [code, bytes] of seen) {
    expect(allowed.has(code)).toBe(true)
    expect(bytes === undefined || (Number.isInteger(bytes) && bytes >= 0 && bytes <= 32768)).toBe(true)
  }
})

test("a slimmed request is the same at recall and at record, so Aelios hashes one exchange", async () => {
  mock()
  const [c] = ctx("anthropic", { options: { record: true } })
  const req = anthropicString()
  const sent = await onRequest(structuredClone(req), c)
  // ctx.request is the request after injection; the record still carries the pre-injection slim copy
  onResponse({ content: [{ type: "text", text: "Paris" }] }, { ...c, success: true, request: sent })
  await flush()
  expect(JSON.stringify(of("/v1/hook/record")[0].body.body)).toBe(JSON.stringify(of("/v1/hook/recall")[0].body.body))
  expect(JSON.stringify(of("/v1/hook/record")[0].body.body)).not.toContain(PATCH)
})
