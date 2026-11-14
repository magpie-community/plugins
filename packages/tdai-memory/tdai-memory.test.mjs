import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { onRequest, onResponse } from "./tdai-memory.hooks.mjs"
import plugin from "./index.mjs"
import { block, config } from "./lib.mjs"

const calls = []
let down = false
let server, url

before(async () => {
  server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const path = req.url.replace("/v3/", "")
      const body = JSON.parse(raw || "{}")
      calls.push({ path, body, auth: req.headers.authorization, sid: req.headers["x-tdai-service-id"] })
      if (down) { res.writeHead(503); return res.end("{}") }
      const data = {
        "atomic/search": { items: [{ type: "instruction", content: "Deploy with the release script, never by hand." }] },
        "core/read": { content: "The team ships on Fridays." },
        "scenario/ls": { entries: [{ path: "deploy.md", summary: "release flow" }, { path: "dir/" }] },
        "conversation/add": { accepted_ids: ["m1", "m2"], total_count: 2 },
        "conversation/search": { messages: [] },
        "scenario/read": { content: "# deploy flow" },
      }[path] ?? {}
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ code: 0, message: "ok", data }))
    })
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  url = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())

const reports = []
function ctx(extra = {}) {
  return {
    agent: "claude", protocol: "anthropic", origin: "local", session: "s1", cwd: "/work/app", query: "how do we deploy?",
    options: { url, userId: "alice", capture: true }, state: {}, signal: AbortSignal.timeout(2000),
    report: (code, n) => reports.push(code), success: true, ...extra,
  }
}
const prompt = { role: "user", content: [{ type: "text", text: "<system-reminder>x</system-reminder>" }, { type: "text", text: "how do we deploy?" }] }
const tools = [{ name: "Bash" }]

