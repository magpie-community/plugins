// A coding plan's requests name the device in metadata.user_id, as ZCode's
// client (3.14.3, glm/zcode.cjs MLs and vWr) does on every Anthropic-format
// request, not on the Start Plan's alone (#387, wendyeq): BigModel's
// endpoint keeps a prompt cache on the machine it picks by it, and Pi's
// requests without it hit the cache 1 time in 19. The requests go to a
// local Bun.serve that records them; nothing reaches z.ai or bigmodel.cn.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { homedir, tmpdir } from "node:os"
import { realpathSync } from "node:fs"

let ZCodeAuthPlugin
let server
const got = []
beforeAll(async () => {
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ ZCodeAuthPlugin } = await import("./index.mjs"))
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      got.push({ path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: await req.text() })
      return Response.json({ type: "message", content: [] })
    },
  })
})
afterAll(() => server?.stop(true))

const real = globalThis.fetch
const HOSTS = ["https://zcode.z.ai", "https://api.z.ai", "https://open.bigmodel.cn"]
function routeToFake() {
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const host = HOSTS.find((h) => url.startsWith(h + "/"))
    if (!host) throw new Error("no network in tests: " + url)
    return real(`http://127.0.0.1:${server.port}/${new URL(host).host}${url.slice(host.length)}`, init)
  }
}
afterEach(() => {
  globalThis.fetch = real
  got.length = 0
})

const DEVICE = "11111111-2222-4333-8444-555555555555"
// a BigModel coding plan sign-in, its device saved with it
const signedIn = { type: "oauth", access: "id.secret", refresh: JSON.stringify({ site: "bigmodel", base: "https://open.bigmodel.cn/api/anthropic", key: "id.secret", device: DEVICE }), expires: 0 }
// an API key the user pasted, with no sign-in behind it
const pasted = { type: "api", key: "id.pasted", metadata: { site: "bigmodel" } }

async function send(auth, body, path = "/v1/messages") {
  routeToFake()
  const hooks = await ZCodeAuthPlugin({ client: { auth: { set: async () => {} } } })
  const opts = await hooks.auth.loader(async () => auth, { id: "zcode" })
  const text = typeof body === "string" ? body : JSON.stringify(body)
  const headers = { "content-type": "application/json", "x-api-key": "zcode", "anthropic-version": "2023-06-01", "content-length": String(Buffer.byteLength(text)) }
  await opts.fetch("https://open.bigmodel.cn/api/anthropic" + path, { method: "POST", headers, body: text })
  expect(got.length).toBe(1)
  return { body: got[0].body, path: got[0].path }
}

// Pi's request, as it reached magpie: no metadata
const pi = () => ({
  model: "GLM-5.3-Flash",
  max_tokens: 16000,
  stream: true,
  system: [{ type: "text", text: "You are Pi.", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }],
})
const userIdOf = (b) => JSON.parse(JSON.parse(b).metadata.user_id)

test("a coding plan's Messages request names the sign-in's device, as ZCode's does", async () => {
  const { body, path } = await send(signedIn, pi())
  expect(path).toBe("/open.bigmodel.cn/api/anthropic/v1/messages")
  const { sessionOf } = require("./index.mjs")._internal
  // and the conversation, as x-session-id names it; Pi named none (#387)
  expect(userIdOf(body)).toEqual({ device_id: DEVICE, account_uuid: "", session_id: sessionOf("", DEVICE) })
  // the rest of the request is the agent's, as it sent it
  const b = JSON.parse(body)
  delete b.metadata
  expect(b).toEqual(pi())
})

test("every request of one account names the same device", async () => {
  const a = userIdOf((await send(signedIn, pi())).body)
  got.length = 0
  const b = userIdOf((await send(signedIn, { ...pi(), messages: [...pi().messages, { role: "assistant", content: "hi" }, { role: "user", content: "again" }] })).body)
  expect(a).toEqual(b)
})

test("a pasted key's device is the same on every start, and its own", () => {
  const { keyDevice, stateOf } = require("./index.mjs")._internal
  expect(stateOf(pasted).device).toBe(keyDevice("id.pasted"))
  expect(stateOf(pasted).device).toBe(stateOf({ ...pasted }).device)
  expect(stateOf({ ...pasted, key: "id.other" }).device).not.toBe(stateOf(pasted).device)
  expect(keyDevice("id.pasted")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  // a sign-in's saved device wins
  expect(stateOf(signedIn).device).toBe(DEVICE)
})

test("a pasted key's request names its device too", async () => {
  const { keyDevice } = require("./index.mjs")._internal
  const { body } = await send(pasted, pi())
  expect(userIdOf(body).device_id).toBe(keyDevice("id.pasted"))
})

test("an agent's own user_id and other metadata are kept", async () => {
  const own = JSON.stringify({ device_id: "cc", account_uuid: "x", session_id: "s" })
  const { body } = await send(signedIn, { ...pi(), metadata: { user_id: own } })
  expect(JSON.parse(body).metadata).toEqual({ user_id: own })
  got.length = 0
  const other = await send(signedIn, { ...pi(), metadata: { trace: "t" } })
  expect(JSON.parse(other.body).metadata.trace).toBe("t")
  expect(userIdOf(other.body).device_id).toBe(DEVICE)
})

test("count_tokens and a body that isn't a Messages request go as they are", async () => {
  const counted = JSON.stringify({ model: "GLM-5.3-Flash", messages: [{ role: "user", content: "hi" }] })
  expect((await send(signedIn, counted, "/v1/messages/count_tokens")).body).toBe(counted)
  got.length = 0
  expect((await send(signedIn, "not json, messages")).body).toBe("not json, messages")
})
