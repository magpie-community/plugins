// Anthropic's hosted web search on Kiro: the model's call to web_search is
// searched with Kiro's own web_search, through its runtime's InvokeMCP as
// kiro-cli calls it,
// the model asked again with what was found, and the caller answered with
// server_tool_use, web_search_tool_result and the answer, never a tool_use
// of web_search. Everything runs against a fake Kiro: no network.
import { expect, test, afterAll, afterEach } from "bun:test"
import { KiroAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
const offline = async () => { throw new Error("no network in tests") }
globalThis.fetch = offline
afterEach(() => (globalThis.fetch = offline))
afterAll(() => (globalThis.fetch = real))

function frame(headers, payload) {
  const enc = new TextEncoder()
  const hs = []
  for (const [k, v] of Object.entries(headers)) {
    const name = enc.encode(k)
    const val = enc.encode(v)
    const h = new Uint8Array(1 + name.length + 1 + 2 + val.length)
    h[0] = name.length
    h.set(name, 1)
    h[1 + name.length] = 7
    new DataView(h.buffer).setUint16(2 + name.length, val.length)
    h.set(val, 4 + name.length)
    hs.push(h)
  }
  const hlen = hs.reduce((n, h) => n + h.length, 0)
  const body = enc.encode(JSON.stringify(payload))
  const total = 12 + hlen + body.length + 4
  const out = new Uint8Array(total)
  const v = new DataView(out.buffer)
  v.setUint32(0, total)
  v.setUint32(4, hlen)
  let i = 12
  for (const h of hs) {
    out.set(h, i)
    i += h.length
  }
  out.set(body, i)
  return out
}
const ev = (type, payload) => frame({ ":message-type": "event", ":event-type": type }, payload)
const say = (text) => ev("assistantResponseEvent", { content: text })
const use = (id, name, input) => [ev("toolUseEvent", { toolUseId: id, name, input: JSON.stringify(input) }), ev("toolUseEvent", { toolUseId: id, name, stop: true })]
const stream = (frames) => new Response(new ReadableStream({ start(c) { for (const f of frames.flat()) c.enqueue(f); c.close() } }), { status: 200 })

const hit = (n, over = {}) => ({ title: `Page ${n}`, url: `https://example${n}.com/a`, snippet: `snippet ${n}`, publishedDate: "2026-10-01",
  id: `id${n}`, domain: `example${n}.com`, maxVerbatimWordLimit: 30, publicDomain: false, ...over })
const mcpOK = (results, query = "q") =>
  Response.json({ jsonrpc: "2.0", id: "1", result: { content: [{ type: "text", text: JSON.stringify({ results, totalResults: results.length, query, error: null }) }] } })

// kiro is a fake Kiro: turns answers each generateAssistantResponse in turn,
// mcp each InvokeMCP (known by its x-amz-target, wherever it is sent). It
// notes what was sent.
function kiro({ turns, mcp = () => mcpOK([hit(1), hit(2)]), refresh } = {}) {
  const seen = { kiro: [], mcp: [], refreshes: 0 }
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.includes("generateAssistantResponse")) {
      seen.kiro.push({ url: u, body: JSON.parse(init.body), headers: new Headers(init.headers) })
      const t = turns[seen.kiro.length - 1]
      if (!t) throw new Error("Kiro asked more turns than scripted")
      return typeof t === "function" ? t(init) : stream(t)
    }
    if (new Headers(init.headers).get("x-amz-target") === "AmazonCodeWhispererStreamingService.InvokeMCP") {
      seen.mcp.push({ url: u, body: JSON.parse(init.body), headers: new Headers(init.headers) })
      return mcp(init, seen.mcp.length)
    }
    if (u.includes("refreshToken")) {
      seen.refreshes++
      return refresh ? refresh() : Response.json({ accessToken: "new", refreshToken: "r2", expiresIn: 3600 })
    }
    return new Response("{}", { status: 400 }) // GetProfile: a key with no profile
  }
  return seen
}

const KEY = { type: "api", key: "ksk_secretsecretsecret" }
const PROFILE = "arn:aws:codewhisperer:eu-central-1:111111111111:profile/TEST"
const OAUTH = { type: "oauth", access: "old", refresh: "r1", expires: Date.now() + 3600_000, method: "social", region: "eu-central-1",
  profileArn: PROFILE, accountId: "me@example.com" }
