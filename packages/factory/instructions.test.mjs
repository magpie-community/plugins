// plugins#243 (zygs1083-dotcom): Claude Code renders its instructions
// attachment two ways. The first copy opens with the preamble; a copy
// re-read after the files changed (changed: true, reason "compaction" and
// the others) opens with its own sentence. Both name ~/.claude/CLAUDE.md
// "(user's private global instructions for all projects)", which Factory
// refuses (yetone/magpie#634), but only the first copy was adapted, so a
// long session went 403 on every account after compaction.
//
// The texts below are what Claude Code 2.1.303's n_t()/Mje()/bMr() build
// (the same functions as the reporter's 2.1.292), wrapped as id() wraps a
// meta message: "<system-reminder>\n" + text + "\n</system-reminder>".
import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))
const messages = "https://api.factory.ai/api/llm/a/v1/messages"
const chat = "https://api.factory.ai/api/llm/o/v1/chat/completions"
const droid = "You are Droid, an AI software engineering agent built by Factory."

const GLOBAL = "(user's private global instructions for all projects)"
const files = "Contents of /home/u/.claude/CLAUDE.md " + GLOBAL + ":\nUse tabs.\nContents of /tmp/p/CLAUDE.md (project instructions, checked into the codebase):\nRun the tests."
const preamble = "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written."
const replaces = " — each replaces its earlier copy, and the instructions preamble above still applies:\n"
const wrap = (t) => "<system-reminder>\n" + t + "\n</system-reminder>"
const WRAPPERS = {
  initial: wrap(preamble + "\n" + files),
  compaction: wrap("Instruction files were re-read after the conversation was compacted; these differ from their earlier copies" + replaces + files),
  "settings sync": wrap("Instruction files were re-read after settings were synced onto this machine; these differ from their earlier copies" + replaces + files),
  "no reason": wrap("These instruction files changed" + replaces + files),
  "with a removed file": wrap("Instruction files were re-read after the conversation was compacted; these differ from their earlier copies" + replaces + files + "\nInstructions no longer present: /tmp/p/old/CLAUDE.md"),
}
const adapted = (t) => t.replaceAll(GLOBAL, "(global instructions)")

async function loaded(status = 200, reply = '{"id":"ok"}', headers = {}) {
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), ...init })
    return new Response(reply, { status, headers })
  }
  const auth = { type: "oauth", access: "factory-token", expires: Date.now() + 3_600_000, activeOrganizationId: "org_A" }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => {} } } })
  return { l: await hooks.auth.loader(async () => auth), seen }
}

for (const [name, reminder] of Object.entries(WRAPPERS)) {
  test(`renames the global CLAUDE.md in the ${name} instructions reminder`, async () => {
    const { l, seen } = await loaded()
    const pasted = "Why does Claude Code write " + GLOBAL + "?"
    // Messages: text blocks, and a string user turn
    await l.fetch(messages, { method: "POST", body: JSON.stringify({ system: droid, messages: [{ role: "user", content: [{ type: "text", text: reminder }, { type: "text", text: pasted }] }, { role: "assistant", content: "ok" }, { role: "user", content: reminder }] }) })
    const sent = JSON.parse(seen.at(-1).body).messages
    expect(sent[0].content[0].text).toBe(adapted(reminder))
    expect(sent[0].content[0].text).not.toContain(GLOBAL)
    expect(sent[0].content[1].text).toBe(pasted)
    expect(sent[2].content).toBe(adapted(reminder))
    // chat completions: magpie joins a turn's text blocks into one string
    await l.fetch(chat, { method: "POST", body: JSON.stringify({ model: "glm-5", messages: [{ role: "system", content: droid }, { role: "user", content: reminder + pasted }] }) })
    expect(JSON.parse(seen.at(-1).body).messages[1].content).toBe(adapted(reminder) + pasted)
  })
}

test("leaves text that only resembles the changed instructions reminder", async () => {
  const { l, seen } = await loaded()
  const near = [
    wrap("These instruction files changed and " + GLOBAL),
    "Quoted:\n" + WRAPPERS.compaction,
    wrap("Instruction files were re-read after the conversation was compacted; these differ from their earlier copies" + replaces + "Use " + GLOBAL),
  ]
  for (const text of near) {
    const body = JSON.stringify({ system: droid, messages: [{ role: "user", content: [{ type: "text", text }] }] })
    await l.fetch(messages, { method: "POST", body })
    expect(seen.at(-1).body).toBe(body)
  }
})

test("losslessly quotes the instructions template when a tool result shows it", async () => {
  const { l, seen } = await loaded()
  // what reading Claude Code's renderer source puts in the history
  const source = 'case"User":return" ' + GLOBAL + '"}}\ns=e.reason?`Instruction files were re-read ${Qj(e.reason)}; these differ from their earlier copies`:"These instruction files changed"\n' + WRAPPERS.compaction
  const request = { system: droid, messages: [{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "grep" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: source }, { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: source }] }] }] }
  await l.fetch(messages, { method: "POST", body: JSON.stringify(request) })
  const sent = JSON.parse(seen.at(-1).body).messages[1].content
  for (const encoded of [sent[0].content, sent[1].content[0].text]) {
    expect(encoded).toStartWith("Tool output encoded as a JSON string.")
    expect(encoded).not.toContain(GLOBAL)
    expect(JSON.parse(encoded.slice(encoded.indexOf("\n") + 1))).toBe(source)
  }
  // the same on chat completions' tool messages
  await l.fetch(chat, { method: "POST", body: JSON.stringify({ model: "glm-5", messages: [{ role: "system", content: droid }, { role: "tool", tool_call_id: "t1", content: source }] }) })
  const tool = JSON.parse(seen.at(-1).body).messages[1].content
  expect(tool).not.toContain(GLOBAL)
  expect(JSON.parse(tool.slice(tool.indexOf("\n") + 1))).toBe(source)
})

test("a 403 keeps Factory's request id and error code", async () => {
  const { l } = await loaded(403, JSON.stringify({ error: { message: "Forbidden", code: "client_rejected", type: "forbidden" } }), { "x-request-id": "req_abc123", "cf-ray": "8f00-SJC" })
  const res = await l.fetch(messages, { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "OK" }] }) })
  expect(res.status).toBe(403)
  expect(res.headers.get("x-request-id")).toBe("req_abc123")
  const body = await res.json()
  expect(body.request_id).toBe("req_abc123")
  expect(body.error.type).toBe("permission_error")
  expect(body.error.message).toStartWith("Forbidden (upstream request id req_abc123, code client_rejected, type forbidden) — Factory refused")

  // a plain-text 403 with only a ray id says that, on the OpenAI route too
  const plain = await loaded(403, "Forbidden", { "cf-ray": "8f00-SJC" })
  const res2 = await plain.l.fetch(chat, { method: "POST", body: JSON.stringify({ model: "glm-5", messages: [{ role: "user", content: "OK" }] }) })
  const msg = (await res2.json()).error.message
  expect(msg).toStartWith("403 Forbidden: Forbidden (upstream request id 8f00-SJC) — Factory refused")

  // nothing to tell: the message is as before
  const bare = await loaded(403, "Forbidden")
  const res3 = await bare.l.fetch(messages, { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "OK" }] }) })
  const b3 = await res3.json()
  expect(b3.request_id).toBeUndefined()
  expect(b3.error.message).toStartWith("403 Forbidden: Forbidden — Factory refused")
})
