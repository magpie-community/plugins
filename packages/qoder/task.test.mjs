// #330 (real-jacket): one DSH task on Qoder's dfmodel made 265 calls in 55
// minutes, and Qoder then answered "Billing daily count exceeded". Each call
// went out as a task of its own: a new request_set_id and business.id, and
// begin_at the call's own time with stage "start". Qoder's own client
// (qoder-agent-sdk in Qoder.app, qoder-worker-runtime's AgentLifecycle)
// makes that record once for a user prompt and keeps it for every call of
// its tool loop, moving stage from "start" to "processing" once a call is
// answered; only request_id and chat_record_id are new on each call. DSH's
// own session (x-deepseek-harness-session-id, which magpie hands a plugin's
// chat.headers hook as its session) names session_id, so a system prompt
// DSH changes mid-task no longer splits it (yetone/magpie#3298).
import { afterEach, beforeEach, expect, test } from "bun:test"
import { QoderAuthPlugin, QoderCNAuthPlugin, _internal } from "./index.mjs"

const { qoderBody, sessionOf, taskOf, TASKS, TASK_MAX, TASK_IDLE, SESSION } = _internal
const m = { key: "dfmodel", config: { key: "dfmodel" }, context: 128_000 }
const real = globalThis.fetch
beforeEach(() => TASKS.clear())
afterEach(() => {
  globalThis.fetch = real
  TASKS.clear()
})

const API_CHAT = "https://api3.qoder.sh/v1/chat/completions"
const LISTING = { chat: [{ key: "dfmodel", display_name: "DeepSeek Flash", enable: true }] }
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } })
const line = (body) => `data:${JSON.stringify({ headers: {}, body: typeof body === "string" ? body : JSON.stringify(body), statusCodeValue: 200 })}\n\n`
const answered = () =>
  new Response(line({ choices: [{ delta: { content: "ok" } }] }) + line({ choices: [{ delta: {}, finish_reason: "stop" }] }) + line("[DONE]"), {
    headers: { "Content-Type": "text/event-stream" },
  })

// the plugin as magpie's host runs it: the chat.headers hook is told the
// session, and what it adds goes to the loader's fetch with the request
async function plugin(make = QoderAuthPlugin, id = "qoder") {
  const auth = { type: "oauth", access: "jt", refresh: "rt", expires: Date.now() + 3_600_000, accountId: "one@x", uid: "u1", machineId: "m1" }
  const sent = []
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (u.pathname.endsWith("/model/list")) return json(LISTING)
    sent.push({ body: JSON.parse(_internal.decodeBody(init.body)), headers: init.headers })
    return answered()
  }
  const hooks = await make({ client: { auth: { set: async () => {} } } })
  const l = await hooks.auth.loader(async () => auth)
  const call = async (messages, session) => {
    const out = { headers: {} }
    await hooks["chat.headers"]({ sessionID: session ?? "", model: { providerID: id, id: "dfmodel" } }, out)
    const res = await l.fetch(API_CHAT, { method: "POST", headers: new Headers(out.headers), body: JSON.stringify({ model: "dfmodel", messages }) })
    expect(res.status).toBe(200)
    await res.text()
    return sent.at(-1).body
  }
  return { call, sent, hooks }
}

const sys = (s) => ({ role: "system", content: s })
const user = (s) => ({ role: "user", content: s })
const called = (id) => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }] })
const result = (id) => ({ role: "tool", tool_call_id: id, content: "a.txt" })