const SEARCH_TYPE_OK = "web_search_20250305"
const SEARCH = { type: SEARCH_TYPE_OK, name: "web_search", max_uses: 3 }
// kiro-cli's own web_search (2.35's strings), with the purpose its agent adds
const CLI_SPEC = { name: "web_search",
  description: "WebSearch looks up information that is outside the model's training data or cannot be reliably inferred from the current codebase/context.",
  inputSchema: { json: { type: "object", properties: {
    query: { type: "string", maxLength: 200, description: "Search query (max 200 chars) - use concise keywords, not full sentences" },
    __tool_use_purpose: { type: "string", description: "A brief explanation why you are making this tool use." } }, required: ["query"] } } }
const READ = { name: "Read", description: "read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }

async function ask(body, { auth = KEY, signal } = {}) {
  const hooks = await KiroAuthPlugin({ client: { auth: { set: async () => {} } } })
  const l = await hooks.auth.loader(async () => auth)
  return l.fetch("https://kiro.invalid/v1/messages", { method: "POST", signal,
    body: JSON.stringify({ model: "claude-haiku-5.5", max_tokens: 1024, messages: [{ role: "user", content: "what's new?" }], ...body }) })
}
// sse reads a stream's events, and the message they build
async function sse(res) {
  const out = []
  for (const chunk of (await res.text()).split("\n\n"))
    for (const line of chunk.split("\n")) if (line.startsWith("data: ")) out.push(JSON.parse(line.slice(6)))
  return out
}
const toolsSent = (s, i = 0) => s.kiro[i].body.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools ?? []

test("a search the model asks for is Kiro's MCP web_search, its pages given back, the answer after (buffered)", async () => {
  const s = kiro({ turns: [[say("Let me look. "), use("tu1", "web_search", { query: "magpie release" })], [say("Magpie 2 is out [https://example1.com/a].")]] })
  const res = await ask({ tools: [SEARCH] })
  expect(res.status).toBe(200)
  const m = await res.json()
  // the tool Kiro is offered: its own web search, not the hosted declaration
  expect(toolsSent(s).map((t) => t.toolSpecification.name)).toEqual(["web_search"])
  expect(toolsSent(s)[0].toolSpecification).toEqual(CLI_SPEC)
  // the search, as kiro-cli sends it: InvokeMCP at the runtime's root, the
  // tools/call's arguments the query alone (no _meta)
  expect(s.mcp.length).toBe(1)
  const q = s.mcp[0]
  expect(q.url).toBe("https://runtime.us-east-1.kiro.dev/")
  expect(q.headers.get("content-type")).toBe("application/x-amz-json-1.0")
  expect(q.headers.get("x-amz-target")).toBe("AmazonCodeWhispererStreamingService.InvokeMCP")
  expect(q.body).toEqual({ jsonrpc: "2.0", id: "1", method: "tools/call", params: { name: "web_search", arguments: { query: "magpie release" } } })
  expect(q.headers.get("authorization")).toBe("Bearer ksk_secretsecretsecret")
  expect(q.headers.get("tokentype")).toBe("API_KEY")
  // an API key names no profile, in the body (above) or a header, as kiro-cli;
  // nothing of generateAssistantResponse's own
  expect(q.headers.has("x-amzn-kiro-profile-arn")).toBe(false)
  for (const h of ["x-amzn-kiro-agent-mode", "x-amzn-codewhisperer-optout", "accept"]) expect(q.headers.has(h)).toBe(false)
  // the next turn has the call and its result, snippets included
  const next = s.kiro[1].body.conversationState
  const call = next.history.at(-1).assistantResponseMessage
  expect(call.content).toBe("Let me look. ")
  expect(call.toolUses).toEqual([{ name: "web_search", toolUseId: expect.stringMatching(/^srvtoolu_/), input: { query: "magpie release" } }])
  const result = next.currentMessage.userInputMessage.userInputMessageContext.toolResults[0]
  expect(result.toolUseId).toBe(call.toolUses[0].toolUseId)
  expect(result.status).toBe("success")
  expect(result.content[0].text).toContain("URL: https://example1.com/a")
  expect(result.content[0].text).toContain("snippet 2")
  // the caller's answer
  expect(m.content.map((b) => b.type)).toEqual(["text", "server_tool_use", "web_search_tool_result", "text"])
  expect(m.content[1]).toEqual({ type: "server_tool_use", id: call.toolUses[0].toolUseId, name: "web_search", input: { query: "magpie release" } })
  expect(m.content[2]).toEqual({ type: "web_search_tool_result", tool_use_id: m.content[1].id, content: [
    { type: "web_search_result", title: "Page 1", url: "https://example1.com/a", encrypted_content: "", page_age: "2026-10-01" },
    { type: "web_search_result", title: "Page 2", url: "https://example2.com/a", encrypted_content: "", page_age: "2026-10-01" }] })
  expect(m.content[3].text).toContain("https://example1.com/a")
  expect(m.stop_reason).toBe("end_turn")
  expect(m.usage.server_tool_use).toEqual({ web_search_requests: 1 })
  expect(JSON.stringify(m)).not.toContain('"tool_use"')
})

// kiro-cli's agent adds __tool_use_purpose to its tools: the model may say
// why it searches. That is kiro-cli's, not Anthropic's: the caller's
// server_tool_use has the query alone, and only the query is searched for.
test("a search's turns are one request: their credits are summed", async () => {
  const metered = (n) => ev("meteringEvent", { unit: "credit", unitPlural: "credits", usage: n })
  const s = kiro({ turns: [[say("Let me look. "), use("tu1", "web_search", { query: "magpie release" }), metered(0.25)], [say("Magpie 2 is out."), metered(0.5)]] })
  const m = await (await ask({ tools: [SEARCH] })).json()
  expect(s.kiro.length).toBe(2)
  expect(m.usage.credit).toBe(0.75)
})

test("a call's __tool_use_purpose is neither searched for nor shown, nor sent back", async () => {
  const s = kiro({ turns: [[use("tu1", "web_search", { query: "bun 2", __tool_use_purpose: "check the release" })], [say("ok")]] })
  const m = await (await ask({ tools: [SEARCH] })).json()
  expect(s.mcp[0].body.params.arguments).toEqual({ query: "bun 2" })
  expect(m.content[0]).toEqual({ type: "server_tool_use", id: expect.stringMatching(/^srvtoolu_/), name: "web_search", input: { query: "bun 2" } })
  expect(s.kiro[1].body.conversationState.history.at(-1).assistantResponseMessage.toolUses[0].input).toEqual({ query: "bun 2" })
  // streamed too
  kiro({ turns: [[use("tu1", "web_search", { query: "bun 2", __tool_use_purpose: "why" })], [say("ok")]] })
  const events = await sse(await ask({ tools: [SEARCH], stream: true }))
  const input = events.filter((e) => e.type === "content_block_delta" && e.index === 0).map((e) => e.delta.partial_json).join("")
  expect(JSON.parse(input)).toEqual({ query: "bun 2" })
})

// InvokeMCP's answer is { jsonrpc, id, result, error }; result is a document
test("InvokeMCP's answer is read, its result an object or its JSON text; its error is a search error", async () => {
  const text = JSON.stringify({ results: [hit(1)], totalResults: 1, query: "x", error: null })
  for (const result of [{ content: [{ type: "text", text }] }, JSON.stringify({ content: [{ type: "text", text }] })]) {
    kiro({ turns: [[use("a", "web_search", { query: "x" })], [say("ok")]], mcp: () => Response.json({ jsonrpc: "2.0", id: "1", result }) })
    const m = await (await ask({ tools: [SEARCH] })).json()
    expect(m.content.find((b) => b.type === "web_search_tool_result").content.map((r) => r.url)).toEqual(["https://example1.com/a"])
  }
  const s = kiro({ turns: [[use("a", "web_search", { query: "x" })], [say("ok")]],
    mcp: () => Response.json({ jsonrpc: "2.0", id: "1", error: { code: -32602, message: "bad params" } }) })
  const m = await (await ask({ tools: [SEARCH] })).json()
  expect(m.content.find((b) => b.type === "web_search_tool_result").content).toEqual({ type: "web_search_tool_result_error", error_code: "unavailable" })
  expect(s.kiro[1].body.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults[0].content[0].text).toContain("bad params")
})

test("streamed, the same blocks come as Messages' events", async () => {
  kiro({ turns: [[use("tu1", "web_search", { query: "magpie" })], [say("Found it.")]] })
  const events = await sse(await ask({ tools: [SEARCH], stream: true }))
  const starts = events.filter((e) => e.type === "content_block_start").map((e) => e.content_block)
  expect(starts.map((b) => b.type)).toEqual(["server_tool_use", "web_search_tool_result", "text"])
  expect(starts[1].content[0]).toMatchObject({ type: "web_search_result", url: "https://example1.com/a" })
  const input = events.filter((e) => e.type === "content_block_delta" && e.index === 0).map((e) => e.delta.partial_json).join("")
  expect(JSON.parse(input)).toEqual({ query: "magpie" })
  expect(events.filter((e) => e.type === "content_block_stop").map((e) => e.index)).toEqual([0, 1, 2])
  const done = events.find((e) => e.type === "message_delta")
  expect(done.delta.stop_reason).toBe("end_turn")
  expect(done.usage.server_tool_use).toEqual({ web_search_requests: 1 })
  expect(events.at(-1).type).toBe("message_stop")
})

test("a call of the caller's own tool is passed on, the searches of its turn with it; neither is run twice", async () => {
  const s = kiro({ turns: [[use("tu1", "Read", { path: "a.txt" }), use("tu2", "web_search", { query: "x" })]] })
  const m = await (await ask({ tools: [READ, SEARCH] })).json()
  expect(m.content.map((b) => b.type)).toEqual(["tool_use", "server_tool_use", "web_search_tool_result"])
  expect(m.content[0]).toEqual({ type: "tool_use", id: "tu1", name: "Read", input: { path: "a.txt" } })
  expect(m.stop_reason).toBe("tool_use")
  expect(s.kiro.length).toBe(1) // the caller runs Read and comes back
  expect(s.mcp.length).toBe(1)
})

test("the conversation sent back with the search and the tool's result pairs each call with its result", async () => {
  const s = kiro({ turns: [[use("tu1", "Read", { path: "a.txt" }), use("tu2", "web_search", { query: "x" })], [say("Done.")]] })
  const first = await (await ask({ tools: [READ, SEARCH] })).json()
  const messages = [{ role: "user", content: "what's new?" }, { role: "assistant", content: first.content },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "file text" }] }]
  const m = await (await ask({ tools: [READ, SEARCH], messages })).json()
  expect(m.content).toEqual([{ type: "text", text: "Done." }])
  const st = s.kiro[1].body.conversationState
  const calls = st.history.filter((e) => e.assistantResponseMessage).flatMap((e) => e.assistantResponseMessage.toolUses ?? [])
  expect(calls.map((c) => c.name)).toEqual(["Read", "web_search"])
  // every call is answered in the message after it, the search's with its snippets
  const results = [...st.history.filter((e) => e.userInputMessage?.userInputMessageContext).flatMap((e) => e.userInputMessage.userInputMessageContext.toolResults ?? []),
    ...(st.currentMessage.userInputMessage.userInputMessageContext?.toolResults ?? [])]
  expect(results.map((r) => r.toolUseId).sort()).toEqual(calls.map((c) => c.toolUseId).sort())
  expect(results.find((r) => r.toolUseId === "tu1").content[0].text).toBe("file text")
  expect(results.find((r) => r.toolUseId === first.content[1].id).content[0].text).toContain("snippet 1")
  expect(results.some((r) => r.content[0].text.includes("interrupted"))).toBe(false)
})