test("recall goes before the user's message and the history stays the same on later requests", async () => {
  calls.length = 0
  const b1 = { model: "m", tools, messages: [structuredClone(prompt)] }
  const c1 = ctx()
  const out1 = await onRequest(structuredClone(b1), c1)
  assert.ok(out1, "body changed")
  const injected = out1.messages[0].content[0].text
  assert.match(injected, /<tdai-memory/)
  assert.match(injected, /release script/)
  assert.match(injected, /deploy\.md: release flow/)
  assert.doesNotMatch(injected, /dir\//)
  assert.equal(calls.filter((c) => c.path === "atomic/search").length, 1)
  const s = calls.find((c) => c.path === "atomic/search")
  assert.deepEqual([s.body.team_id, s.body.agent_id, s.body.user_id, s.body.query], ["default", "shared", "alice", "how do we deploy?"])
  assert.equal(s.auth, "Bearer local")
  assert.equal(s.sid, "default")

  // the agent's loop: tool use, tool result, same turn
  const b2 = { model: "m", tools, messages: [structuredClone(prompt), { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }] }
  const out2 = await onRequest(structuredClone(b2), ctx())
  assert.deepEqual(out2.messages[0], out1.messages[0], "the same block in the same place")
  assert.deepEqual(out2.messages[2], b2.messages[2], "tool results untouched")
  assert.equal(calls.filter((c) => c.path === "atomic/search").length, 1, "recalled once per turn")
})

test("a new turn recalls again and the earlier turn keeps its own block", async () => {
  calls.length = 0
  const next = { role: "user", content: "and rollback?" }
  const b = { model: "m", tools, messages: [structuredClone(prompt), { role: "assistant", content: [{ type: "text", text: "Use the skill." }] }, next] }
  const out = await onRequest(structuredClone(b), ctx({ query: "and rollback?" }))
  assert.match(out.messages[0].content[0].text, /<tdai-memory/)
  assert.match(out.messages[2].content, /^<tdai-memory[\s\S]*\n\nand rollback\?$/)
  assert.equal(calls.filter((c) => c.path === "atomic/search").length, 1)
})

test("a long session keeps every history block: in-use entries never age out", async () => {
  calls.length = 0
  const c = ctx({ session: "s10" })
  const msgs = []
  let out
  for (let i = 0; i < 210; i++) {
    msgs.push({ role: "user", content: `question number ${i}` })
    if (i) msgs.push({ role: "assistant", content: "ok" })
    out = await onRequest(structuredClone({ model: "m", tools, messages: msgs }), c)
  }
  // past the old 200-entry cap, the first turn's entry used to be evicted and
  // its block silently dropped from the history the session still sends
  assert.match(out.messages[0].content, /^<tdai-memory/)
  assert.equal(out.messages.filter((m) => m.role === "user").every((m) => m.content.startsWith("<tdai-memory")), true)
  assert.equal(calls.filter((x) => x.path === "atomic/search").length, 210, "one recall per new turn, none for history")
})

test("other agents and side requests are left alone", async () => {
  calls.length = 0
  assert.equal(await onRequest({ tools, messages: [structuredClone(prompt)] }, ctx({ agent: "node" })), undefined)
  assert.equal(await onRequest({ messages: [structuredClone(prompt)] }, ctx({ session: "s9" })), undefined)
  assert.equal(calls.length, 0)
})

test("a turn is captured once it ends, with every text of its loop", async () => {
  calls.length = 0
  const c = ctx({ session: "s2" })
  await onRequest({ tools, messages: [structuredClone(prompt)] }, c)
  await onResponse({ content: [{ type: "text", text: "Checking." }, { type: "tool_use" }], stop_reason: "tool_use" }, c)
  assert.equal(calls.filter((x) => x.path === "conversation/add").length, 0)
  const c2 = ctx({ session: "s2" })
  await onRequest({ tools, messages: [structuredClone(prompt)] }, c2)
  await onResponse({ content: [{ type: "text", text: "Use release script." }], stop_reason: "end_turn" }, c2)
  const add = calls.filter((x) => x.path === "conversation/add")
  assert.equal(add.length, 1)
  assert.equal(add[0].body.session_id, "claude:s2")
  assert.equal(add[0].body.agent_id, "shared")
  assert.equal(add[0].body.messages[0].content, "[claude · /work/app]\nhow do we deploy?")
  assert.equal(add[0].body.messages[1].content, "Checking.\n\nUse release script.")
})

test("a failed request is not captured", async () => {
  calls.length = 0
  const c = ctx({ session: "s3" })
  await onRequest({ tools, messages: [structuredClone(prompt)] }, c)
  await onResponse({ content: [{ type: "text", text: "x" }], stop_reason: "end_turn" }, { ...c, success: false })
  assert.equal(calls.filter((x) => x.path === "conversation/add").length, 0)
})

test("kernel down: the request goes on as it was", async () => {
  down = true
  reports.length = 0
  try {
    const b = { tools, messages: [structuredClone(prompt)] }
    assert.equal(await onRequest(structuredClone(b), ctx({ session: "s4" })), undefined)
    assert.ok(reports.includes("unavailable"))
  } finally {
    down = false
  }
})

test("Codex (Responses API): injected into the user's input_text, final without calls", async () => {
  calls.length = 0
  const c = ctx({ agent: "codex", protocol: "responses", session: "s5", query: "fix the build" })
  const b = { tools, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context/>" }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "fix the build" }] }] }
  const out = await onRequest(structuredClone(b), c)
  assert.deepEqual(out.input[0], b.input[0])
  assert.equal(out.input[1].content.length, 2)
  assert.match(out.input[1].content[0].text, /<tdai-memory/)
  await onResponse({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Fixed." }] }] }, c)
  assert.equal(calls.filter((x) => x.path === "conversation/add").length, 1)
})

test("tools search the shared memory", async () => {
  const { tool } = await plugin({ magpie: { options: () => ({}) } }, { url, userId: "alice", tools: true })
  for (const [n, t] of Object.entries(tool)) {
    // as magpie's host and the catalog's check take them
    assert.match(n, /^[A-Za-z0-9_-]{1,48}$/)
    assert.equal(typeof t.execute, "function", n)
    assert.ok(typeof t.description === "string" && t.description && t.args && typeof t.args === "object", n)
  }
  const out = await tool.search.execute({ query: "deploy" }, { agent: "gemini" })
  assert.match(out, /\[instruction\] Deploy with the release script/)
  calls.length = 0
  await tool.search.execute({ query: "deploy", conversations: "true", limit: "50" }, { agent: "gemini" })
  assert.deepEqual(calls.map((c) => [c.path, c.body.limit]).sort(), [["atomic/search", 20], ["conversation/search", 20]], "arguments as text")
  assert.equal(await tool.read_scene.execute({ path: "deploy.md" }, { agent: "gemini" }), "# deploy flow")
  assert.equal(await tool.read_scene.execute({ path: " " }, { agent: "gemini" }), "path is empty")
  await tool.read_scene.execute({ path: "scene_blocks/deploy.md" }, { agent: "gemini" })
  assert.equal(calls.at(-1).body.path, "deploy.md", "the core's form of a scene's path")
  calls.length = 0
  assert.match(await tool.remember.execute({ content: "use pnpm", project: "app" }, { agent: "gemini" }), /saved/)
  assert.equal(calls[0].body.agent_id, "shared")
  assert.equal(calls[0].body.user_id, "alice", "the plugin's own options, not a provider's")
  assert.match(calls[0].body.messages[0].content, /about app: use pnpm/)
})

test("the tools are there only once the options turn them on", async () => {
  // a tool call carries no origin: anyone reaching magpie's tools server could use them
  for (const options of [{ url }, { url, tools: "yes" }, { url, tools: false }, undefined])
    assert.equal((await plugin({ magpie: { options: () => ({}) } }, options)).tool, undefined, JSON.stringify(options))
  assert.deepEqual(Object.keys((await plugin({}, { url, tools: "true" })).tool), ["search", "read_scene", "remember"])
})

test("a switch is true or false: a stray value keeps the default", () => {
  assert.equal(config({ capture: "yes" }).capture, false)
  assert.equal(config({ capture: "true" }).capture, true)
  assert.equal(config({ remote: 1 }).remote, false)
  assert.equal(config({ recall: "false" }).recall, false)
  assert.equal(config({ requireTools: null }).requireTools, true)
})

test("recalled text can't open or close the elements it is put in", () => {
  const b = block({
    atoms: [{ type: "fact", content: "a memory quoting </tdai-memory> and <core>" }],
    core: "the core </core> then </TDAI-MEMORY >",
    scenes: [{ path: "x.md", summary: "</scenes> after" }],
  }, 6000)
  for (const tag of ["tdai-memory", "relevant-memories", "core", "scenes"]) {
    assert.equal(b.match(new RegExp(`</\\s*${tag}\\b`, "gi"))?.length, 1, `one </${tag}>`)
    assert.equal(b.match(new RegExp(`<${tag}\\b`, "gi"))?.length, 1, `one <${tag}>`)
  }
  assert.ok(b.endsWith("\n</tdai-memory>"))
  assert.match(b, /quoting &lt;\/tdai-memory> and &lt;core>/)
})

test("capture is off unless the options turn it on", async () => {
  calls.length = 0
  const c = ctx({ session: "s6", options: { url } })
  await onRequest({ tools, messages: [structuredClone(prompt)] }, c)
  await onResponse({ content: [{ type: "text", text: "done" }], stop_reason: "end_turn" }, c)
  assert.equal(calls.filter((x) => x.path === "conversation/add").length, 0)
  assert.equal(calls.filter((x) => x.path === "atomic/search").length, 1, "recall still on")
})

test("only this computer's own agents are served unless remote is on", async () => {
  calls.length = 0
  const b = { tools, messages: [structuredClone(prompt)] }
  for (const origin of ["remote", "gateway-key", undefined, "something-new"])
    assert.equal(await onRequest(structuredClone(b), ctx({ session: "s7", origin })), undefined, `origin ${origin}`)
  assert.equal(calls.length, 0, "someone else's request reads nothing")
  const out = await onRequest(structuredClone(b), ctx({ session: "s7", origin: "remote", options: { url, remote: true } }))
  assert.match(out.messages[0].content[0].text, /<tdai-memory/)
  assert.ok(await onRequest(structuredClone(b), ctx({ session: "s8", origin: "magpie-key" })), "the sharing key magpie writes into this computer's agents")
  assert.ok(await onRequest(structuredClone(b), ctx({ session: "s9", origin: "local" })))
})