test("every call of one task's tool loop goes out under one task, as Qoder's client sends it", async () => {
  const { call } = await plugin()
  const s = "dsh-session-1"
  const one = [sys("You are DSH."), user("fix the bug")]
  const a = await call(one, s)
  const b = await call([...one, called("c1"), result("c1")], s)
  const c = await call([...one, called("c1"), result("c1"), called("c2"), result("c2")], s)
  for (const x of [b, c]) {
    expect(x.request_set_id).toBe(a.request_set_id)
    expect(x.business.id).toBe(a.business.id)
    expect(x.business.begin_at).toBe(a.business.begin_at)
    expect(x.session_id).toBe(a.session_id)
  }
  // the task's record is the prompt's: business.id is its request_set_id
  expect(a.business.id).toBe(a.request_set_id)
  expect(a.business.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  // the first call starts it; once a call is answered it is processing
  expect([a, b, c].map((x) => x.business.stage)).toEqual(["start", "processing", "processing"])
  // each call is its own request
  expect(new Set([a, b, c].map((x) => x.request_id)).size).toBe(3)
  for (const x of [a, b, c]) expect(x.chat_record_id).toBe(x.request_id)
})

test("a new prompt in the session is a new task, and the session stays one", async () => {
  const { call } = await plugin()
  const s = "dsh-session-2"
  const one = [sys("You are DSH."), user("fix the bug")]
  const a = await call(one, s)
  const b = await call([...one, { role: "assistant", content: "done" }, user("now add a test")], s)
  expect(b.request_set_id).not.toBe(a.request_set_id)
  expect(b.business.id).not.toBe(a.business.id)
  expect(b.business.stage).toBe("start")
  expect(b.session_id).toBe(a.session_id)
  // the same words in another session are another task
  const c = await call(one, "dsh-session-3")
  expect(c.request_set_id).not.toBe(a.request_set_id)
  expect(c.session_id).not.toBe(a.session_id)
})

test("the session the agent named is the session_id, through a system prompt that changes mid-task", async () => {
  const { call, sent } = await plugin()
  const s = "dsh-session-4"
  const a = await call([sys("You are DSH. tools: a"), user("fix the bug")], s)
  const b = await call([sys("You are DSH. tools: a, b"), user("fix the bug"), called("c1"), result("c1")], s)
  expect(b.session_id).toBe(a.session_id)
  expect(b.request_set_id).toBe(a.request_set_id)
  expect(a.session_id).toBe(sessionOf({ messages: [] }, s))
  // without one, the conversation's opening names it, as before
  const c = await call([sys("You are DSH. tools: a"), user("fix the bug")])
  expect(c.session_id).toBe(sessionOf({ messages: [sys("You are DSH. tools: a"), user("fix the bug")] }))
  expect(c.session_id).not.toBe(a.session_id)
  // the session goes to Qoder hashed, and the header never goes at all
  for (const x of sent) {
    expect(JSON.stringify(x.body)).not.toContain("dsh-session")
    expect(Object.keys(x.headers).map((k) => k.toLowerCase())).not.toContain(SESSION)
  }
})

test("magpie's own hash of the first message names no session, and another provider's request gets no header", async () => {
  const { hooks } = await plugin()
  const out = { headers: {} }
  await hooks["chat.headers"]({ sessionID: "magpie-0123456789abcdef01234567", model: { providerID: "qoder" } }, out)
  expect(out.headers).toEqual({})
  await hooks["chat.headers"]({ sessionID: "dsh-x", model: { providerID: "cursor" } }, out)
  expect(out.headers).toEqual({})
  await hooks["chat.headers"]({ sessionID: "dsh-x", model: { providerID: "qoder" } }, out)
  expect(out.headers).toEqual({ [SESSION]: "dsh-x" })
  // Qoder CN's hook names its own provider's requests
  const cn = await plugin(QoderCNAuthPlugin, "qoder-cn")
  const o2 = { headers: {} }
  await cn.hooks["chat.headers"]({ sessionID: "dsh-x", model: { providerID: "qoder" } }, o2)
  expect(o2.headers).toEqual({})
  await cn.hooks["chat.headers"]({ sessionID: "dsh-x", model: { providerID: "qoder-cn" } }, o2)
  expect(o2.headers).toEqual({ [SESSION]: "dsh-x" })
})

test("a failed call leaves its task at start", () => {
  const msgs = [user("hi")]
  const t = taskOf(sessionOf({ messages: msgs }), { messages: msgs })
  expect(qoderBody({ messages: msgs }, m, "", t).business.stage).toBe("start")
  expect(qoderBody({ messages: msgs }, m).business.stage).toBe("start")
  t.answered = true
  expect(qoderBody({ messages: msgs }, m).business.stage).toBe("processing")
})

test("the tasks kept are bounded in number and in time", () => {
  const now = 1_000_000_000
  const first = taskOf("s", { messages: [user("task 0")] }, now)
  for (let i = 1; i <= TASK_MAX + 50; i++) taskOf("s", { messages: [user("task " + i)] }, now + i)
  expect(TASKS.size).toBe(TASK_MAX)
  // the oldest went first: its prompt is a new task now
  expect(taskOf("s", { messages: [user("task 0")] }, now + TASK_MAX + 60).id).not.toBe(first.id)
  // one used within TASK_IDLE stays, past it is a new task and the idle ones go
  const late = now + TASK_MAX + 100
  const kept = taskOf("s", { messages: [user("long task")] }, late)
  expect(taskOf("s", { messages: [user("long task")] }, late + TASK_IDLE - 1).id).toBe(kept.id)
  expect(taskOf("s", { messages: [user("long task")] }, late + 2 * TASK_IDLE).id).not.toBe(kept.id)
  expect(TASKS.size).toBe(1)
})