test("a history of another client's search (no snippets kept here) is told from its titles and URLs; an error as an error", async () => {
  const s = kiro({ turns: [[say("ok")]] })
  const messages = [{ role: "user", content: "q" }, { role: "assistant", content: [
    { type: "server_tool_use", id: "srvtoolu_other1", name: "web_search", input: { query: "a" } },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_other1", content: [{ type: "web_search_result", title: "T", url: "https://t.example/", encrypted_content: "Eq…", page_age: null }] },
    { type: "server_tool_use", id: "srvtoolu_other2", name: "web_search", input: { query: "b" } },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_other2", content: { type: "web_search_tool_result_error", error_code: "unavailable" } },
    { type: "text", text: "Answer." }] }, { role: "user", content: "more" }]
  await (await ask({ tools: [SEARCH], messages })).json()
  const h = s.kiro[0].body.conversationState.history
  expect(h.map((e) => Object.keys(e)[0])).toEqual(["userInputMessage", "assistantResponseMessage", "userInputMessage", "assistantResponseMessage", "userInputMessage", "assistantResponseMessage"])
  expect(h[1].assistantResponseMessage.toolUses[0].toolUseId).toBe("srvtoolu_other1")
  expect(h[2].userInputMessage.userInputMessageContext.toolResults[0]).toEqual({ toolUseId: "srvtoolu_other1", status: "success", content: [{ text: "[1] T\nURL: https://t.example/" }] })
  expect(h[4].userInputMessage.userInputMessageContext.toolResults[0]).toMatchObject({ toolUseId: "srvtoolu_other2", status: "error" })
  expect(h[5].assistantResponseMessage.content).toBe("Answer.")
  expect(JSON.stringify(s.kiro[0].body)).not.toContain("Eq…")
})

