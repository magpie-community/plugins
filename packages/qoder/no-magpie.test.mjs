// magpie-community/plugins#354: every chat request's business record was
// named "magpie session". Qoder's own client names an agent task by its
// prompt, the first ten characters of it (qoder-agent-sdk's
// AgentLifecycle: hdr → C6s), and so does the plugin now. Nothing that
// goes upstream names the app: the URL, every header, the wire body and
// the body under its encoding.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { QoderAuthPlugin, QoderCNAuthPlugin, _internal } from "./index.mjs"

const { TASKS } = _internal
const real = globalThis.fetch
beforeEach(() => TASKS.clear())
afterEach(() => {
  globalThis.fetch = real
  TASKS.clear()
})

const json = (v) => new Response(JSON.stringify(v), { headers: { "Content-Type": "application/json" } })
const line = (body) => `data:${JSON.stringify({ headers: {}, body: typeof body === "string" ? body : JSON.stringify(body), statusCodeValue: 200 })}\n\n`
const answered = () =>
  new Response(line({ choices: [{ delta: { content: "ok" } }] }) + line({ choices: [{ delta: {}, finish_reason: "stop" }] }) + line("[DONE]"), {
    headers: { "Content-Type": "text/event-stream" },
  })

async function run(make, id, session) {
  const auth = { type: "oauth", access: "jt", refresh: "rt", expires: Date.now() + 3_600_000, accountId: "one@x", uid: "u1", machineId: "m1" }
  const sent = []
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url ?? input)
    const wire = init.body == null ? "" : typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body)
    sent.push({ url, headers: [...new Headers(init.headers)].flat(), wire })
    if (new URL(url).pathname.endsWith("/model/list")) return json({ chat: [{ key: "dfmodel", display_name: "DeepSeek Flash", enable: true }] })
    return answered()
  }
  const hooks = await make({ client: { auth: { set: async () => {} } } })
  const l = await hooks.auth.loader(async () => auth)
  const out = { headers: {} }
  await hooks["chat.headers"]({ sessionID: session, model: { providerID: id, id: "dfmodel" } }, out)
  const messages = [{ role: "system", content: "You are a coding agent." }, { role: "user", content: "fix the failing build on main" }]
  const res = await l.fetch("https://api3.qoder.sh/v1/chat/completions", { method: "POST", headers: new Headers(out.headers), body: JSON.stringify({ model: "dfmodel", messages }) })
  expect(res.status).toBe(200)
  await res.text()
  return sent
}

for (const [make, id] of [[QoderAuthPlugin, "qoder"], [QoderCNAuthPlugin, "qoder-cn"]])
  for (const session of ["", "magpie-0123456789abcdef01234567", "dsh-session-1"])
    test(`no request to ${id} names magpie (session ${JSON.stringify(session)}) (#354)`, async () => {
      const sent = await run(make, id, session)
      const chats = sent.filter((s) => !new URL(s.url).pathname.endsWith("/model/list"))
      expect(chats.length).toBe(1)
      for (const s of sent) {
        expect([s.url, ...s.headers, s.wire].join("\n")).not.toMatch(/magpie/i)
        if (s.wire) expect(_internal.decodeBody(s.wire)).not.toMatch(/magpie/i)
      }
      // named as Qoder's client names an agent task: its prompt's first ten
      const body = JSON.parse(_internal.decodeBody(chats[0].wire))
      expect(body.business.name).toBe("fix the fa")
    })

test("a short prompt is the whole name; a task keeps its name through its tool loop", () => {
  const { qoderBody } = _internal
  const m = { key: "dfmodel", config: { key: "dfmodel" }, context: 128_000 }
  const one = [{ role: "user", content: "hi" }]
  const a = qoderBody({ messages: one }, m, "s1")
  expect(a.business.name).toBe("hi")
  const b = qoderBody({ messages: [...one, { role: "assistant", content: "", tool_calls: [{ id: "c", type: "function", function: { name: "ls", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c", content: "x" }] }, m, "s1")
  expect(b.business.id).toBe(a.business.id)
  expect(b.business.name).toBe("hi")
  expect(qoderBody({ messages: [{ role: "user", content: [{ type: "text", text: "继续修复这个构建失败的问题吧" }] }] }, m, "s2").business.name).toBe("继续修复这个构建失败")
})
