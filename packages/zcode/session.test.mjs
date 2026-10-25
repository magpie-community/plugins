// Every request names its conversation in x-session-id, as ZCode's client
// (3.14.3, glm/zcode.cjs xst and Tst) does: a bare UUID, the same on each
// turn. BigModel's prompt cache follows it (#387). The agent's session
// comes through chat.headers: a UUID goes as it is, anything else, magpie's
// own magpie-<hex> among them, as a UUID made from it; with none, a UUID
// made from the device. metadata.user_id's session_id is the same UUID.
// Nothing leaves the machine: the plugin's fetch is the fake here.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
const { ZCodeAuthPlugin, _internal } = await import("./index.mjs")

const jwt = ["{}", JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })].map((s) => Buffer.from(s).toString("base64url")).join(".") + ".sig"
const DEVICE = "11111111-2222-4333-8444-555555555555"
const KEY = "session.secret"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const AGENT = "01A17286-ABCD-4EF0-9123-456789ABCDEF" // Claude Code's kind of session
const coding = { type: "oauth", access: KEY, refresh: JSON.stringify({ site: "bigmodel", base: "https://open.bigmodel.cn/api/anthropic", key: KEY, device: DEVICE, plan: "GLM Coding Pro" }), expires: 0 }
const start = { type: "oauth", access: jwt, refresh: JSON.stringify({ site: "zai", base: "https://api.z.ai/api/anthropic", jwt, device: DEVICE }), expires: 0 }

const sent = []
const real = globalThis.fetch
beforeEach(() => {
  _internal.routes.clear()
  sent.length = 0
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    sent.push({ origin: url.origin, path: url.pathname, headers: Object.fromEntries(new Headers(init.headers ?? {})), body: init.body })
    if (url.pathname.endsWith("/messages")) return new Response(JSON.stringify({ type: "message", content: [] }), { headers: { "content-type": "application/json" } })
    if (url.pathname === "/api/biz/subscription/list") return new Response(JSON.stringify({ code: 0, data: [{ productName: "GLM Coding Pro", status: "VALID" }] }))
    return new Response("", { status: 404 })
  }
})
afterEach(() => (globalThis.fetch = real))

const plugin = async () => ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
const body = JSON.stringify({ model: "glm-5.3-flash", max_tokens: 100, messages: [{ role: "user", content: "hi" }] })
async function send(auth, url, headers = {}) {
  const opts = await (await plugin()).auth.loader(async () => auth, { id: "zcode" })
  return opts.fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "zcode", ...headers }, body })
}
const message = () => sent.filter((c) => c.path.endsWith("/messages")).at(-1)
const sessionIn = (m) => JSON.parse(JSON.parse(m.body).metadata.user_id).session_id
const CODING = "https://open.bigmodel.cn/api/anthropic/v1/messages"
const hook = async (sessionID, providerID = "zcode") => {
  const out = { headers: {} }
  await (await plugin())["chat.headers"]({ sessionID, model: { providerID } }, out)
  return out.headers
}

test("an agent's UUID session goes as it is, in lower case", async () => {
  expect(await hook(AGENT)).toEqual({ "x-session-id": AGENT.toLowerCase() })
  expect(_internal.sessionOf(AGENT, DEVICE)).toBe(AGENT.toLowerCase())
})

test("any other session goes as a UUID made from it, the same every time", async () => {
  for (const id of ["magpie-0123456789abcdef01234567", "ses_3f2a9c1b7e", "sess_abc", "a b/c"]) {
    const sid = (await hook(id))["x-session-id"]
    expect(sid).toMatch(UUID)
    expect(sid).not.toMatch(/magpie|ses_|sess_/)
    expect(await hook(id)).toEqual({ "x-session-id": sid })
    expect(_internal.sessionOf(sid)).toBe(sid) // a UUID made once stays as it is
  }
  expect(_internal.sessionOf("magpie-a")).not.toBe(_internal.sessionOf("magpie-b"))
})

test("chat.headers names a session for zcode only, and only when there is one", async () => {
  expect(await hook(AGENT, "openai")).toEqual({})
  expect(await hook("")).toEqual({})
  expect(await hook(undefined)).toEqual({})
})

test("a coding plan request keeps the agent's session, in the header and metadata.user_id alike", async () => {
  await send(coding, CODING, { "x-session-id": AGENT.toLowerCase() })
  expect(message().headers["x-session-id"]).toBe(AGENT.toLowerCase())
  // the body goes as sent, but for metadata.user_id naming the device and the session (#387)
  const b = JSON.parse(message().body)
  expect(JSON.parse(b.metadata.user_id)).toEqual({ device_id: DEVICE, account_uuid: "", session_id: AGENT.toLowerCase() })
  delete b.metadata
  expect(b).toEqual(JSON.parse(body))
})

test("a session that reaches the request unmapped goes as its UUID too", async () => {
  await send(coding, CODING, { "x-session-id": "magpie-0123456789abcdef01234567" })
  const sid = message().headers["x-session-id"]
  expect(sid).toBe(_internal.sessionOf("magpie-0123456789abcdef01234567"))
  expect(sessionIn(message())).toBe(sid)
})

test("a coding plan request with no session names a UUID made from the device", async () => {
  await send(coding, CODING)
  const first = message().headers["x-session-id"]
  expect(first).toMatch(UUID)
  expect(first).not.toBe(DEVICE)
  expect(first).not.toContain(DEVICE)
  expect(sessionIn(message())).toBe(first)
  await send(coding, CODING)
  expect(message().headers["x-session-id"]).toBe(first)
})

test("a Start Plan request carries the session in the header and metadata.user_id alike", async () => {
  _internal.routes.set("\0" + jwt, { start: true, gift: null, at: Date.now(), ttl: 600_000 })
  await send(start, "https://api.z.ai/api/anthropic/v1/messages", { "x-session-id": AGENT })
  expect(message().origin).toBe("https://zcode.z.ai")
  expect(message().headers["x-session-id"]).toBe(AGENT.toLowerCase())
  expect(sessionIn(message())).toBe(AGENT.toLowerCase())
})