// Anthropic's own reply to parallel searches has both calls, then both
// results: each result still answers its call
test("a history of parallel searches, the calls before their results, keeps each result with its call", async () => {
  const s = kiro({ turns: [[say("ok")]] })
  const result = (id, url) => ({ type: "web_search_tool_result", tool_use_id: id, content: [{ type: "web_search_result", title: url, url, encrypted_content: "", page_age: null }] })
  const messages = [{ role: "user", content: "q" }, { role: "assistant", content: [
    { type: "server_tool_use", id: "srvtoolu_p1", name: "web_search", input: { query: "a" } },
    { type: "server_tool_use", id: "srvtoolu_p2", name: "web_search", input: { query: "b" } },
    result("srvtoolu_p1", "https://a.example/"), result("srvtoolu_p2", "https://b.example/"),
    { type: "text", text: "Both." }] }, { role: "user", content: "more" }]
  await (await ask({ tools: [SEARCH], messages })).json()
  const h = s.kiro[0].body.conversationState.history
  expect(h.map((e) => Object.keys(e)[0])).toEqual(["userInputMessage", "assistantResponseMessage", "userInputMessage", "assistantResponseMessage"])
  expect(h[1].assistantResponseMessage.toolUses.map((c) => c.toolUseId)).toEqual(["srvtoolu_p1", "srvtoolu_p2"])
  expect(h[2].userInputMessage.userInputMessageContext.toolResults.map((r) => [r.toolUseId, r.status, r.content[0].text])).toEqual([
    ["srvtoolu_p1", "success", "[1] https://a.example/\nURL: https://a.example/"],
    ["srvtoolu_p2", "success", "[1] https://b.example/\nURL: https://b.example/"]])
  expect(h[3].assistantResponseMessage.content).toBe("Both.")
})

