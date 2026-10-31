// Runs the hook the way magpie's gateway calls it, against an Aelios faked
// with fetch: no server, no key of anyone's and no network.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { flush, onRequest, onResponse, reset } from "./aelios.hooks.mjs"

const realFetch = globalThis.fetch
const KEY = "synthetic-aelios-key"
const PATCH = "<memory>synthetic recalled fact</memory>"
const calls = []
const identitySlugs = [
  "default", "magpie-test", "gpt-husband", "claude-husband", "selected",
  "wrong-model", "wrong-agent-case", "first", "second", "agent-only", "fallback",
  "stale", "changed", "changed-default", "valid",
]
const metadata = () => Response.json({ identities: identitySlugs.map((slug) => ({ slug, name: slug, mainModels: ["*"] })) })
let routes = {}

function mock(extra = {}) {
  routes = {
    "/v1/hook/identities": metadata,
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
const dialogue = () => calls.filter((c) => /\/v1\/hook\/(recall|record)$/.test(c.path))
function checkMetadata(path = "/v1/hook/identities", key = KEY) {
  const [call] = of(path)
  expect(of(path)).toHaveLength(1)
  expect(call.init.method).toBe("GET")
  expect(call.init.redirect).toBe("error")
  expect(call.init.headers.Authorization).toBe(`Bearer ${key}`)
  expect(call.init.body).toBeUndefined()
  expect(call.body).toBeUndefined()
}
const hang = (_body, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))

function ctx(protocol, extra = {}) {
  const reports = []
  const c = {
    protocol, model: "claude-opus-4-5", stream: true, path: "/v1/messages", origin: "local", agent: "claude",
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

test("the shipped hook and settings service use separate host entry points", async () => {
  const pkg = await Bun.file(new URL("./package.json", import.meta.url)).json()
  expect(pkg.name).toBe("@magpie-community/gateway-aelios")
  expect(pkg.main).toBe("./service.mjs")
  expect(pkg.magpie.page.file).toBe("page/settings.html")
  expect(pkg.magpie.page.service).toEqual({ port: 3481, option: "port" })
  expect(pkg.exports).toBeUndefined()
  expect(pkg.magpie.middleware).toBeUndefined()
  expect(pkg.magpie.gateway).toBeUndefined()
  expect(pkg.magpie.hooks).toBe("./aelios.hooks.mjs")
  expect(Object.hasOwn(pkg.magpie.options, "serverUrl")).toBe(false)
  expect(pkg.files).toEqual(["aelios.hooks.mjs", "slim.mjs", "service.mjs", "probe.mjs", "page", "README.md"])
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
    checkMetadata()
    expect(calls).toHaveLength(2)
    expect(calls[0].path).toBe("/v1/hook/identities")
    const [call] = of("/v1/hook/recall")
    expect(call.body.identity).toBe("default")
    expect(call.url).toBe("https://aelios.example.workers.dev/v1/hook/recall")
    expect(call.init.method).toBe("POST")
    expect(call.init.redirect).toBe("error")
    expect(call.init.headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(call.body.protocol).toBe({ anthropic: "messages", chat: "chat", responses: "responses" }[protocol])
    expect(call.body.model).toBe("claude-opus-4-5")
    expect(call.body.agent).toBe("claude")
    expect(call.body.session).toBe("session-a")
    // slimmed: no system prompt or instructions travel
    expect(JSON.stringify(call.body.body)).not.toContain('"sys"')
    expect(call.body.body.system).toBeUndefined()
    expect(call.body.body.instructions).toBeUndefined()
    expect(c.state.aelios.slimmed).toEqual(call.body.body)
  })
}

test("identity and a server path prefix are passed through", async () => {
  mock({ "/base/v1/hook/identities": metadata, "/base/v1/hook/recall": () => Response.json({ memory: "empty", patch: "" }) })
  const [c, reports] = ctx("anthropic", { options: { serverUrl: "https://a.example/base/", identity: "magpie-test" } })
  expect(await onRequest(anthropicString(), c)).toBeUndefined()
  checkMetadata("/base/v1/hook/identities")
  expect(of("/base/v1/hook/identities")[0].url).toBe("https://a.example/base/v1/hook/identities")
  expect(of("/base/v1/hook/recall")[0].body.identity).toBe("magpie-test")
  expect(reports).toEqual([["empty"]])
})

test("the key can come from AELIOS_API_KEY or a named variable", async () => {
  mock()
  process.env.AELIOS_TEST_KEY = "from-env"
  try {
    const [c] = ctx("chat", { options: { apiKey: undefined, apiKeyEnv: "AELIOS_TEST_KEY" } })
    await onRequest(chat(), c)
    checkMetadata("/v1/hook/identities", "from-env")
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
  checkMetadata()
  expect(calls).toHaveLength(1)
  expect(dialogue()).toHaveLength(0)
  expect(reports).toEqual([["skipped"]])
  const reply = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-4-5-20260101", content: [{ type: "text", text: "Two files." }], stop_reason: "end_turn" }
  onResponse(reply, { ...c, success: true, request: req })
  await flush()
  const [rec] = of("/v1/hook/record")
  expect(rec.body).toEqual({
    protocol: "messages", model: "claude-opus-4-5", agent: "claude", session: "session-a", identity: "default",
    body: c.state.aelios.slimmed,
    reply: { model: reply.model, content: reply.content, stop_reason: reply.stop_reason },
    success: true, upstream_model: "claude-opus-4-5-20260101",
  })
  expect(rec.body.body.messages[2].content).toEqual([{ type: "tool_result", content: "" }])
  expect(reports.at(-1)[0]).toBe("ready")
})

for (const record of [undefined, false, true]) {
  test(`recall explicitly sends recording permission (${record ?? "default"})`, async () => {
    mock()
    const [c] = ctx("chat", { options: record === undefined ? {} : { record } })
    await onRequest(chat(), c)
    expect(of("/v1/hook/recall")[0].body.record).toBe(record === true)
  })
}

for (const record of [false, true]) {
  test(`credentials prevent both recall and response export (record ${record})`, async () => {
    mock()
    const [c, reports] = ctx("chat", { options: { record } })
    // Even stale request state must not allow an onResponse export.
    c.state.aelios = { protocol: "chat", slimmed: { messages: [] } }
    const req = { messages: [{ role: "user", content: "password=synthetic-review-only" }] }
    expect(await onRequest(req, c)).toBeUndefined()
    expect(c.state.aelios).toBeUndefined()
    onResponse({ choices: [{ message: { content: "ok" } }] }, { ...c, success: true })
    await flush()
    expect(calls).toHaveLength(0)
    expect(reports).toEqual([["skipped"]])
  })
}

test("transport-wrapped human speech reaches recall and receives memory", async () => {
  mock()
  const [c] = ctx("chat")
  const text = '<message sender="user" msg_id="123">What is my favorite food?</message>'
  const req = { messages: [{ role: "user", content: text }] }
  expect(await onRequest(req, c)).toBeDefined()
  expect(of("/v1/hook/recall")).toHaveLength(1)
  expect(req.messages[0].content).toBe(`${text}\n\n${PATCH}`)
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
  const [c, reports] = ctx("chat", { agent: "codex", options: { agents: ["claude"], record: true } })
  expect(await onRequest(chat(), c)).toBeUndefined()
  onResponse({ choices: [] }, { ...c, success: true })
  await flush()
  expect(calls).toHaveLength(0)
  expect(reports).toEqual([["skipped"]])
  const [c2] = ctx("chat", { agent: "claude", options: { agents: ["claude"] } })
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
  checkMetadata()
  expect(calls).toHaveLength(1)
  expect(dialogue()).toHaveLength(0)
  expect(reports).toEqual([["skipped"]])
})

test("recall off: no recall request", async () => {
  mock()
  const [c] = ctx("chat", { options: { recall: false } })
  expect(await onRequest(chat(), c)).toBeUndefined()
  checkMetadata()
  expect(calls).toHaveLength(1)
  expect(dialogue()).toHaveLength(0)
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
    { agents: "claude" },
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
  checkMetadata()
  expect(calls).toHaveLength(2)
})

const identityRoutes = [
  { models: ["gpt-*"], identity: "gpt-husband" },
  { models: ["claude-*"], identity: "claude-husband" },
]

for (const [protocol, model, agent, make, identity] of [
  ["chat", "gpt-5", "codex", chat, "gpt-husband"],
  ["anthropic", "claude-opus-4-5", "claude", anthropicString, "claude-husband"],
]) {
  test(`${model}: recall and record use its isolated identity`, async () => {
    mock({ "/v1/hook/recall": (body) => Response.json({ memory: "injected", patch: `<memory>${body.identity}</memory>` }) })
    const [c] = ctx(protocol, { model, agent, options: { routes: identityRoutes, record: true } })
    const req = make()
    const original = structuredClone(req)
    await onRequest(req, c)
    onResponse({ content: [{ type: "text", text: "ok" }] }, { ...c, success: true, request: req })
    await flush()
    expect(of("/v1/hook/recall")[0].body.identity).toBe(identity)
    expect(of("/v1/hook/record")[0].body.identity).toBe(identity)
    expect(JSON.stringify(req)).toContain(`<memory>${identity}</memory>`)
    for (const key of ["model", "stream", "tools", "tool_choice", "system", "instructions"]) expect(req[key]).toEqual(original[key])
    expect(of("/v1/hook/record")[0].body.body).toEqual(of("/v1/hook/recall")[0].body.body)
  })
}

for (const [pattern, model, matches] of [
  ["gpt-*", "provider/nested/GPT-5", true],
  ["PROVIDER/*/gpt-*", "provider/nested/gpt-5", true],
  ["gpt-*", "other-gpt-5", false],
  ["gpt-5", "gpt-5-extra", false],
  ["gpt-5.1+test", "gpt-5.1+test", true],
  ["gpt-5.1+test", "gpt-5X11test", false],
]) {
  test(`model pattern ${pattern} matches ${model}: ${matches}`, async () => {
    mock()
    const [c] = ctx("chat", { model, options: { routes: [{ models: [pattern], identity: "selected" }] } })
    await onRequest(chat(), c)
    expect(dialogue()).toHaveLength(matches ? 1 : 0)
    if (matches) {
      checkMetadata()
      expect(of("/v1/hook/recall")[0].body.identity).toBe("selected")
    } else expect(calls).toHaveLength(0)
  })
}

test("agent and model selectors require AND; the first matching route wins", async () => {
  mock()
  const routing = [
    { models: ["claude-*"], agents: ["codex"], identity: "wrong-model" },
    { models: ["gpt-*"], agents: ["Codex"], identity: "wrong-agent-case" },
    { models: ["gpt-*"], agents: ["codex"], identity: "first" },
    { models: ["gpt-*"], identity: "second" },
  ]
  const [c] = ctx("chat", { model: "gpt-5", agent: "codex", options: { routes: routing } })
  await onRequest(chat(), c)
  expect(of("/v1/hook/recall")[0].body.identity).toBe("first")
  const [agentOnly] = ctx("chat", { model: "other", agent: "codex", options: { routes: [{ agents: ["codex"], identity: "agent-only" }] } })
  await onRequest(chat(), agentOnly)
  checkMetadata()
  expect(calls).toHaveLength(3)
  expect(of("/v1/hook/recall")[1].body.identity).toBe("agent-only")
})

for (const identity of [undefined, "fallback"]) {
  test(`unmatched routes ${identity ? "use explicit fallback" : "skip recall and record, including stale state"}`, async () => {
    mock()
    const [c, reports] = ctx("chat", { model: "other", options: { routes: identityRoutes, identity, record: true } })
    c.state.aelios = { payload: { identity: "stale" }, slimmed: {} }
    await onRequest(chat(), c)
    onResponse({ choices: [] }, { ...c, success: true })
    await flush()
    expect(dialogue()).toHaveLength(identity ? 2 : 0)
    if (identity) {
      checkMetadata()
      expect(calls).toHaveLength(3)
      for (const call of dialogue()) expect(call.body.identity).toBe(identity)
    }
    else {
      expect(calls).toHaveLength(0)
      expect(c.state.aelios).toBeUndefined()
      expect(reports).toEqual([["skipped"]])
    }
  })
}

for (const routes of [undefined, []]) {
  test(`routes ${JSON.stringify(routes)} automatically select the first admitted identity`, async () => {
    mock()
    const [c] = ctx("chat", { options: { routes, record: true } })
    await onRequest(chat(), c)
    onResponse({ choices: [] }, { ...c, success: true })
    await flush()
    checkMetadata()
    expect(calls).toHaveLength(3)
    expect(dialogue()).toHaveLength(2)
    for (const call of dialogue()) expect(call.body.identity).toBe("default")
  })
}

for (const [name, make, protocol, model] of [
  ["tool continuation", anthropicTool, "anthropic", "claude-opus-4-5"],
  ["recall:false", chat, "chat", "gpt-5"],
]) {
  test(`${name} still resolves routing and records with original metadata`, async () => {
    mock()
    const [c] = ctx(protocol, { model, options: { routes: identityRoutes, record: true, recall: name !== "recall:false" } })
    await onRequest(make(), c)
    checkMetadata()
    expect(calls).toHaveLength(1)
    expect(dialogue()).toHaveLength(0)
    onResponse({ choices: [] }, { ...c, success: true })
    await flush()
    expect(calls).toHaveLength(2)
    expect(dialogue()).toHaveLength(1)
    expect(of("/v1/hook/recall")).toHaveLength(0)
    expect(of("/v1/hook/record")[0].body.identity).toBe(model.startsWith("gpt") ? "gpt-husband" : "claude-husband")
  })
}

test("payload is pinned before recall awaits; changed response context and routes cannot redirect recording", async () => {
  let release
  let entered
  const recalling = new Promise((resolve) => { entered = resolve })
  mock({ "/v1/hook/recall": () => new Promise((resolve) => {
    release = () => resolve(Response.json({ memory: "empty" }))
    entered()
  }) })
  const [c] = ctx("chat", { model: "provider/gpt-5", agent: "codex", options: { routes: identityRoutes, record: true } })
  const pending = onRequest(chat(), c)
  await recalling
  expect(c.state.aelios.payload.identity).toBe("gpt-husband")
  c.model = "claude-opus-4-5"
  c.agent = "claude"
  c.session = "different-session"
  c.options.routes = [{ models: ["*"], identity: "changed" }]
  c.options.identity = "changed-default"
  release()
  await pending
  c.state = JSON.parse(JSON.stringify(c.state))
  onResponse({ model: "actual-upstream", choices: [] }, { ...c, request: { model: "other" }, success: true })
  await flush()
  const { record, ...original } = of("/v1/hook/recall")[0].body
  const { reply, success, upstream_model, ...recorded } = of("/v1/hook/record")[0].body
  expect(recorded).toEqual(original)
  expect(recorded).toMatchObject({ identity: "gpt-husband", model: "provider/gpt-5", agent: "codex", session: "session-a" })
  expect(upstream_model).toBe("actual-upstream")
})

for (const change of [{ record: false }, { agents: ["different"] }, { allowRemote: false }]) {
  test(`response still checks current permission ${JSON.stringify(change)}`, async () => {
    mock()
    const [c] = ctx("chat", { model: "gpt-5", options: { routes: identityRoutes, record: true } })
    await onRequest(chat(), c)
    onResponse({ choices: [] }, { ...c, origin: "allowRemote" in change ? "remote" : "local", options: { ...c.options, ...change } })
    await flush()
    expect(of("/v1/hook/record")).toHaveLength(0)
  })
}

test("backoff is isolated by resolved identity on the same server and key", async () => {
  mock({ "/v1/hook/recall": (body) => body.identity === "gpt-husband" ? new Response("", { status: 503 }) : Response.json({ memory: "empty" }) })
  for (const model of ["gpt-5", "claude-opus-4-5", "gpt-6", "claude-sonnet-4-5"]) {
    const [c] = ctx("chat", { model, options: { routes: identityRoutes } })
    await onRequest(chat(), c)
  }
  checkMetadata()
  expect(of("/v1/hook/recall").map((call) => call.body.identity)).toEqual(["gpt-husband", "claude-husband", "claude-husband"])
})

test("invalid routes always fail with a fixed error and zero network, clearing stale state", async () => {
  mock()
  const valid = { models: ["gpt-*"], identity: "gpt-husband" }
  for (const routes of [
    null, {}, "routes", Array(65).fill(valid), [null], [[]], ["route"], [{}],
    [{ ...valid, identity: "" }], [{ ...valid, identity: " " }], [{ ...valid, identity: "a".repeat(65) }],
    ...["/path", "with space", "é", "_leading", "admin", "V1"].map((identity) => [{ ...valid, identity }]),
    [{ identity: "valid" }], [{ ...valid, models: [] }], [{ ...valid, models: "gpt-*" }],
    ...[null, 12, "", " ", "x".repeat(201)].map((pattern) => [{ ...valid, models: [pattern] }]),
    [{ ...valid, agents: [] }], [{ ...valid, agents: null }], [{ ...valid, agents: [""] }], [{ ...valid, agents: [1] }],
  ]) {
    const [c, reports] = ctx("chat", { options: { routes, record: true } })
    c.state.aelios = { payload: { identity: "stale" }, slimmed: {} }
    await expect(onRequest(chat(), c)).rejects.toThrow("Aelios invalid")
    onResponse({ choices: [] }, c)
    await flush()
    expect(c.state.aelios).toBeUndefined()
    expect(reports).toEqual([["invalid"]])
    expect(calls).toHaveLength(0)
  }
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


// The request history is sanitized; fresh speech fields consumed by
// OutputCollector, including speech tool arguments, survive reply slimming.
const privacyProtocols = [
  {
    protocol: "anthropic", key: "messages",
    calls: [
      { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "/synthetic-private.ts", old_string: "old", new_string: "const token = getToken(req)" } }] },
      { role: "assistant", content: [{ type: "server_tool_use", name: "Write", input: { content: "interface Opts { apiKey: string }; password=synthetic-history-only" } }] },
    ],
    reply: (text) => ({ content: [{ type: "tool_use", name: "send_message", input: { text } }] }),
  },
  {
    protocol: "chat", key: "messages",
    calls: [{ role: "assistant", tool_calls: [
      { type: "function", function: { name: "Edit", arguments: '{"new_string":"const token = getToken(req)","file_path":"/synthetic-private.ts"}' } },
      { type: "function", function: { name: "Write", arguments: '{"content":"interface Opts { apiKey: string }; password=synthetic-history-only"}' } },
    ] }],
    reply: (text) => ({ choices: [{ message: { tool_calls: [{ type: "function", function: { name: "send_message", arguments: JSON.stringify({ text }) } }] } }] }),
  },
  {
    protocol: "responses", key: "input",
    calls: [
      { type: "function_call", name: "Edit", arguments: '{"new_string":"const token = getToken(req)","file_path":"/synthetic-private.ts"}' },
      { type: "custom_tool_call", name: "Write", input: "interface Opts { apiKey: string }; password=synthetic-history-only" },
    ],
    reply: (text) => ({ output: [{ type: "function_call", name: "send_message", arguments: JSON.stringify({ text }) }, { type: "custom_tool_call", name: "send_message", input: text }] }),
  },
]

for (const { protocol, key, calls: history, reply } of privacyProtocols) {
  test(`${protocol}: historical Edit/Write arguments never export; next turn recalls and fresh speech stays intact`, async () => {
    mock()
    const [c] = ctx(protocol, { options: { record: true } })
    const req = { [key]: [{ role: "user", content: "Fix the code" }, ...history, { role: "user", content: "What is for dinner?" }] }
    const before = structuredClone(req)
    expect(await onRequest(req, c)).toBeDefined()
    const fresh = reply("synthetic speech for the recipient")
    const originalReply = structuredClone(fresh)
    onResponse(fresh, { ...c, success: true })
    await flush()
    expect(of("/v1/hook/recall")).toHaveLength(1)
    expect(of("/v1/hook/record")).toHaveLength(1)
    const recalled = of("/v1/hook/recall")[0].body.body
    const recorded = of("/v1/hook/record")[0].body
    expect(recorded.body).toEqual(recalled)
    expect(recorded.reply).toEqual(protocol === "chat"
      ? { choices: [{ message: { role: "assistant", content: [], tool_calls: originalReply.choices[0].message.tool_calls } }] }
      : originalReply)
    expect(fresh).toEqual(originalReply)
    const wire = JSON.stringify(recorded.body)
    for (const privateText of ["getToken", "Opts", "synthetic-history-only", "synthetic-private", "old_string", "new_string", "arguments"]) expect(wire).not.toContain(privateText)
    expect(JSON.stringify(recalled[key])).not.toContain('"input":')
    expect(wire).toContain("Edit")
    expect(wire).toContain("Write")
    expect(req[key].slice(0, -1)).toEqual(before[key].slice(0, -1))
  })

  for (const record of [false, true]) {
    test(`${protocol}: historical secret text is omitted and ordinary current turn recalls (record ${record})`, async () => {
      mock()
      const [c] = ctx(protocol, { options: { record } })
      const req = { [key]: [
        { role: "user", content: "password=synthetic-history-only" },
        { role: "assistant", content: [{ type: "text", text: "sk-abcdefghijklmnopqrstuvwxyz" }, { type: "text", text: "safe context" }] },
        { role: "user", content: "What do you remember?" },
      ] }
      expect(await onRequest(req, c)).toBeDefined()
      onResponse(reply("safe speech"), { ...c, success: true })
      await flush()
      expect(of("/v1/hook/recall")).toHaveLength(1)
      expect(of("/v1/hook/record")).toHaveLength(record ? 1 : 0)
      for (const call of dialogue()) {
        const wire = JSON.stringify(call.body)
        expect(wire).not.toContain("synthetic-history-only")
        expect(wire).not.toContain("sk-abcdefghijklmnopqrstuvwxyz")
        expect(call.body.body[key][0].content).toBe("[credential omitted]")
        expect(call.body.body[key][1].content).toEqual([{ type: "text", text: "[credential omitted]" }, { type: "text", text: "safe context" }])
      }
    })

    test(`${protocol}: current credential skips whole turn and next human turn recovers (record ${record})`, async () => {
      mock()
      const [c] = ctx(protocol, { options: { record } })
      const secret = { role: "user", content: [{ type: "text", text: "token=synthetic-current-only" }] }
      const req = { [key]: [secret] }
      expect(await onRequest(req, c)).toBeUndefined()
      expect(req[key][0]).toEqual(secret)
      expect(c.state.aelios).toBeUndefined()
      onResponse(reply("safe speech"), { ...c, success: true })
      await flush()
      expect(calls).toHaveLength(0)
      const next = { [key]: [secret, { role: "assistant", content: "ok" }, { role: "user", content: "What should I eat?" }] }
      expect(await onRequest(next, c)).toBeDefined()
      onResponse(reply("safe speech"), { ...c, success: true })
      await flush()
      expect(of("/v1/hook/recall")).toHaveLength(1)
      expect(of("/v1/hook/record")).toHaveLength(record ? 1 : 0)
      for (const call of dialogue()) expect(JSON.stringify(call.body)).not.toContain("synthetic-current-only")
    })
  }

  test(`${protocol}: secret in fresh speech arguments still prevents recording`, async () => {
    mock()
    const [c, reports] = ctx(protocol, { options: { record: true } })
    await onRequest({ [key]: [{ role: "user", content: "Say hello" }] }, c)
    onResponse(reply("token=synthetic-reply-only"), { ...c, success: true })
    await flush()
    expect(of("/v1/hook/recall")).toHaveLength(1)
    expect(of("/v1/hook/record")).toHaveLength(0)
    expect(reports.at(-1)).toEqual(["skipped"])
  })
}

test("tool-only final user records safely after a credential-bearing human turn", async () => {
  mock()
  const [c] = ctx("anthropic", { options: { record: true } })
  const req = anthropicTool()
  req.messages[0].content = "password=synthetic-prior-human"
  expect(await onRequest(req, c)).toBeUndefined()
  onResponse({ content: [{ type: "text", text: "Done" }] }, { ...c, success: true })
  await flush()
  expect(of("/v1/hook/recall")).toHaveLength(0)
  expect(of("/v1/hook/record")).toHaveLength(1)
  expect(of("/v1/hook/record")[0].body.body.messages[0].content).toBe("[credential omitted]")
  expect(JSON.stringify(of("/v1/hook/record")[0].body)).not.toContain("synthetic-prior-human")
})

test("legacy claude-code remains an exact supported agent id", async () => {
  mock()
  const [c] = ctx("anthropic", { agent: "claude-code", options: { agents: ["claude-code"] } })
  expect(await onRequest(anthropicString(), c)).toBeDefined()
  expect(of("/v1/hook/recall")[0].body.agent).toBe("claude-code")
})

test("ordinary generation max_token text still recalls", async () => {
  mock()
  const [c] = ctx("chat")
  expect(await onRequest({ messages: [{ role: "user", content: "Use max_token: 4000" }] }, c)).toBeDefined()
  expect(of("/v1/hook/recall")).toHaveLength(1)
})