test("max_uses is kept: searches past it are max_uses_exceeded, unsearched", async () => {
  const s = kiro({ turns: [[use("a", "web_search", { query: "1" }), use("b", "web_search", { query: "2" })], [say("done")]] })
  const m = await (await ask({ tools: [{ ...SEARCH, max_uses: 1 }] })).json()
  const results = m.content.filter((b) => b.type === "web_search_tool_result")
  expect(results.length).toBe(2)
  expect(Array.isArray(results[0].content)).toBe(true)
  expect(results[1].content).toEqual({ type: "web_search_tool_result_error", error_code: "max_uses_exceeded" })
  expect(s.mcp.length).toBe(1)
  expect(m.usage.server_tool_use).toEqual({ web_search_requests: 1 })
})

test("a max_uses that isn't a whole number of at least 1 is a 400, nothing searched or asked", async () => {
  for (const max_uses of [0, -1, 1.5, "3"]) {
    const s = kiro({ turns: [] })
    const res = await ask({ tools: [{ ...SEARCH, max_uses }] })
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toContain("max_uses")
    expect(s.kiro.length + s.mcp.length).toBe(0)
  }
})

test("a model that keeps searching is stopped: max_uses + 2 turns, then pause_turn", async () => {
  const again = () => [use("x" + Math.random(), "web_search", { query: "again" })]
  const s = kiro({ turns: [again(), again(), again(), again(), again()] })
  const m = await (await ask({ tools: [{ ...SEARCH, max_uses: 1 }] })).json()
  expect(s.kiro.length).toBe(3)
  expect(s.mcp.length).toBe(1)
  expect(m.stop_reason).toBe("pause_turn")
  // and no max_uses is bounded too
  const s2 = kiro({ turns: Array.from({ length: 30 }, again) })
  await (await ask({ tools: [{ type: "web_search_20250305", name: "web_search" }] })).json()
  expect(s2.mcp.length).toBe(10)
  expect(s2.kiro.length).toBe(12)
})

test("a query missing or over 200 characters isn't sent to the search", async () => {
  const s = kiro({ turns: [[use("a", "web_search", {}), use("b", "web_search", { query: "x".repeat(201) })], [say("ok")]] })
  const m = await (await ask({ tools: [SEARCH] })).json()
  expect(m.content.filter((b) => b.type === "web_search_tool_result").map((b) => b.content.error_code)).toEqual(["invalid_tool_input", "query_too_long"])
  expect(s.mcp.length).toBe(0)
})

test("a search that fails is a web_search_tool_result_error, the model told why, with no token in it", async () => {
  const answers = [
    () => new Response("<html>oops</html>", { status: 200 }),
    () => Response.json({ jsonrpc: "2.0", id: "1", error: { code: -32000, message: "bad Bearer ksk_secretsecretsecret" } }),
    () => Response.json({ jsonrpc: "2.0", id: "1", result: { isError: true, content: [{ type: "text", text: "tool failed" }] } }),
    () => new Response("slow down", { status: 429 }),
    () => new Response("boom", { status: 500 }),
    () => Response.json({ jsonrpc: "2.0", id: "1", result: { content: {} } }),
    () => Response.json({ jsonrpc: "2.0", id: "1", result: { content: [{ type: "text", text: JSON.stringify({ results: {} }) }] } }),
    () => { throw new Error("connect ECONNREFUSED token=ksk_secretsecretsecret") },
  ]
  for (const [i, answer] of answers.entries()) {
    const s = kiro({ turns: [[use("a", "web_search", { query: "x" })], [say("sorry")]], mcp: answer })
    const m = await (await ask({ tools: [SEARCH] })).json()
    const r = m.content.find((b) => b.type === "web_search_tool_result")
    expect(r.content).toEqual({ type: "web_search_tool_result_error", error_code: i === 3 ? "too_many_requests" : "unavailable" })
    const told = s.kiro[1].body.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults[0]
    expect(told.status).toBe("error")
    expect(told.content[0].text).toStartWith("Web search failed")
    expect(JSON.stringify(s.kiro[1].body)).not.toContain("secretsecret")
    expect(m.content.at(-1)).toEqual({ type: "text", text: "sorry" })
  }
})

test("a token Kiro's search turns down is refreshed once and the search tried again", async () => {
  const s = kiro({ turns: [[use("a", "web_search", { query: "x" })], [say("ok")]],
    mcp: (init, n) => (n === 1 ? new Response("{}", { status: 403 }) : mcpOK([hit(1)])) })
  const m = await (await ask({ tools: [SEARCH] }, { auth: OAUTH })).json()
  expect(s.refreshes).toBe(1)
  expect(s.mcp.map((c) => c.headers.get("authorization"))).toEqual(["Bearer old", "Bearer new"])
  // the profile's region is the search's too. The profile is InvokeMCP's
  // profileArn in the body (AWS JSON 1.0; without it Kiro answers 400
  // "profileArn is required for this request"), and x-amzn-kiro-profile-arn
  // too, as kiro-cli 2.35 sends it
  expect(s.mcp.map((c) => c.url)).toEqual(["https://runtime.eu-central-1.kiro.dev/", "https://runtime.eu-central-1.kiro.dev/"])
  expect(s.mcp.map((c) => c.headers.get("x-amzn-kiro-profile-arn"))).toEqual([PROFILE, PROFILE])
  expect(s.mcp.map((c) => c.headers.has("tokentype"))).toEqual([false, false])
  expect(s.mcp.map((c) => c.body)).toEqual([0, 1].map(() =>
    ({ jsonrpc: "2.0", id: "1", method: "tools/call", profileArn: PROFILE, params: { name: "web_search", arguments: { query: "x" } } })))
  expect(Array.isArray(m.content.find((b) => b.type === "web_search_tool_result").content)).toBe(true)
  // an API key isn't refreshed: the search is unavailable, the answer goes on
  const s2 = kiro({ turns: [[use("a", "web_search", { query: "x" })], [say("ok")]], mcp: () => new Response("{}", { status: 403 }) })
  const m2 = await (await ask({ tools: [SEARCH] })).json()
  expect(s2.refreshes).toBe(0)
  expect(m2.content.find((b) => b.type === "web_search_tool_result").content.error_code).toBe("unavailable")
  expect(m2.content.at(-1).text).toBe("ok")
})

test("Kiro failing on the turn after a search is said, buffered and streamed", async () => {
  const fail = () => new Response(JSON.stringify({ message: "Improperly formed request." }), { status: 400 })
  kiro({ turns: [[say("Looking. "), use("a", "web_search", { query: "x" })], fail] })
  const events = await sse(await ask({ tools: [SEARCH], stream: true }))
  expect(events.find((e) => e.type === "error").error.message).toContain("Improperly formed request.")
  // buffered, it is a status: the searches alone aren't a finished answer
  kiro({ turns: [[say("Looking. "), use("a", "web_search", { query: "x" })], fail] })
  let res = await ask({ tools: [SEARCH] })
  expect(res.status).toBe(400)
  expect((await res.json()).error.message).toContain("Improperly formed request.")
  // and so is that turn's reply breaking off
  const broken = frame({ ":message-type": "exception", ":exception-type": "internalServerException" }, { message: "kaput" })
  kiro({ turns: [[use("a", "web_search", { query: "x" })], [say("half an"), broken]] })
  res = await ask({ tools: [SEARCH] })
  expect(res.status).toBe(502)
  expect((await res.json()).error.message).toContain("kaput")
  // with nothing said before it, a status another account may take over from
  kiro({ turns: [fail] })
  expect((await ask({ tools: [SEARCH] })).status).toBe(400)
  // the first turn breaking off after some of the answer keeps what was said, as without the search
  kiro({ turns: [[say("half an"), broken]] })
  res = await ask({ tools: [SEARCH] })
  expect(res.status).toBe(200)
  expect((await res.json()).content).toEqual([{ type: "text", text: "half an" }])
})

test("a request cancelled during a search stops there: no more searches or turns", async () => {
  const ctl = new AbortController()
  const s = kiro({ turns: [[use("a", "web_search", { query: "x" })], [say("never")]],
    mcp: (init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))
      setTimeout(() => ctl.abort(), 5)
    }) })
  const e = await ask({ tools: [SEARCH] }, { signal: ctl.signal }).then((r) => r.json()).catch((e) => e)
  expect(e?.name).toBe("AbortError")
  expect(s.kiro.length).toBe(1)
  expect(s.mcp.length).toBe(1)
  // cancelled while Kiro's reply is read, it isn't taken for a whole answer
  const ctl2 = new AbortController()
  const s2 = kiro({ turns: [(init) => new Response(new ReadableStream({ start(c) {
    c.enqueue(say("partial"))
    init.signal.addEventListener("abort", () => c.error(Object.assign(new Error("aborted"), { name: "AbortError" })))
    setTimeout(() => ctl2.abort(), 5)
  } }), { status: 200 })] })
  const e2 = await ask({ tools: [SEARCH] }, { signal: ctl2.signal }).then((r) => r.json()).catch((e) => e)
  expect(e2?.name).toBe("AbortError")
  expect(s2.mcp.length).toBe(0)
})

test("allowed_domains and blocked_domains keep only the pages they allow; user_location, or both lists, is a 400", async () => {
  const results = [hit(1, { url: "https://docs.example.com/x" }), hit(2, { url: "https://other.org/y" }), hit(3, { url: "https://example.com.evil.net/" })]
  kiro({ turns: [[use("a", "web_search", { query: "x" })], [say("ok")]], mcp: () => mcpOK(results) })
  let m = await (await ask({ tools: [{ ...SEARCH, allowed_domains: ["example.com"] }] })).json()
  expect(m.content.find((b) => b.type === "web_search_tool_result").content.map((r) => r.url)).toEqual(["https://docs.example.com/x"])
  kiro({ turns: [[use("a", "web_search", { query: "x" })], [say("ok")]], mcp: () => mcpOK(results) })
  m = await (await ask({ tools: [{ ...SEARCH, blocked_domains: ["other.org"] }] })).json()
  expect(m.content.find((b) => b.type === "web_search_tool_result").content.map((r) => r.url)).toEqual(["https://docs.example.com/x", "https://example.com.evil.net/"])
  // a domain with a path: the host matched in any case, the path as written
  const paths = [hit(1, { url: "https://example.com/Docs/intro" }), hit(2, { url: "https://EXAMPLE.com/docs/intro" }),
    hit(3, { url: "https://www.example.com/Docs" }), hit(4, { url: "https://example.com/Blog" }), hit(5, { url: "https://example.org/Docs" })]
  kiro({ turns: [[use("a", "web_search", { query: "x" })], [say("ok")]], mcp: () => mcpOK(paths) })
  m = await (await ask({ tools: [{ ...SEARCH, allowed_domains: ["Example.COM/Docs"] }] })).json()
  expect(m.content.find((b) => b.type === "web_search_tool_result").content.map((r) => r.url)).toEqual(["https://example.com/Docs/intro", "https://www.example.com/Docs"])
  kiro({ turns: [[use("a", "web_search", { query: "x" })], [say("ok")]], mcp: () => mcpOK(paths) })
  m = await (await ask({ tools: [{ ...SEARCH, blocked_domains: ["EXAMPLE.com/Docs"] }] })).json()
  expect(m.content.find((b) => b.type === "web_search_tool_result").content.map((r) => r.url)).toEqual(["https://example.com/docs/intro", "https://example.com/Blog", "https://example.org/Docs"])
  for (const t of [{ ...SEARCH, user_location: { type: "approximate", country: "US" } }, { ...SEARCH, allowed_domains: ["a.com"], blocked_domains: ["b.com"] }]) {
    const s = kiro({ turns: [] })
    const res = await ask({ tools: [t] })
    expect(res.status).toBe(400)
    expect((await res.json()).error.type).toBe("invalid_request_error")
    expect(s.kiro.length).toBe(0)
  }
})

test("a page that isn't http(s) is dropped; none found is an empty result, not a made-up one", async () => {
  kiro({ turns: [[use("a", "web_search", { query: "x" })], [say("nothing")]], mcp: () => mcpOK([hit(1, { url: "javascript:alert(1)" }), hit(2, { url: "not a url" })]) })
  const m = await (await ask({ tools: [SEARCH] })).json()
  expect(m.content.find((b) => b.type === "web_search_tool_result").content).toEqual([])
})

test("without the hosted search nothing changes: no MCP call, and a tool of the caller's named web_search is the caller's", async () => {
  let s = kiro({ turns: [[say("hi")]] })
  let m = await (await ask({})).json()
  expect(m.content).toEqual([{ type: "text", text: "hi" }])
  expect(s.mcp.length).toBe(0)
  const mine = { name: "web_search", description: "my own", input_schema: { type: "object", properties: { q: { type: "string" } } } }
  s = kiro({ turns: [[use("t", "web_search", { q: "x" })]] })
  m = await (await ask({ tools: [mine] })).json()
  expect(m.content).toEqual([{ type: "tool_use", id: "t", name: "web_search", input: { q: "x" } }])
  expect(s.mcp.length).toBe(0)
  expect(toolsSent(s)[0].toolSpecification.description).toBe("my own")
  // and the hosted one beside another tool of that name is a 400
  s = kiro({ turns: [] })
  expect((await ask({ tools: [SEARCH, mine] })).status).toBe(400)
})

// magpie hands this provider every tool typed web_search… (searches: true)
// instead of searching for it, so one this can't run is said, not dropped
test("a hosted web search other than web_search_20250305 named web_search is a 400, before Kiro is asked", async () => {
  for (const tools of [[{ type: "web_search_20260209", name: "web_search" }], [{ type: "web_search_preview", name: "web_search" }],
    [{ type: SEARCH_TYPE_OK, name: "search" }], [READ, { type: "web_search_20260209", name: "web_search", max_uses: 2 }], [SEARCH, { ...SEARCH }]]) {
    const s = kiro({ turns: [] })
    const res = await ask({ tools })
    expect(res.status).toBe(400)
    const e = (await res.json()).error
    expect(e.type).toBe("invalid_request_error")
    expect(e.message).toContain("web_search")
    expect(s.kiro.length + s.mcp.length).toBe(0)
  }
  // a newer version says how to have magpie search for it instead
  for (const type of ["web_search_20260209", "web_search_preview"]) {
    kiro({ turns: [] })
    expect((await (await ask({ tools: [{ type, name: "web_search" }] })).json()).error.message).toContain("provider.kiro.searches to false")
  }
  // another hosted tool (not a web search) is still left out, as before
  const s = kiro({ turns: [[say("hi")]] })
  expect((await ask({ tools: [{ type: "code_execution_20250522", name: "code_execution" }, READ] })).status).toBe(200)
  expect(toolsSent(s).map((t) => t.toolSpecification.name)).toEqual(["Read"])
})

test("the config hook says Kiro searches by itself, unless the user says otherwise", async () => {
  const hooks = await KiroAuthPlugin({})
  const cfg = {}
  await hooks.config(cfg)
  expect(cfg.provider.kiro.searches).toBe(true)
  const mine = { provider: { kiro: { searches: false } } }
  await hooks.config(mine)
  expect(mine.provider.kiro.searches).toBe(false)
})
